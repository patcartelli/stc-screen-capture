import { test } from "vitest";

/**
 * Driven by `e2e-diagnostics.test.ts` through `vitest.config.ts` beside it,
 * never by the suite itself (the name matches no project's include). An
 * assertion failure, then four hangs, then a test that would pass: the
 * failure must not count toward the streak, the third hang must trip it, and
 * everything after must be skipped rather than run.
 */
const hang = () => new Promise((r) => setTimeout(r, 5_000));

test("an ordinary failure", () => { throw new Error("expected 1 to be 2"); });
test("hang 1", hang, 100);
test("hang 2", hang, 100);
test("hang 3", hang, 100);
test("would hang 4", hang, 100);
test("would pass", () => {});
