import { describe, test, expect } from "vitest";
import { quitDecision } from "../src/quit-guard.js";

describe("quitting with takes nobody has decided on (STC-392 D8)", () => {
  test("no unhandled takes, no warning", () => {
    expect(quitDecision({ unhandled: 0, systemInitiated: false })).toBe("quit");
  });

  test("unhandled takes and a user-initiated quit warns", () => {
    expect(quitDecision({ unhandled: 2, systemInitiated: false })).toBe("warn");
  });

  test("a logout, restart or shutdown NEVER warns, however many are waiting", () => {
    // The spec's own reason: "so it never blocks the system; recovery covers
    // those takes." A modal nobody is looking at, holding up a shutdown, is a
    // worse failure than the takes it was protecting — and it is not even
    // protecting them, because Quit Anyway does not delete and recovery finds
    // them either way.
    expect(quitDecision({ unhandled: 9, systemInitiated: true })).toBe("quit");
  });

  test("a system-initiated quit with NO unhandled takes still just quits", () => {
    // Not a distinct rule from the one above — `quitDecision`'s own ordering
    // checks systemInitiated first, so this only pins that the two true-ish
    // inputs don't interact in some third way.
    expect(quitDecision({ unhandled: 0, systemInitiated: true })).toBe("quit");
  });
});
