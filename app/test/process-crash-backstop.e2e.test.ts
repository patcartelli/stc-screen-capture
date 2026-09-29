import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { makeTakeFolder } from "./_take-fixture.js";
import { launchApp } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * STC-468: the main process used to have no `unhandledRejection` or
 * `uncaughtException` handler anywhere. Node's default for the second is to
 * terminate the process — for Electron's main process that takes every
 * window, the helper supervisor and any live recording down with it, silently
 * (no dialog, no crash reporter here).
 *
 * This does not assert on a log line: capturing the main process's own
 * `console.error` reliably across the Playwright-Electron boundary has no
 * precedent in this suite (`grep`'s own search for it came back empty), and a
 * flaky stdout scrape would be worse than no test. Instead it asserts the
 * BEHAVIOUR the ticket actually cares about — the process survives a fault
 * severe enough that Node's own default would have killed it — which is
 * exactly the shape of test this repo already prefers for a claim about
 * SHAPE/robustness over a claim about pixels (CLAUDE.md's own "watching the
 * agreed answer" reasoning, one level down: here there is no agreed answer to
 * watch, only "did the process live").
 *
 * `setTimeout(..., 0)` inside `app.evaluate` schedules the throw for AFTER
 * the evaluate call's own promise has already resolved, so the exception is
 * genuinely detached from anything this test is awaiting — a real, ownerless
 * `uncaughtException` in the main process's event loop, not a rejected
 * `evaluate()` call.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

describe("process-level crash backstop (STC-468)", () => {
  test("the main process survives an uncaught exception in a detached callback", async () => {
    const { dir } = makeTakeFolder();
    const { app: a, win } = await launchApp(dir);
    app = a;

    await a.evaluate(() => {
      setTimeout(() => { throw new Error("STC-468 probe: uncaught exception"); }, 0);
    });

    // Give the detached throw a moment to actually fire (and, pre-fix, to
    // take the process down with it) before checking anything.
    await new Promise((r) => setTimeout(r, 500));

    // Still alive: an ordinary main-process round trip still answers, and the
    // window is still the one that was there before — neither is true of a
    // process that just crashed.
    await expect(a.evaluate(({ app: electronApp }) => electronApp.getVersion())).resolves.toBeTruthy();
    expect(win.isClosed()).toBe(false);
  }, 60_000);

  test("the main process survives an unhandled rejection with no handler of its own", async () => {
    const { dir } = makeTakeFolder();
    const { app: a, win } = await launchApp(dir);
    app = a;

    await a.evaluate(() => {
      void Promise.reject(new Error("STC-468 probe: unhandled rejection"));
    });
    await new Promise((r) => setTimeout(r, 500));

    await expect(a.evaluate(({ app: electronApp }) => electronApp.getVersion())).resolves.toBeTruthy();
    expect(win.isClosed()).toBe(false);
  }, 60_000);
});
