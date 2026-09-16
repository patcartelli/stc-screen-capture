import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * Pause semantics (STC-240). Pure, so this needs no grant and no display —
 * which matters because the interesting cases (a sample exactly on a boundary,
 * a zero-length span) are ones a live recording cannot be made to produce on
 * demand.
 */
describe("pause decisions (STC-240)", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "pause",
      sources: [
        "helper/src/PauseDecisions.swift",
        "helper/test/pauses/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
