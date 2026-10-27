import { describe, test, expect } from "vitest";
import { placeMenu, MENU_GAP } from "../src/settings-dropdown.js";

// The Settings window is 760 x 560; a trigger is 32 px tall.
const view = { width: 760, height: 560 };
const menu = { width: 168, height: 160 };

describe("placeMenu (STC-581)", () => {
  test("opens below the trigger, left-aligned with it, when there is room", () => {
    expect(placeMenu({ left: 500, top: 100, bottom: 132 }, menu, view))
      .toEqual({ left: 500, top: 132 + MENU_GAP, above: false });
  });
  test("flips above when below would run past the window's bottom", () => {
    expect(placeMenu({ left: 500, top: 480, bottom: 512 }, menu, view))
      .toEqual({ left: 500, top: 480 - MENU_GAP - 160, above: true });
  });
  test("stays below when neither side fits, rather than leaving the top of the window", () => {
    expect(placeMenu({ left: 500, top: 100, bottom: 132 }, { width: 168, height: 500 }, view).above).toBe(false);
  });
  test("is pulled back inside the window's right edge", () => {
    expect(placeMenu({ left: 700, top: 100, bottom: 132 }, menu, view).left).toBe(760 - MENU_GAP - 168);
  });
});
