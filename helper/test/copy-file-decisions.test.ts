import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * STC-488: `copy-file`'s request decisions, without a pasteboard. Runs on CI.
 * The pasteboard itself needs a logged-in session and lives in the grant suite
 * (`copy-file.grant.test.ts`), the same split the still path has.
 */
describe("copy-file decisions (STC-488)", () => {
  test("Swift pure-function assertions pass", async () => {
    const out = await runSwiftHarness({
      label: "copy-file",
      sources: ["helper/src/CopyFileDecisions.swift", "helper/test/copy-file/main.swift"],
    });
    expect(out, out).toContain("ALL PASS");
  });
});
