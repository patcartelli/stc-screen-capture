import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { toastText } from "./_toast.js";
import { pillPage, pillShowing, pillWindowState } from "./_pill.js";

/**
 * The pill's live mic level (STC-528), WIRED: `pill.test.ts` proves `meterView`
 * decides, which is a different claim from the helper's `level` event reaching the
 * pill through supervisor -> main -> the pill window's preload -> its renderer. `_fake-helper.mjs`'s
 * `STC_FAKE_LEVEL` sends the readings ("live", or "silent" — what follows 10 s of
 * nothing, the helper's own decision). Mechanism only: this sandbox has no window
 * manager (pill.e2e.test.ts's header), so nothing here is about pixels.
 *
 * Modelled on track-loss.e2e.test.ts (STC-237).
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

/** The take's pill, once it is showing (STC-550: its own window). */
async function livePill(): Promise<Page> {
  await expect.poll(() => pillShowing(app!), { timeout: 30_000 }).toBe(true);
  return pillPage(app!);
}

async function launch(extraEnv: Record<string, string>): Promise<Page> {
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
      STC_HELPER_BIN: FAKE_HELPER, STC_OVERLAY_SYNTHETIC_INPUT: "1", STC_NO_SHUTTER: "1",
      ...extraEnv,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#record");
  await withoutCountdown(win);
  return win;
}

const meterClass = (pill: Page) => pill.getAttribute("#pill-meter", "class").then((c) => c ?? "");

describe("the pill's mic level (STC-528)", () => {
  test("a live mic moves the meter off hatched", async () => {
    const win = await launch({ STC_FAKE_MIC: "Fixture USB Mic", STC_FAKE_LEVEL: "live" });
    expect((await pillWindowState(app!)).exists, "no pill before any take").toBe(false);
    await startRecordFlow(app!, win);
    const pill = await livePill();
    await expect.poll(() => meterClass(pill), { timeout: 30_000 }).toContain("live");
    const level = await pill.evaluate(() => getComputedStyle(document.getElementById("pill-meter")!).getPropertyValue("--level"));
    expect(Number(level), "0.3 linear is about -10 dBFS: most of the bar").toBeGreaterThan(0.7);
    expect(await pill.getAttribute("#pill-meter", "title")).toBeNull();
  }, 240_000);

  test("a silent mic shows the marker with its tooltip, and nothing else happens", async () => {
    const win = await launch({ STC_FAKE_MIC: "Fixture USB Mic", STC_FAKE_LEVEL: "silent" });
    await startRecordFlow(app!, win);
    const pill = await livePill();
    await expect.poll(() => meterClass(pill), { timeout: 30_000 }).toContain("no-signal");
    expect(await pill.getAttribute("#pill-meter", "title")).toBe("No mic signal for 10 s");
    // Warn only (STC-505): no toast, and the take keeps running with its pill still Stop.
    for (let i = 0; i < 6; i++) {
      expect(await toastText(app!)).not.toMatch(/mic|signal/i);
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(await pill.isDisabled("#pill-stop")).toBe(false);
    // No class attribute at all is null, not "": the pill has neither state.
    expect((await pill.getAttribute("#pill", "class")) ?? "").not.toMatch(/stopped|notice/);
  }, 240_000);

  test("a take with no mic stays hatched", async () => {
    const win = await launch({});
    await startRecordFlow(app!, win);
    const pill = await livePill();
    await expect.poll(() => pill.textContent("#pill-timer"), { timeout: 30_000 }).not.toBe("00:00");
    expect(await meterClass(pill)).not.toMatch(/live|no-signal/);
  }, 240_000);
});
