import { BrowserWindow, screen } from "electron";
import type { HelperSupervisor } from "./supervisor.js";
import {
  PILL_HEIGHT_PX, RESTORED_WIDTH_PX, clampPillWidth, decidePillAction,
  type PillWindowState,
} from "./pill.js";

/**
 * The pill's real window mechanics (STC-375). `pill.ts` decides WHAT the
 * window should be; this does the actual `BrowserWindow` calls, the same
 * split `overlay-session.ts` and `thumbnail-window.ts` make for their own
 * windowed interactions.
 *
 * SCAFFOLD, not yet wired into `main.ts` — see `pill.ts`'s header for why.
 * Every function here operates on a `BrowserWindow` handed to it rather than
 * one it creates and owns, so it can be pointed at the app's real main
 * window once STC-374 has stripped it down to capture + grid, without this
 * file changing.
 */

export interface PillGeometry {
  /** The instrument's height, once STC-374 has settled it — not guessed here. */
  instrumentHeight: number;
}

/**
 * The ticket's own pseudocode, in order: measure the content, lock resizing,
 * shrink to the pill, float above everything, and survive a Space switch.
 *
 * `"screen-saver"` is the level `overlay-session.ts` already uses.
 * `setVisibleOnAllWorkspaces` is what stops the pill vanishing on a Space
 * switch mid-take — the ticket's own reasoning, and screen recordings
 * involve Space switches constantly.
 *
 * The width is clamped twice: `clampPillWidth` refuses a non-finite or
 * negative measurement (the pure half), and here it is also capped to the
 * display's own work area — a pure function cannot know how wide a real
 * screen is, and a pill wider than the display it floats over is not
 * "content-width," it is broken.
 */
export function collapsePill(win: BrowserWindow, measuredContentWidthPx: number): void {
  if (win.isDestroyed()) return;
  const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
  const width = Math.min(clampPillWidth(measuredContentWidthPx), workArea.width);
  win.setResizable(false);
  win.setSize(width, PILL_HEIGHT_PX);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

/**
 * The ticket's own pseudocode for the way back: come off always-on-top
 * before growing, restore the instrument's size, unlock resizing, and
 * centre on the display the pill was actually sitting on — not the primary
 * display, which the take may not have been running on at all.
 */
export function restorePill(win: BrowserWindow, geometry: PillGeometry): void {
  if (win.isDestroyed()) return;
  const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
  win.setAlwaysOnTop(false);
  win.setSize(RESTORED_WIDTH_PX, geometry.instrumentHeight);
  win.setResizable(true);
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - RESTORED_WIDTH_PX) / 2),
    y: Math.round(workArea.y + (workArea.height - geometry.instrumentHeight) / 2),
    width: RESTORED_WIDTH_PX,
    height: geometry.instrumentHeight,
  });
}

export interface AttachOptions extends PillGeometry {
  /** How wide the pill's real content measures right now (renderer-supplied). */
  getContentWidthPx: () => number;
}

/**
 * Drives collapse/restore off the supervisor's own heartbeat-confirmed
 * state — traps 1 and 3 from the ticket, encoded rather than trusted.
 *
 * Trap 1: collapse happens after `start` is answered, never inside it. This
 * is never called from a click handler or from inside `startRecording()`'s
 * own promise — only from the supervisor's `stats` heartbeat and its
 * explicit `recording-ended` / `recording-lost` events, all of which fire
 * strictly *after* a `start`/`stop` round trip has already completed.
 *
 * Trap 3: the click that started the take is not the signal `sup.state` is.
 * A take the helper stopped on its own (`recording-ended`, or the heartbeat
 * itself noticing `state: "idle"` — see `HelperSupervisor`'s own self-heal)
 * reaches this the exact same way a take the user stopped does, so the pill
 * cannot outlive a recording that has already ended.
 *
 * Returns an unsubscribe function; the caller owns the window's lifetime.
 */
export function attachPillToSupervisor(
  win: BrowserWindow,
  sup: HelperSupervisor,
  opts: AttachOptions,
): () => void {
  let current: PillWindowState = "expanded";

  const reconcile = (): void => {
    if (win.isDestroyed()) return;
    const action = decidePillAction(current, sup.state);
    if (action === "collapse") {
      collapsePill(win, opts.getContentWidthPx());
      current = "collapsed";
    } else if (action === "restore") {
      restorePill(win, opts);
      current = "expanded";
    }
  };

  const offStats = sup.on("stats", reconcile);
  const offEnded = sup.on("recording-ended", reconcile);
  const offLost = sup.on("recording-lost", reconcile);
  return () => { offStats(); offEnded(); offLost(); };
}
