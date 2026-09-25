import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { toastPage } from "./_toast.js";

/**
 * The countdown, wired through the real app (STC-391).
 *
 * `countdown.test.ts` proves the decisions with no window; this drives the
 * real `runCountdown` that `recorder:start` and `captureStill` call, against
 * the control-plane stand-in `_fake-helper.mjs`.
 *
 * ## What each test is actually discriminating on
 *
 * The stand-in logs every `start` and every `capture-still` it is sent, which
 * is the only thing that can tell "the countdown ran" from "the countdown
 * looked like it ran": a cancelled countdown has to leave those logs EMPTY,
 * and a skipped one has to fill them long before its own clock would have.
 * So the cancel tests use a countdown far longer than the test, and a start
 * arriving at all would fail them on its own — they do not rely on asserting
 * before a timer that was going to fire anyway.
 *
 * ## What this CANNOT check here
 *
 * The same limit `pill.e2e.test.ts` already documents: Xvfb has no window
 * manager, so nothing here asserts where the
 * panel actually sits on screen, whether the sweep looks smooth, or whether
 * three seconds is the right number. `docs/STC-391-RUNBOOK.md` owns all of
 * that.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

/**
 * Longer than any test here takes, so "it started" can only mean Skip or
 * Return did it — never that the countdown quietly ran out underneath the
 * assertion.
 */
const LONGER_THAN_THE_TEST_MS = 30_000;
/** Short enough to elapse inside a test, long enough that the gap before it
 * does is observable rather than a race. */
const SHORT_MS = 900;

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Launched { win: Page; startLog: string; stillLog: string; tempTakes: string }

async function launch(extraEnv: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const ud = mkdtempSync(join(tmpdir(), "stc-ud-"));
  const logs = mkdtempSync(join(tmpdir(), "stc-logs-"));
  // Where a take actually LANDS since STC-393 — the library root is only what
  // a clean stop promotes into. A "nothing was recorded" assertion pointed at
  // `recordings` would pass for a take that really had been started, which is
  // the whole property these tests exist to check.
  const tempTakes = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const startLog = join(logs, "start.jsonl");
  const stillLog = join(logs, "still.jsonl");
  app = await electron.launch({
    args: [root, `--user-data-dir=${ud}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: tempTakes,
           STC_HELPER_BIN: FAKE_HELPER,
           STC_FAKE_START_LOG: startLog, STC_FAKE_STILL_LOG: stillLog,
           STC_OVERLAY_SYNTHETIC_INPUT: "1", ...extraEnv },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#record");
  return { win, startLog, stillLog, tempTakes };
}

const lines = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];

/**
 * The countdown panel, once it can actually be driven.
 *
 * The window object exists the moment `loadFile` is called, long before the
 * page's own `keydown` listener is attached — and a key pressed into that gap
 * is not queued, it is LOST. The first version of this returned as soon as the
 * URL matched, and the Escape test duly waited out a 30-second countdown and
 * then asserted on a capture that had gone ahead. So this waits for the bridge,
 * for the buttons, AND for a painted count, which together mean the state
 * channel is live and input will land.
 */
async function countdownPage(ms = 15_000): Promise<Page> {
  const started = Date.now();
  for (;;) {
    for (const p of app!.windows()) {
      if (!p.url().includes("countdown.html")) continue;
      await p.waitForFunction(() => Boolean((window as any).countdown));
      await p.waitForSelector("#skip");
      await p.waitForFunction(() => /^\d+$/.test(document.getElementById("count")?.textContent ?? ""));
      return p;
    }
    if (Date.now() - started > ms) throw new Error(`no countdown window appeared within ${ms}ms`);
    await sleep(50);
  }
}

function hasCountdownWindow(): Promise<boolean> {
  return app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("countdown.html")));
}

/**
 * Leave the app IDLE before `afterEach` quits it (STC-388 follow-up).
 *
 * The two tests below end with a Record flow parked in a countdown. Quitting
 * with that panel alive means `runQuitTeardown`'s `cancelCountdown()` has to
 * tear it down. Under `STC_COUNTDOWN_FAULT` that teardown throws before
 * `destroy()`, so `app.quit()` is left to close a live panel. On the macOS
 * runner that quit printed `[quit] teardown … helper=8ms` and then did not
 * exit within 72 s (run 36163869597, re-run job 108173025132).
 *
 * This destroys every countdown panel, then waits until no overlay is left
 * and the flow has settled (`#record` back to "Record" and enabled), the
 * idle state every other e2e file quits from. What each test ASSERTS is
 * unchanged; this only runs after.
 */
async function settleToIdle(win: Page): Promise<void> {
  await app!.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().includes("countdown.html")) w.destroy();
    }
  });
  await expect.poll(hasCountdownWindow, { timeout: 10_000 }).toBe(false);
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("overlay.html"))),
  { timeout: 10_000 }).toBe(false);
  await expect.poll(() => win.textContent("#record"), { timeout: 10_000 }).toBe("Record");
  await expect.poll(() => win.isEnabled("#record"), { timeout: 10_000 }).toBe(true);
}

async function overlayPage(ms = 15_000): Promise<Page> {
  const started = Date.now();
  for (;;) {
    for (const p of app!.windows()) if (p.url().includes("overlay.html")) return p;
    if (Date.now() - started > ms) throw new Error(`no overlay appeared within ${ms}ms`);
    await sleep(50);
  }
}

/** Drags out an area in the overlay — release is the self-timer's scope step,
 * which remains SEPARATE from the countdown. */
async function pickAnArea(): Promise<void> {
  const overlay = await overlayPage();
  const b = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
  const from = { x: b.x + 100, y: b.y + 80 };
  const to = { x: from.x + 200, y: from.y + 100 };
  const send = (e: unknown) => overlay.evaluate((ev) => (window as any).overlay.send(ev), e);
  await send({ t: "pointerdown", at: from });
  await send({ t: "pointermove", at: to });
  await send({ t: "pointerup", at: to });
}

describe("Record always counts down", () => {
  test("the helper is not told to start until the countdown ends", async () => {
    const { win, startLog } = await launch();
    await withCountdown(win, SHORT_MS);
    await startRecordFlow(app!, win);

    // The panel is up and the take has NOT begun: this is the whole of "the
    // countdown is what makes Record feel weightier than Capture".
    const page = await countdownPage();
    expect(lines(startLog)).toHaveLength(0);
    await expect.poll(() => page.textContent("#caption"), { timeout: 5_000 })
      .toBe("Recording starts in");

    // …and then it does begin, on its own, with no further input.
    await expect.poll(() => lines(startLog).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(hasCountdownWindow, { timeout: 5_000 }).toBe(false);
  }, 120_000);

  test("Escape cancels: nothing is recorded and the app is idle again", async () => {
    const { win, startLog } = await launch();
    // Far longer than this test — so a start appearing could only mean the
    // cancel did not take, never that the clock ran out.
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    await startRecordFlow(app!, win);

    const page = await countdownPage();
    await page.keyboard.press("Escape");

    await expect.poll(hasCountdownWindow, { timeout: 10_000 }).toBe(false);
    expect(lines(startLog)).toHaveLength(0);
    // The ticket's requirement 1 in full: "returns to idle". A cancellation is
    // not a failure, so no alert either.
    await expect.poll(() => win.textContent("#record"), { timeout: 10_000 }).toBe("Record");
    expect(await toastPage(app!)).toBeUndefined();
    // Deliberately NOT a directory count: nothing on the recording path
    // creates a take directory before the helper does (`newTempTakeDir` only
    // names one), so a count would read the same whether the cancel took or
    // not. `startLog` is the discriminator here and the stand-in writes it on
    // every `start` it is sent.
  }, 120_000);

  test("Skip starts it now", async () => {
    const { win, startLog } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    await startRecordFlow(app!, win);

    const page = await countdownPage();
    await page.click("#skip");
    // A start inside seconds, against a 30s countdown, can only be the button.
    await expect.poll(() => lines(startLog).length, { timeout: 10_000 }).toBe(1);
  }, 120_000);

  test("Return is Skip's keyboard equivalent", async () => {
    const { win, startLog } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    await startRecordFlow(app!, win);

    const page = await countdownPage();
    await page.keyboard.press("Enter");
    await expect.poll(() => lines(startLog).length, { timeout: 10_000 }).toBe(1);
  }, 120_000);

  test("a countdown of zero is off, and Record behaves as it always did", async () => {
    const { win, startLog } = await launch();
    await withCountdown(win, 0);
    await startRecordFlow(app!, win);
    await expect.poll(() => lines(startLog).length, { timeout: 15_000 }).toBe(1);
    expect(await hasCountdownWindow()).toBe(false);
  }, 120_000);
});

describe("the panel itself", () => {
  test("counts down, and honours prefers-reduced-motion without ceasing to count", async () => {
    const { win } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    await startRecordFlow(app!, win);
    const page = await countdownPage();

    // Moving by default: the sweep is drawn and the body says so.
    await expect.poll(() => page.getAttribute("body", "data-animate"), { timeout: 10_000 })
      .toBe("true");
    expect(await page.isVisible("#ring")).toBe(true);

    await page.emulateMedia({ reducedMotion: "reduce" });
    // The ticket's requirement 4. Both halves: the animation goes AND the
    // count is still a count — a panel that stopped counting would satisfy
    // the first half by deleting the feature.
    await expect.poll(() => page.getAttribute("body", "data-animate"), { timeout: 10_000 })
      .toBe("false");
    expect(await page.isVisible("#ring")).toBe(false);
    expect(await page.textContent("#count")).toMatch(/^\d+$/);
  }, 120_000);
});

describe("a countdown that loses its own window does not wedge the app", () => {
  test("a teardown that THROWS still settles, and Record works after", async () => {
    // The fault this is really about, reached deliberately because its natural
    // trigger is a timing coincidence. With the teardown outside a `finally`,
    // the throw meant `settle` was never called: the caller's promise never
    // resolved, `capturing` stayed true and `active` stayed set, so the app
    // could not capture OR record again for the rest of the session.
    const { win, startLog } = await launch({ STC_COUNTDOWN_FAULT: "teardown-throws" });
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    await startRecordFlow(app!, win);
    const page = await countdownPage();
    await page.keyboard.press("Escape");

    // Cancelled, so nothing was recorded — the throw must not turn a cancel
    // into a take.
    await expect.poll(() => win.textContent("#record"), { timeout: 15_000 }).toBe("Record");
    expect(lines(startLog)).toHaveLength(0);

    // The fault is the throw BEFORE `hide()`/`destroy()`, so this first panel
    // is still alive even though its session settled. It has to go before
    // the second Record, or `countdownPage()` below returns THIS stale panel
    // at once and never sees whether a second countdown opened at all. That
    // is how it read before: the second flow's real panel opened only after
    // the cleanup at the end of the test, survived into `afterEach`, and hit
    // the fault branch again at quit. On the macOS runner that quit hung
    // past 72 s (run 36163869597).
    await app!.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.webContents.getURL().includes("countdown.html")) w.destroy();
      }
    });
    await expect.poll(hasCountdownWindow, { timeout: 10_000 }).toBe(false);

    // The part that matters: not wedged. A second Record has to reach a
    // countdown again rather than be refused for a capture that has ended.
    await startRecordFlow(app!, win);
    await countdownPage();
    expect(await toastPage(app!)).toBeUndefined();

    // STC_COUNTDOWN_FAULT stays set for the whole process, so this second
    // countdown's own `finish()` would ALSO throw before it destroys its
    // panel if anything cancelled it normally, quit included. `settleToIdle`
    // destroys it directly instead. `finish()` checks `isDestroyed()` before
    // the throw, so a panel that is already gone never reaches the fault,
    // and the flow settles before `afterEach` quits.
    await settleToIdle(win);
  }, 120_000);

  test("destroying the panel mid-countdown still settles, and Record works after", async () => {
    const { win, startLog } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    await startRecordFlow(app!, win);
    await countdownPage();

    // Destroy the panel out from under the session — the shape of the real
    // fault, which is that `finish`'s teardown can throw on a window that has
    // gone between the `isDestroyed()` check and the `hide()` after it. Before
    // the `finally`, that rejection meant `settle` was never called: the
    // caller's promise never resolved, `capturing` stayed true and `active`
    // stayed set, so the app could not capture OR record again for the rest of
    // the session. This asserts the recovery, not the mechanism.
    await app!.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.webContents.getURL().includes("countdown.html")) w.destroy();
      }
    });

    // The countdown is gone and nothing was recorded — a lost panel cancels,
    // it does not silently record.
    await expect.poll(hasCountdownWindow, { timeout: 10_000 }).toBe(false);
    expect(lines(startLog)).toHaveLength(0);

    // The part that actually matters: the app is not wedged. A second Record
    // must reach the countdown again rather than being refused for a capture
    // that is no longer in flight.
    await expect.poll(() => win.isEnabled("#record"), { timeout: 10_000 }).toBe(true);
    await startRecordFlow(app!, win);
    await countdownPage();
    expect(await toastPage(app!)).toBeUndefined();
    await settleToIdle(win);
  }, 120_000);
});

describe("the countdown duration is choosable (STC-391, from hardware)", () => {
  test("the profile sheet offers the options, and the pick is what Record waits", async () => {
    const { win, startLog } = await launch();
    await win.click("#settings");
    await win.waitForSelector("#countdownms");

    // Built from COUNTDOWN_OPTIONS, not hand-listed in the markup.
    const values = await win.evaluate(() =>
      [...document.querySelectorAll("#countdownms option")].map((o) => (o as HTMLOptionElement).value));
    expect(values).toEqual(["3000", "5000", "10000"]);
    expect(await win.inputValue("#countdownms")).toBe("3000");

    // Pick 10s, then prove Record really waits it out rather than the stored
    // default: no start within a window that 3s would comfortably have cleared.
    await win.selectOption("#countdownms", "10000");
    await win.click("#profileclose");
    await startRecordFlow(app!, win);
    await countdownPage();
    await sleep(4_000);
    expect(lines(startLog)).toHaveLength(0);
  }, 120_000);

  test("the choice survives a restart", async () => {
    const { dir: recordings } = makeTakeFolder();
    const ud = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const open = async () => {
      app = await electron.launch({
        args: [root, `--user-data-dir=${ud}`],
        cwd: root,
        env: { ...process.env, STC_RECORDINGS_DIR: recordings,
               STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
               STC_HELPER_BIN: FAKE_HELPER },
      });
      await stubQuitDialog(app);
      const w = await app.firstWindow();
      await w.waitForSelector("#record");
      await w.click("#settings");
      await w.waitForSelector("#countdownms");
      return w;
    };

    const first = await open();
    await first.selectOption("#countdownms", "5000");
    await expect.poll(() => first.inputValue("#countdownms"), { timeout: 10_000 }).toBe("5000");
    await app!.close();

    const second = await open();
    expect(await second.inputValue("#countdownms")).toBe("5000");
  }, 120_000);
});

describe("the self-timer (scope → countdown → capture)", () => {
  test("the countdown comes AFTER the scope is set, and then the capture happens", async () => {
    const { win, stillLog } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    void win.evaluate(() => (window as any).recorder.captureStill("self-timer"));

    // Scope first — the ticket makes them separate steps, and nothing has
    // been captured while the overlay is still up.
    await pickAnArea();
    const page = await countdownPage();
    expect(lines(stillLog)).toHaveLength(0);
    await expect.poll(() => page.textContent("#caption"), { timeout: 5_000 })
      .toBe("Capturing in");

    await page.click("#skip");
    await expect.poll(() => lines(stillLog).length, { timeout: 15_000 }).toBe(1);
    // Requirement 3: the panel is not on screen when the frame is taken. It is
    // destroyed before the request is ever sent, so by the time the stand-in
    // has logged one there can be no countdown window left to photograph.
    expect(await hasCountdownWindow()).toBe(false);
  }, 120_000);

  test("Escape during a self-timer captures nothing at all", async () => {
    const { win, stillLog, tempTakes } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    const before = readdirSync(tempTakes).length;
    const result = win.evaluate(() => (window as any).recorder.captureStill("self-timer"));

    await pickAnArea();
    const page = await countdownPage();
    await page.keyboard.press("Escape");

    expect(await result).toMatchObject({ ok: false, cancelled: true });
    expect(lines(stillLog)).toHaveLength(0);
    // A real discriminator, unlike the recording path's: the stand-in creates
    // the leaf directory itself on `capture-still` (as the real helper does),
    // so a shot that went ahead would show up here as well as in `stillLog`.
    expect(readdirSync(tempTakes).length).toBe(before);
  }, 120_000);

  test("an ordinary capture still fires immediately — the self-timer is one shot, not a mode", async () => {
    const { win, stillLog } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    void win.evaluate(() => (window as any).recorder.captureStill("region"));
    await pickAnArea();
    // No countdown between the selection and the frame, with a 30s countdown
    // configured: "Capture fires immediately unless it was started with the
    // self-timer."
    await expect.poll(() => lines(stillLog).length, { timeout: 15_000 }).toBe(1);
    expect(await hasCountdownWindow()).toBe(false);
  }, 120_000);
});
