import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

// STC-528: the mic's live level, when it counts as silent, and which silent
// stretches the take's sidecar keeps.
describe("mic signal (STC-528)", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "mic-signal",
      sources: ["helper/src/MicSignalDecisions.swift", "helper/test/mic-signal/main.swift"],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
