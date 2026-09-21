import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { positionFor, type Corner, type Size } from "./thumbnail.js";
import { PANEL_WINDOW_TYPE } from "./panel-focus.js";
import { UNDO_WINDOW_MS } from "./panel-actions.js";

/**
 * The toast that appears when Trash PROMISES a deletion (STC-392 Task 6),
 * rather than performing one.
 *
 * `pending-trash.ts` decides WHEN a promise is kept; this owns the one real
 * `BrowserWindow` that tells the user about it — the same split every other
 * floating surface in this app makes (`thumbnail.ts`/`thumbnail-window.ts`,
 * `countdown.ts`/`countdown-window.ts`). Unlike those two, a toast has
 * exactly one thing it can be asked to do — go away, early (Undo) or on time
 * (the window elapsing) — so there is no separate pure decision module here.
 *
 * ## It does NOT take focus — `showInactive()`, not `show()`
 *
 * `thumbnail-window.ts`'s focus rule 1 exists because a panel WAITS for a
 * decision and has to be typeable at. A toast is the opposite: it reports
 * that something already happened and asks nothing, so stealing the keyboard
 * to say "deleted" would be that same rule applied to the wrong window.
 * `showInactive()` puts the window on screen without making it key or
 * activating the app. `type: PANEL_WINDOW_TYPE` is kept anyway, for
 * consistency with every other floating surface in this app rather than
 * because this window is ever asked to take focus — it never calls
 * `focusPanel` or `win.focus()`.
 *
 * ## One instance
 *
 * A second Trash while a toast is already up replaces it; there is no stack
 * here the way the panel has one. The promise the replaced toast was showing
 * for is unaffected — `pending-trash.ts` tracks it independently of whether
 * anything is on screen for it, so `main.ts`'s periodic sweep still commits
 * it on schedule even though its own toast never got to finish its bar.
 */

/** The window's size — small enough to read as a notice, not a second panel. */
export const TOAST_SIZE: Size = { width: 240, height: 68 };

export interface ShowUndoToastOptions {
  /** The take this toast is about — never shown, only echoed back on Undo. */
  dir: string;
  corner: Corner;
  /** Where `toast-preload.cjs` lives (`here` in main.ts). */
  dist: string;
  /** Where `toast.html` lives (`join(here, "..", "renderer")`). */
  rendererDir: string;
}

let current: { win: BrowserWindow; timer: NodeJS.Timeout } | undefined;

/**
 * Show the toast, replacing whichever one is already up.
 *
 * The window is loaded with `ms=UNDO_WINDOW_MS` on its own query string
 * (ruling 2, the task brief's own words): the page's CSS progress bar reads
 * its animation duration from that same value rather than a literal of its
 * own, and this function's own timer — which is what actually takes the
 * window away — is set from the identical import. One constant, never a
 * duration written twice.
 */
export function showUndoToast(opts: ShowUndoToastOptions): void {
  hideUndoToast();
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const { x, y } = positionFor(opts.corner, workArea, TOAST_SIZE);
  const win = new BrowserWindow({
    x, y, width: TOAST_SIZE.width, height: TOAST_SIZE.height,
    transparent: true, frame: false, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true,
    type: PANEL_WINDOW_TYPE,
    // Not shown before its first paint, the same reason the panel and the
    // overlay both do this — a transparent window shown empty flashes the
    // desktop through it.
    show: false,
    webPreferences: {
      preload: join(opts.dist, "toast-preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(join(opts.rendererDir, "toast.html"), {
    query: { dir: opts.dir, ms: String(UNDO_WINDOW_MS) },
  });
  win.once("ready-to-show", () => {
    // Rule 1: a notice, not a request for input — see the class doc above.
    win.showInactive();
  });
  const timer = setTimeout(() => {
    // Tell the page first: it disables its own Undo button, so a click that
    // lands in the instant between this firing and the window actually going
    // away cannot start an undo for a promise that is about to be committed.
    if (!win.isDestroyed()) win.webContents.send("toast:expire");
    hideUndoToast();
  }, UNDO_WINDOW_MS);
  win.on("closed", () => { if (current?.win === win) current = undefined; });
  current = { win, timer };
}

/**
 * Take the toast off screen right now, if one is up. Idempotent — safe to
 * call from `panel:undoTrash` (main.ts) whether or not the toast the undo
 * belongs to is still the current one.
 */
export function hideUndoToast(): void {
  if (!current) return;
  clearTimeout(current.timer);
  const { win } = current;
  current = undefined;
  if (!win.isDestroyed()) win.destroy();
}
