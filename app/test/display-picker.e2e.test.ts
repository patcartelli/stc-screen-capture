import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForStart } from "./_start-log.js";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";

/**
 * The display picker (STC-247), end to end through the real app: the real IPC
 * handlers, the real settings file, the real start path. The helper stand-in
 * answers `devices` with two displays and records the start payload; it
 * captures nothing, and nothing here claims anything about capture — whether
 * the helper records the RIGHT screen for a given id is the grant test's and
 * the hardware runbook's to prove.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

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
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  // STC-391: Record counts down now. This file is not about the countdown,
  // so it turns it off through the shipped preference rather than waiting
  // out three real seconds on every take.
  await withoutCountdown(win);
  // STC-412: the Source picker lives inside the Settings sheet now. Open it
  // once here, as a user does, so these tests drive it the way it is reached.
  await win.click("#settings");
  return win;
}

const optionValues = (win: any) =>
  win.$$eval("#display option", (os: HTMLOptionElement[]) => os.map((o) => o.value));
const optionTexts = (win: any) =>
  win.$$eval("#display option", (os: HTMLOptionElement[]) => os.map((o) => o.textContent));

describe("the display picker", () => {
  test("offers Automatic first, then what the helper enumerates, and defaults to Automatic", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const win = await launch({ userData, recordings });

    await expect.poll(() => optionValues(win), { timeout: 20_000 }).toEqual(["", "1", "2"]);
    const texts = await optionTexts(win);
    expect(texts[0]).toBe("Automatic");
    expect(texts[1]).toContain("Built-in Display");
    expect(texts[1]).toContain("(main)");
    expect(texts[2]).toContain("External Display");
    expect(texts[2]).not.toContain("(main)");
    expect(await win.inputValue("#display")).toBe("");
  }, 180_000);

  test("a picked display survives a restart", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();

    let win = await launch({ userData, recordings });
    await expect.poll(() => optionValues(win), { timeout: 20_000 }).toEqual(["", "1", "2"]);
    await win.selectOption("#display", "2");
    await expect.poll(() => win.inputValue("#display")).toBe("2");
    await app!.close();
    app = undefined;

    win = await launch({ userData, recordings });
    await expect.poll(() => win.inputValue("#display"), { timeout: 20_000 }).toBe("2");
  }, 180_000);

  // STC-388 found this test asserting the OLD contract and it is restated
  // rather than loosened: Task 6 made scope a per-take choice, chosen fresh
  // from the overlay every time Record is pressed, and "the old sticky-scope
  // settings path is gone" (main.ts's own comment on `runRecordFlow`) is
  // literal — `stored.displayId` is read nowhere in the recording path
  // anymore. Source (`#display`) still exists in the window, and its stored
  // value still round-trips (the test above this one), but as of this review
  // NOTHING in the shipped app currently reads `Settings.displayId` at all —
  // `captureStill` takes its display from the CURSOR's position (STC-374's
  // `getDisplayNearestPoint`), not from this setting, and a recording is
  // scoped from the overlay every time, per this file's own header. Do not
  // invent a new purpose for the control here; whether `#display` should
  // still exist, and what it should mean if it does, is unscoped follow-up
  // work for STC-388 rather than something this test can settle. What the
  // helper is actually told, and what this test still checks, is the display
  // the selection was DRAGGED on — a real, checkable claim regardless of
  // what `#display` does or doesn't feed: the display has to reach the
  // process that opens the stream.
  test("recording sends the displayId of the display the selection was made on", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);

    // Read from Electron's own primary display rather than assumed — the
    // overlay's `ctx.displays` comes from `screen.getAllDisplays()`
    // (overlay-session.ts's `toDisplayInfo`), not from the stand-in's
    // STC_FAKE_DISPLAYS list, which only feeds the `#display` dropdown's text.
    const wantDisplayId = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().id);
    await startRecordFlow(app!, win);
    const cmd = await waitForStart(startLog);
    expect(cmd.cmd).toBe("start");
    expect(cmd.displayId, `start payload was ${JSON.stringify(cmd)}`).toBe(wantDisplayId);
    // The whole settings panel still locks during a take (`lockSettings` in
    // renderer.ts), Source included, even though Source itself no longer
    // feeds a recording's target.
    await expect.poll(() => win.isDisabled("#display"), { timeout: 20_000 }).toBe(true);
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
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    const wantDisplayId = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().id);
    await startRecordFlow(app!, win, { fullDisplay: true });
    const cmd = await waitForStart(startLog);
    expect(cmd.displayId, `start payload was ${JSON.stringify(cmd)}`).toBe(wantDisplayId);
    expect("region" in cmd, `start payload was ${JSON.stringify(cmd)}`).toBe(false);
  }, 180_000);

  // The stored choice outlives the display. Dropping it silently would record
  // the wrong screen without a word; the helper refuses such a start with
  // display-not-found, so the user should see the stale choice before then.
  test("a stored display that is no longer listed is shown as not connected, not dropped", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();

    let win = await launch({ userData, recordings });
    await expect.poll(() => optionValues(win), { timeout: 20_000 }).toEqual(["", "1", "2"]);
    await win.selectOption("#display", "2");
    await expect.poll(() => win.inputValue("#display")).toBe("2");
    await app!.close();
    app = undefined;

    const onlyMain = JSON.stringify([{ id: 1, main: true, name: "Built-in Display", pointW: 1800, pointH: 1169,
                                       pixelW: 3600, pixelH: 2338, originX: 0, originY: 0 }]);
    win = await launch({ userData, recordings, displays: onlyMain });
    await expect.poll(() => win.inputValue("#display"), { timeout: 20_000 }).toBe("2");
    const texts = await optionTexts(win);
    expect(texts.at(-1)).toBe("Display 2 (not connected)");
  }, 180_000);
});
