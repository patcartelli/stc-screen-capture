import { describe, test, expect } from "vitest";
import {
  METER_FLOOR_DB, CLIP_HOLD_MS, METER_IDLE, peakToDb, meterFill, blockAt, meterStep, clipLit, snapToUnity, unityFraction,
} from "../src/audio-meter.js";

describe("meter scale", () => {
  test("silence is the floor, full scale is 0 dB", () => {
    expect(peakToDb(0)).toBe(METER_FLOOR_DB);
    expect(peakToDb(NaN)).toBe(METER_FLOOR_DB);
    expect(peakToDb(1)).toBe(0);
    expect(peakToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(peakToDb(1e-9)).toBe(METER_FLOOR_DB);
  });
  test("fill maps the floor to empty and 0 dB to full", () => {
    expect(meterFill(METER_FLOOR_DB)).toBe(0);
    expect(meterFill(0)).toBe(1);
    expect(meterFill(6)).toBe(1);
    expect(meterFill(-30)).toBeCloseTo(0.5);
  });
});

describe("blockAt", () => {
  const blocks = [
    { startS: 1, endS: 1.025, mic: 0.1, system: 0, mix: 0.1 },
    { startS: 1.025, endS: 1.05, mic: 0.2, system: 0, mix: 0.2 },
  ];
  test("finds the block being heard, end-exclusive", () => {
    expect(blockAt(blocks, 1.01)?.mic).toBe(0.1);
    expect(blockAt(blocks, 1.025)?.mic).toBe(0.2);
    expect(blockAt(blocks, 1.05)).toBeNull();
    expect(blockAt(blocks, 0.5)).toBeNull();
  });
});

describe("meterStep", () => {
  test("attack is instant: a peak is never missed", () => {
    expect(meterStep(METER_IDLE, 1, false, 0, 16).db).toBe(0);
  });
  test("release falls at a steady rate and stops at the floor", () => {
    const hit = meterStep(METER_IDLE, 1, false, 0, 16);
    const later = meterStep(hit, 0, false, 1000, 1000);
    expect(later.db).toBeCloseTo(-30, 6);
    expect(meterStep(later, 0, false, 5000, 4000).db).toBe(METER_FLOOR_DB);
  });
  test("a quieter block never pulls the bar down faster than the release", () => {
    const hit = meterStep(METER_IDLE, 1, false, 0, 16);
    expect(meterStep(hit, 0.001, false, 16, 16).db).toBeGreaterThan(-1);
  });
  test("clip holds for CLIP_HOLD_MS, then clears; a new clip restarts the hold", () => {
    const clipped = meterStep(METER_IDLE, 1.2, true, 1000, 16);
    expect(clipLit(clipped, 1000 + CLIP_HOLD_MS - 1)).toBe(true);
    const held = meterStep(clipped, 0, false, 1000 + CLIP_HOLD_MS - 1, 16);
    expect(clipLit(held, 1000 + CLIP_HOLD_MS - 1)).toBe(true);
    const cleared = meterStep(held, 0, false, 1000 + CLIP_HOLD_MS + 1, 16);
    expect(clipLit(cleared, 1000 + CLIP_HOLD_MS + 1)).toBe(false);
    expect(cleared.clipUntilMs).toBe(0);
    expect(meterStep(clipped, 1.2, true, 2500, 16).clipUntilMs).toBe(2500 + CLIP_HOLD_MS);
  });
});

describe("slider detent", () => {
  test("snaps within the radius, leaves the rest alone", () => {
    expect(snapToUnity(74, 75)).toBe(75);
    expect(snapToUnity(77, 75)).toBe(75);
    expect(snapToUnity(72, 75)).toBe(72);
    expect(snapToUnity(78, 75)).toBe(78);
    expect(snapToUnity(99, 100)).toBe(100);
  });
  test("the tick sits at the unity fraction", () => {
    expect(unityFraction(75)).toBe(0.75);
    expect(unityFraction(100)).toBe(1);
    expect(unityFraction(150)).toBe(1);
  });
});
