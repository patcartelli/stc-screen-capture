import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphanedBundles, ORPHAN_MARKER_FILE, TEMP_TAKE_MAX_AGE_MS } from "../src/temp-takes.js";
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

/**
 * One matched pair: a `raw/` bundle with a real `capture.json`, and a
 * top-level `login-bug.mp4` tagged with that same id — the "live" state
 * every test starts from before it removes, restores or pollutes the file.
 */
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "stc-orphan-"));
  bundle = join(root, "raw", "2026-09-01_10-00-00");
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, "anchors.json"), JSON.stringify({ version: 5 }));
  const id = mintCaptureId();
  await writeFile(join(bundle, "capture.json"), JSON.stringify({ version: 1, id }));
  await writeFile(join(root, "login-bug.mp4"), tagMp4(mp4Bytes(), id));
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("orphaned bundles are swept, aged from when they were orphaned", () => {
  test("a bundle with a live finished file is never marked", async () => {
    await sweepOrphanedBundles(env, root, Date.now());
    expect(existsSync(join(bundle, ORPHAN_MARKER_FILE))).toBe(false);
  });

  test("first sweep marks an orphan but does not delete it", async () => {
    await rm(join(root, "login-bug.mp4"));
    expect(await sweepOrphanedBundles(env, root, Date.now())).toEqual([]);
    expect(existsSync(join(bundle, ORPHAN_MARKER_FILE))).toBe(true);
    expect(existsSync(bundle)).toBe(true);
  });

  test("an orphan older than the threshold is removed", async () => {
    await rm(join(root, "login-bug.mp4"));
    const t0 = Date.now();
    await sweepOrphanedBundles(env, root, t0);
    const removed = await sweepOrphanedBundles(env, root, t0 + TEMP_TAKE_MAX_AGE_MS + 1);
    expect(removed).toHaveLength(1);
    expect(existsSync(bundle)).toBe(false);
  });

  test("a file that comes back clears the mark — a temporary move costs nothing", async () => {
    const bytes = await readFile(join(root, "login-bug.mp4"));
    await rm(join(root, "login-bug.mp4"));
    await sweepOrphanedBundles(env, root, Date.now());
    await writeFile(join(root, "login-bug.mp4"), bytes);
    await sweepOrphanedBundles(env, root, Date.now());
    expect(existsSync(join(bundle, ORPHAN_MARKER_FILE))).toBe(false);
  });

  test("a finished file is NEVER touched by the sweep", async () => {
    await sweepOrphanedBundles(env, root, Date.now() + TEMP_TAKE_MAX_AGE_MS * 10);
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(true);
  });

  test("an UNREADABLE-id file present means nothing is swept at all", async () => {
    // A JPEG still carries no id we can read, so we cannot prove any bundle is
    // orphaned while one is sitting there. Deleting the source behind a
    // perfectly good still is much worse than never reclaiming the disk.
    await rm(join(root, "login-bug.mp4"));                  // make the bundle look orphaned
    await writeFile(join(root, "holiday.jpg"), new Uint8Array([0xff, 0xd8, 0xff]));

    const t0 = Date.now();
    await sweepOrphanedBundles(env, root, t0);
    const removed = await sweepOrphanedBundles(env, root, t0 + TEMP_TAKE_MAX_AGE_MS + 1);

    expect(removed).toEqual([]);                            // nothing swept
    expect(existsSync(bundle)).toBe(true);                  // the bundle survives
  });
});
