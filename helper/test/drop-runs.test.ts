import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * STC-238: the writer's refusals as timestamped runs. Pure, so the cases a live
 * take cannot be made to produce on demand (a run still open at stop, a drop
 * after teardown began) are asserted directly. The live half — that
 * `STC_CAPTURE_FAULT=encoder-stall` produces one `frames-dropped` warning
 * covering its window — is fault-soak.soak.test.ts's.
 */
describe("dropped-frame runs (STC-238)", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "drop-runs",
      sources: [
        "helper/src/DropRunDecisions.swift",
        "helper/test/drop-runs/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
