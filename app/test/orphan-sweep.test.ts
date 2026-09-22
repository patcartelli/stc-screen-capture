import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
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

  // Round-1 fix (Important 1): `sweepOrphanedBundles` never removes a
  // bundle itself — it is Electron-free and the object it is reporting is
  // the SAME kind Task 11 already removes via `shell.trashItem`. It only
  // returns the directory as DUE; `main.ts` is what actually trashes it.
  test("an orphan older than the threshold is returned as due, not deleted directly", async () => {
    await rm(join(root, "login-bug.mp4"));
    const t0 = Date.now();
    await sweepOrphanedBundles(env, root, t0);
    const due = await sweepOrphanedBundles(env, root, t0 + TEMP_TAKE_MAX_AGE_MS + 1);
    expect(due).toEqual([bundle]);
    // The sweep only decides. If it had deleted the directory itself, this
    // would fail — trashing is main.ts's job, through shell.trashItem.
    expect(existsSync(bundle)).toBe(true);
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

  test("an UNREADABLE-id file present means nothing is reported as due", async () => {
    // A JPEG still carries no id we can read, so we cannot prove any bundle is
    // orphaned while one is sitting there. Deleting the source behind a
    // perfectly good still is much worse than never reclaiming the disk.
    await rm(join(root, "login-bug.mp4"));                  // make the bundle look orphaned
    await writeFile(join(root, "holiday.jpg"), new Uint8Array([0xff, 0xd8, 0xff]));

    const t0 = Date.now();
    await sweepOrphanedBundles(env, root, t0);
    const due = await sweepOrphanedBundles(env, root, t0 + TEMP_TAKE_MAX_AGE_MS + 1);

    expect(due).toEqual([]);                                // nothing reported
    expect(existsSync(bundle)).toBe(true);                  // the bundle survives
  });

  // Round-1 fix (Critical): `Number("")` is `0`, and `0` is finite — so a
  // zero-byte or whitespace-only marker (exactly what a crash mid
  // `writeFile` leaves, since `writeFile` truncates before it writes, and a
  // full disk — the very condition this sweep exists to relieve — is the
  // likeliest cause of a truncated write) must never be read as epoch 0.
  // None of the six tests above construct a corrupt marker, so this is its
  // own regression test.
  test("a zero-byte or whitespace-only marker is a fresh sighting, never ancient", async () => {
    await rm(join(root, "login-bug.mp4"));
    // Simulate the crash directly, rather than via the sweep's own writer,
    // so this test does not depend on the writer having the same bug.
    await writeFile(join(bundle, ORPHAN_MARKER_FILE), "   ");

    const future = Date.now() + TEMP_TAKE_MAX_AGE_MS * 10;
    const due = await sweepOrphanedBundles(env, root, future);

    // The buggy version reads "" as epoch 0, so `future - 0` clears the age
    // gate immediately and the bundle comes back as due on the very next
    // sweep — this assertion is what catches that.
    expect(due).toEqual([]);
    // Treated as a FRESH sighting: the marker is rewritten with `future`,
    // not left as the unreadable value, and not deleted either.
    expect(await readFile(join(bundle, ORPHAN_MARKER_FILE), "utf8")).toBe(String(future));
  });

  // Round-1 fix (Important 2): `stat` follows a symlink; `lstat` does not.
  // A symlinked entry under `raw/` must be skipped outright, never
  // followed — reading/writing through it would touch a directory OUTSIDE
  // this function's declared root.
  test("a symlinked entry under raw/ is skipped, never followed", async () => {
    const outside = await mkdtemp(join(tmpdir(), "stc-orphan-outside-"));
    try {
      // Set up `outside` to look exactly like a genuinely orphaned bundle —
      // a capture.json whose id matches nothing at top level — so the OLD
      // (stat-following) code would have proceeded straight through to
      // writing a marker into it.
      await writeFile(join(outside, "capture.json"),
        JSON.stringify({ version: 1, id: mintCaptureId() }));
      await symlink(outside, join(root, "raw", "not-a-real-bundle"));

      await sweepOrphanedBundles(env, root, Date.now());

      expect(existsSync(join(outside, ORPHAN_MARKER_FILE))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
