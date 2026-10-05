import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForStart } from "./_start-log.js";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The Record bar's Keys toggle reaching the helper (STC-419). Pins the one
 * line in `recordFlowBody`'s start-param builder (main.ts) that turns the
 * bar's `keys` into `keys: true`, and that the choice is sticky.
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
      STC_OVERLAY_SYNTHETIC_INPUT: "1",
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

describe("the Keys toggle (STC-419)", () => {
  test("off by default: a take sends no keys field", async () => {
    const o = fresh();
    const win = await launch(o);
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await startRecordFlow(app!, win);
    const cmd = await waitForStart(o.startLog);
    expect(cmd.keys, `start payload was ${JSON.stringify(cmd)}`).toBeUndefined();
  }, 180_000);

  test("pressed on the bar: the take sends keys: true, and the choice is sticky", async () => {
    const o = fresh();
    const win = await launch(o);
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await startRecordFlow(app!, win, { keys: true });
    const cmd = await waitForStart(o.startLog);
    expect(cmd.keys, `start payload was ${JSON.stringify(cmd)}`).toBe(true);
    expect((await win.evaluate(() => (window as any).recorder.getSettings())).recordKeys).toBe(true);
  }, 180_000);
});
