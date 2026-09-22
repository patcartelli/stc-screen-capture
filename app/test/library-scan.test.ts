import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLibrary, listTakes } from "../src/library.js";
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
    // A real (non-empty) display.mp4 is what makes this a HEALTHY bundle —
    // without one, `readRecording` fails and the item degrades to the
    // matched-but-broken `looseFileItem` shape, which carries no `label` at
    // all (a different code path than the one the label assertion below is
    // actually about; found the hard way, chasing why that assertion kept
    // reading `undefined` against a correct fix).
    await writeFile(join(bundle, "display.mp4"), new Uint8Array([1, 2, 3, 4]));
    await writeFile(join(root, "login-bug.mp4"), tagMp4(mp4Bytes(), id));

    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(1);                       // one capture, not two
    expect(items[0]!.file).toBe(join(root, "login-bug.mp4"));
    expect(items[0]!.dir).toBe(bundle);
    expect(items[0]!.id).toBe("2026-09-22_14-30-01");    // the export name, not the filename
    // Task 13 fix round 1: a matched item's LABEL is the file's own stem —
    // the tile's title falls back to `id` (the bundle's immune stamp) when
    // `label` is unset, so a matched item with no label would render the
    // OLD stamp forever after a rename that correctly renamed the file.
    expect(items[0]!.label).toBe("login-bug");
  });

  /**
   * Task 13 fix round 1: the reviewer's own repro. A matched item must show
   * the FILE's current name, never a stale `take.json` label left over from
   * before the take was ever matched (or from before this ticket existed at
   * all) — `library.ts` clears the sidecar-sourced label on a match for
   * exactly this reason, and DERIVES the display label from the file
   * instead, rather than leaving it unset.
   */
  test("a matched item's label is the file's name, never a stale take.json label", async () => {
    const id = mintCaptureId();
    const bundle = join(root, "raw", "2026-09-22_14-30-01");
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, "anchors.json"), JSON.stringify({ version: 5 }));
    await writeFile(join(bundle, "capture.json"), JSON.stringify({ version: 1, id }));
    await writeFile(join(bundle, "display.mp4"), new Uint8Array([1, 2, 3, 4]));  // a HEALTHY bundle — see above
    // A label from BEFORE this take was ever matched (or from before
    // STC-413 existed) — `take.json` is the OLD mechanism and must not be
    // consulted for a finished capture any more.
    await writeFile(join(bundle, "take.json"),
      JSON.stringify({ version: 1, label: "a stale label from long ago" }));
    await writeFile(join(root, "renamed-clip.mp4"), tagMp4(mp4Bytes(), id));

    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("renamed-clip");
    expect(items[0]!.label).not.toContain("stale");
  });

  test("a foreign file has no bundle to name", async () => {
    await writeFile(join(root, "holiday.mp4"), mp4Bytes());
    const { items } = await listLibrary(env, root);
    expect(items[0]!.file).toBe(join(root, "holiday.mp4"));
    expect(items[0]!.dir).toBeUndefined();
  });

  test("sorts by capture time, NOT by filename", async () => {
    // The load-bearing case for STC-413: renaming in Finder must not reorder
    // the library.
    //
    // The stamps are deliberately OPPOSED to the filenames: `zzz` is the
    // NEWER capture and must sort first, even though its name sorts last.
    // An earlier version of this fixture had them the other way round and was
    // VACUOUS — it passed under the old id-based comparator AND under a
    // filename-ascending one, because a matched pair's `id` is its BUNDLE's
    // stamp rather than its filename, so every ordering agreed. If you change
    // these stamps, re-check that the test can still fail.
    for (const [name, stamp] of [["zzz.mp4", "2026-09-22_17-00-00"],
                                 ["aaa.mp4", "2026-09-22_09-00-00"]] as const) {
      const id = mintCaptureId();
      const bundle = join(root, "raw", stamp);
      await mkdir(bundle, { recursive: true });
      await writeFile(join(bundle, "anchors.json"), JSON.stringify({ version: 5 }));
      await writeFile(join(bundle, "capture.json"), JSON.stringify({ version: 1, id }));
      await writeFile(join(root, name), tagMp4(mp4Bytes(), id));
    }
    // A LOOSE file too, and it is what makes this test discriminate at all.
    // Two matched pairs cannot: a matched item's `id` IS its bundle's stamp
    // and its `createdAt` is `stampToMs` of that same stamp, so id-descending
    // and createdAt-descending are mathematically identical for them. Only an
    // UNMATCHED item's id (the file's stem) can diverge from its createdAt.
    // "mmm" sorts above both stamps under the old id comparator, and belongs
    // in the middle by time.
    const loose = join(root, "mmm.mp4");
    await writeFile(loose, mp4Bytes());                        // no id, no bundle
    // Built from LOCAL components, not a UTC ISO string — matching
    // `stampToMs`'s own convention (which mirrors `takes.ts`'s `stamp()`,
    // itself built from `getHours()`/`getMinutes()` etc., not `getUTCHours()`).
    // A UTC string here would drift against the bundles' LOCAL-parsed 09:00/
    // 17:00 stamps by the runner's own offset: verified directly on this
    // machine (America/New_York, UTC-4 in September) that
    // `new Date("2026-09-22T12:00:00Z")` is 08:00 LOCAL — before the "09:00"
    // stamp, not between it and "17:00" as intended, which failed this exact
    // test the first time it was run. `new Date(y, m, d, h, mi, s)` is
    // timezone-proof by construction: it IS local time, on every machine.
    const noon = new Date(2026, 8, 22, 12, 0, 0);
    await utimes(loose, noon, noon);

    const { items } = await listLibrary(env, root);
    // By capture time: zzz (17:00), mmm (12:00), aaa (09:00).
    // The OLD id comparator would give: mmm, zzz, aaa — "mmm" outranks both
    // "2026-…" stems. Anything filename-driven gives: zzz, mmm, aaa reversed
    // or scrambled. Only createdAt-descending produces this exact list.
    expect(items.map((i) => i.file?.split("/").pop())).toEqual(
      ["zzz.mp4", "mmm.mp4", "aaa.mp4"]);
  });

  test("a matched bundle that fails to parse is listed AND reported", async () => {
    // Both, not either. The file plays, so its tile belongs in the grid — but
    // `library.ts`'s own header rule is that a broken take is REPORTED, never
    // silently skipped, because "a take that quietly vanishes from the list is
    // indistinguishable from one that was deleted". Suppressing the report
    // also drops it out of `listTakes` entirely, which is the recordings-only
    // view the editor uses.
    const id = mintCaptureId();
    const bundle = join(root, "raw", "2026-09-22_14-30-01");
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, "anchors.json"), JSON.stringify({ version: 5 }));
    await writeFile(join(bundle, "capture.json"), JSON.stringify({ version: 1, id }));
    // No display.mp4 — readRecording will fail.
    await writeFile(join(root, "login-bug.mp4"), tagMp4(mp4Bytes(), id));

    const { items, invalid } = await listLibrary(env, root);
    expect(items).toHaveLength(1);                       // the file still plays
    expect(invalid).toHaveLength(1);                     // and the corruption is visible
    expect(invalid[0]!.dir).toBe(bundle);
  });

  test("an exported bundle whose file cannot be linked is shown, not called broken", async () => {
    // `capture.json` is minted AT EXPORT, so its presence PROVES this bundle
    // was exported — even though nothing here carries its id back (a JPEG or
    // HEIC still, which ImageIO tags only in the PNG dictionary; or a file
    // moved out of the folder entirely). Three properties at once, because
    // this sits one `else if` away from regressing into either `invalid`
    // (which would call an exported capture broken) or `takes` (which would
    // break the "only fully-read bundles" invariant).
    const bundle = join(root, "raw", "2026-09-22_14-30-01");
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, "anchors.json"), JSON.stringify({ version: 5 }));
    await writeFile(join(bundle, "capture.json"),
                    JSON.stringify({ version: 1, id: mintCaptureId() }));
    // No display.mp4, and no top-level file carrying that id.

    const { items, invalid } = await listLibrary(env, root);
    expect(items).toHaveLength(1);                       // visible
    expect(items[0]!.file).toBeUndefined();              // with no file to open
    expect(items[0]!.actions.map((a) => a.id)).not.toContain("open");
    expect(invalid).toHaveLength(0);                     // NOT broken — it was exported

    const { takes } = await listTakes(env, root);
    expect(takes).toHaveLength(0);                       // and not playable either
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
 *
 * **What this does NOT cover** — and the distinction is worth stating, since
 * this block's old title ("a real, larger-than-the-window capture") reads as
 * if it did: the FILE is larger than the window, `moov` itself is 1,275
 * bytes. That is the multi-hop walk PAST `mdat`. The separate case of `moov`
 * itself exceeding the window is C2, below.
 */
describe("the scan walks past a large mdat to reach moov", () => {
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

/**
 * STC-413 C2: `moov` ITSELF bigger than the read window.
 *
 * Not a hypothetical shape. `moov` grows with the SAMPLE COUNT — `stts`,
 * `stsz`, `stco` and `ctts` are one entry per sample — measured on this
 * repo's own fixtures at 14.2 B/sample (`fixtures/basic/display.mp4`) and
 * 11.2 B/sample (`fixtures/pip/camera.mp4`). So `moov` passes
 * `MP4_TAIL_PROBE_BYTES`'s 64 KB somewhere around 4,600-5,800 samples, which
 * at 60 fps is **80 to 95 seconds**. An ordinary take.
 *
 * `locateMoovBytes` used to re-cap that second, targeted read at the same
 * 64 KB, so it handed `mp4BoxesIn` a PREFIX of `moov` — which correctly
 * refuses a box declaring more bytes than it was given, yielding neither
 * facts nor an id. Downstream: two tiles for one capture, a re-export
 * refused with "it belongs to a different capture" about the user's own
 * file, and `share:publish` reporting an exported take as never exported.
 *
 * The padding is a `free` box inside `moov`, which is structurally valid and
 * which `probeMp4`'s own child walk skips — the point is `moov`'s declared
 * SIZE, not what fills it.
 */
describe("the scan on a capture whose moov alone exceeds the read window", () => {
  /** `mp4Bytes`, with `moov` grown past `padTo` bytes by a `free` child. */
  function bigMoovMp4(padTo: number): Uint8Array {
    const mvhd = box("mvhd", [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(600), ...be32(3000)]);
    const tkhd = box("tkhd", [
      0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(1), ...be32(0), ...be32(0),
      ...new Array(8).fill(0), 0, 0, 0, 0, 0, 0, 0, 0,
      ...new Array(36).fill(0),
      ...be32(1920 * 65536), ...be32(1080 * 65536),
    ]);
    const moovBody = [...mvhd, ...box("trak", tkhd),
                      ...box("free", new Array(padTo).fill(0))];
    return new Uint8Array([...box("ftyp", chars("isom")), ...box("mdat", [1, 2, 3, 4]),
      ...box("moov", moovBody)]);
  }

  test("a moov of 96 KB still yields its facts AND its embedded id", async () => {
    const id = mintCaptureId();
    const bytes = tagMp4(bigMoovMp4(96 * 1024), id);
    // The premise, asserted rather than assumed: without this the test could
    // silently become another under-the-window case and pass for free.
    const moovAt = Buffer.from(bytes).indexOf(Buffer.from("moov", "latin1")) - 4;
    const moovSize = Buffer.from(bytes).readUInt32BE(moovAt);
    expect(moovSize, "moov's own declared size").toBeGreaterThan(65536);

    await writeFile(join(root, "long-take.mp4"), bytes);
    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(1);
    expect(items[0]!.summary, "facts read out of an oversized moov").toMatch(/1920×1080/);

    // The id is the half with the visible consequences: without it the bundle
    // below matches nothing and the capture lists TWICE.
    const bundle = join(root, "raw", "2026-09-22_10-00-00");
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, "anchors.json"), JSON.stringify({ version: 5 }));
    await writeFile(join(bundle, "display.mp4"), "x");
    await writeFile(join(bundle, "capture.json"), JSON.stringify({ version: 1, id }));

    const matched = await listLibrary(env, root);
    expect(matched.items, "one capture, not one tile per half").toHaveLength(1);
    expect(matched.items[0]!.file).toBe(join(root, "long-take.mp4"));
  });
});

/**
 * A GROSS-REGRESSION BACKSTOP, deliberately not a tight budget.
 *
 * This runs in the normal suite, and a tight timing assertion there reddens
 * PRs at random under load — which this repo has already paid for once
 * (`ring-overflow.slow.test.ts` was taken out of CI for exactly that, on the
 * rule that "a test that reddens PRs at random is worse than one that does
 * not run"). So the number below is the measured figure with a LARGE multiple
 * on top: it catches a scan that became quadratic, and deliberately does NOT
 * catch a 2x slowdown. The printed value is the real signal; a human reading
 * it is the instrument.
 *
 * Measured on: pcartelli's Mac (Darwin 27.0.0 / macOS 27.0, arm64), 2026-09-22,
 * this worktree, `npx vitest run app/test/library-scan.test.ts -t "500 files"`
 * — 500 tagged 300-byte fixture MP4s, real filesystem (mkdtemp under the OS
 * tmpdir): consistently 41-42 ms total, ~0.08 ms/file over three runs. 10x
 * that is ~420 ms; set to 450 ms for a little extra headroom.
 *
 * What this DOES NOT cover: the fixture's files are a few hundred bytes, so
 * each "64 KB tail read" is really reading a whole tiny file in one shot.
 * Against 500 real 4K exports the same scan does ~32 MB of scattered IO on
 * top of this — this pins per-file OVERHEAD (`readdir`, open, header parse,
 * id extract), not IO throughput. The IO half needs a real folder of real
 * exports on a Mac; see `docs/STC-413-RUNBOOK.md`.
 */
const SCAN_BACKSTOP_MS = 450;

test("500 files scan without going quadratic", async () => {
  for (let i = 0; i < 500; i++) {
    await writeFile(join(root, `take-${String(i).padStart(3, "0")}.mp4`),
                    tagMp4(mp4Bytes(), mintCaptureId()));
  }
  const t0 = performance.now();
  const { items } = await listLibrary(env, root);
  const ms = performance.now() - t0;
  process.stderr.write(`500-file scan: ${Math.round(ms)} ms ` +
                       `(${(ms / 500).toFixed(2)} ms/file)\n`);
  expect(items).toHaveLength(500);
  expect(ms).toBeLessThan(SCAN_BACKSTOP_MS);
}, 120_000);
