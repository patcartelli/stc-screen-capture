import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { closeApp, APP_CLOSE_MS, stubQuitDialog } from "./_quit-fixture.js";
import { waitForStart } from "./_start-log.js";
import { pillPage, pillShowing, pillWindowState } from "./_pill.js";

/**
 * The pill's own window, wired through the real app (STC-550; the pill is
 * STC-375's).
 *
 * `pill.test.ts` proves the pure decisions with no window; this drives the
 * real windows main.ts creates, through the real Record flow, against the
 * control-plane stand-in `_fake-helper.mjs`, which actually goes
 * `state: "recording"` and reports it on its own heartbeat (faking supervisor
 * state against a live idle helper gets undone by the next heartbeat).
 *
 * ## What this CANNOT check, on THIS machine, and why
 *
 * This sandbox's Xvfb has no window manager: a bare `win.setSize()` leaves
 * `getBounds()` unchanged, because the size request has nowhere to go, while
 * the booleans Electron tracks in-process (`isAlwaysOnTop`, `isResizable`)
 * toggle correctly. So WHERE the pill is (top-centre of the recorded display),
 * a drag, and whether it is in the exported video are
 * `docs/STC-550-RUNBOOK.md`'s, not this file's.
 *
 * What IS verified here: the pill is its own window and the library is never
 * turned into it; it shows off the confirmed state (traps 1 and 3), is made
 * before `start` so its window id rides on it (requirement 9's half that a
 * test can see), goes away whether the user or the helper ends the take, and
 * the library steps aside for the take and comes back after it.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(env: Record<string, string> = {}): Promise<{ win: Page; startLog: string }> {
  const { dir: recordings } = makeTakeFolder();
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  const startLog = join(mkdtempSync(join(tmpdir(), "stc-start-")), "start.log");
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
           STC_HELPER_BIN: FAKE_HELPER, STC_FAKE_START_LOG: startLog, ...env },
  });
  // A stopped take leaves a fresh panel now (STC-487), so a quit raises the
  // "unsaved takes" warning (STC-392 D8). Unstubbed it is a real modal and
  // app.close() waits on it until closeApp gives up.
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  // STC-391: Record counts down. This file is not about the countdown.
  await withoutCountdown(win);
  return { win, startLog };
}

/** The library window's own state, from main. */
async function library(): Promise<{ visible: boolean; resizable: boolean; alwaysOnTop: boolean }> {
  const handle = await app!.browserWindow(await app!.firstWindow());
  return handle.evaluate((w) => ({ visible: w.isVisible(), resizable: w.isResizable(), alwaysOnTop: w.isAlwaysOnTop() }));
}

describe("the pill's own window (STC-550)", () => {
  test("Record shows the pill in its own window; the library steps aside, untouched, and its Stop ends the take", async () => {
    const { win, startLog } = await launch();
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    expect(await library()).toEqual({ visible: true, resizable: true, alwaysOnTop: false });
    expect((await pillWindowState(app!)).exists).toBe(false);

    await startRecordFlow(app!, win);
    await expect.poll(() => pillShowing(app!), { timeout: 20_000 }).toBe(true);
    // A floating, unfocused, fixed-size panel — requirement 1's flags.
    expect(await pillWindowState(app!)).toMatchObject({
      alwaysOnTop: true, resizable: false, minimizable: false, focused: false,
    });
    // Hidden, never collapsed: the library's own window is exactly what it
    // was apart from being off screen (requirement 6).
    expect(await library()).toEqual({ visible: false, resizable: true, alwaysOnTop: false });

    // Requirement 9, the half a test can see: the pill existed before `start`
    // and its CGWindowID went with it, so the helper can leave it out.
    const cmd = await waitForStart(startLog);
    const pillId = await app!.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("pill.html"));
      return w ? Number(/^window:(\d+)/.exec(w.getMediaSourceId())?.[1]) : undefined;
    });
    expect(cmd.excludeWindowIds, `start payload was ${JSON.stringify(cmd)}`).toEqual([pillId]);

    // The dot, the meter, the Stop glyph and a real, moving elapsed time.
    const pill = await pillPage(app!);
    expect(await pill.locator("#pill-dot").count()).toBe(1);
    expect(await pill.locator("#pill-meter").count()).toBe(1);
    expect(await pill.locator("#pill-stop").count()).toBe(1);
    await expect.poll(() => pill.textContent("#pill-timer"), { timeout: 10_000 }).not.toBe("00:00");
    expect(await pill.textContent("#pill-timer")).toMatch(/^\d{2}:\d{2}$/);
    // The library's copy is gone, not hidden (acceptance: no body.pill-collapsed).
    expect(await win.locator("#pill").count()).toBe(0);

    // Stop is the one control in the drag region, and it ends this take.
    await pill.click("#pill-stop");
    await expect.poll(() => pillWindowState(app!).then((s) => s.exists), { timeout: 20_000 }).toBe(false);
    await expect.poll(() => win.textContent("#record"), { timeout: 20_000 }).toBe("Record");
    // Back, and as it was.
    await expect.poll(library, { timeout: 20_000 }).toEqual({ visible: true, resizable: true, alwaysOnTop: false });
  }, 210_000);

  test("a take the helper ends on its own also puts the pill away and brings the library back", async () => {
    // STC-306: a display stream dying mid-take ends it unsolicited, through
    // the same `recording-ended` path a user's own Stop produces. The pill
    // must not depend on which path got there — trap 3 in pill.ts's header.
    const { win } = await launch({ STC_FAKE_STREAM_DEATH_MS: "900" });
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);

    await startRecordFlow(app!, win);
    await expect.poll(() => pillShowing(app!), { timeout: 20_000 }).toBe(true);

    // No further click: the stand-in ends the take on its own.
    await expect.poll(() => pillWindowState(app!).then((s) => s.exists), { timeout: 20_000 }).toBe(false);
    await expect.poll(() => win.textContent("#record"), { timeout: 20_000 }).toBe("Record");
    await expect.poll(() => library().then((l) => l.visible), { timeout: 20_000 }).toBe(true);
  }, 180_000);

  test("every take gets a fresh pill: a second take's window is a new one, not the last take's", async () => {
    const { win } = await launch();
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    const idOf = () => app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("pill.html"))?.id);

    await startRecordFlow(app!, win);
    await expect.poll(() => pillShowing(app!), { timeout: 20_000 }).toBe(true);
    const first = await idOf();
    await (await pillPage(app!)).click("#pill-stop");
    await expect.poll(() => pillWindowState(app!).then((s) => s.exists), { timeout: 20_000 }).toBe(false);
    await expect.poll(() => win.textContent("#record"), { timeout: 20_000 }).toBe("Record");

    await startRecordFlow(app!, win);
    await expect.poll(() => pillShowing(app!), { timeout: 20_000 }).toBe(true);
    // A new window is a new position: decided 2026-10-15, a drag lasts one take.
    expect(await idOf()).not.toBe(first);
    expect(await (await pillPage(app!)).textContent("#pill-timer")).toMatch(/^\d{2}:\d{2}$/);
  }, 240_000);
});
