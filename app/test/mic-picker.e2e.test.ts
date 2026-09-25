import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForStart } from "./_start-log.js";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { observeTextSequence, textSequence, occursBefore } from "./_state-sequence.js";
import { toastText } from "./_toast.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The mic picker, end to end through the real app (STC-233).
 *
 * Mirrors camera-toggle.e2e.test.ts's shape, with the one real difference
 * the ticket itself calls for: a mic is picked by DEVICE, never toggled on
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
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  // STC-391: Record counts down now. This file is not about the countdown,
  // so it turns it off through the shipped preference rather than waiting
  // out three real seconds on every take.
  await withoutCountdown(win);
  // STC-414: the mic picker lives on the always-visible #devicestate row
  // now, not behind Settings — no sheet to open first.
  return win;
}

/**
 * Opens the popover and picks the row with this label — "Off", or a device
 * name from the fake helper's `mics` list. `refreshDevices()` populates the
 * row list from an async `devices()` round trip, so a click issued before it
 * lands would miss a row that does not exist yet — not a product bug, a race
 * in the test. Wait for the row itself rather than a fixed delay.
 */
async function pickMic(win: Awaited<ReturnType<typeof launch>>, label: string): Promise<void> {
  await win.click("#mic-picker");
  const row = win.locator(`#devicepopover >> text="${label}"`);
  await expect.poll(() => row.count(), { timeout: 20_000 }).toBeGreaterThan(0);
  await row.click();
}

describe("the mic picker", () => {
  test("defaults to Off, and a picked mic survives a restart", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();

    let win = await launch({ userData, recordings });
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 }).toBe("off");
    // The stand-in's default device list (_fake-helper.mjs) offers exactly
    // one mic, "Fixture USB Mic" (uid "fixture-mic-1").
    await pickMic(win, "Fixture USB Mic");
    await expect.poll(() => win.textContent("#mic-state")).toBe("Fixture USB Mic");
    await app!.close();
    app = undefined;

    win = await launch({ userData, recordings });
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 }).toBe("Fixture USB Mic");
  }, 180_000);

  // THE assertion for this ticket. Everything else can be right while the
  // uid never reaches the process that opens the device, and nothing else in
  // the suite can see that.
  test("recording with a mic picked sends micDeviceUid to the helper", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await pickMic(win, "Fixture USB Mic");
    await expect.poll(() => win.textContent("#mic-state")).toBe("Fixture USB Mic");

    await win.click("#record");
    const cmd = await waitForStart(startLog);
    expect(cmd.cmd).toBe("start");
    expect(cmd.micDeviceUid, `start payload was ${JSON.stringify(cmd)}`).toBe("fixture-mic-1");
    // While a take is running the setting must not look changeable: the
    // device is opened at start and closed at stop, same as the camera.
    await expect.poll(() => win.isDisabled("#mic-picker"), { timeout: 20_000 }).toBe(true);
  }, 180_000);

  test("recording with no mic picked sends no micDeviceUid at all", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await win.click("#record");
    const cmd = await waitForStart(startLog);
    expect(cmd.micDeviceUid).toBeUndefined();
  }, 180_000);

  test("a stored mic that is no longer connected is shown as such, not silently dropped", async () => {
    // The same "(not connected)" treatment the display picker already gives
    // a missing display (STC-247) — a picker must not have its choice
    // silently swapped for another, and the picker should say so before
    // Record is even pressed.
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();

    let win = await launch({ userData, recordings });
    await pickMic(win, "Fixture USB Mic");
    await app!.close();
    app = undefined;

    // Relaunch with a device list that no longer includes the stored uid.
    win = await launch({ userData, recordings, mics: [] });
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 }).toBe("not connected");
    await win.click("#mic-picker");
    const stale = '#devicepopover >> text="Mic (not connected)"';
    await expect.poll(() => win.locator(stale).count(), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(await win.getAttribute(stale, "aria-selected")).toBe("true");
  }, 180_000);
});

/**
 * STC-233's own device-lifecycle reporting, mirroring the camera's
 * (STC-287) exactly — the helper always announced mic-started/failure
 * events, and a stand-in with nothing listening cannot exercise the
 * complaint this class of bug is about.
 */
describe("the mic says what it is doing", () => {
  const dirs = () => ({
    userData: mkdtempSync(join(tmpdir(), "stc-ud-")),
    recordings: makeTakeFolder().dir,
  });

  test("a mic that opens is named, once it actually opens", async () => {
    const win = await launch({ ...dirs(), mic: "Fixture USB Mic" });
    await pickMic(win, "Fixture USB Mic");
    await win.click("#record");
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 })
      .toContain("Fixture USB Mic");
  }, 60_000);

  test("a mic that cannot be found says so instead of failing silently", async () => {
    const win = await launch({ ...dirs(), mic: "fail" });
    await pickMic(win, "Fixture USB Mic");
    await win.click("#record");
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 })
      .toContain("failed");
    await expect.poll(() => toastText(app!), { timeout: 20_000 })
      .toContain("no longer available");
  }, 60_000);

  // STC-389: mirrors camera-toggle.e2e.test.ts's own fix exactly, one device
  // over — "Fixture USB Mic" and "no frames" are 80ms apart in the fake
  // helper, and sampling #mic-state at two points in time could land after
  // that window closed. Recording the whole sequence and asserting order
  // proves the same claim without racing the runner's scheduling.
  test("a mic that opens and then sends nothing stops claiming it works", async () => {
    const win = await launch({ ...dirs(), mic: "noframes" });
    await pickMic(win, "Fixture USB Mic");
    await observeTextSequence(win, "mic-state");

    await win.click("#record");

    await expect.poll(
      async () => (await textSequence(win, "mic-state")).some((s) => s.includes("no frames")),
      { timeout: 20_000 },
    ).toBe(true);

    const seq = await textSequence(win, "mic-state");
    expect(occursBefore(seq, "Fixture USB Mic", "no frames"), `states were ${JSON.stringify(seq)}`)
      .toBe(true);

    await expect.poll(() => toastText(app!), { timeout: 20_000 })
      .toContain("no microphone audio");
  }, 60_000);
});
