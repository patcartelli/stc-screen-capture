import { describe, it, expect } from "vitest";
import {
  clampPillWidth, decidePillAction, formatElapsedTimer,
  MIN_PILL_WIDTH_PX, METER_MODE, RESIZE_STYLE, PILL_HEIGHT_PX,
} from "../src/pill.js";

describe("clampPillWidth", () => {
  it("adds padding to a real measurement", () => {
    expect(clampPillWidth(100, 16)).toBe(116);
  });

  it("floors at MIN_PILL_WIDTH_PX for a tiny measurement", () => {
    expect(clampPillWidth(10, 16)).toBe(MIN_PILL_WIDTH_PX);
  });

  it("never trusts a non-finite or negative measurement", () => {
    expect(clampPillWidth(NaN)).toBe(MIN_PILL_WIDTH_PX);
    expect(clampPillWidth(-50)).toBe(MIN_PILL_WIDTH_PX);
    expect(clampPillWidth(Infinity)).toBe(MIN_PILL_WIDTH_PX);
    expect(clampPillWidth(0)).toBe(MIN_PILL_WIDTH_PX);
  });
});

describe("decidePillAction", () => {
  it("collapses when the confirmed state becomes recording", () => {
    expect(decidePillAction("expanded", "recording")).toBe("collapse");
  });

  it("restores when the confirmed state is anything other than recording", () => {
    for (const s of ["idle", "stopped", "failed", "starting"] as const) {
      expect(decidePillAction("collapsed", s)).toBe("restore");
    }
  });

  it("is idempotent once already in the state the signal implies", () => {
    expect(decidePillAction("collapsed", "recording")).toBe("none");
    expect(decidePillAction("expanded", "idle")).toBe("none");
  });
});

describe("formatElapsedTimer", () => {
  it("is mm:ss under an hour", () => {
    expect(formatElapsedTimer(0)).toBe("00:00");
    expect(formatElapsedTimer(65_000)).toBe("01:05");
    expect(formatElapsedTimer(59 * 60_000 + 59_000)).toBe("59:59");
  });

  it("gains two digits at an hour, per the ticket's own words", () => {
    expect(formatElapsedTimer(60 * 60_000)).toBe("1:00:00");
    expect(formatElapsedTimer(60 * 60_000 + 61_000)).toBe("1:01:01");
  });

  it("never goes negative on a clock that reads before zero", () => {
    expect(formatElapsedTimer(-500)).toBe("00:00");
  });
});

describe("constants the design fixes", () => {
  it("matches the ticket's own pseudocode number for the pill's height", () => {
    expect(PILL_HEIGHT_PX).toBe(26);
  });

  it("only ever draws the meter hatched — no audio capture exists to back a live one", () => {
    expect(METER_MODE).toBe("hatched");
  });

  it("only implements snap — animate is the ticket's own open question", () => {
    expect(RESIZE_STYLE).toBe("snap");
  });
});
