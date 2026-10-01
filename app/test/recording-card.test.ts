import { describe, test, expect } from "vitest";
import { recordingDurationMs, recordingScopeLabel } from "../src/library-items.js";

/**
 * The two facts a recording's panel card states about its take (STC-487):
 * how long it ran, and what it was pointed at.
 */
describe("recordingScopeLabel", () => {
  test("no scope block, or an explicit display, is Screen", () => {
    expect(recordingScopeLabel({})).toBe("Screen");
    expect(recordingScopeLabel(undefined)).toBe("Screen");
    expect(recordingScopeLabel({ scope: { kind: "display" } })).toBe("Screen");
  });

  test("a region is Area — the record flow's own word", () => {
    expect(recordingScopeLabel({ scope: { kind: "region" } })).toBe("Area");
  });

  test("a window is its app's name, or Window when the app is absent or empty", () => {
    expect(recordingScopeLabel({ scope: { kind: "window", window: { app: "Safari" } } })).toBe("Safari");
    expect(recordingScopeLabel({ scope: { kind: "window", window: {} } })).toBe("Window");
    expect(recordingScopeLabel({ scope: { kind: "window", window: { app: "" } } })).toBe("Window");
    expect(recordingScopeLabel({ scope: { kind: "window" } })).toBe("Window");
  });
});

describe("recordingDurationMs", () => {
  test("stop.t is session nanoseconds, rounded to whole milliseconds", () => {
    expect(recordingDurationMs({ stop: { t: 42_000_000_000 } })).toBe(42_000);
    expect(recordingDurationMs({ stop: { t: 1_500_000 } })).toBe(2);   // 1.5 ms rounds up
  });

  test("a take that never wrote a stop reads as zero, not NaN", () => {
    expect(recordingDurationMs({})).toBe(0);
    expect(recordingDurationMs(undefined)).toBe(0);
  });
});
