import { describe, test, expect } from "vitest";
import {
  decideRedactKey, moveRegion, placeRegion, resizeRegion, selectionAfterDelete,
  KEYBOARD_REDACTION_SIZE, MIN_REDACTION_PX, REDACTION_STEP, REDACTION_STEP_LARGE,
  type RedactKeyState,
} from "../src/still-redact.js";

/**
 * STC-576: redaction from the keyboard — place, select, move, resize, delete —
 * as arithmetic, with no canvas and no DOM. `app/test/redaction.e2e.test.ts`
 * is what proves the canvas really takes the focus and acts on these.
 */

const frame = { width: 1000, height: 500 };
const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.2 };
const none: RedactKeyState = { regions: [], selected: undefined };
const one: RedactKeyState = { regions: [box], selected: 0 };

describe("placeRegion", () => {
  test("is centred, at the keyboard size, inside the frame", () => {
    const r = placeRegion();
    expect(r.width).toBe(KEYBOARD_REDACTION_SIZE.width);
    expect(r.height).toBe(KEYBOARD_REDACTION_SIZE.height);
    expect(r.x + r.width / 2).toBeCloseTo(0.5);
    expect(r.y + r.height / 2).toBeCloseTo(0.5);
  });
});

describe("moveRegion", () => {
  test("moves by the step and keeps the size", () => {
    expect(moveRegion(box, 0.01, -0.01)).toEqual({ ...box, x: box.x + 0.01, y: box.y - 0.01 });
  });

  test("stops at every edge rather than leaving the frame", () => {
    expect(moveRegion(box, -5, -5)).toEqual({ ...box, x: 0, y: 0 });
    const r = moveRegion(box, 5, 5);
    expect(r.x + r.width).toBeCloseTo(1);
    expect(r.y + r.height).toBeCloseTo(1);
    expect(r.width).toBe(box.width);
  });
});

describe("resizeRegion", () => {
  test("grows and shrinks from the bottom-right corner; the top-left stays put", () => {
    const r = resizeRegion(box, 0.1, -0.05, frame);
    expect(r).toEqual({ x: box.x, y: box.y, width: box.width + 0.1, height: box.height - 0.05 });
  });

  test("never past the frame's edge", () => {
    const r = resizeRegion(box, 5, 5, frame);
    expect(box.x + r.width).toBeCloseTo(1);
    expect(box.y + r.height).toBeCloseTo(1);
  });

  test("never under MIN_REDACTION_PX capture pixels, so no key makes a box a click would not", () => {
    const r = resizeRegion(box, -5, -5, frame);
    expect(r.width * frame.width).toBeCloseTo(MIN_REDACTION_PX);
    expect(r.height * frame.height).toBeCloseTo(MIN_REDACTION_PX);
  });
});

describe("decideRedactKey", () => {
  test("Return or Space places a new box and selects it", () => {
    for (const key of ["Enter", " "]) {
      const r = decideRedactKey({ key }, one, frame)!;
      expect(r.changed).toBe(true);
      expect(r.regions).toEqual([box, placeRegion()]);
      expect(r.selected).toBe(1);
    }
  });

  test("] and [ walk the boxes and wrap, and change nothing on disk", () => {
    const two: RedactKeyState = { regions: [box, placeRegion()], selected: undefined };
    expect(decideRedactKey({ key: "]" }, two, frame)).toMatchObject({ selected: 0, changed: false });
    expect(decideRedactKey({ key: "[" }, two, frame)).toMatchObject({ selected: 1, changed: false });
    expect(decideRedactKey({ key: "]" }, { ...two, selected: 1 }, frame)!.selected).toBe(0);
    expect(decideRedactKey({ key: "[" }, { ...two, selected: 0 }, frame)!.selected).toBe(1);
    expect(decideRedactKey({ key: "]" }, none, frame)).toMatchObject({ selected: undefined, changed: false });
  });

  test("arrows move the selected box by a step; ⇧ by the large step", () => {
    const r = decideRedactKey({ key: "ArrowRight" }, one, frame)!;
    expect(r.changed).toBe(true);
    expect(r.regions[0]!.x).toBeCloseTo(box.x + REDACTION_STEP);
    const big = decideRedactKey({ key: "ArrowDown", shiftKey: true }, one, frame)!;
    expect(big.regions[0]!.y).toBeCloseTo(box.y + REDACTION_STEP_LARGE);
    expect(big.regions[0]!.width).toBe(box.width);
  });

  test("⌥ + arrows resize the selected box instead", () => {
    const r = decideRedactKey({ key: "ArrowLeft", altKey: true }, one, frame)!;
    expect(r.regions[0]).toMatchObject({ x: box.x, y: box.y });
    expect(r.regions[0]!.width).toBeCloseTo(box.width - REDACTION_STEP);
  });

  test("an arrow that the frame's edge stops is not a change, so nothing is written", () => {
    const atEdge: RedactKeyState = { regions: [{ ...box, x: 0 }], selected: 0 };
    expect(decideRedactKey({ key: "ArrowLeft" }, atEdge, frame)!.changed).toBe(false);
  });

  test("Delete and Backspace remove the selected box; the selection steps back", () => {
    const two: RedactKeyState = { regions: [box, placeRegion()], selected: 1 };
    for (const key of ["Delete", "Backspace"]) {
      const r = decideRedactKey({ key }, two, frame)!;
      expect(r).toMatchObject({ regions: [box], selected: 0, changed: true });
    }
    expect(decideRedactKey({ key: "Delete" }, one, frame)).toMatchObject({ regions: [], selected: undefined, changed: true });
  });

  test("with nothing selected, arrows and Delete are the canvas's but do nothing", () => {
    const unselected: RedactKeyState = { regions: [box], selected: undefined };
    for (const key of ["ArrowUp", "Delete"]) {
      expect(decideRedactKey({ key }, unselected, frame)).toMatchObject({ regions: [box], changed: false });
    }
  });

  test("a stale selection past the end is treated as none", () => {
    expect(decideRedactKey({ key: "Delete" }, { regions: [box], selected: 4 }, frame))
      .toMatchObject({ regions: [box], selected: undefined, changed: false });
  });

  test("leaves the window's keys alone: ⌘/⌃ shortcuts, Tab, Escape, plain letters", () => {
    for (const k of [{ key: "z", metaKey: true }, { key: "ArrowLeft", metaKey: true },
                     { key: "Enter", ctrlKey: true }, { key: "Tab" }, { key: "Escape" }, { key: "a" }]) {
      expect(decideRedactKey(k, one, frame)).toBeUndefined();
    }
  });
});

describe("selectionAfterDelete", () => {
  test("steps back one, stays at 0, and is none once nothing is left", () => {
    expect(selectionAfterDelete(2, 2)).toBe(1);
    expect(selectionAfterDelete(0, 3)).toBe(0);
    expect(selectionAfterDelete(0, 0)).toBeUndefined();
  });
});
