import { describe, test, expect } from "vitest";
import { latestOnly } from "../src/latest-only.js";

/**
 * STC-489: two library scans in flight at once could answer out of order, and
 * the OLDER one, drawn last, hid the take the newer one had found until
 * something rescanned again. The newest request wins, whatever order the
 * answers arrive in.
 */
describe("latestOnly (STC-489)", () => {
  test("a single request is current", () => {
    const begin = latestOnly();
    const isCurrent = begin();
    expect(isCurrent()).toBe(true);
  });

  test("an older request answering last is not current", () => {
    const begin = latestOnly();
    const older = begin();
    const newer = begin();
    // The newer scan answers first and is drawn; the older one then arrives.
    expect(newer()).toBe(true);
    expect(older()).toBe(false);
  });

  test("the newest of many is the only current one", () => {
    const begin = latestOnly();
    const all = [begin(), begin(), begin(), begin()];
    expect(all.map((c) => c())).toEqual([false, false, false, true]);
  });

  test("gates are independent", () => {
    const a = latestOnly();
    const b = latestOnly();
    const fromA = a();
    b();
    expect(fromA()).toBe(true);
  });
});
