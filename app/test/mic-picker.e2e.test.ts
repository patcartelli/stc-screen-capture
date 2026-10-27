import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForStart } from "./_start-log.js";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { toastText } from "./_toast.js";
import { startRecordFlow } from "./_record-flow.js";
import { closeApp, APP_CLOSE_MS, stubQuitDialog } from "./_quit-fixture.js";
import { recorderState } from "./_library-window.js";

/**
 * The mic choice, end to end through the real app (STC-233): what reaches the
 * helper, and what the user is told when the mic fails.
 *
 * STC-584 took the main window's mic row and popover out (the record bar
 * picks devices, and `record-flow.e2e.test.ts` drives its menu), so the
 * choice is made here through the stored setting the bar writes. A mic is
 * picked by DEVICE, the one real difference from the camera that the ticket
 * calls for: a mic is picked by DEVICE, never toggled on
 * to whatever the helper thinks is best. The settled decision (phase 0) is
 * that this app must never take a mic without the user naming it explicitly
 * — auto-grabbing a Bluetooth mic once stalled capture and wedged CoreAudio
 * system-wide — so "Off" is not merely the default, it is the only
 * automatic choice.
 *
 * The helper stand-in speaks the control plane and records the start
 * payload; it captures no audio, and nothing here claims anything about
 * capture itself.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(opts: {
  userData: string; recordings: string; startLog?: string; mic?: string; mics?: unknown[];
}) {
  app = await electron.launch({
    args: [root, `--user-data-dir=${opts.userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: opts.recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
      ...(opts.startLog ? { STC_FAKE_START_LOG: opts.startLog } : {}),
      ...(opts.mic ? { STC_FAKE_MIC: opts.mic } : {}),
      ...(opts.mics ? { STC_FAKE_MICS: JSON.stringify(opts.mics) } : {}),
    },
  });
  // A stopped take leaves a fresh panel now (STC-487), so a quit raises the
  // "unsaved takes" warning (STC-392 D8); unstubbed it is a real modal.
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  // STC-391: Record counts down now. This file is not about the countdown,
  // so it turns it off through the shipped preference rather than waiting
  // out three real seconds on every take.
  await withoutCountdown(win);
  return win;
}

/** The record bar's mic pick, as it lands: the stored setting (`writeBarOptions`). */
async function pickMic(win: Awaited<ReturnType<typeof launch>>, uid: string): Promise<void> {
  await win.evaluate((u) => (window as any).recorder.setSettings({ micDeviceUid: u }), uid);
}

describe("the mic choice reaches the helper", () => {
  // THE assertion for this ticket. Everything else can be right while the
  // uid never reaches the process that opens the device, and nothing else in
  // the suite can see that.
  test("recording with a mic picked sends micDeviceUid to the helper", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => recorderState(win), { timeout: 30_000 }).toBe("idle");
    // The stand-in's default device list (_fake-helper.mjs) offers exactly
    // one mic, "Fixture USB Mic" (uid "fixture-mic-1").
    await pickMic(win, "fixture-mic-1");

    await startRecordFlow(app!, win);
    const cmd = await waitForStart(startLog);
    expect(cmd.cmd).toBe("start");
    expect(cmd.micDeviceUid, `start payload was ${JSON.stringify(cmd)}`).toBe("fixture-mic-1");
  }, 180_000);

  test("recording with no mic picked sends no micDeviceUid at all", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => recorderState(win), { timeout: 30_000 }).toBe("idle");
    await startRecordFlow(app!, win);
    const cmd = await waitForStart(startLog);
    expect(cmd.micDeviceUid).toBeUndefined();
  }, 180_000);
});

/**
 * STC-233's own device-lifecycle reporting, mirroring the camera's
 * (STC-287): a mic that fails is said, never dropped. The toast is the one
 * place it is said while the take runs since STC-584 removed the mic row
 * (Patrick, 2026-10-27).
 */
describe("the mic says when it fails", () => {
  const dirs = () => ({
    userData: mkdtempSync(join(tmpdir(), "stc-ud-")),
    recordings: makeTakeFolder().dir,
  });

  test("a mic that cannot be found says so instead of failing silently", async () => {
    const win = await launch({ ...dirs(), mic: "fail" });
    await pickMic(win, "fixture-mic-1");
    await startRecordFlow(app!, win);
    await expect.poll(() => toastText(app!), { timeout: 20_000 })
      .toContain("no longer available");
  }, 180_000);

  test("a mic that opens and then sends nothing stops claiming it works", async () => {
    const win = await launch({ ...dirs(), mic: "noframes" });
    await pickMic(win, "fixture-mic-1");
    await startRecordFlow(app!, win);
    await expect.poll(() => toastText(app!), { timeout: 20_000 })
      .toContain("no microphone audio");
  }, 180_000);
});
