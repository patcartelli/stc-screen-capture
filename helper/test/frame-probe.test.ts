import { describe, test, expect } from "vitest";
import { join } from "node:path";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * STC-235 Task 11: proves the frame probe itself runs on this Mac, with no
 * grant and no live capture — `display-refit.grant.test.ts` is the only
 * place its LUMA numbers are asserted on for real, and that file cannot run
 * here (no Screen Recording grant). This one runs on `fixtures/basic/`'s
 * generated `display.mp4` (640x360, 5 s, from `fixtures/basic/anchors.json`)
 * and only checks that the probe grabs a real frame and prints two finite
 * LUMA numbers — the mechanism, not any particular pixel value, since the
 * fixture's content is not this ticket's concern.
 */
const FIXTURE = join(__dirname, "..", "..", "fixtures", "basic", "display.mp4");

describe("frame probe (STC-235)", () => {
  test("grabs a frame from a real mp4 and reports LUMA_INSIDE/LUMA_OUTSIDE", async () => {
    const out = await runSwiftHarness({
      label: "frame-probe",
      sources: ["helper/test/frame-probe/main.swift"],
      args: [FIXTURE, "2.5", "100", "80", "300", "150"],
    });

    const outside = /LUMA_OUTSIDE=([\d.eE+-]+)/.exec(out);
    const inside = /LUMA_INSIDE=([\d.eE+-]+)/.exec(out);
    expect(outside, out).not.toBeNull();
    expect(inside, out).not.toBeNull();

    const outsideVal = Number(outside![1]);
    const insideVal = Number(inside![1]);
    expect(Number.isFinite(outsideVal), out).toBe(true);
    expect(Number.isFinite(insideVal), out).toBe(true);
    // A real decoded frame's luma sits in the valid 0-255 range; anything
    // else means the probe read garbage rather than pixels.
    expect(outsideVal).toBeGreaterThanOrEqual(0);
    expect(outsideVal).toBeLessThanOrEqual(255);
    expect(insideVal).toBeGreaterThanOrEqual(0);
    expect(insideVal).toBeLessThanOrEqual(255);
  }, 60_000);

  test("refuses a rect that does not fit inside the frame", async () => {
    await expect(runSwiftHarness({
      label: "frame-probe",
      sources: ["helper/test/frame-probe/main.swift"],
      args: [FIXTURE, "2.5", "0", "0", "9999", "9999"],
    })).rejects.toThrow(/exited/);
  }, 60_000);
});
