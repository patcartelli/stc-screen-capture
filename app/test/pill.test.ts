import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clampPillWidth, decidePillAction, formatElapsedTimer,
  MIN_PILL_WIDTH_PX, RESIZE_STYLE, PILL_HEIGHT_PX,
  PILL_NOTICE_MS, shouldShowTrackNotice,
  METER_FLOOR_DB, NO_SIGNAL_TOOLTIP, meterFill, meterView, parseLevel,
  PILL_CHROME_PX, PILL_TOP_INSET_PX, pillBounds, resizePillBounds, libraryAroundTake,
  dragTarget, easeStep, PILL_DRAG_FRAME_MS,
} from "../src/pill.js";
import { trackLossPillLabel } from "../src/stop-copy.js";

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

  // STC-579: nothing holds a restore; the pill is for a recording in progress.
  it("a new take after a stop collapses with no leftover state", () => {
    expect(decidePillAction("collapsed", "idle")).toBe("restore");
    expect(decidePillAction("expanded", "recording")).toBe("collapse");
  });
});

describe("PILL_NOTICE_MS", () => {
  it("is the ~2 s a track notice stands in for the timer", () => {
    expect(PILL_NOTICE_MS).toBe(2000);
  });
});

describe("shouldShowTrackNotice (STC-237)", () => {
  it("shows a lost track's label on the pill of a take still recording", () => {
    expect(shouldShowTrackNotice("collapsed", "recording", trackLossPillLabel("mic-disconnected"))).toBe(true);
    expect(shouldShowTrackNotice("collapsed", "recording", trackLossPillLabel("camera-disconnected"))).toBe(true);
    expect(shouldShowTrackNotice("collapsed", "recording", trackLossPillLabel("system-audio-stopped"))).toBe(true);   // STC-542
  });

  it("not on an expanded window, a take that is not recording, or with no label", () => {
    expect(shouldShowTrackNotice("expanded", "recording", "Mic lost")).toBe(false);
    expect(shouldShowTrackNotice("collapsed", "idle", "Mic lost")).toBe(false);
    expect(shouldShowTrackNotice("collapsed", "recording", trackLossPillLabel("camera-no-frames"))).toBe(false);
    expect(shouldShowTrackNotice("collapsed", "recording", "")).toBe(false);
  });

  it("never moves the window: a notice is a label swap", () => {
    // The take keeps recording, so the pill stays collapsed whatever the notice does.
    expect(decidePillAction("collapsed", "recording")).toBe("none");
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

describe("pillBounds (STC-550)", () => {
  const workArea = { x: 0, y: 25, width: 1512, height: 920 };

  it("opens centred on the recorded display's work area, just under the menu bar", () => {
    const b = pillBounds(workArea, 100);
    expect(b).toEqual({ x: Math.round((1512 - b.width) / 2), y: 25 + PILL_TOP_INSET_PX,
                        width: 100 + PILL_CHROME_PX, height: PILL_HEIGHT_PX });
  });

  it("is on the SECOND display when that is the one recorded", () => {
    const secondary = { x: 1512, y: -200, width: 2560, height: 1415 };
    const b = pillBounds(secondary, 100);
    expect(b.x).toBeGreaterThanOrEqual(secondary.x);
    expect(b.x + b.width).toBeLessThanOrEqual(secondary.x + secondary.width);
    expect(b.x + b.width / 2).toBeCloseTo(secondary.x + secondary.width / 2, 0);
    expect(b.y).toBe(-200 + PILL_TOP_INSET_PX);
  });

  it("never trusts a bad measurement, and never exceeds the work area", () => {
    expect(pillBounds(workArea, Number.NaN).width).toBe(MIN_PILL_WIDTH_PX);
    expect(pillBounds({ x: 0, y: 0, width: 50, height: 50 }, 400).width).toBe(50);
  });

  it("the inset is tokens.css's --space-3", () => {
    const tokens = readFileSync(join(__dirname, "../renderer/tokens.css"), "utf8");
    expect(tokens).toMatch(new RegExp(`--space-3: ${PILL_TOP_INSET_PX}px;`));
  });
});

describe("resizePillBounds (STC-550)", () => {
  const workArea = { x: 0, y: 25, width: 1000, height: 700 };

  it("grows about the pill's current centre, so a dragged pill stays where it was put", () => {
    const dragged = { x: 300, y: 400, width: 120, height: PILL_HEIGHT_PX };
    const b = resizePillBounds(dragged, workArea, 140);
    expect(b.width).toBe(140 + PILL_CHROME_PX);
    expect(b.x + b.width / 2).toBeCloseTo(360, 0);
    expect(b.y).toBe(400);
  });

  it("stays inside the work area when grown against an edge", () => {
    const atEdge = { x: 1000 - 120, y: 30, width: 120, height: PILL_HEIGHT_PX };
    const b = resizePillBounds(atEdge, workArea, 300);
    expect(b.x + b.width).toBe(1000);
  });
});

describe("the pill's drag (STC-550)", () => {
  it("moves the window exactly as far as the pointer moved", () => {
    expect(dragTarget({ x: 700, y: 33 }, { x: 750, y: 45 }, { x: 610, y: 400 })).toEqual({ x: 560, y: 388 });
  });

  it("works across displays, in negative screen coordinates", () => {
    expect(dragTarget({ x: 100, y: 10 }, { x: 120, y: 20 }, { x: -380, y: -180 })).toEqual({ x: -400, y: -190 });
  });

  it("eases toward the target and always settles exactly on it", () => {
    const target = { x: 200, y: 0 };
    let p = { x: 0, y: 0 };
    let frames = 0;
    while ((p.x !== target.x || p.y !== target.y) && frames < 100) { p = easeStep(p, target); frames++; }
    expect(p).toEqual(target);
    // Close behind the pointer, never a slow drift: well under 200 ms at 60 fps.
    expect(frames * PILL_DRAG_FRAME_MS).toBeLessThan(250);
  });

  it("never overshoots", () => {
    let p = { x: 0, y: 0 };
    for (let i = 0; i < 20; i++) {
      p = easeStep(p, { x: 100, y: -50 });
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(-50);
    }
  });
});

describe("libraryAroundTake (STC-550)", () => {
  const base = { exists: true, visible: true, minimized: false, appHidden: false };

  it("an open library is hidden for the take and comes back after it", () => {
    expect(libraryAroundTake(base)).toEqual({ hide: true, showAfter: true });
  });

  it("a minimized library is left in the Dock, before and after (STC-538)", () => {
    expect(libraryAroundTake({ ...base, minimized: true })).toEqual({ hide: false, showAfter: false });
    expect(libraryAroundTake({ ...base, minimized: true, visible: false })).toEqual({ hide: false, showAfter: false });
  });

  it("a library hidden with the app (⌘H) is kept hidden through the unhide, and not shown after", () => {
    expect(libraryAroundTake({ ...base, appHidden: true })).toEqual({ hide: true, showAfter: false });
  });

  it("no library: none is made and none appears after (STC-524)", () => {
    expect(libraryAroundTake({ exists: false, visible: false, minimized: false, appHidden: false }))
      .toEqual({ hide: false, showAfter: false });
  });

  it("a library that exists but is not on screen stays that way", () => {
    expect(libraryAroundTake({ ...base, visible: false })).toEqual({ hide: false, showAfter: false });
  });
});
