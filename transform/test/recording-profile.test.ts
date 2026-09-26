import { describe, test, expect } from "vitest";
import {
  RECORDING_PROFILES, profileById, outputSizeForProfile,
  INSTAGRAM_WIDTH_PX, CASE_STUDY_WIDTH_PX,
} from "../src/recording-profile.js";
import { outputSizeFor } from "../src/output-size.js";

const cap = (width: number, height: number) => ({ width, height });

describe("recording profiles (STC-447)", () => {
  test("both built-ins are present, with the ticket's own ids", () => {
    const ids = RECORDING_PROFILES.map((p) => p.id);
    expect(ids).toEqual(["instagram", "case-study"]);
  });

  test("profileById resolves a known id, and null/unknown both mean 'no profile'", () => {
    expect(profileById("instagram")?.label).toBe("Instagram");
    expect(profileById("case-study")?.label).toBe("4K case study");
    expect(profileById(null)).toBeNull();
    expect(profileById(undefined)).toBeNull();
    expect(profileById("not-a-real-id")).toBeNull();
  });

  test("outputSizeForProfile agrees with outputSizeFor — one size calculation, not two", () => {
    const capture = cap(3840, 2160);
    for (const p of RECORDING_PROFILES) {
      expect(outputSizeForProfile(p, capture)).toEqual(outputSizeFor(capture, p.targetWidthPx));
    }
  });

  test("case-study on a capture at the ceiling rescales to nothing — no upscale invented", () => {
    const capture = cap(CASE_STUDY_WIDTH_PX, 2160);
    const size = outputSizeForProfile(profileById("case-study")!, capture);
    expect(size).toEqual(capture);
  });

  test("case-study on a smaller capture never upscales past it", () => {
    // outputSizeFor never invents pixels; feeding a target wider than the
    // capture must not produce a width past the capture's own.
    const capture = cap(1920, 1080);
    const size = outputSizeForProfile(profileById("case-study")!, capture);
    expect(size.width).toBeLessThanOrEqual(capture.width);
  });

  test("instagram preserves the capture's own aspect ratio", () => {
    const capture = cap(2560, 1440);
    const size = outputSizeForProfile(profileById("instagram")!, capture);
    expect(size.width / size.height).toBeCloseTo(capture.width / capture.height, 2);
  });

  test("both dimensions stay even, same rule outputSizeFor already enforces", () => {
    for (const capture of [cap(3326, 2160), cap(1728, 1117)]) {
      for (const p of RECORDING_PROFILES) {
        const size = outputSizeForProfile(p, capture);
        expect(size.width % 2).toBe(0);
        expect(size.height % 2).toBe(0);
      }
    }
  });

  test("INSTAGRAM_WIDTH_PX and CASE_STUDY_WIDTH_PX are exactly what the profiles use", () => {
    expect(profileById("instagram")?.targetWidthPx).toBe(INSTAGRAM_WIDTH_PX);
    expect(profileById("case-study")?.targetWidthPx).toBe(CASE_STUDY_WIDTH_PX);
  });
});
