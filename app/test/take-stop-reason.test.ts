import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANCHORS_SIGNAL_REASON, ANCHORS_STOP_REASONS, takeEndedStopReason } from "../src/take-stop-reason.js";

const schema = JSON.parse(readFileSync(join(__dirname, "..", "..", "schema/anchors-12.schema.json"), "utf8"));
const reasonSchema = schema.properties.stop.properties.reason;
const schemaEnum: string[] = reasonSchema.anyOf.find((a: { enum?: string[] }) => a.enum).enum;
const schemaPattern: string = reasonSchema.anyOf.find((a: { pattern?: string }) => a.pattern).pattern;

/** What anchors-12 itself accepts, read from the schema rather than from the module under test. */
const schemaAccepts = (r: string) => schemaEnum.includes(r) || new RegExp(schemaPattern).test(r);

describe("takeEndedStopReason (STC-530)", () => {
  test("the module's list and pattern ARE anchors-12's", () => {
    expect([...ANCHORS_STOP_REASONS].sort()).toEqual([...schemaEnum].sort());
    expect(ANCHORS_SIGNAL_REASON.source).toBe(schemaPattern);
  });

  test.each([
    ["stopped", "user"],
    ["user-timeout", "user-timeout"],
    ["disk-full", "disk-full"],
    ["signal-15", "signal-15"],
    ["helper-stopped", "error"],
    ["helper-idle", "error"],
    [undefined, "error"],
  ])("%s -> %s", (input, want) => {
    const got = takeEndedStopReason(input);
    expect(got).toBe(want);
    expect(schemaAccepts(got)).toBe(true);
  });

  test("every schema reason passes through unchanged", () => {
    for (const r of schemaEnum) expect(takeEndedStopReason(r)).toBe(r);
  });
});
