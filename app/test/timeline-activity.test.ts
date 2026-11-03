import { describe, expect, test } from "vitest";
import {
  clipActivity, zoomCurveSamples, laneBitmap, CLICK_WEIGHT, MOVE_WEIGHT, formatBlockTime, zoomAmountLabel, zoomPlaceOf, zoomLaneHeight, ZOOM_LANE_PEAK_FLOOR,
  trimRangeParts, activityIn, activityLabel, ZOOM_LANE_FLOOR, ZOOM_LANE_REACH_NS, ZOOM_LANE_DENSE_STEP_NS,
} from "../src/timeline-activity.js";
import type { SessionEvent } from "@transform/types.js";
import { createZoomSim, ZOOM_PRESETS, type ZoomEasing, type ZoomWindow } from "@transform/zoom.js";
import { tickOf, tickTimeNs } from "@transform/time.js";

const S = 1_000_000_000;

describe("clipActivity", () => {
  test("an event list with nothing in it produces all zeros, not NaN", () => {
    expect(clipActivity([], 10 * S, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  test("zero duration is a real answer, not a division by zero", () => {
    const events: SessionEvent[] = [{ t: 0, kind: "down", x: 0, y: 0, button: 0 }];
    expect(clipActivity(events, 0, 4)).toEqual([0, 0, 0, 0]);
  });

  test("a click bucket normalises to 1, the loudest bucket in the take", () => {
    const events: SessionEvent[] = [{ t: 0, kind: "down", x: 0, y: 0, button: 0 }];
    const out = clipActivity(events, 4 * S, 4);
    expect(out[0]).toBe(1);
    expect(out.slice(1)).toEqual([0, 0, 0]);
  });

  test("clicks outweigh bare moves at the same count", () => {
    const clicks: SessionEvent[] = [
      { t: 0, kind: "down", x: 0, y: 0, button: 0 },
      { t: 0, kind: "up", x: 0, y: 0, button: 0 },
    ];
    const moves: SessionEvent[] = [
      { t: 3 * S, kind: "move", x: 0, y: 0 },
      { t: 3 * S, kind: "move", x: 1, y: 1 },
    ];
    const out = clipActivity([...clicks, ...moves], 4 * S, 4);
    // bucket 0 (clicks) = 2 * CLICK_WEIGHT, bucket 3 (moves) = 2 * MOVE_WEIGHT.
    expect(out[0]).toBe(1);
    expect(out[3]).toBeCloseTo((2 * MOVE_WEIGHT) / (2 * CLICK_WEIGHT), 6);
  });

  test("a cursor-shape event contributes nothing", () => {
    const events: SessionEvent[] = [{ t: 0, kind: "cursor", shape: "arrow" as never }];
    expect(clipActivity(events, 4 * S, 4)).toEqual([0, 0, 0, 0]);
  });

  test("an event past the end of the take clamps into the last bucket", () => {
    const events: SessionEvent[] = [{ t: 100 * S, kind: "down", x: 0, y: 0, button: 0 }];
    const out = clipActivity(events, 4 * S, 4);
    expect(out[3]).toBe(1);
  });
});

describe("zoomCurveSamples (STC-620)", () => {
  const win = (startNs: number, endNs: number): ZoomWindow => ({ startNs, endNs, events: [] });
  /** The sim's own curve, read the way render() reads it: one answer per time. */
  const sampler = (windows: ZoomWindow[], easing: ZoomEasing) => {
    const sim = createZoomSim(windows, easing);
    return (tNs: readonly number[]) => sim.amountsAt(tNs.map(tickOf));
  };
  const D = 713 * S; // the ticket's 11:53 take
  const PX = 1000;

  /** Linear interpolation of the drawn polygon at `t`, as the canvas would fill it. */
  const drawnAt = (c: { tNs: number[]; value: number[] }, t: number): number => {
    let i = 0;
    while (i < c.tNs.length - 1 && c.tNs[i + 1]! < t) i++;
    const t0 = c.tNs[i]!, t1 = c.tNs[i + 1] ?? t0;
    if (t1 === t0) return c.value[i]!;
    return c.value[i]! + ((c.value[i + 1]! - c.value[i]!) * (t - t0)) / (t1 - t0);
  };

  test("nothing to draw without a window, and nothing outside a block's zone", () => {
    const none = zoomCurveSamples({ valuesAt: () => [], windows: [], startNs: 0, endNs: D, baseSamples: PX });
    expect(none.tNs).toEqual([]);
    const windows = [win(100 * S, 103 * S)];
    const c = zoomCurveSamples({ valuesAt: sampler(windows, ZOOM_PRESETS.snappy), windows, startNs: 0, endNs: D, baseSamples: PX });
    expect(c.tNs.length).toBeGreaterThan(0);
    expect(c.tNs[0]!).toBeGreaterThan(99 * S);
    expect(c.tNs[c.tNs.length - 1]!).toBeLessThanOrEqual(103 * S + ZOOM_LANE_REACH_NS);
  });

  test("the samples are strictly increasing, inside the span, and each has a value", () => {
    const windows = [win(100 * S, 103 * S), win(102 * S, 110 * S), win(500 * S, 501 * S)];
    const c = zoomCurveSamples({ valuesAt: sampler(windows, ZOOM_PRESETS.standard), windows, startNs: 50 * S, endNs: 600 * S, baseSamples: PX });
    expect(c.value).toHaveLength(c.tNs.length);
    for (let i = 1; i < c.tNs.length; i++) expect(c.tNs[i]!).toBeGreaterThan(c.tNs[i - 1]!);
    const TICK = 8_333_334;
    expect(c.tNs[0]!).toBeGreaterThanOrEqual(50 * S - TICK);
    expect(c.tNs[c.tNs.length - 1]!).toBeLessThanOrEqual(600 * S);
    // Each time is the start of a sim tick, so its value is exactly the sim's there.
    for (const t of c.tNs) expect(tickTimeNs(tickOf(t))).toBe(t);
  });

  test("a Fast ramp on a 12 minute take at full zoom is covered by many samples (the old lane had none)", () => {
    // snappy's IN shoulder is the fastest: omega 18*sqrt(2), back under 1% in ~0.26 s.
    const windows = [win(300 * S, 310 * S)];
    const c = zoomCurveSamples({ valuesAt: sampler(windows, ZOOM_PRESETS.snappy), windows, startNs: 0, endNs: D, baseSamples: PX });
    const onRamp = c.tNs.filter((t) => t >= 300 * S && t <= 300 * S + 260_000_000);
    expect(onRamp.length).toBeGreaterThanOrEqual(12);
    // The old lane: 480 samples over 713 s is one per ~1.49 s, so a ramp this
    // fast fell between two of them.
    expect(D / 480).toBeGreaterThan(1.4 * S);
  });

  test("the drawn curve stays within 0.02 of the true one at every instant, for every preset and direction", () => {
    for (const name of ["calm", "standard", "snappy"] as const) {
      const easing = ZOOM_PRESETS[name];
      const windows = [win(120 * S, 124 * S), win(400 * S, 401 * S)];
      const exact = sampler(windows, easing);
      const c = zoomCurveSamples({ valuesAt: exact, windows, startNs: 0, endNs: D, baseSamples: PX });
      let worst = 0;
      const ranges: [number, number][] = [[119 * S, 124 * S + ZOOM_LANE_REACH_NS], [399 * S, 401 * S + ZOOM_LANE_REACH_NS]];
      for (const [lo, hi] of ranges) {
        // At every sim tick: the sim is a 120 Hz staircase, so a tick's start
        // is the only instant it has a value, and the drawn polygon has to
        // pass through those (between samples it interpolates).
        const probe: number[] = [];
        for (let n = tickOf(lo); n <= tickOf(hi); n++) probe.push(tickTimeNs(n));
        const truth = exact(probe);
        probe.forEach((t, i) => { worst = Math.max(worst, Math.abs(drawnAt(c, t) - truth[i]!)); });
      }
      expect(worst, name).toBeLessThan(0.02);
    }
  });

  test("zoomed in to about a minute, the pixel rate carries it and the dense run is skipped", () => {
    const windows = [win(300 * S, 310 * S)];
    const spacing = (60 * S) / (PX - 1);
    expect(spacing).toBeLessThan(ZOOM_LANE_DENSE_STEP_NS * 5); // sanity: close to the dense step
    const c = zoomCurveSamples({ valuesAt: sampler(windows, ZOOM_PRESETS.calm), windows, startNs: 290 * S, endNs: 350 * S, baseSamples: 4000 });
    // 4000 px over 60 s is 15 ms apart: finer than the dense step, so no extras.
    const gaps = c.tNs.slice(1).map((t, i) => t - c.tNs[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(ZOOM_LANE_DENSE_STEP_NS);
  });

  test("the cost is bounded: a hundred blocks across the whole take stay under 60 000 samples", () => {
    const windows = Array.from({ length: 100 }, (_, i) => win((10 + i * 7) * S, (12 + i * 7) * S));
    const c = zoomCurveSamples({ valuesAt: sampler(windows, ZOOM_PRESETS.standard), windows, startNs: 0, endNs: D, baseSamples: PX });
    expect(c.tNs.length).toBeLessThan(60_000);
  });

  test("the reach covers every preset's ease-out tail (a slower preset must fail here, not draw a clipped tail)", () => {
    for (const name of ["calm", "standard", "snappy"] as const) {
      const sim = createZoomSim([win(0, 10 * S)], ZOOM_PRESETS[name]);
      const [after] = sim.amountsAt([tickOf(10 * S + ZOOM_LANE_REACH_NS)]);
      expect(after!, name).toBeLessThan(ZOOM_LANE_FLOOR);
    }
  });
});

describe("zoomLaneHeight (STC-636): magnification on a log scale", () => {
  test("1x is the floor of the lane, 2x halfway, 4x the top", () => {
    expect(zoomLaneHeight(1, 1)).toBe(0);
    expect(zoomLaneHeight(2, 1)).toBeCloseTo(0.5, 12);
    expect(zoomLaneHeight(4, 1)).toBeCloseTo(1, 12);
    // Each doubling is the same step.
    expect(zoomLaneHeight(Math.SQRT2 * 2, 1) - zoomLaneHeight(2, 1))
      .toBeCloseTo(zoomLaneHeight(2, 1) - zoomLaneHeight(Math.SQRT2, 1), 12);
  });

  test("a 4x block stands taller than a 1.5x one", () => {
    expect(zoomLaneHeight(4, 1)).toBeGreaterThan(zoomLaneHeight(1.5, 1) + 0.6);
  });

  test("a block that zooms at all peaks at no less than the floor", () => {
    expect(ZOOM_LANE_PEAK_FLOOR).toBeCloseTo(0.15, 2);
    expect(zoomLaneHeight(1.05, 1)).toBe(ZOOM_LANE_PEAK_FLOOR);
    expect(zoomLaneHeight(1.2, 1)).toBe(ZOOM_LANE_PEAK_FLOOR);
    // Above the floor the log rules.
    expect(zoomLaneHeight(1.5, 1)).toBeCloseTo(Math.log(1.5) / Math.log(4), 12);
  });

  test("the floor scales with the ease, so a ramp rises from zero instead of jumping", () => {
    // A 1.1x block a tenth of the way in: crop 1 - 0.0909 * 0.1.
    const m = 1 / (1 - (1 - 1 / 1.1) * 0.1);
    expect(zoomLaneHeight(m, 0.1)).toBeCloseTo(ZOOM_LANE_PEAK_FLOOR * 0.1, 12);
    expect(zoomLaneHeight(m, 0.1)).toBeLessThan(ZOOM_LANE_PEAK_FLOOR);
    // Rising through the ramp never steps down.
    let last = 0;
    for (let a = 0; a <= 1.0001; a += 0.05) {
      const h = zoomLaneHeight(1 / (1 - (1 - 1 / 3) * a), a);
      expect(h).toBeGreaterThanOrEqual(last);
      last = h;
    }
  });

  test("never above the ease, so ZOOM_LANE_REACH_NS still bounds the tail", () => {
    for (const target of [1.1, 1.5, 2, 3, 4]) {
      for (let a = 0.001; a <= 1; a += 0.013) {
        const m = 1 / (1 - (1 - 1 / target) * a);
        expect(zoomLaneHeight(m, a)).toBeLessThanOrEqual(a + 1e-12);
      }
    }
  });

  test("a block that does not zoom draws nothing while its ease runs; no ease, no height", () => {
    expect(zoomLaneHeight(1, 0.7)).toBe(0);
    expect(zoomLaneHeight(2, 0)).toBe(0);
    expect(zoomLaneHeight(NaN, 1)).toBe(0);
    // Never over the top of the lane.
    expect(zoomLaneHeight(8, 1)).toBe(1);
  });
});

describe("laneBitmap", () => {
  test("1x draws one bitmap pixel per CSS pixel", () => {
    expect(laneBitmap(800, 22, 1)).toEqual({ width: 800, height: 22, scale: 1 });
  });

  test("a 2x display gets a bitmap twice the CSS size, so nothing is stretched", () => {
    expect(laneBitmap(800, 22, 2)).toEqual({ width: 1600, height: 44, scale: 2 });
  });

  test("a fractional ratio rounds the bitmap but reports the scale it was asked for", () => {
    expect(laneBitmap(801, 22, 1.5)).toEqual({ width: 1202, height: 33, scale: 1.5 });
  });

  test("a ratio below 1 or not a number is treated as 1, never a shrunken bitmap", () => {
    expect(laneBitmap(100, 22, 0.5).scale).toBe(1);
    expect(laneBitmap(100, 22, NaN).scale).toBe(1);
    expect(laneBitmap(100, 22, 0).scale).toBe(1);
  });

  test("an unlaid-out lane is still a 1-pixel bitmap, not zero", () => {
    expect(laneBitmap(0, 22, 2)).toEqual({ width: 1, height: 44, scale: 2 });
  });
});

describe("the Zoom section's readouts (STC-604)", () => {
  test("a block time is m:ss.t with the tenth floored, never rounded up", () => {
    expect(formatBlockTime(0)).toBe("0:00.0");
    expect(formatBlockTime(19.4 * S)).toBe("0:19.4");
    expect(formatBlockTime(19.46 * S)).toBe("0:19.4");
    expect(formatBlockTime(59.99 * S)).toBe("0:59.9");
    expect(formatBlockTime(60 * S)).toBe("1:00.0");
    expect(formatBlockTime(26.0 * S)).toBe("0:26.0");
    expect(formatBlockTime(-5)).toBe("0:00.0");
  });
  test("the amount is the frame over the region's longer side", () => {
    expect(zoomAmountLabel({ width: 0.5, height: 0.3 })).toBe("2.0×");
    expect(zoomAmountLabel({ width: 0.3, height: 0.5 })).toBe("2.0×");
    expect(zoomAmountLabel({ width: 0.4545, height: 0.4 })).toBe("2.2×");
  });
  test("an Auto block shows stage 2's amount, never a word (STC-636)", () => {
    const stage2 = { width: 0.625, height: 0.6 };
    expect(zoomAmountLabel(null, stage2)).toBe("1.6×");
    // A saved region wins over stage 2's.
    expect(zoomAmountLabel({ width: 0.25, height: 0.2 }, stage2)).toBe("4.0×");
    // Stage 2's null is its "don't zoom": the whole frame, 1.0×.
    expect(zoomAmountLabel(null, null)).toBe("1.0×");
    expect(zoomAmountLabel(null)).toBe("1.0×");
    expect(zoomAmountLabel({ width: 0, height: 0 })).toBe("1.0×");
  });
  test("Place is Auto with no saved region and Fixed with one (STC-636)", () => {
    expect(zoomPlaceOf(null)).toBe("auto");
    expect(zoomPlaceOf({ width: 0.5, height: 0.5 })).toBe("fixed");
  });
});

describe("trimRangeParts (STC-606's Export range chip)", () => {
  const S = 1_000_000_000;
  test("the frame's own example: In 0:02.8, Out 0:44.2, 0:41", () => {
    expect(trimRangeParts(2.8 * S, 44.2 * S)).toEqual({ in: "0:02.8", out: "0:44.2", length: "0:41" });
  });
  test("the ends floor to the tenth, as a block's times do; the length rounds, as the Length row does", () => {
    expect(trimRangeParts(2.86 * S, 44.29 * S)).toEqual({ in: "0:02.8", out: "0:44.2", length: "0:41" });
    expect(trimRangeParts(0, 59.6 * S).length).toBe("1:00");
  });
  test("past a minute", () => {
    expect(trimRangeParts(61.5 * S, 125 * S)).toEqual({ in: "1:01.5", out: "2:05.0", length: "1:04" });
  });
});

describe("activityIn / activityLabel (STC-606's Frame hover tooltip)", () => {
  const down = (t: number): SessionEvent => ({ t, kind: "down", x: 0, y: 0, button: 0 });
  const up = (t: number): SessionEvent => ({ t, kind: "up", x: 0, y: 0, button: 0 });
  const move = (t: number): SessionEvent => ({ t, kind: "move", x: 0, y: 0 });
  test("a click is its down: the up and the moves between do not count", () => {
    const events = [down(1 * S), move(1.1 * S), up(1.2 * S), down(1.5 * S), up(1.6 * S)];
    expect(activityIn(events, [], 1 * S, 2 * S).clicks).toBe(2);
  });
  test("the span is half-open, so a bar's edge is counted once, by the later bar", () => {
    const events = [down(2 * S)];
    expect(activityIn(events, [], 1 * S, 2 * S).clicks).toBe(0);
    expect(activityIn(events, [], 2 * S, 3 * S).clicks).toBe(1);
  });
  test("keys in the span are counted; a take with no key track says nothing about keys", () => {
    const keys = [{ t: 1.1 * S }, { t: 1.9 * S }, { t: 2.5 * S }];
    expect(activityIn([], keys, 1 * S, 2 * S)).toEqual({ clicks: 0, keys: 2 });
    expect(activityIn([], undefined, 1 * S, 2 * S)).toEqual({ clicks: 0, keys: undefined });
  });
  test("the label: the frame's own example, singulars, and no keys part without a key track", () => {
    expect(activityLabel({ clicks: 2, keys: 14 })).toBe("2 clicks · 14 keys");
    expect(activityLabel({ clicks: 1, keys: 1 })).toBe("1 click · 1 key");
    expect(activityLabel({ clicks: 0, keys: 0 })).toBe("0 clicks · 0 keys");
    expect(activityLabel({ clicks: 3, keys: undefined })).toBe("3 clicks");
  });
});
