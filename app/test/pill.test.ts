import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clampPillWidth, decidePillAction, formatElapsedTimer,
  MIN_PILL_WIDTH_PX, RESIZE_STYLE, PILL_HEIGHT_PX,
  PILL_STOPPED_DWELL_MS, shouldDwell, shouldShowTrackNotice,
  METER_FLOOR_DB, NO_SIGNAL_TOOLTIP, meterFill, meterView, parseLevel,
} from "../src/pill.js";
import { HELPER_STOP_REASONS, pillLabel, trackLossPillLabel } from "../src/stop-copy.js";

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

  // STC-531: the stopped label holds the restore, and ONLY the restore.
  it("holds a restore while the stopped label is up", () => {
    for (const s of ["idle", "stopped", "failed", "starting"] as const) {
      expect(decidePillAction("collapsed", s, true)).toBe("none");
    }
  });

  it("never holds a collapse: a new take during the label is that take's pill", () => {
    expect(decidePillAction("expanded", "recording", true)).toBe("collapse");
    expect(decidePillAction("collapsed", "recording", true)).toBe("none");
  });
});

describe("shouldDwell (STC-531)", () => {
  it("dwells only for a labelled stop on the collapsed pill", () => {
    expect(shouldDwell("collapsed", "Window closed")).toBe(true);
    expect(shouldDwell("expanded", "Window closed")).toBe(false);
    expect(shouldDwell("collapsed", undefined)).toBe(false);
    expect(shouldDwell("collapsed", "")).toBe(false);
  });

  it("each labelled stop the helper decides on dwells; a user stop does not", () => {
    for (const r of HELPER_STOP_REASONS) expect(shouldDwell("collapsed", pillLabel(r)), r).toBe(true);
    for (const r of ["user", "quit", "stopped", "helper-idle", "recorder-quit"]) {
      expect(shouldDwell("collapsed", pillLabel(r)), r).toBe(false);
    }
  });

  it("is the spec's ~2 s", () => {
    expect(PILL_STOPPED_DWELL_MS).toBe(2000);
  });
});

describe("shouldShowTrackNotice (STC-237)", () => {
  it("shows a lost track's label on the pill of a take still recording", () => {
    expect(shouldShowTrackNotice("collapsed", "recording", trackLossPillLabel("mic-disconnected"))).toBe(true);
    expect(shouldShowTrackNotice("collapsed", "recording", trackLossPillLabel("camera-disconnected"))).toBe(true);
  });

  it("not on an expanded window, a take that is not recording, or with no label", () => {
    expect(shouldShowTrackNotice("expanded", "recording", "Mic lost")).toBe(false);
    expect(shouldShowTrackNotice("collapsed", "idle", "Mic lost")).toBe(false);
    expect(shouldShowTrackNotice("collapsed", "recording", trackLossPillLabel("camera-no-frames"))).toBe(false);
    expect(shouldShowTrackNotice("collapsed", "recording", "")).toBe(false);
  });

  it("never moves the window: a notice is a label swap, not a dwell", () => {
    // The take keeps recording, so the pill stays collapsed whatever the notice does.
    expect(decidePillAction("collapsed", "recording", false)).toBe("none");
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

  it("only implements snap — animate is the ticket's own open question", () => {
    expect(RESIZE_STYLE).toBe("snap");
  });
});

describe("the level meter (STC-528)", () => {
  const swift = readFileSync(join(__dirname, "..", "..", "helper/src/MicSignalDecisions.swift"), "utf8");

  it("is hatched until the helper has sent a reading — never a guessed level", () => {
    expect(meterView(undefined, false)).toEqual({ mode: "hatched", fill: 0 });
  });

  it("is hatched once the mic is lost, even if a reading is still in flight", () => {
    expect(meterView({ peak: 0.5, silent: false }, true).mode).toBe("hatched");
  });

  it("goes live on a reading and moves with it", () => {
    const quiet = meterView({ peak: 0.01, silent: false });
    const loud = meterView({ peak: 0.5, silent: false });
    expect(quiet.mode).toBe("live");
    expect(loud.fill).toBeGreaterThan(quiet.fill);
  });

  it("shows no-signal, with an empty bar, when the helper says silent; clears when it does not", () => {
    expect(meterView({ peak: 0, silent: true }, false)).toEqual({ mode: "no-signal", fill: 0 });
    expect(meterView({ peak: 0.2, silent: false }, false).mode).toBe("live");
  });

  it("is a dB scale from the helper's silence floor to full scale", () => {
    expect(meterFill(0)).toBe(0);
    expect(meterFill(10 ** (METER_FLOOR_DB / 20))).toBeCloseTo(0, 9);
    expect(meterFill(1)).toBe(1);
    expect(meterFill(2)).toBe(1);
    expect(meterFill(10 ** (-30 / 20))).toBeCloseTo(0.5, 9);   // ordinary speech is mid-bar, not a sliver
    expect(meterFill(Number.NaN)).toBe(0);
  });

  it("uses the helper's own floor and duration, read from the Swift", () => {
    expect(swift).toMatch(new RegExp(`silenceFloorDbfs: Double = ${METER_FLOOR_DB}\\b`));
    const ns = Number(/silentSpanMinNs: Int64 = ([\d_]+)/.exec(swift)?.[1]?.replace(/_/g, ""));
    expect(NO_SIGNAL_TOOLTIP).toBe(`No mic signal for ${ns / 1e9} s`);
  });

  it("trusts nothing it is sent", () => {
    expect(parseLevel({ peak: 0.3, silent: false })).toEqual({ peak: 0.3, silent: false });
    expect(parseLevel({ peak: 7, silent: true })).toEqual({ peak: 1, silent: true });
    for (const bad of [null, undefined, {}, { peak: "0.3", silent: false }, { peak: 0.3 }, { peak: Number.NaN, silent: false }]) {
      expect(parseLevel(bad)).toBeUndefined();
    }
  });
});
