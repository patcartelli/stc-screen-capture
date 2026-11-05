import { describe, expect, test } from "vitest";
import { clampEdge, overlaps, placeNewBlock, refusalText } from "../src/zoom-placement.js";

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

describe("clampEdge", () => {
  const D = 20 * S;
  const span = { startNs: 5 * S, endNs: 8 * S };
  const others = [{ startNs: 1 * S, endNs: 3 * S }, { startNs: 10 * S, endNs: 12 * S }];

  test("an end dragged right stops at the next block's start, and can be dragged back", () => {
    expect(clampEdge("end", 15 * S, span, others, D, MIN)).toBe(10 * S);
    expect(clampEdge("end", 9 * S, span, others, D, MIN)).toBe(9 * S);
  });

  test("a start dragged left stops at the previous block's end", () => {
    expect(clampEdge("start", 0, span, others, D, MIN)).toBe(3 * S);
    expect(clampEdge("start", 4 * S, span, others, D, MIN)).toBe(4 * S);
  });

  test("with no neighbour the edge runs to the take's edge", () => {
    expect(clampEdge("end", 99 * S, span, [], D, MIN)).toBe(D);
    expect(clampEdge("start", -5 * S, span, [], D, MIN)).toBe(0);
  });

  test("an edge keeps the minimum length from the other edge", () => {
    expect(clampEdge("end", 0, span, others, D, MIN)).toBe(5 * S + MIN);
    expect(clampEdge("start", 99 * S, span, others, D, MIN)).toBe(8 * S - MIN);
  });

  test("a block the draft already overlaps is not a wall", () => {
    const overlapping = [{ startNs: 6 * S, endNs: 7 * S }];
    expect(clampEdge("end", 15 * S, span, overlapping, D, MIN)).toBe(15 * S);
    expect(clampEdge("start", 0, span, overlapping, D, MIN)).toBe(0);
  });
});

describe("overlap helpers", () => {
  test("touching edges do not overlap", () => {
    expect(overlaps({ startNs: 0, endNs: 5 }, { startNs: 5, endNs: 9 })).toBe(false);
    expect(overlaps({ startNs: 0, endNs: 6 }, { startNs: 5, endNs: 9 })).toBe(true);
  });

  test("each refusal has its own sentence", () => {
    expect(refusalText("on-block")).not.toBe(refusalText("no-room"));
  });
});
