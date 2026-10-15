import { BrowserWindow, screen, type Rectangle } from "electron";
import type { HelperSupervisor } from "./supervisor.js";
import {
  PILL_HEIGHT_PX, PILL_STOPPED_DWELL_MS, clampPillWidth, decidePillAction, shouldDwell, shouldShowTrackNotice,
  type PillWindowState,
} from "./pill.js";
import { pillLabel, trackLossPillLabel } from "./stop-copy.js";
import { setBoundsUnlessClosing } from "./window-geometry.js";

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
  // `setSize`'s meaning (top-left stays put; Electron fills x/y from the
  // current bounds), through the same guard every geometry change takes
  // (STC-496).
  setBoundsUnlessClosing(win, { width, height: PILL_HEIGHT_PX }, "collapsePill");
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
  // A take the helper ends during quit's shutdown restores the pill too
  // (STC-496: a resize at quit is what crashes on CI).
  setBoundsUnlessClosing(win, bounds, "restorePill");
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
 * Returns `detach` and `reconcileNow`; the caller owns the window's lifetime.
 * A caller must re-attach after replacing `win` — STC-292 made the main
 * window closable and re-creatable (menu-bar-first), and this does not
 * survive that on its own; `main.ts` would call this again inside its own
 * `createWindow()`.
 */
export function attachPillToSupervisor(
  win: BrowserWindow,
  sup: HelperSupervisor,
  opts: AttachOptions,
): PillAttachment {
  let current: PillWindowState = "expanded";
  let expandedBounds: Rectangle | undefined;
  // STC-531: the pill showing why the helper stopped its take. While this is
  // set, `decidePillAction` holds the restore; it ends on its own timer, or
  // the moment a new take is recording.
  let dwell: ReturnType<typeof setTimeout> | undefined;

  const endDwell = (): void => {
    if (dwell === undefined) return;
    clearTimeout(dwell);
    dwell = undefined;
    sendPillStopped(win, undefined);
  };

  // STC-237: a mic or camera lost while the take KEEPS recording. The pill shows it in
  // place of the timer for the same time a stop's label shows, then goes back. It moves
  // no window, so it never touches `reconcile`. A second loss restarts the clock with its
  // own label; a stop takes over from it (`onEnded`).
  let notice: ReturnType<typeof setTimeout> | undefined;
  const endNotice = (): void => {
    if (notice === undefined) return;
    clearTimeout(notice);
    notice = undefined;
    sendPillNotice(win, undefined);
  };
  const onWarning = (l: { code?: unknown } | undefined): void => {
    const label = trackLossPillLabel(String(l?.code));
    if (win.isDestroyed() || !shouldShowTrackNotice(current, sup.state, label)) return;
    if (notice !== undefined) clearTimeout(notice);
    sendPillNotice(win, label);
    notice = setTimeout(() => {
      notice = undefined;
      sendPillNotice(win, undefined);
    }, PILL_STOPPED_DWELL_MS);
  };

  const reconcile = (): void => {
    if (win.isDestroyed()) { endDwell(); return; }
    // A new take while the label is up: the pill is that take's now.
    if (sup.state === "recording") endDwell();
    const action = decidePillAction(current, sup.state, dwell !== undefined);
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

  // `recording-ended` is only ever a stop the HELPER decided on (the
  // supervisor's own contract), so its reason is what the pill says.
  const onEnded = (i: { reason?: unknown } | undefined): void => {
    endNotice();
    const label = pillLabel(typeof i?.reason === "string" ? i.reason : undefined);
    if (dwell === undefined && !win.isDestroyed() && shouldDwell(current, label)) {
      sendPillStopped(win, label);
      dwell = setTimeout(() => {
        dwell = undefined;
        sendPillStopped(win, undefined);
        reconcile();
      }, PILL_STOPPED_DWELL_MS);
    }
    reconcile();
  };

  const offStats = sup.on("stats", reconcile);
  const offEnded = sup.on("recording-ended", onEnded);
  const offLost = sup.on("recording-lost", () => { endNotice(); reconcile(); });
  const offWarning = sup.on("helper:warning", onWarning);
  return {
    detach: () => { endDwell(); endNotice(); offStats(); offEnded(); offLost(); offWarning(); },
    reconcileNow: reconcile,
  };
}

/** STC-237: a lost track's label on a pill still recording, or `undefined` to clear it. */
function sendPillNotice(win: BrowserWindow, label: string | undefined): void {
  if (win.isDestroyed()) return;
  win.webContents.send("pill:notice", { label: label ?? null });
}

/** STC-531: the pill's stopped label, or `undefined` to clear it. */
function sendPillStopped(win: BrowserWindow, label: string | undefined): void {
  if (win.isDestroyed()) return;
  win.webContents.send("pill:stopped", { label: label ?? null });
}

export interface PillAttachment {
  /** Stop listening. The caller owns the window's lifetime. */
  detach: () => void;
  /**
   * Reconcile against the supervisor's state right now, instead of waiting for
   * the next heartbeat. A window created while a take is already running
   * (STC-502: the hotkey started it with no window open) uses this to become
   * the pill BEFORE it is ever shown, so it never appears as the full library.
   */
  reconcileNow: () => void;
}
