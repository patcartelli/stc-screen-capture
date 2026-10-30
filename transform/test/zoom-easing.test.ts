import { describe, expect, test } from "vitest";
import {
  isEasingSpec, isCompleteEasing, isPairEasing, normalizeEasing, speedsOf, resolveEasing, easingKey, zoomEasingOf,
} from "../src/zoom-easing.js";
import { ZOOM_PRESETS, createZoomSim, type ZoomSim } from "../src/zoom.js";
import { SIM_HZ, tickOf } from "../src/time.js";

/** Milliseconds from a window edge until the amount is within 1% of where it is going. */
function settleMs(sim: ZoomSim, edgeNs: number, dir: "in" | "out"): number {
  const from = tickOf(edgeNs);
  for (let k = 0; k < 4 * SIM_HZ; k++) {
    const a = sim.amountAt(from + k);
    if (dir === "in" ? a >= 0.99 : a <= 0.01) return Math.round((k * 1000) / SIM_HZ);
  }
  return Infinity;
}

describe("the saved shape (STC-619)", () => {
  test("a name, or a pair naming at least one side, is an easing", () => {
    for (const v of ["calm", "standard", "snappy", { in: "calm" }, { out: "snappy" }, { in: "calm", out: "snappy" }]) {
      expect(isEasingSpec(v)).toBe(true);
    }
  });
  test.each([
    ["an unknown name", "wobbly"], ["an empty pair", {}], ["an unknown side", { in: "calm", middle: "calm" }],
    ["a bad speed", { in: "wobbly" }], ["a number", 3], ["null", null], ["an array", ["calm"]], ["a pair of undefined", { in: undefined }],
  ])("is refused: %s", (_n, v) => {
    expect(isEasingSpec(v)).toBe(false);
  });
  test("a manual window's easing is complete: a name or both sides", () => {
    expect(isCompleteEasing("snappy")).toBe(true);
    expect(isCompleteEasing({ in: "calm", out: "snappy" })).toBe(true);
    expect(isCompleteEasing({ in: "calm" })).toBe(false);
    expect(isCompleteEasing({})).toBe(false);
  });
  test("only the object form is a pair", () => {
    expect(isPairEasing({ in: "calm" })).toBe(true);
    expect(isPairEasing("calm")).toBe(false);
    expect(isPairEasing(undefined)).toBe(false);
  });
});

describe("normalizeEasing: what the controls choose, written the smallest way", () => {
  test("nothing chosen is no easing", () => {
    expect(normalizeEasing({})).toBeUndefined();
  });
  test("both sides the same is the preset's name, as every older document writes it", () => {
    expect(normalizeEasing({ in: "snappy", out: "snappy" })).toBe("snappy");
  });
  test("different sides are an object, and one side is an object holding only it", () => {
    expect(normalizeEasing({ in: "calm", out: "snappy" })).toEqual({ in: "calm", out: "snappy" });
    expect(normalizeEasing({ in: "calm" })).toEqual({ in: "calm" });
    expect(normalizeEasing({ out: "standard" })).toEqual({ out: "standard" });
  });
  test("speedsOf is its inverse: a name is both sides", () => {
    expect(speedsOf("calm")).toEqual({ in: "calm", out: "calm" });
    expect(speedsOf({ out: "snappy" })).toEqual({ out: "snappy" });
    expect(speedsOf(undefined)).toEqual({});
    for (const p of [{ in: "calm", out: "snappy" }, { in: "standard" }, { in: "snappy", out: "snappy" }] as const) {
      expect(speedsOf(normalizeEasing(p))).toEqual(p);
    }
  });
});

describe("resolution", () => {
  test("a missing side is the project's preset, so no easing is today's behaviour", () => {
    expect(resolveEasing(undefined, "standard")).toEqual({ in: "standard", out: "standard" });
    expect(resolveEasing({ in: "calm" }, "snappy")).toEqual({ in: "calm", out: "snappy" });
    expect(resolveEasing({ out: "calm" }, "snappy")).toEqual({ in: "snappy", out: "calm" });
    expect(resolveEasing("calm", "snappy")).toEqual({ in: "calm", out: "calm" });
  });
  test("equal pairs share a key; different pairs do not", () => {
    expect(easingKey({ in: "calm", out: "snappy" })).toBe("calm/snappy");
    expect(easingKey({ in: "snappy", out: "calm" })).not.toBe(easingKey({ in: "calm", out: "snappy" }));
  });
  test("a preset's pair IS that preset: byte-identical shoulders, so existing takes do not move", () => {
    for (const name of ["calm", "standard", "snappy"] as const) {
      expect(zoomEasingOf({ in: name, out: name })).toEqual(ZOOM_PRESETS[name]);
    }
  });
  test("each side takes its own preset's shoulder for ITS direction", () => {
    const e = zoomEasingOf({ in: "calm", out: "snappy" });
    expect(e.in).toEqual(ZOOM_PRESETS.calm.in);
    expect(e.out).toEqual(ZOOM_PRESETS.snappy.out);
  });
});

describe("slow in, fast out, through the real sim", () => {
  const win = { startNs: 1_000_000_000, endNs: 4_000_000_000, events: [] };
  test("the push in takes as long as calm's, the release as short as snappy's", () => {
    const slowFast = createZoomSim([win], zoomEasingOf({ in: "calm", out: "snappy" }));
    const calm = createZoomSim([win], ZOOM_PRESETS.calm);
    const snappy = createZoomSim([win], ZOOM_PRESETS.snappy);
    // Settling in: the mixed block matches calm's push exactly (same shoulder, same start).
    expect(settleMs(slowFast, win.startNs, "in")).toBe(settleMs(calm, win.startNs, "in"));
    // Settling out: it matches snappy's release exactly, and is much quicker than calm's.
    expect(settleMs(slowFast, win.endNs, "out")).toBe(settleMs(snappy, win.endNs, "out"));
    expect(settleMs(slowFast, win.endNs, "out")).toBeLessThan(settleMs(calm, win.endNs, "out") / 2);
    // And the push is much slower than snappy's.
    expect(settleMs(slowFast, win.startNs, "in")).toBeGreaterThan(settleMs(snappy, win.startNs, "in") * 3);
  });
});
