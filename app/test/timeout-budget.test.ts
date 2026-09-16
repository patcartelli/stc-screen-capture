import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  readBudgets, hasClearance, innerSum, describeViolation,
  E2E_DEFAULT_TEST_MS, type TestBudget,
} from "./_timeout-budget.js";

const HERE = new URL(".", import.meta.url).pathname;

/** The first budget in `src`, refusing rather than returning undefined. */
function only(src: string): TestBudget {
  const [b, ...rest] = readBudgets("f.e2e.test.ts", src);
  if (!b) throw new Error("the reader found no test at all in this source");
  if (rest.length) throw new Error(`expected one test, the reader found ${rest.length + 1}`);
  return b;
}
const e2eFiles = readdirSync(HERE).filter((f) => f.endsWith(".e2e.test.ts")).sort();

function allBudgets(): TestBudget[] {
  return e2eFiles.flatMap((f) => readBudgets(f, readFileSync(join(HERE, f), "utf8")));
}

describe("the rule", () => {
  const b = (outerMs: number, innerMs: number[], declared = true): TestBudget =>
    ({ file: "f.e2e.test.ts", name: "t", outerMs, innerMs, declared });

  test("an outer bound above its inner sum has clearance", () => {
    expect(hasClearance(b(60_000, [10_000, 10_000, 10_000]))).toBe(true);
  });

  test("EQUAL is a violation — that is the case that actually failed", () => {
    // 30s of polls under a 30s test: the outer bound always wins the race, so
    // the poll never names what it was waiting for.
    expect(hasClearance(b(30_000, [10_000, 10_000, 10_000]))).toBe(false);
  });

  test("an inner sum ABOVE the outer bound is a violation too", () => {
    expect(hasClearance(b(30_000, [10_000, 10_000, 10_000, 10_000]))).toBe(false);
  });

  test("a test with no inner bounds at all is never a violation", () => {
    expect(hasClearance(b(15_000, []))).toBe(true);
  });

  test("the message names both numbers, not just the verdict", () => {
    const msg = describeViolation(b(30_000, [10_000, 10_000, 10_000]));
    expect(msg).toContain("30000");
    expect(msg).toContain("30000ms inside");
    expect(msg).toContain("10000 + 10000 + 10000");
  });

  test("an inherited bound says so, because the fix differs", () => {
    // A declared bound is raised; an inherited one has to be written down
    // first, and a reader needs to know which they are looking at.
    expect(describeViolation(b(15_000, [10_000, 10_000], false)))
      .toContain("inherits the 15000ms default");
  });
});

describe("the reader", () => {
  test("reads a declared bound and the polls inside it", () => {
    const src = `
  test("a thing", async () => {
    await expect.poll(() => x, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => y, { timeout: 5_000 }).toBe(2);
  }, 60_000);
`;
    const b = only(src);
    expect(b.name).toBe("a thing");
    expect(b.outerMs).toBe(60_000);
    expect(b.declared).toBe(true);
    expect(innerSum(b)).toBe(15_000);
  });

  test("a test with no declared bound inherits the project default, and is marked as inheriting", () => {
    const src = `
  test("no bound", async () => {
    await expect.poll(() => x, { timeout: 10_000 }).toBe(1);
  });
`;
    const b = only(src);
    expect(b.outerMs).toBe(E2E_DEFAULT_TEST_MS);
    expect(b.declared).toBe(false);
  });

  test("an escaped quote in a test name does not truncate it", () => {
    // The test this whole guard came from is named
    // `"Delete window" removes the whole entry`, quotes and all.
    const src = `
  test("\\"Delete window\\" removes it", async () => {
    await expect.poll(() => x, { timeout: 10_000 }).toBe(1);
  }, 60_000);
`;
    expect(only(src).name).toBe('"Delete window" removes it');
  });

  test("reads a TEMPLATE-LITERAL test name too", () => {
    // `nothing-lost.e2e.test.ts` builds its names from a constant. A reader
    // that knew only double quotes found zero tests in that file and said
    // nothing — the failure mode a guard must not have.
    const src = [
      "",
      "  test(`${N} captures leave ${N} shots`, async () => {",
      "    await expect.poll(() => x, { timeout: 10_000 }).toBe(1);",
      "  }, 60_000);",
      "",
    ].join("\n");
    const b = only(src);
    expect(b.name).toContain("captures leave");
    expect(b.outerMs).toBe(60_000);
  });

  test("reads every test in a file, not just the first", () => {
    const src = `
  test("one", async () => {
    await expect.poll(() => x, { timeout: 1_000 }).toBe(1);
  }, 30_000);

  test("two", async () => {
    await expect.poll(() => y, { timeout: 2_000 }).toBe(2);
  }, 30_000);
`;
    expect(readBudgets("f.e2e.test.ts", src).map((b) => b.name)).toEqual(["one", "two"]);
  });
});

describe("the suite itself", () => {
  test("the reader finds the tests that are really there", () => {
    // A guard that silently reads nothing passes forever. Pin it against the
    // file count and a lower bound on tests, so a parser that stops working
    // fails here rather than going quiet.
    const budgets = allBudgets();
    expect(e2eFiles.length).toBeGreaterThan(20);
    expect(budgets.length).toBeGreaterThan(150);
    expect(new Set(budgets.map((b) => b.file)).size).toBe(e2eFiles.length);
  });

  test("every E2E test's own timeout exceeds the bounds waiting inside it", () => {
    const bad = allBudgets().filter((b) => !hasClearance(b));
    expect(bad.map(describeViolation).join("\n")).toBe("");
  });
});
