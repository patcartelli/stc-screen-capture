import { describe, test, expect } from "vitest";
import type { ElectronApplication } from "playwright";
import { stubQuitDialog } from "./_quit-fixture.js";

/**
 * `stubQuitDialog` against a stub app (STC-513). The real failure needs a
 * minor GC to land inside one particular startup gap, which nothing here can
 * schedule, so the stub replays what Playwright reports when it does: the
 * function RAN in the main process, and only its reply was lost.
 */
const COLLECTED = "electronApplication.evaluate: Resulting promise was garbage collected.";

function stubApp(replies: Array<"run" | "collected" | Error>) {
  const dialog = { showMessageBox: (() => "real") as unknown };
  let calls = 0;
  const app = {
    evaluate: async (fn: (m: { dialog: typeof dialog }) => unknown) => {
      const reply = replies[calls++] ?? "run";
      if (reply instanceof Error) throw reply;
      const value = fn({ dialog });
      if (reply === "collected") throw new Error(COLLECTED);
      return value;
    },
  };
  return { app: app as unknown as ElectronApplication, dialog, calls: () => calls };
}

describe("stubQuitDialog (STC-513)", () => {
  test("installs the stub with one evaluate when the reply arrives", async () => {
    const { app, dialog, calls } = stubApp(["run"]);
    await stubQuitDialog(app);
    expect(calls()).toBe(1);
    await expect((dialog.showMessageBox as () => Promise<unknown>)()).resolves.toEqual({ response: 1, checkboxChecked: false });
  });

  test("a lost reply is read back, not taken on trust and not ignored", async () => {
    const { app, dialog, calls } = stubApp(["collected", "run"]);
    await stubQuitDialog(app);
    expect(calls()).toBe(2);
    await expect((dialog.showMessageBox as () => Promise<unknown>)()).resolves.toEqual({ response: 1, checkboxChecked: false });
  });

  test("a read-back whose own reply is lost is asked again, a bounded number of times", async () => {
    const { app, calls } = stubApp(["collected", "collected", "run"]);
    await stubQuitDialog(app);
    expect(calls()).toBe(3);
    const { app: stuck } = stubApp(Array(20).fill("collected"));
    await expect(stubQuitDialog(stuck)).rejects.toThrow(/garbage collected/);
  });

  test("a lost reply whose stub is NOT in place throws, rather than pretending", async () => {
    // Cannot happen if the cause is what STC-513 says it is (the body runs
    // before the reply is lost) — and if it ever does, the cause is wrong.
    const { app, dialog } = stubApp(["collected", "run"]);
    const real = dialog.showMessageBox;
    let first = true;
    const evaluate = app.evaluate.bind(app);
    (app as unknown as { evaluate: typeof evaluate }).evaluate = (async (fn: never) => {
      if (first) { first = false; throw new Error(COLLECTED); }
      return evaluate(fn);
    }) as typeof evaluate;
    await expect(stubQuitDialog(app)).rejects.toThrow(/STC-513/);
    expect(dialog.showMessageBox).toBe(real);
  });

  test("any other evaluate failure is rethrown untouched", async () => {
    const { app } = stubApp([new Error("Target page, context or browser has been closed")]);
    await expect(stubQuitDialog(app)).rejects.toThrow("has been closed");
  });
});
