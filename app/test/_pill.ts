import type { ElectronApplication, Page } from "playwright";
import { pageWithUrl } from "./_windows.js";

/**
 * The pill's own window (STC-550), for every e2e test that looks at it.
 *
 * Read from the MAIN process (`_windows.ts`'s rule): the pill is made at
 * opacity 0 before `start` and only becomes visible off the confirmed
 * recording state, so "is there a pill window" and "is the pill showing" are
 * different questions, and only `getOpacity()` tells them apart.
 *
 * Nothing here reads a size or a position: this sandbox's Xvfb has no window
 * manager (`pill.e2e.test.ts`'s header), so geometry is the runbook's.
 */
export interface PillWindowState {
  /** A pill window exists at all (visible or still invisible). */
  exists: boolean;
  /** Made and on screen at opacity 1: the take is live and the pill says so. */
  showing: boolean;
  alwaysOnTop: boolean;
  resizable: boolean;
  minimizable: boolean;
  focused: boolean;
}

export function pillWindowState(app: ElectronApplication): Promise<PillWindowState> {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("pill.html"));
    if (!w) return { exists: false, showing: false, alwaysOnTop: false, resizable: false, minimizable: false, focused: false };
    return {
      exists: true,
      showing: w.isVisible() && w.getOpacity() === 1,
      alwaysOnTop: w.isAlwaysOnTop(),
      resizable: w.isResizable(),
      minimizable: w.isMinimizable(),
      focused: w.isFocused(),
    };
  });
}

/** Whether the pill is up and showing — the poll most tests want. */
export function pillShowing(app: ElectronApplication): Promise<boolean> {
  return pillWindowState(app).then((s) => s.showing);
}

/** The pill window's page, to read or click. */
export function pillPage(app: ElectronApplication): Promise<Page> {
  return pageWithUrl(app, "pill.html");
}
