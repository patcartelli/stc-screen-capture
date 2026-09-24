import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { parseShot } from "../../transform/src/shot.js";
import { REDACTION_FILL_ON_LIGHT, REDACTION_FILL_ON_DARK } from "../../transform/src/still-redact.js";
import { THUMBNAIL_FILE } from "../src/library-items.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { windowCount, hasWindow, clickThatCloses } from "./_windows.js";
import { RAW_SUBDIR } from "../src/takes.js";
import { keptFileRequests } from "./_still-log.js";

/**
 * Redaction, end to end (STC-297, moved into its own still editor by
 * STC-300).
 *
 * The arithmetic — what a drag means, which colour a fill takes — is
 * `transform/test/still-redact.test.ts`, with no pointer and no canvas. That
 * an exported PNG genuinely contains no trace of what was covered is
 * `helper/test/still-encode.test.ts`, which decodes the encoded file. What is
 * left for this file is the WIRING those two cannot see: that a real drag on
 * a real still-editor window becomes a region, that Undo takes one back, and
 * that the regions reach `shot.json` on disk — which is the whole of
 * "redaction survives an app restart", since that document IS the still.
 *
 * Redact used to be a mode of the post-capture PANEL, resized in place
 * (`REDACT_SIZE`) — this file drove `#redact`/`#mode`/`#undo` directly on
 * that window. STC-300 moved the whole interaction to a dedicated,
 * real-window editor reached through Edit; `Edit promotes first`
 * (`panel:edit`'s own doc), so every test here opens the editor on an
 * ALREADY-promoted take rather than one still in temp storage. Two tests the
 * old file had no longer apply and are not replaced: "Save persists the
 * chosen Style" (there is no Style picker anywhere any more — it was removed
 * as redundant, not moved), and "a swipe on the panel's chrome does not
 * discard while redacting" (the still editor is an ordinary window with no
 * swipe-to-discard gesture at all, so that class of bug cannot recur here).
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(extraEnv: Record<string, string> = {}):
  Promise<{ win: Page; destDir: string; recordings: string; temp: string }> {
  const { dir: recordings } = makeTakeFolder();
  // A folder nothing is ever configured to write to. STC-412 unified
  // `saveFolder` to govern BOTH stills and recordings — `panel:save`'s
  // promote included — so seeding `destDir` here as the ACTIVE saveFolder
  // would divert a promoted take away from `recordings`, which is what
  // "the stored regions reach the promoted take" and the Style test below
  // assert against. `saveFolder: null` leaves `STC_RECORDINGS_DIR`
  // (`recordings`) as the resolved root, matching those assertions;
  // `destDir` is unused, kept only for interface-shape parity with the
  // other fixtures in this file's family.
  const destDir = mkdtempSync(join(tmpdir(), "stc-redact-dest-"));
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on disk, never through `recorder:setSettings` — that channel
  // deliberately strips `saveFolder` (STC-293 review, #92 — `saveFolder`
  // replaced `still.destination` at STC-412).
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    saveFolder: null,
  }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp, STC_HELPER_BIN: FAKE_HELPER,
      STC_NO_SHUTTER: "1", ...extraEnv,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  return { win, destDir, recordings, temp };
}

async function thumbnailWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) if (p.url().includes("thumbnail.html")) return p;
    if (Date.now() - start > ms) {
      throw new Error(`no thumbnail window appeared within ${ms}ms; windows: `
        + JSON.stringify(app!.windows().map((p) => p.url())));
    }
    await sleep(50);
  }
}

/** The still editor window, once it is up. */
async function stillEditorWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) if (p.url().includes("still-editor.html")) return p;
    if (Date.now() - start > ms) {
      throw new Error(`no still editor window appeared within ${ms}ms; windows: `
        + JSON.stringify(app!.windows().map((p) => p.url())));
    }
    await sleep(50);
  }
}

/** The regions the stored document actually carries, through the real loader. */
const storedRegions = (dir: string) =>
  parseShot(JSON.parse(readFileSync(join(dir, "shot.json"), "utf8"))).decoration.redactions;

/**
 * The stage canvas's box, once it has stopped moving.
 *
 * The editor draws asynchronously after fetching the frame, so a box read
 * immediately after the window appears can be the pre-layout one. Two
 * consecutive identical reads, then drag — the same reasoning the old
 * panel-based version of this file used for its own (window-resize-driven)
 * settling race.
 */
async function settledCanvasBox(editor: Page, ms = 10_000):
  Promise<{ x: number; y: number; width: number; height: number }> {
  const read = async () => editor.locator("#stagecanvas").boundingBox();
  const start = Date.now();
  let last = await read();
  for (;;) {
    await sleep(120);
    const now = await read();
    if (last && now && now.x === last.x && now.y === last.y
        && now.width === last.width && now.height === last.height && now.width > 0) {
      return now;
    }
    if (Date.now() - start > ms) {
      throw new Error(`the stage canvas never settled: ${JSON.stringify({ last, now })}`);
    }
    last = now;
  }
}

/**
 * A capture, its panel, Edit clicked, and the still editor it opens.
 *
 * `Edit promotes first` (`panel:edit`'s own doc) — by the time the editor's
 * window exists, the take is already out of temp storage and the panel is
 * already gone, so this returns the PROMOTED directory, read from the
 * editor's own query string rather than the capture's original (now stale)
 * temp path.
 */
async function redactingEditor(win: Page): Promise<{ editor: Page; dir: string }> {
  const r = await win.evaluate(() => (window as any).recorder.captureStill("display"));
  expect(r.ok).toBe(true);
  const panel = await thumbnailWindow();
  await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
    .toContain("in");
  await clickThatCloses(panel, "#edit");
  const editor = await stillEditorWindow();
  await editor.waitForSelector("#stagecanvas");
  const dir = await editor.evaluate(() => new URLSearchParams(location.search).get("dir")!);
  return { editor, dir };
}

const HEX_FILLS = [REDACTION_FILL_ON_LIGHT, REDACTION_FILL_ON_DARK].map((hex) => ({
  r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16),
}));

/**
 * The pixel at a fraction of the stage canvas's OWN bitmap — its intrinsic
 * `width`/`height`, not its on-screen CSS box, so this needs no DPI or layout
 * conversion the way a real pointer coordinate does.
 */
async function canvasPixel(editor: Page, fx: number, fy: number): Promise<{ r: number; g: number; b: number }> {
  return editor.evaluate(({ fx, fy }) => {
    const canvas = document.getElementById("stagecanvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(
      Math.floor(fx * canvas.width), Math.floor(fy * canvas.height), 1, 1).data;
    return { r: data[0]!, g: data[1]!, b: data[2]! };
  }, { fx, fy });
}

/** Whether a sampled pixel is (near enough) one of the two solid redaction fills — the VISUAL half of "a drag becomes a region", which reading `shot.json` alone cannot see. */
function isRedactionFill(px: { r: number; g: number; b: number }): boolean {
  return HEX_FILLS.some((f) => Math.abs(px.r - f.r) <= 4 && Math.abs(px.g - f.g) <= 4 && Math.abs(px.b - f.b) <= 4);
}

/**
 * Drag a box across the middle of the stage, as a person would.
 *
 * Fractions of the canvas rather than pixels: the editor sizes its canvas to
 * the shot and the window, so a fixed pixel box would fall outside it for a
 * differently shaped capture or window size.
 */
async function dragBox(editor: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await settledCanvasBox(editor);
  const at = ([fx, fy]: [number, number]) =>
    ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const a = at(from), b = at(to);
  await editor.mouse.move(a.x, a.y);
  await editor.mouse.down();
  // Two moves, not one: a single move can be coalesced with the press, and
  // this is testing that a DRAG is followed rather than that a click lands.
  await editor.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await editor.mouse.move(b.x, b.y);
  await editor.mouse.up();
}

describe("redaction", () => {
  test("Edit opens a still editor, and a drag becomes a stored region", async () => {
    const { win } = await launch();
    const { editor, dir } = await redactingEditor(win);
    expect(storedRegions(dir)).toHaveLength(0);
    // Before the drag: whatever the capture actually looks like there, which
    // is not a redaction fill (the fixture is a real screenshot, not a
    // pre-filled solid block).
    expect(isRedactionFill(await canvasPixel(editor, 0.5, 0.475))).toBe(false);

    await dragBox(editor, [0.3, 0.35], [0.7, 0.6]);

    // Polled, not read once: the write is a round trip to main and back, and
    // asserting immediately would be asserting on the moment before it.
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    const [region] = storedRegions(dir);
    // Normalised and inside the capture — the schema's own rule, and what
    // makes a region survive a change of crop, padding or output scale.
    expect(region!.x).toBeGreaterThanOrEqual(0);
    expect(region!.y).toBeGreaterThanOrEqual(0);
    expect(region!.width).toBeGreaterThan(0);
    expect(region!.height).toBeGreaterThan(0);
    expect(region!.x + region!.width).toBeLessThanOrEqual(1);
    expect(region!.y + region!.height).toBeLessThanOrEqual(1);
    // The VISUAL half — `shot.json` gaining a region is not the same claim as
    // a fill actually being drawn. `layoutStill` positions a shot's
    // redaction rects from `shot.decoration.redactions`, so this is exactly
    // the check that would have caught the box the editor stored but never
    // drew: reading only the stored regions could not tell "drawn" from
    // "recorded and silently dropped on the way to the canvas" apart.
    await expect.poll(async () => isRedactionFill(await canvasPixel(editor, 0.5, 0.475)),
                       { timeout: 15_000 }).toBe(true);
  }, 60_000);

  test("a second box adds rather than replaces, and Undo takes back the last one", async () => {
    const { win } = await launch();
    const { editor, dir } = await redactingEditor(win);

    await dragBox(editor, [0.1, 0.1], [0.4, 0.3]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    const first = storedRegions(dir)[0]!;

    await dragBox(editor, [0.55, 0.55], [0.9, 0.8]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(2);

    await editor.click("#undo");
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    // The one that survived is the FIRST — undo is last-in-first-out, not
    // "clear everything and hope".
    expect(storedRegions(dir)[0]).toEqual(first);
  }, 60_000);

  test("editing the regions drops the library's cached thumbnail (STC-294)", async () => {
    const { win } = await launch();
    const { editor, dir } = await redactingEditor(win);
    // A cached picture, as the library grid would have left behind. It was
    // rendered from the decoration that is about to change, so leaving it
    // would show the grid a shot that no longer exists.
    writeFileSync(join(dir, THUMBNAIL_FILE), Buffer.alloc(64));
    expect(existsSync(join(dir, THUMBNAIL_FILE))).toBe(true);

    await dragBox(editor, [0.3, 0.35], [0.7, 0.6]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    // Dropped by the same handler that wrote the regions, so the two cannot
    // disagree about what this shot looks like.
    await expect.poll(() => existsSync(join(dir, THUMBNAIL_FILE)),
                      { timeout: 15_000 }).toBe(false);
  }, 60_000);

  test("a click is not a region", async () => {
    const { win } = await launch();
    const { editor, dir } = await redactingEditor(win);
    const box = await settledCanvasBox(editor);
    await editor.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await editor.mouse.down();
    await editor.mouse.up();
    // Nothing to poll FOR here, so this waits out the round trip a real region
    // would have taken and then asserts nothing arrived.
    await sleep(1500);
    expect(storedRegions(dir)).toHaveLength(0);
  }, 60_000);

  test("Edit promotes before the editor opens, and Done does not undo a persisted region", async () => {
    const { win, recordings, temp } = await launch();
    const { editor, dir } = await redactingEditor(win);
    // Already promoted — not still in temp storage — and the panel that
    // opened this editor is already gone (`panel:edit` dismisses it before
    // returning).
    expect(dir.startsWith(recordings)).toBe(true);
    expect(readdirSync(temp).length).toBe(0);
    expect(await hasWindow(app!, "thumbnail.html")).toBe(false);
    // The promoted bundle lands in `raw/` now (STC-413) — filtering the seed
    // fixture out of the TOP level would still read `1` regardless of how
    // many bundles actually promoted, since they all nest under one `raw/`
    // entry there. `raw/`'s own contents are what actually discriminates.
    expect(readdirSync(join(recordings, RAW_SUBDIR))).toHaveLength(1);

    await dragBox(editor, [0.25, 0.3], [0.75, 0.65]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);

    await clickThatCloses(editor, "#done");
    await expect.poll(() => windowCount(app!, "still-editor.html"), { timeout: 15_000 }).toBe(0);
    // Still there after the window closes — Done just closes it, it does not
    // undo anything (there is nothing left to decide; the take was kept the
    // moment Edit was clicked).
    expect(storedRegions(dir)).toHaveLength(1);
  }, 60_000);

  /**
   * STC-446: the editor can produce the deliverable.
   *
   * This window is the ONLY door to a still already in the library — a
   * library Open comes straight here (`main.ts`'s `still:reopen`) and the
   * tile offers no export — so until Save existed, a kept still could never
   * leave the app. Measured on a real folder before the fix: three top-level
   * `.mp4` and zero `.png`.
   *
   * Asserted off the helper's own request log rather than off a folder, for
   * the reason `_still-log.ts` records: the panel writes a drag-out file into
   * the clipboard cache the moment it paints, so "a file appeared" is not the
   * same claim as "a file anybody kept". `keptFileRequests` filters that one
   * out.
   */
  test("the editor's Save writes the finished file, at the top level (STC-446)", async () => {
    const stillLog = join(mkdtempSync(join(tmpdir(), "stc-still-log-")), "requests.jsonl");
    const { win, recordings } = await launch({ STC_FAKE_STILL_LOG: stillLog });
    const { editor, dir } = await redactingEditor(win);

    // Nothing kept yet — Edit promotes the bundle but writes no file. The
    // control for the assertion below: without it, a drag-out file leaking
    // past the cache filter would make this test pass on its own.
    expect(keptFileRequests(stillLog)).toEqual([]);

    // A region first, so the file written is demonstrably the DECORATED
    // composite rather than the raw frame copied through.
    await dragBox(editor, [0.25, 0.3], [0.75, 0.65]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);

    await editor.click("#save");
    await expect.poll(() => keptFileRequests(stillLog).length, { timeout: 15_000 }).toBe(1);

    const kept = keptFileRequests(stillLog)[0];
    // Into the save folder's TOP LEVEL. `raw/` is source material under
    // STC-413, and a deliverable written in there would be invisible to the
    // user and would sit beside the frame it was rendered from.
    expect(kept.file.startsWith(join(recordings, RAW_SUBDIR)),
           `wrote into raw/: ${kept.file}`).toBe(false);
    expect(kept.file.startsWith(recordings), `wrote outside the save folder: ${kept.file}`).toBe(true);

    // At the CAPTURE's resolution, not the window's. The editor draws a
    // full-size composite and then fits a VIEW canvas to whatever size the
    // window happens to be; exporting the view would make how you had the
    // window sized decide what comes out — STC-318's "a way of looking must
    // not change what comes out", in a second window.
    //
    // The numbers discriminate, which is the whole reason they are here:
    // `_fake-helper.mjs` declares a 480x270 crop at 2x, so the frame is
    // 960x540, while the editor window is 900x700 and its stage fits the
    // view canvas to ~868 wide. Export the view instead of the composite and
    // this reads 868, not 960. (Written the other way round first, against a
    // guessed 1280x720 capture — the run said 960x540 and the fixture, not
    // the code, was what I had wrong.)
    expect(kept.width, `wrote ${kept.width}x${kept.height}`).toBeGreaterThanOrEqual(960);
    expect(kept.height, `wrote ${kept.width}x${kept.height}`).toBeGreaterThanOrEqual(540);

    // The window stays open — Save produces a file, it is not a way out.
    // Done is still the only thing that closes this editor.
    expect(await windowCount(app!, "still-editor.html")).toBe(1);
  }, 60_000);
});
