import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { parseShot } from "../../transform/src/shot.js";
import { REDACTION_FILL_ON_LIGHT, REDACTION_FILL_ON_DARK } from "../../transform/src/still-redact.js";
import { THUMBNAIL_FILE } from "../src/library-items.js";
import { stubQuitDialog } from "./_quit-fixture.js";
import { windowCount, hasWindow } from "./_windows.js";

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
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(extraEnv: Record<string, string> = {}):
  Promise<{ win: Page; destDir: string; recordings: string; temp: string }> {
  const { dir: recordings } = makeTakeFolder();
  const destDir = mkdtempSync(join(tmpdir(), "stc-redact-dest-"));
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on disk, never through `recorder:setSettings` — that channel
  // deliberately strips `still.destination` (STC-293 review, #92).
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    still: { destination: destDir },
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
  await panel.click("#edit");
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
    const ownRecordings = readdirSync(recordings).filter((n) => n !== "2026-08-24_10-00-00");
    expect(ownRecordings).toHaveLength(1);

    await dragBox(editor, [0.25, 0.3], [0.75, 0.65]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);

    await editor.click("#done");
    await expect.poll(() => windowCount(app!, "still-editor.html"), { timeout: 15_000 }).toBe(0);
    // Still there after the window closes — Done just closes it, it does not
    // undo anything (there is nothing left to decide; the take was kept the
    // moment Edit was clicked).
    expect(storedRegions(dir)).toHaveLength(1);
  }, 60_000);
});
