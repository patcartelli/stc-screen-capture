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
import { pillPage, pillShowing } from "./_pill.js";

/**
 * A mic or camera lost while the take KEEPS recording (STC-237): the pill shows
 * "Mic lost" / "Camera lost" in place of its timer for PILL_STOPPED_DWELL_MS and
 * stays Stop, nothing toasts, and the take's panel names the track and when.
 *
 * `_fake-helper.mjs`'s `STC_FAKE_WARNING` + `STC_FAKE_WARNING_MS` send the warning
 * after the pill is showing; `STC_FAKE_ANCHORS_EXTRA`
 * puts the matching anchors-12 `endedBy` in the take the fake then stops. Mechanism
 * only: this sandbox has no window manager (pill.e2e.test.ts's header).
 *
 * Modelled on stop-copy.e2e.test.ts (STC-531).
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

/** Well past the pill showing (stop-copy.e2e.test.ts). */
const WARNING_MS = "2500";

describe("a mic or camera lost mid-take (STC-237)", () => {
  test("the pill says Mic lost, stays Stop, then goes back to the timer; no toast", async () => {
    const win = await launch({ STC_FAKE_WARNING: "mic-disconnected", STC_FAKE_WARNING_MS: WARNING_MS });
    await startRecordFlow(app!, win);
    await expect.poll(() => pillShowing(app!), { timeout: 30_000 }).toBe(true);
    const pill = await pillPage(app!);
    await expect.poll(() => pill.textContent("#pill-label"), { timeout: 30_000 }).toBe("Mic lost");
    expect(await pill.getAttribute("#pill", "class")).toContain("notice");
    expect(await pill.getAttribute("#pill", "class")).not.toContain("stopped");
    expect(await pill.isDisabled("#pill-stop"), "the take is still running; its pill is still Stop").toBe(false);
    // STC-528: no mic track from here on, so the meter is back to hatched.
    expect(await pill.getAttribute("#pill-meter", "class") ?? "").not.toMatch(/live|no-signal/);
    for (let i = 0; i < 8; i++) {
      expect(await toastText(app!)).not.toMatch(/microphone disconnected|reported a problem/i);
      await new Promise((r) => setTimeout(r, 250));
    }
    // The notice clears on its own, and the take is still recording.
    await expect.poll(() => pill.getAttribute("#pill", "class"), { timeout: 15_000 }).not.toContain("notice");
    expect(await pill.textContent("#pill-label")).toBe("");
    expect(await pillShowing(app!), "nothing ended the take").toBe(true);
    expect(await windowCount(app!, "thumbnail.html"), "nothing ended the take").toBe(0);
  }, 240_000);

  test("the panel names the lost camera and when, after the stop's own line", async () => {
    const extra = {
      version: 12,
      camera: { present: true, device: "Fake Camera", width: 1280, height: 720, firstFramePtsNs: 0,
                lastFramePtsNs: 2_400_000_000, frameIntervalNs: 33_000_000, endedBy: "disconnected" },
    };
    const win = await launch({
      STC_FAKE_WARNING: "camera-disconnected", STC_FAKE_WARNING_MS: WARNING_MS,
      STC_FAKE_STREAM_DEATH_MS: "6000", STC_FAKE_STOP_REASON: "window-closed",
      STC_FAKE_ANCHORS_EXTRA: JSON.stringify(extra),
    });
    await startRecordFlow(app!, win);
    await expect.poll(() => pillShowing(app!), { timeout: 30_000 }).toBe(true);
    const pill = await pillPage(app!);
    await expect.poll(() => pill.textContent("#pill-label"), { timeout: 30_000 }).toBe("Camera lost");
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 30_000 }).toBe(1);
    const panel = await pageWithUrl(app!, "thumbnail.html");
    await panel.waitForLoadState("domcontentloaded");
    await expect.poll(() => panel.textContent("#takereason"), { timeout: 15_000 })
      .toBe("Stopped at 0:06. The window you were recording was closed. Everything up to then is saved. " +
            "The camera disconnected at 0:02, so the rest of the take has no camera.");
  }, 240_000);
});
