import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

describe("stream stop decisions (STC-531)", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "stream-stop",
      sources: ["helper/src/StreamStopDecisions.swift", "helper/test/stream-stop/main.swift"],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
