import { describe, it, expect } from "vitest";
import { resolveIndicatorTarget } from "../src/scope-indicator.js";
import type { DisplayInfo, WindowInfo } from "../src/selection.js";
import type { ScopeSettings } from "../src/settings.js";

/**
 * `scope-indicator.ts`'s one pure decision (STC-381), with no Electron and no
 * window. See its header for why the window's live bounds are handed in
 * rather than looked up here.
 */

const DISPLAY_A: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const DISPLAY_B: DisplayInfo = { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 800 }, scaleFactor: 2 };
const DISPLAYS = [DISPLAY_A, DISPLAY_B];

const DISPLAY_SCOPE: ScopeSettings = { kind: "display", region: null, windowId: null, windowLabel: null };

describe("resolveIndicatorTarget: display scope", () => {
  it("never draws for Screen scope — the whole display is already unambiguous", () => {
    expect(resolveIndicatorTarget(DISPLAY_SCOPE, DISPLAYS, undefined)).toBeNull();
  });
});

describe("resolveIndicatorTarget: region scope", () => {
  it("converts a display-local region to a global rect on the right display", () => {
    const scope: ScopeSettings = {
      kind: "region", windowId: null, windowLabel: null,
      region: { displayId: 2, x: 40, y: 20, width: 300, height: 200 },
    };
    expect(resolveIndicatorTarget(scope, DISPLAYS, undefined)).toEqual({
      displayId: 2,
      rect: { x: 1960, y: 20, width: 300, height: 200 },
    });
  });

  it("does not draw when the scope is region but nothing has been picked yet", () => {
    const scope: ScopeSettings = { kind: "region", windowId: null, windowLabel: null, region: null };
    expect(resolveIndicatorTarget(scope, DISPLAYS, undefined)).toBeNull();
  });

  it("does not draw when the region names a display that no longer exists", () => {
    const scope: ScopeSettings = {
      kind: "region", windowId: null, windowLabel: null,
      region: { displayId: 99, x: 0, y: 0, width: 100, height: 100 },
    };
    expect(resolveIndicatorTarget(scope, DISPLAYS, undefined)).toBeNull();
  });
});

describe("resolveIndicatorTarget: window scope", () => {
  const scope: ScopeSettings = {
    kind: "window", region: null, windowId: 42, windowLabel: "Finder",
  };

  it("draws the window's LIVE bounds, on the display they currently sit on", () => {
    const live: WindowInfo = { id: 42, app: "Finder", title: "Documents",
      bounds: { x: 1990, y: 60, width: 400, height: 300 } };
    expect(resolveIndicatorTarget(scope, DISPLAYS, live)).toEqual({
      displayId: 2,
      rect: { x: 1990, y: 60, width: 400, height: 300 },
    });
  });

  it("does not draw when the scope is window but nothing has been picked yet", () => {
    const empty: ScopeSettings = { kind: "window", region: null, windowId: null, windowLabel: null };
    const live: WindowInfo = { id: 42, bounds: { x: 0, y: 0, width: 100, height: 100 } };
    expect(resolveIndicatorTarget(empty, DISPLAYS, live)).toBeNull();
  });

  it("does not draw when the fresh lookup found nothing — a closed window, never a stale rect", () => {
    expect(resolveIndicatorTarget(scope, DISPLAYS, undefined)).toBeNull();
  });

  it("does not draw a DIFFERENT window than the one the scope names", () => {
    const wrong: WindowInfo = { id: 7, bounds: { x: 0, y: 0, width: 100, height: 100 } };
    expect(resolveIndicatorTarget(scope, DISPLAYS, wrong)).toBeNull();
  });

  it("does not draw when the window's centre falls on no known display", () => {
    // Off in space — neither display's bounds contain its centre.
    const live: WindowInfo = { id: 42, bounds: { x: 5000, y: 5000, width: 100, height: 100 } };
    expect(resolveIndicatorTarget(scope, DISPLAYS, live)).toBeNull();
  });

  it("picks the display the window's CENTRE falls on, not its top-left corner", () => {
    // Straddles the bezel: origin on display A, centre on display B.
    const live: WindowInfo = { id: 42, bounds: { x: 1800, y: 100, width: 400, height: 200 } };
    const target = resolveIndicatorTarget(scope, DISPLAYS, live);
    expect(target?.displayId).toBe(2);
  });
});
