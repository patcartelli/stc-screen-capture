import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { closeApp, APP_CLOSE_MS, diedFromCrash, stubQuitDialog } from "./_quit-fixture.js";

/**
 * STC-624 class B: a quit moments after a take starts (docs/STC-624-TRIAGE.md).
 *
 * All nine CI crashes of this shape quit 3–50 ms after
 * `[tray] set-menu recording via … reconcileTrayRecording`, with the pill up,
 * and the four with a crash report died in `Tray::SetContextMenu` on a Tray
 * that was NOT the one `runQuitTeardown` had just destroyed. Until now they
 * were only ever hit by accident, by files that start a take for some other
 * reason and then quit. This file aims at that window on purpose, at several
 * offsets, so the crash can be made to happen and its `[tray]` lines (now
 * written synchronously, `tray-log.ts`) name the caller.
 *
 * It FAILS on a crash at quit rather than only printing one: `closeApp`
 * reports a crash and passes, which is how 196 of them went uncounted.
 * The fault is intermittent, so a pass here is corroboration, never proof.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(): Promise<Page> {
  const { dir: recordings } = makeTakeFolder();
  const ud = mkdtempSync(join(tmpdir(), "stc-ud-"));
  const tempTakes = mkdtempSync(join(tmpdir(), "stc-temp-"));
  app = await electron.launch({
    args: [root, `--user-data-dir=${ud}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: tempTakes,
           STC_HELPER_BIN: FAKE_HELPER, STC_OVERLAY_SYNTHETIC_INPUT: "1" },
  });
  // A take open at quit raises the "unsaved takes" warning; unstubbed it is a
  // real modal and the close would wait on it.
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#titlebar");
  return win;
}

const state = (win: Page): Promise<string> =>
  win.evaluate(async () => ((await (window as any).recorder.status()) as { state: string }).state);

/**
 * Start a take, wait for `recording` on a tight poll (the window this aims at
 * is tens of milliseconds wide; expect.poll's default interval would step
 * over it), wait `delay`, quit, and return the signal the app died from.
 */
async function quitAfterRecording(delay: number): Promise<NodeJS.Signals | null> {
  const win = await launch();
  await withoutCountdown(win);
  await startRecordFlow(app!, win);
  const t0 = Date.now();
  while ((await state(win)) !== "recording") {
    if (Date.now() - t0 > 15_000) throw new Error("the take never reached recording");
    await sleep(5);
  }
  if (delay > 0) await sleep(delay);
  const a = app!;
  app = undefined;
  const proc = a.process();
  await closeApp(a);
  return proc.signalCode ?? null;
}

const CRASHED = "the app died from a crash signal while quitting; closeApp printed its [window]/[tray] log above";

// The offsets after `recording` that the nine CI crashes fell inside: 3–50 ms
// after the tray's recording menu was set. Written out rather than looped, so
// `_timeout-budget.ts`'s reader (tests at one indent) can see every bound.
describe("quitting just after a take starts (STC-624 class B)", () => {
  test("at once", async () => {
    expect(diedFromCrash(await quitAfterRecording(0)), CRASHED).toBe(false);
  }, 120_000);

  test("10 ms after", async () => {
    expect(diedFromCrash(await quitAfterRecording(10)), CRASHED).toBe(false);
  }, 120_000);

  test("25 ms after", async () => {
    expect(diedFromCrash(await quitAfterRecording(25)), CRASHED).toBe(false);
  }, 120_000);

  test("50 ms after", async () => {
    expect(diedFromCrash(await quitAfterRecording(50)), CRASHED).toBe(false);
  }, 120_000);
});
