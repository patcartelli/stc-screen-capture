import { describe, test, expect } from "vitest";
import {
  DEFAULT_ICON_PLACEMENT, ICON_PLACEMENTS, ICON_PLACEMENT_LABELS, cleanIconPlacement, decideIcons,
} from "../src/icon-placement.js";

/**
 * Where the icon lives (STC-502): the table in the ticket, row by row, plus the
 * two things a table does not say — there is no "neither", and a stored value
 * that is not one of the three cannot get through.
 */

describe("decideIcons", () => {
  test("Menu bar and Dock: both, whether or not a window is open", () => {
    expect(decideIcons("both", 0)).toEqual({ tray: true, dock: true });
    expect(decideIcons("both", 3)).toEqual({ tray: true, dock: true });
  });

  test("Dock only: no menu-bar item, Dock icon always", () => {
    expect(decideIcons("dock", 0)).toEqual({ tray: false, dock: true });
    expect(decideIcons("dock", 2)).toEqual({ tray: false, dock: true });
  });

  test("Menu bar only: the Dock icon is there for exactly as long as a window is", () => {
    expect(decideIcons("menubar", 0)).toEqual({ tray: true, dock: false });
    expect(decideIcons("menubar", 1)).toEqual({ tray: true, dock: true });
    // The last of several closing is what takes it away, not the first.
    expect(decideIcons("menubar", 2)).toEqual({ tray: true, dock: true });
  });

  test("no setting leaves the user with neither icon", () => {
    // Rule 1: hiding both would leave the hotkey as the only way back in.
    for (const placement of ICON_PLACEMENTS) {
      for (const windows of [0, 1, 2]) {
        const { tray, dock } = decideIcons(placement, windows);
        // With no window open, at least one of the two must be there to click.
        if (windows === 0) expect(tray || dock).toBe(true);
      }
    }
  });
});

describe("cleanIconPlacement", () => {
  test("the default is Menu bar and Dock", () => {
    expect(DEFAULT_ICON_PLACEMENT).toBe("both");
    expect(ICON_PLACEMENT_LABELS[DEFAULT_ICON_PLACEMENT]).toBe("Menu bar and Dock");
  });

  test("keeps the three values", () => {
    for (const p of ICON_PLACEMENTS) expect(cleanIconPlacement(p)).toBe(p);
  });

  test("anything else, including a hand-typed 'none', falls back to the default", () => {
    for (const bad of ["none", "", "BOTH", undefined, null, 1, {}, ["dock"]]) {
      expect(cleanIconPlacement(bad)).toBe(DEFAULT_ICON_PLACEMENT);
    }
  });

  test("every setting has a label to show", () => {
    expect(Object.keys(ICON_PLACEMENT_LABELS).sort()).toEqual([...ICON_PLACEMENTS].sort());
  });
});
