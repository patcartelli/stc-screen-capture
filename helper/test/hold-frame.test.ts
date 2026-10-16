import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * STC-561: when the display writer gets the last frame again. Pure, so the
 * timings a live take cannot be made to produce on demand (a check landing
 * late, frames refused just before a hold) are asserted directly. That the
 * writer really needs this is `fragmented-writer.test.ts`'s gap table; that a
 * real take survives a still screen is `idle-hold.grant.test.ts`'s.
 */
describe("hold frames (STC-561)", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "hold-frame",
      sources: [
        "helper/src/HoldFrameDecisions.swift",
        "helper/test/hold-frame/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
