import { describe, test, expect } from "vitest";
import {
  GIF_FPS_OPTIONS, DEFAULT_GIF_SETTINGS, cleanGifSettings,
  gifFrameStep, gifFrameCount, gifDelaysCs, gifSize,
} from "../src/gif-options.js";
import { EXPORT_FPS } from "../src/time.js";

describe("GIF frame rate", () => {
  test("every offered rate divides the export grid, so GIF frames land on export frames", () => {
    for (const fps of GIF_FPS_OPTIONS) expect(EXPORT_FPS % fps).toBe(0);
  });
  test("the step is export frames per GIF frame", () => {
    expect(gifFrameStep(15)).toBe(4);
    expect(gifFrameStep(30)).toBe(2);
    expect(gifFrameStep(12)).toBe(5);
  });
  test("a rate that is not an option is refused, not rounded", () => {
    expect(() => gifFrameStep(25 as never)).toThrow(/not a GIF frame rate/);
  });
  test("frame count covers every export frame, and a 1-frame take is 1 GIF frame", () => {
    expect(gifFrameCount(60, 15)).toBe(15);
    expect(gifFrameCount(61, 15)).toBe(16);
    expect(gifFrameCount(1, 30)).toBe(1);
    expect(gifFrameCount(0, 15)).toBe(0);
  });
});

describe("GIF delays", () => {
  test("15 fps rounds cumulatively (frame ends at 7, 13, 20, 27 … cs)", () => {
    expect(gifDelaysCs(6, 15)).toEqual([7, 6, 7, 7, 6, 7]);
  });
  test("the total never drifts from the duration", () => {
    for (const fps of GIF_FPS_OPTIONS) {
      for (const n of [1, 2, 7, 15, 899, 900]) {
        const total = gifDelaysCs(n, fps).reduce((a, b) => a + b, 0);
        expect(total).toBe(Math.round((n * 100) / fps));
      }
    }
  });
  test("10 fps is exact", () => {
    expect(gifDelaysCs(3, 10)).toEqual([10, 10, 10]);
  });
});

describe("GIF size", () => {
  test("capped at maxWidth with the capture's aspect, both even", () => {
    expect(gifSize({ width: 3840, height: 2160 }, 960)).toEqual({ width: 960, height: 540 });
    expect(gifSize({ width: 1513, height: 997 }, 640)).toEqual({ width: 640, height: 422 });
  });
  test("never upscaled: a narrow area capture keeps its own width", () => {
    expect(gifSize({ width: 400, height: 300 }, 960)).toEqual({ width: 400, height: 300 });
  });
  test("'original' is the capture's own width, evened DOWN — never up (Review Focus 3)", () => {
    expect(gifSize({ width: 1513, height: 997 }, "original")).toEqual({ width: 1512, height: 996 });
  });
});

describe("cleanGifSettings", () => {
  test("defaults are 15 fps / 960", () => {
    expect(DEFAULT_GIF_SETTINGS).toEqual({ fps: 15, maxWidth: 960 });
  });
  test("valid values round-trip", () => {
    expect(cleanGifSettings({ fps: 30, maxWidth: "original" })).toEqual({ fps: 30, maxWidth: "original" });
  });
  test("each invalid field falls back on its own", () => {
    expect(cleanGifSettings({ fps: 25, maxWidth: 640 })).toEqual({ fps: 15, maxWidth: 640 });
    expect(cleanGifSettings({ fps: 10, maxWidth: 1000 })).toEqual({ fps: 10, maxWidth: 960 });
    expect(cleanGifSettings("nope")).toEqual(DEFAULT_GIF_SETTINGS);
    expect(cleanGifSettings(undefined)).toEqual(DEFAULT_GIF_SETTINGS);
  });
});
