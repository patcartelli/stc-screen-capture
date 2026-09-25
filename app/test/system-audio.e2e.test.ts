import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForStart } from "./_start-log.js";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The system-audio preference reaching the helper (STC-418 PR 2).
 *
 * There is no control for it yet — the options bar's toggle is PR 4, blocked
 * on STC-388 — so the preference is set through the SHIPPED
 * `recorder:setSettings` channel, the same way `_countdown-fixture.ts` sets
 * `countdownMs`. What this file pins is the one line in `main.ts` that turns
 * the stored boolean into the start payload: everything else can be right
 * while `systemAudio` never reaches the process that opens the stream, the
 * same reason `mic-picker.e2e.test.ts` pins `micDeviceUid`.
 *
 * The helper stand-in records the start payload and captures nothing.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(opts: { userData: string; recordings: string; startLog: string }) {
  app = await electron.launch({
    args: [root, `--user-data-dir=${opts.userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: opts.recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
      STC_FAKE_START_LOG: opts.startLog,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await withoutCountdown(win);
  return win;
}

function fresh() {
  return {
    userData: mkdtempSync(join(tmpdir(), "stc-ud-")),
    recordings: makeTakeFolder().dir,
    startLog: join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl"),
  };
}

describe("the system-audio preference", () => {
  test("off by default: a take sends no systemAudio field at all", async () => {
    const o = fresh();
    const win = await launch(o);
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await win.click("#record");
    const cmd = await waitForStart(o.startLog);
    expect(cmd.cmd).toBe("start");
    expect(cmd.systemAudio, `start payload was ${JSON.stringify(cmd)}`).toBeUndefined();
  }, 180_000);

  test("turned on, a take sends systemAudio: true to the helper", async () => {
    const o = fresh();
    const win = await launch(o);
    await win.evaluate(() => (window as any).recorder.setSettings({ systemAudio: true }));
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await win.click("#record");
    const cmd = await waitForStart(o.startLog);
    expect(cmd.cmd).toBe("start");
    expect(cmd.systemAudio, `start payload was ${JSON.stringify(cmd)}`).toBe(true);
  }, 180_000);
});
