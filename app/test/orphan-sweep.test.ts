import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { findOrphanedBundles } from "../src/temp-takes.js";
import { tagMp4 } from "@transform/media-tag.js";
import { mintCaptureId } from "@transform/capture-id.js";

const env = {} as NodeJS.ProcessEnv;
let root: string;
let bundle: string;

/**
 * A structurally valid, tiny MP4 that `scanFinishedFilesAt`'s own MP4 probe
 * can walk (`ftyp`/`mdat`/`moov`). Kept as its own copy rather than imported
 * from `library-scan.test.ts`, per that file's own note: a fixture shared
 * between two test files is a coupling that makes one file's failure look
 * like the other's.
 */
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, data: number[]) => [...be32(8 + data.length), ...chars(type), ...data];

function mp4Bytes(): Uint8Array {
  const mvhd = box("mvhd", [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(600), ...be32(3000)]);
  const tkhd = box("tkhd", [
    0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(1), ...be32(0), ...be32(0),
    ...new Array(8).fill(0), 0, 0, 0, 0, 0, 0, 0, 0,
    ...new Array(36).fill(0),
    ...be32(1920 * 65536), ...be32(1080 * 65536),
  ]);
  return new Uint8Array([...box("ftyp", chars("isom")), ...box("mdat", [1, 2, 3, 4]),
    ...box("moov", [...mvhd, ...box("trak", tkhd)])]);
}

/** A JPEG's first bytes — `library.ts` reads no id from a JPEG at all, by rule. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);

/** A `raw/` bundle of the given kind with its own `capture.json`; returns its dir and id. */
async function makeBundle(name: string, doc: "anchors.json" | "shot.json" | null) {
  const dir = join(root, "raw", name);
  await mkdir(dir, { recursive: true });
  if (doc) await writeFile(join(dir, doc), JSON.stringify({ version: 1 }));
  const id = mintCaptureId();
  await writeFile(join(dir, "capture.json"), JSON.stringify({ version: 1, id }));
  return { dir, id };
}

/** Every path under `dir` with its size and mtime — what "read-only" is checked against. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const n of (await readdir(d)).sort()) {
      const p = join(d, n);
      const st = await stat(p);
      out.push(`${relative(dir, p)} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
  return out;
}

/**
 * One matched pair: a recording bundle with a real `capture.json`, and a
 * top-level `login-bug.mp4` tagged with that same id — the "live" state
 * every test starts from before it removes, restores or pollutes the file.
 */
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "stc-orphan-"));
  const b = await makeBundle("2026-09-01_10-00-00", "anchors.json");
  bundle = b.dir;
  await writeFile(join(bundle, "display.mp4"), new Uint8Array(1000));
  await writeFile(join(root, "login-bug.mp4"), tagMp4(mp4Bytes(), b.id));
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("findOrphanedBundles — what Reclaim space would remove (STC-435)", () => {
  test("a bundle with a live finished file is neither offered nor blocked", async () => {
    expect(await findOrphanedBundles(env, root)).toEqual({ orphans: [], blocked: [] });
  });

  test("a bundle whose file is gone is offered at once — no age gate", async () => {
    await rm(join(root, "login-bug.mp4"));
    const { orphans, blocked } = await findOrphanedBundles(env, root);
    expect(blocked).toEqual([]);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ dir: bundle, name: "2026-09-01_10-00-00", kind: "recording" });
    // capture.json + anchors.json + display.mp4's 1000 bytes.
    expect(orphans[0]!.bytes).toBeGreaterThanOrEqual(1000);
  });

  test("it is READ-ONLY: nothing in the folder is written, moved or removed", async () => {
    await rm(join(root, "login-bug.mp4"));
    await writeFile(join(root, "holiday.jpg"), JPEG);
    const before = await snapshot(root);
    await findOrphanedBundles(env, root);
    await findOrphanedBundles(env, root);
    expect(await snapshot(root)).toEqual(before);
  });

  test("a finished file is never offered, however the bundles look", async () => {
    const { orphans } = await findOrphanedBundles(env, root);
    expect(orphans.map((o) => o.dir)).not.toContain(join(root, "login-bug.mp4"));
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(true);
  });

  test("a bundle with no capture.json is not this sweep's concern", async () => {
    await rm(join(root, "login-bug.mp4"));
    await rm(join(bundle, "capture.json"));
    expect(await findOrphanedBundles(env, root)).toEqual({ orphans: [], blocked: [] });
  });

  test("no raw/ folder at all is an empty report, not an error", async () => {
    await rm(join(root, "raw"), { recursive: true });
    expect(await findOrphanedBundles(env, root)).toEqual({ orphans: [], blocked: [] });
  });

  test("a symlinked entry under raw/ is skipped, never followed", async () => {
    const outside = await mkdtemp(join(tmpdir(), "stc-orphan-outside-"));
    try {
      // Looks exactly like a genuinely orphaned bundle — a capture.json whose
      // id matches nothing at top level — so following it would offer a
      // directory OUTSIDE this function's declared root for the Trash.
      await writeFile(join(outside, "anchors.json"), "{}");
      await writeFile(join(outside, "capture.json"),
        JSON.stringify({ version: 1, id: mintCaptureId() }));
      await symlink(outside, join(root, "raw", "not-a-real-bundle"));

      const { orphans, blocked } = await findOrphanedBundles(env, root);
      const dirs = [...orphans, ...blocked].map((b) => b.dir);
      expect(dirs).not.toContain(join(root, "raw", "not-a-real-bundle"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

/**
 * The per-kind gate. A file whose id cannot be read could be ANY bundle's
 * export — but only a bundle of its own kind: rule 1's scan (`library.ts`)
 * reads `.mp4` as a recording and an image as a still, so an untagged image
 * cannot be what a recording was exported to. Each test below is paired with
 * its control, the same untagged file blocking a bundle of ITS kind, so a gate
 * that ignored kind (blocking all, or none) fails one half of every pair.
 */
describe("an untagged file blocks only bundles of its own kind", () => {
  test("an untagged image does NOT block a recording bundle", async () => {
    await rm(join(root, "login-bug.mp4"));
    await writeFile(join(root, "Screenshot 2026-09-30.png"), new Uint8Array([0x89, 0x50]));
    await writeFile(join(root, "holiday.jpg"), JPEG);
    const { orphans, blocked } = await findOrphanedBundles(env, root);
    expect(orphans.map((o) => o.dir)).toEqual([bundle]);
    expect(blocked).toEqual([]);
  });

  test("CONTROL: an untagged .mp4 DOES block a recording bundle, and is named", async () => {
    await rm(join(root, "login-bug.mp4"));
    await writeFile(join(root, "from-a-friend.mp4"), mp4Bytes());
    const { orphans, blocked } = await findOrphanedBundles(env, root);
    expect(orphans).toEqual([]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ dir: bundle, kind: "recording", blockers: ["from-a-friend.mp4"] });
  });

  test("an untagged .mp4 does NOT block a still bundle", async () => {
    const still = await makeBundle("2026-09-02_10-00-00", "shot.json");
    await writeFile(join(root, "from-a-friend.mp4"), mp4Bytes());
    const { orphans } = await findOrphanedBundles(env, root);
    expect(orphans.map((o) => o.dir)).toEqual([still.dir]);
  });

  test("CONTROL: an untagged image DOES block a still bundle, and every blocker is named", async () => {
    const still = await makeBundle("2026-09-02_10-00-00", "shot.json");
    await writeFile(join(root, "holiday.jpg"), JPEG);
    await writeFile(join(root, "Screenshot 2026-09-30.png"), new Uint8Array([0x89, 0x50]));
    const { orphans, blocked } = await findOrphanedBundles(env, root);
    expect(orphans).toEqual([]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ dir: still.dir, kind: "still" });
    expect([...blocked[0]!.blockers].sort()).toEqual(["Screenshot 2026-09-30.png", "holiday.jpg"]);
  });

  test("a bundle of unknown kind is blocked by an untagged file of EITHER kind", async () => {
    await rm(join(root, "login-bug.mp4"));
    await rm(join(bundle, "anchors.json"));                 // no document: kind unknown
    await writeFile(join(root, "holiday.jpg"), JPEG);
    const { orphans, blocked } = await findOrphanedBundles(env, root);
    expect(orphans).toEqual([]);
    expect(blocked[0]).toMatchObject({ dir: bundle, kind: "unknown", blockers: ["holiday.jpg"] });
  });

  test("a bundle with a LIVE file is never reported as blocked", async () => {
    // The bundle's own file is right there, tagged; a stray untagged .mp4
    // beside it has nothing to say about it.
    await writeFile(join(root, "from-a-friend.mp4"), mp4Bytes());
    expect(await findOrphanedBundles(env, root)).toEqual({ orphans: [], blocked: [] });
  });

  test("the one untagged file does not hide the other kind's orphans (mixed folder)", async () => {
    await rm(join(root, "login-bug.mp4"));
    const still = await makeBundle("2026-09-02_10-00-00", "shot.json");
    await writeFile(join(root, "holiday.jpg"), JPEG);
    const { orphans, blocked } = await findOrphanedBundles(env, root);
    expect(orphans.map((o) => o.dir)).toEqual([bundle]);
    expect(blocked.map((b) => b.dir)).toEqual([still.dir]);
    // And the file it was read from is still there, untouched.
    expect(await readFile(join(root, "holiday.jpg"))).toEqual(Buffer.from(JPEG));
  });
});
