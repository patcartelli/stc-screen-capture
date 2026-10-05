import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { windowCount, pageWithUrl, clickThatCloses } from "./_windows.js";
import { RAW_SUBDIR } from "../src/takes.js";

/**
 * A recording gets the floating panel (STC-487, STC-392 Phase B).
 *
 * What this settles: that a clean stop puts up the SAME panel a still gets,
 * showing a recording's card and no picture; that nothing is promoted until
 * somebody decides; that panels already on screen are hidden for the length of
 * a take and come back behind the new one; that Trash then Undo restores a
 * recording's panel; and that `thumbnail.skip` does not make a recording
 * vanish. What it CANNOT settle, and `docs/STC-487-RUNBOOK.md` owns: how the
 * card looks at the corner, and that a hidden panel is really absent from a
 * real take's first frames — this file runs against `_fake-helper.mjs`, which
 * captures nothing.
 *
 * Takes are started through `startRecordFlow`, never a bare `#record` click
 * (STC-388), and windows are counted through `_windows.ts`, never
 * `app.windows()` (STC-416).
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const POLL_MS = 15_000;

interface Launched { win: Page; recordings: string; temp: string }

async function launch(settings: Record<string, unknown> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // `saveFolder: null` leaves STC_RECORDINGS_DIR as the resolved root, so a
  // promote lands where this file looks for it. Seeded on disk, before launch:
  // `recorder:setSettings` deliberately strips `saveFolder`.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null, ...settings }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
      STC_HELPER_BIN: FAKE_HELPER, STC_OVERLAY_SYNTHETIC_INPUT: "1", STC_NO_SHUTTER: "1",
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#record");
  await withoutCountdown(win);
  return { win, recordings, temp };
}

/** Bundles actually promoted — `raw/`, not the top level (see thumbnail.e2e's `ownTakes`). */
const promoted = (recordings: string): string[] => {
  const raw = join(recordings, RAW_SUBDIR);
  return existsSync(raw) ? readdirSync(raw) : [];
};

const panelWindow = async (): Promise<Page> => {
  const page = await pageWithUrl(app!, "thumbnail.html");
  await page.waitForLoadState("domcontentloaded");
  return page;
};

/** Thumbnail windows that are VISIBLE, read from the main process — the claim is about the windows themselves. */
const visiblePanels = (): Promise<number> => app!.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows()
    .filter((w) => w.webContents.getURL().includes("thumbnail.html") && w.isVisible()).length);

/** Record, then stop, through the real flow. Resolves with the take's temp directory. */
async function recordAndStop({ win, temp }: Launched): Promise<string> {
  await startRecordFlow(app!, win);
  await expect.poll(() => readdirSync(temp).length, { timeout: POLL_MS }).toBe(1);
  const dir = join(temp, readdirSync(temp)[0]!);
  // The stand-in writes no sidecar; a real take has one, and the card reads it.
  writeFileSync(join(dir, "anchors.json"), JSON.stringify({
    version: 3, stop: { t: 42_000_000_000 },
    scope: { kind: "window", window: { id: 1, app: "Safari", bounds: { x: 0, y: 0, width: 10, height: 10 } } },
  }));
  await win.evaluate(() => (window as any).recorder.stop());
  return dir;
}

/**
 * Every test declares 240_000 as a LITERAL, because `_timeout-budget.ts` reads
 * numeric literals only. Composed floor of the worst test (the Trash/Undo one):
 * 60 s launch overhead + 45 s of `startRecordFlow`'s hidden bounds + 15 s for
 * `recordAndStop`'s own poll + six 15 s polls in the body = 210 s, under 240 s.
 */
describe("a recording gets the panel", () => {
  test("a clean stop puts up a recording card with Copy, and saves nothing", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);

    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 15_000 }).toBe(1);
    const panel = await panelWindow();
    await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className),
                       { timeout: 15_000 }).toContain("in");
    // The card, not the picture; Edit and Copy (`actionsFor`'s recording set).
    expect(await panel.isVisible("#takecard")).toBe(true);
    expect(await panel.isVisible("#thumbwrap")).toBe(false);
    expect(await panel.isVisible("#copy")).toBe(true);
    expect(await panel.isVisible("#edit")).toBe(true);
    // Duration and scope, read from the take's own anchors.json.
    expect(await panel.textContent("#takemeta")).toBe("0:42 · Safari");
    // Nobody has decided: still in temp, and nothing in the library.
    expect(existsSync(dir)).toBe(true);
    expect(promoted(l.recordings)).toEqual([]);
  }, 240_000);

  test("Save on that panel promotes it, and the panel closes", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 15_000 }).toBe(1);
    const panel = await panelWindow();
    await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className),
                       { timeout: 15_000 }).toContain("in");

    // The settle window ignores input for 300 ms after paint (SETTLE_KEYS_MS);
    // a click is not a key, so Save is live as soon as the card is.
    await clickThatCloses(panel, "#save");

    await expect.poll(() => promoted(l.recordings).length, { timeout: 15_000 }).toBe(1);
    expect(existsSync(dir)).toBe(false);
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 15_000 }).toBe(0);
  }, 240_000);

  test("a panel already on screen is hidden for the take, and comes back behind the new one", async () => {
    const l = await launch();
    // A still, so there is an older panel to hide.
    const shot = await l.win.evaluate(() => (window as any).recorder.captureStill("display"));
    expect(shot.ok).toBe(true);
    await expect.poll(() => visiblePanels(), { timeout: 15_000 }).toBe(1);
    // The other half of the same CSS: a SHOT's panel shows its picture and not
    // the recording card.
    const stillPanel = await panelWindow();
    expect(await stillPanel.isVisible("#thumbwrap")).toBe(true);
    expect(await stillPanel.isVisible("#takecard")).toBe(false);

    await startRecordFlow(app!, l.win);
    await expect.poll(() => readdirSync(l.temp).length, { timeout: 15_000 }).toBe(2);
    // Hidden while recording — not closed: its window still exists.
    await expect.poll(() => visiblePanels(), { timeout: 15_000 }).toBe(0);
    expect(await windowCount(app!, "thumbnail.html")).toBe(1);

    await l.win.evaluate(() => (window as any).recorder.stop());
    // The still is back, and the recording's panel is in front of it.
    await expect.poll(() => visiblePanels(), { timeout: 15_000 }).toBe(2);
    expect(await windowCount(app!, "thumbnail.html")).toBe(2);
  }, 240_000);

  test("Trash then Undo on a recording puts its panel back", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 15_000 }).toBe(1);
    await clickThatCloses(await panelWindow(), "#trash");
    await expect.poll(() => windowCount(app!, "toast.html"), { timeout: 15_000 }).toBe(1);
    expect(existsSync(dir)).toBe(true);   // promised, not committed

    await clickThatCloses(await pageWithUrl(app!, "toast.html"), "#undo");

    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 15_000 }).toBe(1);
    // It is a RECORDING panel again, not a still's — the undo branched on what
    // is in the directory rather than assuming shot.json.
    const panel = await panelWindow();
    await expect.poll(() => panel.isVisible("#takecard"), { timeout: 15_000 }).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, "anchors.json"), "utf8")).toContain("Safari");
  }, 240_000);

  test("thumbnail.skip does not make a recording vanish", async () => {
    const l = await launch({ thumbnail: { skip: true } });
    const dir = await recordAndStop(l);

    // A silent recording would have no outcome at all: not saved, not copied.
    await expect.poll(() => visiblePanels(), { timeout: 15_000 }).toBe(1);
    expect(existsSync(dir)).toBe(true);
    expect(promoted(l.recordings)).toEqual([]);
  }, 240_000);
});
