import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

describe("key decisions (STC-419)", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "keys",
      sources: ["helper/src/KeyDecisions.swift", "helper/test/keys/main.swift"],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
