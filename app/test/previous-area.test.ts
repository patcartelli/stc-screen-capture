import { describe, expect, test } from "vitest";
import {
  NO_PREVIOUS_AREAS, cleanPreviousAreas, rememberArea, resolvePreviousArea,
  type ConnectedDisplay,
} from "../src/previous-area.js";

const A: ConnectedDisplay = { id: 1, uuid: "UUID-A", width: 1512, height: 982 };
const B: ConnectedDisplay = { id: 2, uuid: "UUID-B", width: 2560, height: 1440 };
const crop = { x: 100, y: 200, width: 400, height: 300 };

describe("rememberArea / resolvePreviousArea (STC-570)", () => {
  test("nothing remembered overlays", () => {
    expect(resolvePreviousArea(NO_PREVIOUS_AREAS, [A])).toEqual({ kind: "overlay", reason: "none" });
  });

  test("a remembered rect retakes on the same display, by its CURRENT id", () => {
    const areas = rememberArea(NO_PREVIOUS_AREAS, A, crop);
    // The display reconnected under a new numeric id; the uuid is the key.
    expect(resolvePreviousArea(areas, [{ ...A, id: 77 }]))
      .toEqual({ kind: "retake", displayId: 77, crop });
  });

  test("shot and recording are one source: the most recent write wins, per display", () => {
    let areas = rememberArea(NO_PREVIOUS_AREAS, A, crop);                         // a shot
    areas = rememberArea(areas, B, { x: 0, y: 0, width: 640, height: 360 });       // a region recording
    expect(resolvePreviousArea(areas, [A, B]))
      .toEqual({ kind: "retake", displayId: 2, crop: { x: 0, y: 0, width: 640, height: 360 } });
    // A's rectangle is still kept for when it is last again.
    expect(areas.byDisplay["UUID-A"]!.crop).toEqual(crop);
  });

  test("a display that is gone falls back to the overlay", () => {
    const areas = rememberArea(NO_PREVIOUS_AREAS, B, crop);
    expect(resolvePreviousArea(areas, [A])).toEqual({ kind: "overlay", reason: "display-gone" });
  });

  test("a resolution change falls back even when the rect still fits", () => {
    const areas = rememberArea(NO_PREVIOUS_AREAS, A, crop);
    expect(resolvePreviousArea(areas, [{ ...A, width: 1728, height: 1117 }]))
      .toEqual({ kind: "overlay", reason: "layout-changed" });
  });

  test("a rect that no longer fits is never clamped", () => {
    const areas = rememberArea(NO_PREVIOUS_AREAS, A, { x: 1400, y: 900, width: 100, height: 80 });
    expect(resolvePreviousArea(areas, [{ ...A, width: 1400, height: 900 }]))
      .toEqual({ kind: "overlay", reason: "layout-changed" });
  });

  test("a degenerate rect, a missing display or no uuid is not remembered", () => {
    expect(rememberArea(NO_PREVIOUS_AREAS, A, { x: 0, y: 0, width: 0, height: 10 })).toBe(NO_PREVIOUS_AREAS);
    expect(rememberArea(NO_PREVIOUS_AREAS, A, { x: NaN, y: 0, width: 10, height: 10 })).toBe(NO_PREVIOUS_AREAS);
    expect(rememberArea(NO_PREVIOUS_AREAS, undefined, crop)).toBe(NO_PREVIOUS_AREAS);
    expect(rememberArea(NO_PREVIOUS_AREAS, { ...A, uuid: "" }, crop)).toBe(NO_PREVIOUS_AREAS);
  });

  test("survives a relaunch: a round trip through JSON cleans back to the same value", () => {
    const areas = rememberArea(rememberArea(NO_PREVIOUS_AREAS, A, crop), B, crop);
    expect(cleanPreviousAreas(JSON.parse(JSON.stringify(areas)))).toEqual(areas);
  });

  test("malformed stored values mean nothing remembered, never a throw", () => {
    for (const bad of [undefined, null, 3, "x", [], { last: "X" }, { last: "X", byDisplay: { X: { crop: {} } } }]) {
      expect(resolvePreviousArea(cleanPreviousAreas(bad), [A])).toEqual({ kind: "overlay", reason: "none" });
    }
    // One good entry survives a bad neighbour; a `last` pointing nowhere is dropped.
    const mixed = cleanPreviousAreas({
      last: "GONE",
      byDisplay: { "UUID-A": { crop, displayWidth: 1512, displayHeight: 982 }, bad: { crop: { x: 1 } } },
    });
    expect(Object.keys(mixed.byDisplay)).toEqual(["UUID-A"]);
    expect(mixed.last).toBeNull();
  });
});
