import { describe, expect, test } from "vitest";
import { overlappingPairs, overlaps, placeNewBlock, refusalText } from "../src/zoom-placement.js";

const S = 1_000_000_000;
const MIN = 300_000_000;
const around = (t: number) => ({ startNs: Math.max(0, t - 0.3 * S), endNs: t + 2.5 * S });

describe("placeNewBlock", () => {
  test("an empty lane takes the default span as is", () => {
    const r = placeNewBlock(10 * S, around(10 * S), [], MIN);
    expect(r).toEqual({ ok: true, span: around(10 * S) });
  });

  test("the pointer on a block is refused, wherever in it", () => {
    const occupied = [{ startNs: 5 * S, endNs: 8 * S }];
    for (const t of [5 * S, 6 * S, 8 * S - 1]) {
      expect(placeNewBlock(t, around(t), occupied, MIN)).toEqual({ ok: false, reason: "on-block" });
    }
  });

  test("the pointer exactly at a block's end is beside it, and the new block starts there", () => {
    const r = placeNewBlock(8 * S, around(8 * S), [{ startNs: 5 * S, endNs: 8 * S }], MIN);
    expect(r).toEqual({ ok: true, span: { startNs: 8 * S, endNs: 10.5 * S } });
  });

  test("a block ahead trims the end; a block behind trims the start", () => {
    const ahead = placeNewBlock(10 * S, around(10 * S), [{ startNs: 11 * S, endNs: 20 * S }], MIN);
    expect(ahead).toEqual({ ok: true, span: { startNs: 9.7 * S, endNs: 11 * S } });
    const behind = placeNewBlock(10 * S, around(10 * S), [{ startNs: 0, endNs: 9.9 * S }], MIN);
    expect(behind).toEqual({ ok: true, span: { startNs: 9.9 * S, endNs: 12.5 * S } });
  });

  test("a gap under the floor is refused, not shrunk to nothing", () => {
    const occupied = [{ startNs: 0, endNs: 10 * S }, { startNs: 10.1 * S, endNs: 20 * S }];
    expect(placeNewBlock(10 * S, around(10 * S), occupied, MIN)).toEqual({ ok: false, reason: "no-room" });
  });

  test("the result never overlaps anything it was given", () => {
    const occupied = [
      { startNs: 2 * S, endNs: 4 * S }, { startNs: 9 * S, endNs: 12 * S }, { startNs: 14 * S, endNs: 15 * S },
    ];
    for (let t = 0; t <= 20 * S; t += 0.1 * S) {
      const r = placeNewBlock(t, around(t), occupied, MIN);
      if (r.ok) for (const o of occupied) expect(overlaps(r.span, o)).toBe(false);
    }
  });
});

describe("overlap helpers", () => {
  test("touching edges do not overlap", () => {
    expect(overlaps({ startNs: 0, endNs: 5 }, { startNs: 5, endNs: 9 })).toBe(false);
    expect(overlaps({ startNs: 0, endNs: 6 }, { startNs: 5, endNs: 9 })).toBe(true);
  });

  test("overlappingPairs names every pair", () => {
    const spans = [{ startNs: 0, endNs: 5 }, { startNs: 4, endNs: 8 }, { startNs: 7, endNs: 9 }, { startNs: 20, endNs: 21 }];
    expect(overlappingPairs(spans)).toEqual([[0, 1], [1, 2]]);
  });

  test("each refusal has its own sentence", () => {
    expect(refusalText("on-block")).not.toBe(refusalText("no-room"));
  });
});
