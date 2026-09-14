import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";


describe("capture decisions", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "dec",
      sources: [
        // StillDecisions.swift for StillRect/parseRect/number/id32 (STC-370:
        // parseStartRequest and chooseDisplayForWindow reuse them rather
        // than keeping a second copy of "what a rect/id looks like").
        "helper/src/StillDecisions.swift",
        "helper/src/CaptureDecisions.swift",
        "helper/test/decisions/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
