import { describe, test, expect } from "vitest";
import {
  centredIn, clampSize, libraryBounds, settingsBounds, cleanWindowBounds,
  LIBRARY_SIZE, LIBRARY_MIN_SIZE, SETTINGS_SIZE,
} from "../src/window-size.js";

// A 14" MacBook's work area under the menu bar, and a second display to its right.
const laptop = { x: 0, y: 38, width: 1512, height: 944 };
const external = { x: 1512, y: 0, width: 2560, height: 1415 };
// Smaller than the library's default in both directions.
const tiny = { x: 0, y: 25, width: 800, height: 575 };

describe("the default sizes (STC-560)", () => {
  test("the library fits four 210px grid columns inside the 20px gutters", () => {
    expect(LIBRARY_SIZE.width).toBeGreaterThanOrEqual(4 * 210 + 3 * 14 + 2 * 20);
  });
  test("its floor still fits two", () => {
    expect(LIBRARY_MIN_SIZE.width).toBeGreaterThanOrEqual(2 * 210 + 14 + 2 * 20);
  });
  test("Settings is STC-581's 760 x 560: a 180px sidebar and a 580px pane", () => {
    expect(SETTINGS_SIZE).toEqual({ width: 180 + 580, height: 560 });
  });
});

describe("centredIn", () => {
  test("centres a size that fits", () => {
    expect(centredIn({ width: 960, height: 720 }, laptop)).toEqual({ x: 276, y: 150, width: 960, height: 720 });
  });
  test("clamps to the work area on a small display, never off screen", () => {
    expect(centredIn(LIBRARY_SIZE, tiny)).toEqual(tiny);
  });
  test("whole pixels", () => {
    const r = centredIn({ width: 101, height: 101 }, { x: 0, y: 0, width: 200, height: 200 });
    expect(Number.isInteger(r.x) && Number.isInteger(r.y)).toBe(true);
  });
});

test("clampSize keeps a minimum inside the display", () => {
  expect(clampSize({ width: 960, height: 720 }, tiny)).toEqual({ width: 800, height: 575 });
  expect(clampSize(LIBRARY_MIN_SIZE, laptop)).toEqual(LIBRARY_MIN_SIZE);
});

describe("libraryBounds", () => {
  test("nothing remembered: the default, centred on the display it opens on", () => {
    expect(libraryBounds(null, [laptop, external], external)).toEqual(centredIn(LIBRARY_SIZE, external));
  });
  test("a remembered place on a connected display is used as is", () => {
    const saved = { x: 1700, y: 100, width: 1200, height: 900 };
    expect(libraryBounds(saved, [laptop, external], laptop)).toEqual(saved);
  });
  test("a remembered place on a display that is gone: the default", () => {
    const saved = { x: 1700, y: 100, width: 1200, height: 900 };
    expect(libraryBounds(saved, [laptop], laptop)).toEqual(centredIn(LIBRARY_SIZE, laptop));
  });
  test("a title bar under the menu bar or above the screen does not count as on it", () => {
    const saved = { x: 100, y: -200, width: 900, height: 700 };
    expect(libraryBounds(saved, [laptop], laptop)).toEqual(centredIn(LIBRARY_SIZE, laptop));
  });
  test("hanging off the edge: pulled fully inside the display it is on", () => {
    const saved = { x: 1000, y: 500, width: 960, height: 720 };
    expect(libraryBounds(saved, [laptop], laptop)).toEqual({ x: 552, y: 262, width: 960, height: 720 });
  });
  test("bigger than the display it is on (it moved to a smaller one): shrunk to fit", () => {
    const saved = { x: 10, y: 40, width: 2400, height: 1400 };
    expect(libraryBounds(saved, [tiny], tiny)).toEqual(tiny);
  });
  test("smaller than the floor: raised to it", () => {
    const saved = { x: 100, y: 100, width: 200, height: 150 };
    expect(libraryBounds(saved, [laptop], laptop)).toEqual({ x: 100, y: 100, ...LIBRARY_MIN_SIZE });
  });
});

test("Settings opens at its own size, centred and clamped", () => {
  expect(settingsBounds(laptop)).toEqual(centredIn(SETTINGS_SIZE, laptop));
  expect(settingsBounds({ x: 0, y: 0, width: 500, height: 500 })).toEqual({ x: 0, y: 0, width: 500, height: 500 });
});

describe("cleanWindowBounds", () => {
  test("accepts four finite numbers with a positive size, rounded", () => {
    expect(cleanWindowBounds({ x: 1.4, y: -20, width: 960.6, height: 720 })).toEqual({ x: 1, y: -20, width: 961, height: 720 });
  });
  test.each([
    null, undefined, "960x720", [0, 0, 960, 720], {},
    { x: 0, y: 0, width: 960 },
    { x: 0, y: 0, width: 0, height: 720 },
    { x: 0, y: 0, width: 960, height: -1 },
    { x: Number.NaN, y: 0, width: 960, height: 720 },
    { x: "0", y: 0, width: 960, height: 720 },
  ])("refuses %j", (v) => {
    expect(cleanWindowBounds(v)).toBeNull();
  });
});
