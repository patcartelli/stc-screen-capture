import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { windowCount, pageWithUrl } from "./_windows.js";
import { toastText } from "./_toast.js";
import { pillPage, pillShowing, pillWindowState } from "./_pill.js";

/**
 * The helper stops a take by itself (STC-531, STC-579): the pill goes away with no
 * label and the panel goes up at once with the reason line and, for a full disk, one
 * action. No toast (Patrick, 2026-10-14).
 *
 * `_fake-helper.mjs`'s `STC_FAKE_STREAM_DEATH_MS` + `STC_FAKE_STOP_REASON` send
 * the unsolicited `stopped` the real helper sends, after writing the take's
 * anchors.json with that stop. Mechanism only: this sandbox has no window
 * manager (pill.e2e.test.ts's header), so nothing here reads a size.
 *
 * Modelled on recording-lost.e2e.test.ts (STC-530).
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

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

/** Stop at 2.5 s: well past the pill showing (pill.e2e.test.ts). */
const DEATH_MS = "2500";

async function stoppedPanel(reason: string): Promise<{ win: Page; panel: Page }> {
  const win = await launch({ STC_FAKE_STREAM_DEATH_MS: DEATH_MS, STC_FAKE_STOP_REASON: reason });
  await startRecordFlow(app!, win);
  await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 30_000 }).toBe(1);
  const panel = await pageWithUrl(app!, "thumbnail.html");
  await panel.waitForLoadState("domcontentloaded");
  return { win, panel };
}

describe("a take the helper stopped by itself (STC-531, STC-579)", () => {
  test("window closed: the pill goes with no label, the panel goes up, and no toast", async () => {
    const win = await launch({ STC_FAKE_STREAM_DEATH_MS: DEATH_MS, STC_FAKE_STOP_REASON: "window-closed" });
    await startRecordFlow(app!, win);
    await expect.poll(() => pillShowing(app!), { timeout: 30_000 }).toBe(true);
    const pill = await pillPage(app!);
    // While the take runs the pill carries no stop label; it never gets one (STC-579).
    expect(await pill.textContent("#pill-label")).toBe("");
    // The pill goes (STC-550: its window is the take's) and the panel goes up with the line.
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => pillWindowState(app!).then((s) => s.exists), { timeout: 15_000 }).toBe(false);
    const panel = await pageWithUrl(app!, "thumbnail.html");
    await panel.waitForLoadState("domcontentloaded");
    await expect.poll(() => panel.textContent("#takereason"), { timeout: 15_000 })
      .toBe("Stopped at 0:02. The window you were recording was closed. Everything up to then is saved.");
    expect(await panel.isHidden("#takeaction"), "window closed has no action").toBe(true);
    // Sampled over time: the old toast came from the renderer on recording-ended.
    for (let i = 0; i < 8; i++) {
      expect(await toastText(app!)).not.toMatch(/stopped by the recorder|waiting in the panel/);
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 240_000);

  test("disk full: the panel offers Reclaim space", async () => {
    const { panel } = await stoppedPanel("disk-full");
    await expect.poll(() => panel.textContent("#takereason"), { timeout: 15_000 })
      .toBe("Stopped at 0:02. Your disk is full. Everything up to then is saved.");
    expect(await panel.isVisible("#takeaction")).toBe(true);
    expect(await panel.textContent("#takeaction")).toBe("Reclaim space");
  }, 240_000);

  test("the action's id is validated by main, not trusted from the page", async () => {
    const { panel } = await stoppedPanel("disk-full");
    await panel.waitForSelector("#takeaction:not([hidden])");
    const refused = await panel.evaluate(() =>
      (window as unknown as { thumb: { stopAction(id: string): Promise<boolean> } }).thumb.stopAction("open-input-monitoring-settings"));
    expect(refused).toBe(false);
  }, 240_000);
});
