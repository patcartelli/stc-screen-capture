import { describe, expect, it } from "vitest";
import {
  EXPORT_RATES, DEFAULT_EXPORT_RATE, cleanExportRate, exportRateStep, exportRateFrameCount,
} from "../src/export-rate.js";
import { EXPORT_FPS, exportFrameTimeNs } from "../src/time.js";

describe("export rate (STC-614)", () => {
  it("every rate divides the export grid, so its frames are grid frames", () => {
    for (const r of EXPORT_RATES) {
      expect(EXPORT_FPS % r).toBe(0);
      expect(exportRateStep(r) * r).toBe(EXPORT_FPS);
    }
    expect(exportRateStep(60)).toBe(1);
    expect(exportRateStep(30)).toBe(2);
  });

  it("refuses a rate that is not one of the options", () => {
    for (const r of [0, 15, 24, 25, 29.97, 120, NaN]) expect(() => exportRateStep(r)).toThrow();
  });

  it("cleans untrusted input to 60 unless it is 30", () => {
    expect(DEFAULT_EXPORT_RATE).toBe(60);
    expect(cleanExportRate(30)).toBe(30);
    expect(cleanExportRate("30")).toBe(30);
    for (const v of [60, "60", undefined, null, "", 0, 24, "gif", {}]) expect(cleanExportRate(v)).toBe(60);
  });

  it("counts the grid frames at 0, step, 2·step … inside the window", () => {
    expect(exportRateFrameCount(0, 30)).toBe(0);
    expect(exportRateFrameCount(1, 30)).toBe(1);
    expect(exportRateFrameCount(600, 30)).toBe(300);
    expect(exportRateFrameCount(601, 30)).toBe(301);
    expect(exportRateFrameCount(601, 60)).toBe(601);
    // The same count compositeFrames' loop yields for `total` and `step`.
    for (const total of [1, 2, 3, 59, 60, 61, 300]) {
      let n = 0;
      for (let k = 0; k < total; k += exportRateStep(30)) n++;
      expect(exportRateFrameCount(total, 30)).toBe(n);
    }
  });

  it("30 fps output frames sit 1/30 s apart on the grid, to within a nanosecond", () => {
    // Output frame i is grid frame i·step: a t the 60 fps grid (and so the
    // preview) already samples, and evenly spaced at the file's own rate.
    const step = exportRateStep(30);
    for (let i = 0; i < 300; i++) {
      const t = exportFrameTimeNs(i * step);
      expect(Math.abs(t - (i * 1e9) / 30)).toBeLessThanOrEqual(1);
    }
  });
});
