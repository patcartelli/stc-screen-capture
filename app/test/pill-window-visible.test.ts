import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
}));

import { collapsePill } from "../src/pill-window.js";

/** The calls collapsePill makes, in order, on a window in the given state. */
function fakeWindow(state: { minimized: boolean; visible: boolean; loading?: boolean }) {
  const calls: string[] = [];
  const win = {
    isDestroyed: () => false,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    restore: () => { calls.push("restore"); state.minimized = false; state.visible = true; },
    showInactive: () => { calls.push("showInactive"); state.visible = true; },
    getBounds: () => { calls.push("getBounds"); return { x: 10, y: 20, width: 520, height: 680 }; },
    setResizable: () => {},
    setSize: () => {},
    setBounds: () => {},
    setAlwaysOnTop: () => {},
    setVisibleOnAllWorkspaces: () => {},
    setWindowButtonVisibility: () => {},
    webContents: { send: () => {}, isLoading: () => state.loading ?? false },
  };
  return { win, calls };
}

describe("collapsePill makes the window visible first (STC-538)", () => {
  it("un-minimizes a minimized library before measuring its bounds", () => {
    const { win, calls } = fakeWindow({ minimized: true, visible: false });
    collapsePill(win as never, 200);
    expect(calls.indexOf("restore")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("restore")).toBeLessThan(calls.indexOf("getBounds"));
  });

  it("shows a hidden (⌘H) window without taking focus", () => {
    const { win, calls } = fakeWindow({ minimized: false, visible: false });
    collapsePill(win as never, 200);
    expect(calls).toContain("showInactive");
    expect(calls.indexOf("showInactive")).toBeLessThan(calls.indexOf("getBounds"));
  });

  // createWindow({ asPill }) shows it at did-finish-load; shown earlier it came
  // up focused on CI (launch-no-window.e2e).
  it("does not show a window whose page is still loading", () => {
    const { win, calls } = fakeWindow({ minimized: false, visible: false, loading: true });
    collapsePill(win as never, 200);
    expect(calls).not.toContain("showInactive");
  });

  it("leaves an already-visible window alone", () => {
    const { win, calls } = fakeWindow({ minimized: false, visible: true });
    collapsePill(win as never, 200);
    expect(calls).not.toContain("restore");
    expect(calls).not.toContain("showInactive");
  });
});
