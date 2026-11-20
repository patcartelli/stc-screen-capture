import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

/** STC-671: `make-poster`'s decisions (which frame, which request), without a video. Runs on CI. */
describe("make-poster decisions (STC-671)", () => {
  test("Swift pure-function assertions pass", async () => {
    const out = await runSwiftHarness({
      label: "poster",
      sources: ["helper/src/PosterDecisions.swift", "helper/test/poster/main.swift"],
    });
    expect(out, out).toContain("ALL PASS");
  });
});
