import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

describe("anchors.partial.json (STC-530)", () => {
  test("partial = stop-time doc minus stop; atomic write; retire only after anchors.json; writes coalesce", async () => {
    const out = await runSwiftHarness({
      label: "partial-anchors",
      sources: [
        "helper/src/StillDecisions.swift",
        "helper/src/PauseDecisions.swift",
        "helper/src/CaptureGeometry.swift",
        "helper/src/AnchorsDoc.swift",
        "helper/src/PartialAnchors.swift",
        "helper/test/partial-anchors/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
});
