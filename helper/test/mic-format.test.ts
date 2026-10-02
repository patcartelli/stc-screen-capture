import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

// STC-485: the mic's pinned capture format and the guard that ends the mic
// track, loudly, rather than writing bytes that do not match their label.
describe("mic format guard (STC-485)", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "mic-format",
      sources: ["helper/src/MicFormatDecisions.swift", "helper/test/mic-format/main.swift"],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
