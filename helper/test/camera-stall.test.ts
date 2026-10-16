import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

// STC-553: when a camera that has delivered frames counts as stalled — not a pause, not
// a slow camera, not a healthy one — and which stretches the take's sidecar keeps.
describe("camera stall (STC-553)", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "camera-stall",
      sources: ["helper/src/CameraStallDecisions.swift", "helper/test/camera-stall/main.swift"],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
