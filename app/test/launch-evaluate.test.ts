import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication } from "playwright";
import { installAtLaunch, LOST_REPLY_READS } from "./_launch-evaluate.js";
import { stubQuitDialog } from "./_quit-fixture.js";

/**
 * `installAtLaunch` against a stub app (STC-513). The real failure needs a
 * minor GC to land inside one particular startup gap, which nothing here can
 * schedule, so the stub replays what Playwright reports when it does: the
 * function RAN in the main process, and only its reply was lost.
 */
const COLLECTED = "electronApplication.evaluate: Resulting promise was garbage collected.";

type Reply = "run" | "collected" | "skip-collected" | Error;

/**
 * Each evaluate takes the next reply: "run" runs it and answers, "collected"
 * runs it and loses the answer, "skip-collected" loses the answer WITHOUT
 * running it (what the cause says cannot happen), an Error is thrown as is.
 */
function stubApp(replies: Reply[]) {
  const electron = { dialog: { showMessageBox: (() => "real") as unknown } };
  let calls = 0;
  const app = {
    evaluate: async (fn: (e: typeof electron, arg: unknown) => unknown, arg?: unknown) => {
      const reply = replies[calls++] ?? "run";
      if (reply instanceof Error) throw reply;
      if (reply === "skip-collected") throw new Error(COLLECTED);
      const value = fn(electron, arg);
      if (reply === "collected") throw new Error(COLLECTED);
      return value;
    },
  };
  return { app: app as unknown as ElectronApplication, electron, calls: () => calls };
}

const g = globalThis as Record<string, unknown>;
afterEach(() => { delete g.__t; delete g.__stcQuitStub; });

const install = (_e: unknown, v: number) => { g.__seen = v; g.__t = true; };

describe("installAtLaunch (STC-513)", () => {
  test("installs, passes the argument, and reads the marker back", async () => {
    const { app, calls } = stubApp([]);
    await installAtLaunch(app, install as never, 7, "__t");
    expect(g.__seen).toBe(7);
    expect(calls()).toBe(2);
  });

  test("a lost reply is read back, not re-installed and not ignored", async () => {
    const { app, calls } = stubApp(["collected"]);
    await installAtLaunch(app, install as never, 1, "__t");
    expect(calls()).toBe(2);
  });

  test("a read-back whose own reply is lost is asked again, a bounded number of times", async () => {
    const { app, calls } = stubApp(["collected", "collected", "run"]);
    await installAtLaunch(app, install as never, 1, "__t");
    expect(calls()).toBe(3);
    const { app: stuck, calls: stuckCalls } = stubApp(Array(20).fill("collected"));
    await expect(installAtLaunch(stuck, install as never, 1, "__t")).rejects.toThrow(/garbage collected/);
    expect(stuckCalls()).toBe(1 + LOST_REPLY_READS);
  });

  test("a lost reply whose install did NOT run throws, rather than pretending", async () => {
    // Cannot happen if the cause is what STC-513 says it is (the body runs
    // before the reply is lost); if it ever does, the cause is wrong.
    const { app } = stubApp(["skip-collected"]);
    await expect(installAtLaunch(app, install as never, 1, "__t")).rejects.toThrow(/STC-513.*did not run/);
  });

  test("an install that forgets its marker fails on the first run, not only the rare one", async () => {
    const { app } = stubApp([]);
    await expect(installAtLaunch(app, (() => {}) as never, 1, "__t")).rejects.toThrow(/did not set globalThis.__t/);
  });

  test("any other evaluate failure is rethrown untouched", async () => {
    const { app } = stubApp([new Error("Target page, context or browser has been closed")]);
    await expect(installAtLaunch(app, install as never, 1, "__t")).rejects.toThrow("has been closed");
  });

  test("stubQuitDialog goes through it, and the stub answers Quit Anyway", async () => {
    const { app, electron } = stubApp(["collected"]);
    await stubQuitDialog(app);
    await expect((electron.dialog.showMessageBox as () => Promise<unknown>)())
      .resolves.toEqual({ response: 1, checkboxChecked: false });
  });
});
