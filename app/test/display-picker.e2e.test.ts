import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForStart } from "./_start-log.js";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { closeApp, APP_CLOSE_MS, stubQuitDialog } from "./_quit-fixture.js";
import { recorderState } from "./_library-window.js";

/**
 * The display a recording targets (STC-247), end to end through the real app: the real IPC
 * handlers, the real settings file, the real start path. The helper stand-in
 * answers `devices` with two displays and records the start payload; it
 * captures nothing, and nothing here claims anything about capture — whether
 * the helper records the RIGHT screen for a given id is the grant test's and
 * the hardware runbook's to prove.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(opts: { userData: string; recordings: string; startLog?: string; displays?: string }) {
  app = await electron.launch({
    args: [root, `--user-data-dir=${opts.userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: opts.recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
      // Record now opens the real overlay (STC-388) — same reason
      // `still-overlay.e2e.test.ts` sets this: without it the overlay's real
      // DOM listeners install and race this file's own synthetic input.
      STC_OVERLAY_SYNTHETIC_INPUT: "1",
      ...(opts.startLog ? { STC_FAKE_START_LOG: opts.startLog } : {}),
      ...(opts.displays ? { STC_FAKE_DISPLAYS: opts.displays } : {}),
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

describe("the display a recording targets", () => {
  // STC-388 found this test asserting the OLD contract and it is restated
  // rather than loosened: Task 6 made scope a per-take choice, chosen fresh
  // from the overlay every time Record is pressed, and "the old sticky-scope
  // settings path is gone" (main.ts's own comment on `runRecordFlow`) is
  // literal — `stored.displayId` is read nowhere in the recording path
  // anymore. NOTHING in the shipped app reads `Settings.displayId`, which is
  // why STC-581 removed Source (`#display`) from Settings: `captureStill`
  // takes its display from the CURSOR's position (STC-374's
  // `getDisplayNearestPoint`), and a recording is scoped from the overlay
  // every time. What the helper is actually told, and what this test checks,
  // is the display the selection was DRAGGED on: the display has to reach the
  // process that opens the stream.
  test("recording sends the displayId of the display the selection was made on", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => recorderState(win), { timeout: 30_000 }).toBe("idle");

    // Read from Electron's own primary display rather than assumed — the
    // overlay's `ctx.displays` comes from `screen.getAllDisplays()`
    // (overlay-session.ts's `toDisplayInfo`), not from the stand-in's
    // STC_FAKE_DISPLAYS list.
    const wantDisplayId = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().id);
    await startRecordFlow(app!, win);
    const cmd = await waitForStart(startLog);
    expect(cmd.cmd).toBe("start");
    expect(cmd.displayId, `start payload was ${JSON.stringify(cmd)}`).toBe(wantDisplayId);
    // And the take is really running (this used to read the window's device
    // pickers locking, which left the library with STC-584).
    await expect.poll(() => recorderState(win), { timeout: 20_000 }).toBe("recording");
  }, 180_000);

  // The old "Automatic sends no displayId at all" test asserted a dead
  // contract too — there is no "Automatic" choice for a recording's target
  // any more, sticky or otherwise. The natural replacement is a WINDOW pick,
  // which sends windowId instead of displayId.
  //
  // STC-388 review, Finding 4: an earlier version of this comment said
  // completing a recording by picking a window was UNREACHABLE through the
  // shipped app — `OverlaySession.push()` derived the options bar's layout
  // from `state.rect` alone, which a window-mode outcome never sets, so the
  // bar's `hidden` attribute never cleared and its Record control could never
  // be pressed. That was true when written and was FIXED three commits later
  // by `anchorRectFor` (overlay-session.ts), which derives the anchor from
  // the PENDING outcome instead — the picked window's own bounds in window
  // mode. `record-flow.e2e.test.ts`'s "expand" describe block now drives a
  // window pick through the real overlay end to end (including pressing the
  // bar's own Record control), so the path this comment used to call
  // unreachable is exercised elsewhere in this suite. This file keeps using
  // `expand` for the test below rather than a window pick, for an unrelated
  // reason that is still true: it is the nearest analogue of "some payload
  // conspicuously omits a field" — expanding to the whole display sends its
  // displayId with no `region` at all, unlike a dragged region, which always
  // carries both.
  test("expanding to the full display sends its displayId with no region", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => recorderState(win), { timeout: 30_000 }).toBe("idle");
    const wantDisplayId = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().id);
    await startRecordFlow(app!, win, { fullDisplay: true });
    const cmd = await waitForStart(startLog);
    expect(cmd.displayId, `start payload was ${JSON.stringify(cmd)}`).toBe(wantDisplayId);
    expect("region" in cmd, `start payload was ${JSON.stringify(cmd)}`).toBe(false);
  }, 180_000);
});
