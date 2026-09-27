import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";


describe("display change decisions", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "display-change",
      sources: [
        "helper/src/StillDecisions.swift",
        // StillDecisions.swift's shotDocument(...) signature names
        // DisplayGeometry (AnchorsDoc.swift) and anchorsDocument(...) there
        // names PauseInterval (PauseDecisions.swift) — needed to compile even
        // though this harness never calls either, the same reason
        // still-decisions.test.ts carries them.
        "helper/src/PauseDecisions.swift",
        "helper/src/CaptureGeometry.swift",
        "helper/src/AnchorsDoc.swift",
        "helper/src/DisplayChangeDecisions.swift",
        "helper/test/display-change/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
