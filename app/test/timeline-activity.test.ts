import { describe, expect, test } from "vitest";
import { clipActivity, zoomCurve, CLICK_WEIGHT, MOVE_WEIGHT } from "../src/timeline-activity.js";
import type { SessionEvent } from "@transform/types.js";

const S = 1_000_000_000;

describe("clipActivity", () => {
  test("an event list with nothing in it produces all zeros, not NaN", () => {
    expect(clipActivity([], 10 * S, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  test("zero duration is a real answer, not a division by zero", () => {
    const events: SessionEvent[] = [{ t: 0, kind: "down", x: 0, y: 0, button: 0 }];
    expect(clipActivity(events, 0, 4)).toEqual([0, 0, 0, 0]);
  });

  test("a click bucket normalises to 1, the loudest bucket in the take", () => {
    const events: SessionEvent[] = [{ t: 0, kind: "down", x: 0, y: 0, button: 0 }];
    const out = clipActivity(events, 4 * S, 4);
    expect(out[0]).toBe(1);
    expect(out.slice(1)).toEqual([0, 0, 0]);
  });

  test("clicks outweigh bare moves at the same count", () => {
    const clicks: SessionEvent[] = [
      { t: 0, kind: "down", x: 0, y: 0, button: 0 },
      { t: 0, kind: "up", x: 0, y: 0, button: 0 },
    ];
    const moves: SessionEvent[] = [
      { t: 3 * S, kind: "move", x: 0, y: 0 },
      { t: 3 * S, kind: "move", x: 1, y: 1 },
    ];
    const out = clipActivity([...clicks, ...moves], 4 * S, 4);
    // bucket 0 (clicks) = 2 * CLICK_WEIGHT, bucket 3 (moves) = 2 * MOVE_WEIGHT.
    expect(out[0]).toBe(1);
    expect(out[3]).toBeCloseTo((2 * MOVE_WEIGHT) / (2 * CLICK_WEIGHT), 6);
  });

  test("a cursor-shape event contributes nothing", () => {
    const events: SessionEvent[] = [{ t: 0, kind: "cursor", shape: "arrow" as never }];
    expect(clipActivity(events, 4 * S, 4)).toEqual([0, 0, 0, 0]);
  });

  test("an event past the end of the take clamps into the last bucket", () => {
    const events: SessionEvent[] = [{ t: 100 * S, kind: "down", x: 0, y: 0, button: 0 }];
    const out = clipActivity(events, 4 * S, 4);
    expect(out[3]).toBe(1);
  });
});

describe("zoomCurve", () => {
  test("samples a constant function at a constant value", () => {
    expect(zoomCurve(() => 0.5, 10 * S, 5)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  test("the first and last samples land on the take's own ends", () => {
    const seen: number[] = [];
    zoomCurve((tNs) => { seen.push(tNs); return tNs; }, 10 * S, 3);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(10 * S);
  });

  test("refuses to divide by a sample count under 2, clamping to 2", () => {
    expect(zoomCurve(() => 0, S, 1)).toHaveLength(2);
    expect(zoomCurve(() => 0, S, 0)).toHaveLength(2);
  });
});
