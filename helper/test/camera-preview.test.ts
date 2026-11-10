import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * STC-638: the live camera view's decisions — the 12 fps cap, idle-only, and who
 * releases the camera. Pure. That a real camera delivers a valid, throttled
 * stream and that stopping really puts it away is `camera-preview.grant.test.ts`'s.
 */
describe("camera preview decisions (STC-638)", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "camera-preview",
      sources: ["helper/src/CameraPreviewDecisions.swift", "helper/test/camera-preview/main.swift"],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
