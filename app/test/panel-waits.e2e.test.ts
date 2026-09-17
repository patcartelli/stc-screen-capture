import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * The contract STC-392 reverses, end to end.
 *
 * `thumbnail.e2e.test.ts` used to assert that ignoring the panel WROTE the
 * shot — "there is no path where a capture is silently lost" was STC-296's
 * acceptance criterion and a timeout was how it was kept. STC-392 keeps the
 * same promise a different way: ignoring the panel writes nothing, because
 * the panel is still there and the take is still in temp storage where
 * STC-393's crash recovery will find it.
 *
 * This is a NEW file rather than an edit, because it is a different claim
 * about the same pixels and the two should be readable side by side.
 *
 * It has also become the home for the two other properties that only show up
 * with a real window and a real clock: Copy no longer promotes (D5) and the
 * ⌘⌫ trash key is gated behind the same settle window every other keyboard
 * accelerator is (focus rule 4).
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Long enough that a timeout would certainly have fired.
 *
 * The old floor was 3 s and the old default 6 s; waiting 8 s means a
 * re-introduced clock at either value is caught rather than raced. The test's
 * own vitest timeout must exceed this — see the rule this repo learned in
 * `bc9faaf`.
 */
const LONGER_THAN_ANY_OLD_TIMEOUT_MS = 8_000;

interface PanelLaunch {
  win: Page;
  app: ElectronApplication;
  temp: string;
  recordings: string;
  destDir: string;
}

/**
 * Launch the app and produce one capture, so a panel is up before the test
 * body starts.
 *
 * The ONE fixture every test in this file uses (STC-392 review: three copies
 * of the same launch dance is the defect this repo names five ways) — Copy,
 * Save and the keyboard settle-window tests all need the identical setup, so
 * they share it rather than each restating `electron.launch`.
 */
async function launchWithPanel(): Promise<PanelLaunch> {
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const destDir = mkdtempSync(join(tmpdir(), "stc-thumb-dest-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  writeFileSync(join(userData, "settings.json"),
                JSON.stringify({ still: { destination: destDir } }));

  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
      STC_HELPER_BIN: FAKE_HELPER, STC_NO_SHUTTER: "1",
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  // NOT a click on the button: `#capturestill` opens the SELECTION overlay
  // (region mode) and needs a driven drag to ever produce a capture — see
  // `still-overlay.e2e.test.ts`'s `STC_OVERLAY_SYNTHETIC_INPUT` dance. This
  // file is about the panel, not the overlay, so it reaches the same
  // `display` capture every other thumbnail/nothing-lost e2e test uses.
  const r = await win.evaluate(() => (window as any).recorder.captureStill("display"));
  if (!r.ok) throw new Error(`captureStill failed: ${JSON.stringify(r)}`);

  await expect.poll(() => app!.windows().filter((p) => p.url().includes("thumbnail.html")).length,
                     { timeout: 15_000 }).toBe(1);
  return { win, app, temp, recordings, destDir };
}

/** The panel window for the take `launchWithPanel` just captured. */
function panelWindow(app: ElectronApplication): Page {
  return app.windows().find((p) => p.url().includes("thumbnail.html"))!;
}

describe("the panel waits (STC-392)", () => {
  test("left alone, the panel is still there and the take is still in temp", async () => {
    const { app: electronApp, temp, recordings, destDir } = await launchWithPanel();

    // The panel is up (`launchWithPanel` already waited for it).
    let panels = electronApp.windows().filter((p) => p.url().includes("thumbnail.html"));
    expect(panels.length).toBe(1);

    await sleep(LONGER_THAN_ANY_OLD_TIMEOUT_MS);

    // Still up — this is the assertion the whole ticket is about.
    panels = electronApp.windows().filter((p) => p.url().includes("thumbnail.html"));
    expect(panels.length).toBe(1);
    // And nothing was written anywhere, because nothing was decided.
    expect(readdirSync(destDir)).toEqual([]);
    // The take is exactly where STC-393 put it.
    expect(readdirSync(temp).length).toBe(1);
    // `makeTakeFolder()` seeds `recordings` with its own fixture take so the
    // app has something to show at boot (the same reasoning every other file
    // using it states); filtered out here so this only names what THIS
    // capture would have promoted, which is nothing.
    expect(readdirSync(recordings).filter((n) => !n.startsWith(".") && n !== "2026-08-24_10-00-00"))
      .toEqual([]);
  }, 40_000);

  test("Copy does not promote — the take is still in temp afterwards", async () => {
    // STC-393's runbook flagged exactly this: every `still:export` used to
    // promote, which was right when Copy was terminal. Under "Copy stays
    // open; you may still Save — or Trash", a Copy that promoted would leave
    // a Trash pressed afterwards deleting something already in the library.
    const { app: electronApp, temp, recordings } = await launchWithPanel();
    const panel = panelWindow(electronApp);
    await panel.click("#copy");
    await panel.waitForFunction(() => document.getElementById("status")!.textContent === "Copied");

    expect(readdirSync(temp).length).toBe(1);
    expect(readdirSync(recordings).filter((n) => !n.startsWith(".") && n !== "2026-08-24_10-00-00"))
      .toEqual([]);
    // And the panel is still up — the other half of the same rule.
    expect(electronApp.windows().some((p) => p.url().includes("thumbnail.html"))).toBe(true);
  }, 40_000);

  test("Save promotes, and closes the panel", async () => {
    const { app: electronApp, temp, recordings } = await launchWithPanel();
    const panel = panelWindow(electronApp);
    await panel.click("#save");
    await expect.poll(() => electronApp.windows().filter((p) => p.url().includes("thumbnail.html")).length,
                       { timeout: 15_000 }).toBe(0);

    expect(readdirSync(temp)).toEqual([]);
    expect(readdirSync(recordings).filter((n) => !n.startsWith(".") && n !== "2026-08-24_10-00-00"))
      .toHaveLength(1);
  }, 40_000);

  /**
   * The ⌘⌫ settle window (STC-392 focus rule 4), watched actually fire.
   *
   * "A guard nobody has watched fire is indistinguishable from one that
   * cannot fire" (CLAUDE.md) — `SETTLE_KEYS_MS` (`thumbnail-renderer.ts`) is
   * asserted against in no other test, so this is the one place a real
   * keystroke, dispatched at a real time, is checked against a real outcome
   * on both sides of the window.
   */
  test("⌘⌫ within the first 100ms of paint is ignored; the same key after 500ms deletes", async () => {
    const { app: electronApp, temp } = await launchWithPanel();
    const panel = panelWindow(electronApp);
    await panel.waitForFunction(() => document.getElementById("card")!.className.includes("in"));
    const paintedAt = Date.now();

    const pressTrashKey = () => panel.evaluate(() => document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", metaKey: true, bubbles: true })));

    // Well inside the settle window — dispatched immediately on detecting
    // paint, so this lands within `SETTLE_KEYS_MS`'s first 100ms in practice.
    await pressTrashKey();
    await sleep(100);
    expect(Date.now() - paintedAt).toBeLessThan(300);
    expect(readdirSync(temp).length).toBe(1);
    expect(electronApp.windows().some((p) => p.url().includes("thumbnail.html"))).toBe(true);

    // Past it: the same key now reaches `perform("trash")`.
    const elapsed = Date.now() - paintedAt;
    if (elapsed < 500) await sleep(500 - elapsed);
    await pressTrashKey();
    await expect.poll(() => electronApp.windows().filter((p) => p.url().includes("thumbnail.html")).length,
                       { timeout: 15_000 }).toBe(0);
    expect(readdirSync(temp).length).toBe(0);
  }, 40_000);
});
