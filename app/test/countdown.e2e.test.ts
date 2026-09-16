import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withCountdown } from "./_countdown-fixture.js";

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
 * before a timer that was going to fire anyway (the trap
 * `scope-indicator.e2e.test.ts` records one ticket over).
 *
 * ## What this CANNOT check here
 *
 * The same limit `pill.e2e.test.ts` and `scope-indicator.e2e.test.ts` already
 * document: Xvfb has no window manager, so nothing here asserts where the
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
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Launched { win: Page; startLog: string; stillLog: string; recordings: string }

async function launch(): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const ud = mkdtempSync(join(tmpdir(), "stc-ud-"));
  const logs = mkdtempSync(join(tmpdir(), "stc-logs-"));
  const startLog = join(logs, "start.jsonl");
  const stillLog = join(logs, "still.jsonl");
  app = await electron.launch({
    args: [root, `--user-data-dir=${ud}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_HELPER_BIN: FAKE_HELPER,
           STC_FAKE_START_LOG: startLog, STC_FAKE_STILL_LOG: stillLog,
           STC_OVERLAY_SYNTHETIC_INPUT: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#record");
  return { win, startLog, stillLog, recordings };
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

async function overlayPage(ms = 15_000): Promise<Page> {
  const started = Date.now();
  for (;;) {
    for (const p of app!.windows()) if (p.url().includes("overlay.html")) return p;
    if (Date.now() - started > ms) throw new Error(`no overlay appeared within ${ms}ms`);
    await sleep(50);
  }
}

/** Drags out an area in the overlay and confirms it — the self-timer's own
 * scope step, which the ticket makes a SEPARATE step before the countdown. */
async function pickAnArea(): Promise<void> {
  const overlay = await overlayPage();
  const b = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
  const from = { x: b.x + 100, y: b.y + 80 };
  const to = { x: from.x + 200, y: from.y + 100 };
  const send = (e: unknown) => overlay.evaluate((ev) => (window as any).overlay.send(ev), e);
  await send({ t: "pointerdown", at: from });
  await send({ t: "pointermove", at: to });
  await send({ t: "pointerup", at: to });
  await expect.poll(() => overlay.textContent("#size"), { timeout: 15_000 }).toBeTruthy();
  await send({ t: "key", key: "Enter" });
}

describe("Record always counts down", () => {
  test("the helper is not told to start until the countdown ends", async () => {
    const { win, startLog } = await launch();
    await withCountdown(win, SHORT_MS);
    await win.click("#record");

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
    const { win, startLog, recordings } = await launch();
    // Far longer than this test — so a start appearing could only mean the
    // cancel did not take, never that the clock ran out.
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    const before = readdirSync(recordings).length;
    await win.click("#record");

    const page = await countdownPage();
    await page.keyboard.press("Escape");

    await expect.poll(hasCountdownWindow, { timeout: 10_000 }).toBe(false);
    expect(lines(startLog)).toHaveLength(0);
    // The ticket's requirement 1 in full: "returns to idle". A cancellation is
    // not a failure, so no alert either.
    await expect.poll(() => win.textContent("#record"), { timeout: 10_000 }).toBe("Record");
    expect(await win.textContent("#alert")).toBeFalsy();
    expect(readdirSync(recordings).length).toBe(before);
  }, 120_000);

  test("Skip starts it now", async () => {
    const { win, startLog } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    await win.click("#record");

    const page = await countdownPage();
    await page.click("#skip");
    // A start inside seconds, against a 30s countdown, can only be the button.
    await expect.poll(() => lines(startLog).length, { timeout: 10_000 }).toBe(1);
  }, 120_000);

  test("Return is Skip's keyboard equivalent", async () => {
    const { win, startLog } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    await win.click("#record");

    const page = await countdownPage();
    await page.keyboard.press("Enter");
    await expect.poll(() => lines(startLog).length, { timeout: 10_000 }).toBe(1);
  }, 120_000);

  test("a countdown of zero is off, and Record behaves as it always did", async () => {
    const { win, startLog } = await launch();
    await withCountdown(win, 0);
    await win.click("#record");
    await expect.poll(() => lines(startLog).length, { timeout: 15_000 }).toBe(1);
    expect(await hasCountdownWindow()).toBe(false);
  }, 120_000);
});

describe("the panel itself", () => {
  test("counts down, and honours prefers-reduced-motion without ceasing to count", async () => {
    const { win } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    await win.click("#record");
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
    const { win, stillLog, recordings } = await launch();
    await withCountdown(win, LONGER_THAN_THE_TEST_MS);
    const before = readdirSync(recordings).length;
    const result = win.evaluate(() => (window as any).recorder.captureStill("self-timer"));

    await pickAnArea();
    const page = await countdownPage();
    await page.keyboard.press("Escape");

    expect(await result).toMatchObject({ ok: false, cancelled: true });
    expect(lines(stillLog)).toHaveLength(0);
    // Nothing touches the disk until there is something to write — the same
    // property "Escape leaves no shot.json on disk" already rests on.
    expect(readdirSync(recordings).length).toBe(before);
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
