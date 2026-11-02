import { describe, test, expect, vi } from "vitest";
import { callersOf, logTray, trayLogLine } from "../src/tray-log.js";

/**
 * STC-624's tray log. What it has to get right is that the last line before a
 * crash NAMES the JS caller, so the stacks here are real V8 ones, made by
 * calling through named functions, not hand-typed strings.
 */
describe("callersOf", () => {
  function reconcileTrayRecording(): string | undefined { return update(); }
  function update(): string | undefined { return build(); }
  function build(): string | undefined { return new Error().stack; }

  test("names the nearest callers, nearest first", () => {
    expect(callersOf(reconcileTrayRecording(), 3)).toEqual(["build", "update", "reconcileTrayRecording"]);
  });

  test("an object method is named without its `Object.` receiver", () => {
    const handle = { update() { return new Error().stack; } };
    expect(callersOf(handle.update(), 1)).toEqual(["update"]);
  });

  test("no stack is no callers, never a throw", () => {
    expect(callersOf(undefined)).toEqual([]);
    expect(callersOf("Error\n    at /bare/file.js:1:1")).toEqual([]);
  });
});

describe("trayLogLine", () => {
  const at = new Date("2026-10-21T16:45:15.123Z");

  test("time to the millisecond, as the .ips captureTime reads, then event, detail and callers", () => {
    expect(trayLogLine("set-menu", at, ["build", "update"], "recording busy"))
      .toBe("[tray] 16:45:15.123 set-menu recording busy via build <- update");
  });

  test("no detail and no callers leave no stray words", () => {
    expect(trayLogLine("destroy", at, [])).toBe("[tray] 16:45:15.123 destroy");
  });
});

describe("logTray", () => {
  test("writes one [tray] line to stderr naming its caller, not itself", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    function runQuitTeardown(): void { logTray("destroy"); }
    runQuitTeardown();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toMatch(/^\[tray\] \d\d:\d\d:\d\d\.\d{3} destroy via runQuitTeardown\b/);
    err.mockRestore();
  });
});
