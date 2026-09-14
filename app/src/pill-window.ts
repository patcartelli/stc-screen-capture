import { BrowserWindow, screen, type Rectangle } from "electron";
import type { HelperSupervisor } from "./supervisor.js";
import { PILL_HEIGHT_PX, clampPillWidth, decidePillAction, type PillWindowState } from "./pill.js";

/**
 * The pill's real window mechanics (STC-375). `pill.ts` decides WHAT the
 * window should be; this does the actual `BrowserWindow` calls, the same
 * split `overlay-session.ts` and `thumbnail-window.ts` make for their own
 * windowed interactions.
 *
 * Wired into `main.ts`'s real window (2026-09-14): the chrome question in
 * `pill.ts`'s header is resolved as `titleBarStyle: "hidden"` — the main
 * window keeps its native traffic lights as an inset overlay rather than
 * going fully frameless, so `collapsePill`/`restorePill` also toggle their
 * visibility (`setButtonsVisible`): a 26px pill has no real room for a
 * title-bar button cluster, and macOS's own `hiddenInset` windows already
 * establish that hiding them while a window is this small is normal rather
 * than surprising.
 *
 * ## "Restore" means the window's OWN remembered bounds, not a fixed size
 *
 * The ticket's pseudocode restores to a fixed `360 x instrumentHeight`,
 * centred on the display. That doesn't fit the window STC-374 actually
 * shipped: `main.ts`'s `createWindow()` makes a normal, resizable,
 * user-positioned window (520x680 by default, no `resizable: false`), not a
 * fixed-size instrument panel. Restoring a resizable window to a hardcoded
 * size the user never chose would silently discard any resize or move they
 * had done before recording — arguably a worse bug than the one this ticket
 * is fixing. So `collapsePill` remembers the window's bounds immediately
 * before shrinking it, and `restorePill` is handed those bounds back rather
 * than a literal — "restore" means "exactly as it was," which also already
 * IS "on the display it was on" and needs no separate centring step.
 */

/**
 * The ticket's own pseudocode, in order: measure the content, lock resizing,
 * shrink to the pill, float above everything, and survive a Space switch.
 * Returns the window's bounds from just before the shrink, so the caller can
 * hand them back to `restorePill` later.
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
 *
 * Also tells the renderer (`pill:state`, STC-375's actual first Mac finding)
 * — without it the page has no way to learn its own window shrank, and goes
 * on laying out the full instrument UI into a 26px viewport: not "a pill
 * with no content yet" but visibly clipped controls, which reads as broken
 * rather than as unfinished. `index.html`'s `body.pill-collapsed` rule hides
 * everything except the Record/Stop button — deliberately kept reachable,
 * since nothing else in the app can stop a recording (no hotkey covers it).
 */
export function collapsePill(win: BrowserWindow, measuredContentWidthPx: number): Rectangle {
  if (win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
  const previousBounds = win.getBounds();
  const workArea = screen.getDisplayMatching(previousBounds).workArea;
  const width = Math.min(clampPillWidth(measuredContentWidthPx), workArea.width);
  win.setResizable(false);
  win.setSize(width, PILL_HEIGHT_PX);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setButtonsVisible(win, false);
  sendPillState(win, "collapsed");
  return previousBounds;
}

/**
 * The way back: come off always-on-top before growing (so the OS is not
 * asked to reflow an always-on-top window mid-resize), unlock resizing, and
 * put the window back exactly where `collapsePill` found it.
 */
export function restorePill(win: BrowserWindow, bounds: Rectangle): void {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(false);
  win.setResizable(true);
  win.setBounds(bounds);
  setButtonsVisible(win, true);
  sendPillState(win, "expanded");
}

function sendPillState(win: BrowserWindow, state: PillWindowState): void {
  if (win.isDestroyed()) return;
  win.webContents.send("pill:state", { collapsed: state === "collapsed" });
}

/**
 * `setWindowButtonVisibility` is macOS-only and only meaningful on a
 * `titleBarStyle: "hidden"`/`"hiddenInset"` window (the traffic lights are
 * drawn as an inset overlay rather than inside a title-bar strip, so they
 * are the one thing left to hide separately when the content shrinks under
 * them). Guarded the same way `setDockVisible` guards an activation-policy
 * change in `main.ts`: a chrome cosmetic is never worth a crash, and this
 * runs on every CI platform this repo tests on, most of which do not have
 * the method at all.
 */
function setButtonsVisible(win: BrowserWindow, visible: boolean): void {
  try { win.setWindowButtonVisibility?.(visible); } catch { /* cosmetic only */ }
}

export interface AttachOptions {
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
 * A caller must re-attach after replacing `win` — STC-292 made the main
 * window closable and re-creatable (menu-bar-first), and this does not
 * survive that on its own; `main.ts` would call this again inside its own
 * `createWindow()`.
 */
export function attachPillToSupervisor(
  win: BrowserWindow,
  sup: HelperSupervisor,
  opts: AttachOptions,
): () => void {
  let current: PillWindowState = "expanded";
  let expandedBounds: Rectangle | undefined;

  const reconcile = (): void => {
    if (win.isDestroyed()) return;
    const action = decidePillAction(current, sup.state);
    if (action === "collapse") {
      expandedBounds = collapsePill(win, opts.getContentWidthPx());
      current = "collapsed";
    } else if (action === "restore") {
      // expandedBounds is always set here: the only path to "collapsed" is
      // through the branch above, which always sets it first.
      if (expandedBounds) restorePill(win, expandedBounds);
      current = "expanded";
    }
  };

  const offStats = sup.on("stats", reconcile);
  const offEnded = sup.on("recording-ended", reconcile);
  const offLost = sup.on("recording-lost", reconcile);
  return () => { offStats(); offEnded(); offLost(); };
}
