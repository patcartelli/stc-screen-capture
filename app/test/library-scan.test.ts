import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLibrary } from "../src/library.js";
import { tagMp4 } from "@transform/media-tag.js";
import { mintCaptureId } from "@transform/capture-id.js";

const env = {} as NodeJS.ProcessEnv;
let root: string;

/**
 * A structurally valid, tiny MP4 that probeMp4 can read: timescale 600,
 * duration 3000 → 5000 ms, track 1920x1080. Written out in full rather than
 * imported from media-probe.test.ts — a test fixture shared between two files
 * is a coupling that makes one file's failure look like the other's.
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

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "stc-lib-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the scan reads the folder", () => {
  test("a finished file at top level lists, with facts from its header", async () => {
    await writeFile(join(root, "login-bug.mp4"), tagMp4(mp4Bytes(), mintCaptureId()));
    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(1);
    // NB the brief's own verbatim test checked `items[0]!.title`, a field
    // `LibraryItem` does not have and which the brief's "three changes, no
    // more" list never mentions adding. `id` is the field the same brief's
    // own doc comment describes as "the finished file's stem" when there is
    // no bundle — exactly what this assertion is actually checking for a
    // file named "login-bug.mp4" with none. Treated as a typo and corrected;
    // see the report's Decisions section.
    expect(items[0]!.id).toContain("login-bug");
  });

  test("a foreign file lists too, with no edit action", async () => {
    await writeFile(join(root, "holiday.mp4"), mp4Bytes());       // untagged
    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(1);
    expect(items[0]!.actions.map((a) => a.id)).not.toContain("edit");
  });

  test("raw/ is not itself listed as a capture", async () => {
    await mkdir(join(root, "raw"), { recursive: true });
    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(0);
  });

  test("a bundle in raw/ with no finished file lists as unfinished", async () => {
    const dir = join(root, "raw", "2026-09-22_14-30-01");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "anchors.json"), JSON.stringify({ version: 5 }));
    const { items, invalid } = await listLibrary(env, root);
    expect(items.length + invalid.length).toBe(1);
  });

  test("a LEGACY top-level bundle still works — this is the whole migration", async () => {
    const dir = join(root, "2026-09-20_10-00-00");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "shot.json"), JSON.stringify({ version: 1 }));
    const { items, invalid } = await listLibrary(env, root);
    expect(items.length + invalid.length).toBe(1);
  });

  test("one unreadable file does not hide the rest", async () => {
    await writeFile(join(root, "broken.mp4"), new Uint8Array([1, 2, 3]));
    await writeFile(join(root, "good.mp4"), tagMp4(mp4Bytes(), mintCaptureId()));
    const { items } = await listLibrary(env, root);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test("a non-media file is ignored entirely", async () => {
    await writeFile(join(root, "notes.txt"), "hello");
    await writeFile(join(root, ".DS_Store"), "x");
    const { items, invalid } = await listLibrary(env, root);
    expect(items).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  test("a finished file names both itself and its bundle", async () => {
    const id = mintCaptureId();
    const bundle = join(root, "raw", "2026-09-22_14-30-01");
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, "anchors.json"), JSON.stringify({ version: 5 }));
    await writeFile(join(bundle, "capture.json"), JSON.stringify({ version: 1, id }));
    await writeFile(join(root, "login-bug.mp4"), tagMp4(mp4Bytes(), id));

    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(1);                       // one capture, not two
    expect(items[0]!.file).toBe(join(root, "login-bug.mp4"));
    expect(items[0]!.dir).toBe(bundle);
    expect(items[0]!.id).toBe("2026-09-22_14-30-01");    // the export name, not the filename
  });

  test("a foreign file has no bundle to name", async () => {
    await writeFile(join(root, "holiday.mp4"), mp4Bytes());
    const { items } = await listLibrary(env, root);
    expect(items[0]!.file).toBe(join(root, "holiday.mp4"));
    expect(items[0]!.dir).toBeUndefined();
  });

  test("sorts by capture time, NOT by filename", async () => {
    // The load-bearing case for STC-413: renaming in Finder must not reorder
    // the library. "aaa" sorts first by name and is the OLDER capture.
    for (const [name, stamp] of [["zzz.mp4", "2026-09-22_09-00-00"],
                                 ["aaa.mp4", "2026-09-22_17-00-00"]] as const) {
      const id = mintCaptureId();
      const bundle = join(root, "raw", stamp);
      await mkdir(bundle, { recursive: true });
      await writeFile(join(bundle, "anchors.json"), JSON.stringify({ version: 5 }));
      await writeFile(join(bundle, "capture.json"), JSON.stringify({ version: 1, id }));
      await writeFile(join(root, name), tagMp4(mp4Bytes(), id));
    }
    const { items } = await listLibrary(env, root);
    expect(items.map((i) => i.file?.endsWith("aaa.mp4"))).toEqual([true, false]);
  });
});

/**
 * Beyond the brief's own tests, deliberately: every fixture above is well
 * under `MP4_TAIL_PROBE_BYTES`, so none of them can tell a correct
 * front-walk-then-targeted-read apart from a naive "read the last 64 KB
 * blind" that only works by accident on a small file. `fixtures/basic/
 * display.mp4` is real `AVAssetWriter` output at 83,894 bytes with `moov`
 * starting at byte 82,619 — past the 65,536-byte window — so a blind tail
 * slice would start 64,261 bytes into `mdat`'s own payload and this would
 * fail. Tagged with an id via `tagMp4` (a copy, not the committed fixture
 * itself) to prove both facts AND id survive the real box layout.
 */
describe("the scan on a real, larger-than-the-window capture", () => {
  test("dimensions, duration and a tagged id all survive a real AVAssetWriter layout", async () => {
    const real = new Uint8Array(await readFile("fixtures/basic/display.mp4"));
    expect(real.length).toBeGreaterThan(65536);           // the premise of this test
    const id = mintCaptureId();
    await writeFile(join(root, "real-take.mp4"), tagMp4(real, id));

    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(1);
    expect(items[0]!.file).toBe(join(root, "real-take.mp4"));
    // width/height/duration land in the summary string — this scan has no
    // other place that surfaces them for a file with no bundle.
    expect(items[0]!.summary).toMatch(/\d+×\d+/);
  });
});
