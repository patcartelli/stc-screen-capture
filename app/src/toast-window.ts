import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { positionFor, type Corner, type Size } from "./thumbnail.js";
import { PANEL_WINDOW_TYPE } from "./panel-focus.js";
import { UNDO_WINDOW_MS } from "./panel-actions.js";
import { MESSAGE_TOAST_SIZE, UNDO_TOAST_SIZE, messageToastMs } from "./toast.js";

/**
 * The toast that appears when Trash PROMISES a deletion (STC-392 Task 6),
 * rather than performing one — and, as of STC-412 Task 5, a plain
 * auto-dismissing message toast too (the main window's warnings, moved off
 * the inline `#alert` banner — Task 6).
 *
 * `pending-trash.ts` decides WHEN a promise is kept; this owns the one real
 * `BrowserWindow` that tells the user about it — the same split every other
 * floating surface in this app makes (`thumbnail.ts`/`thumbnail-window.ts`,
 * `countdown.ts`/`countdown-window.ts`). Unlike those two, a toast has
 * exactly one thing it can be asked to do — go away, early (Undo, undo mode
 * only) or on time (the window elapsing) — so there is no separate pure
 * decision module here. Both modes share the same window class and the same
 * "one instance" slot below; `buildToastWindow` is the one place their
 * construction agrees.
 *
 * ## It does NOT take focus — `showInactive()`, not `show()`
 *
 * `thumbnail-window.ts`'s focus rule 1 exists because a panel WAITS for a
 * decision and has to be typeable at. A toast is the opposite: it reports
 * that something already happened (or is simply a notice) and asks nothing
 * of the undo kind, so stealing the keyboard to say "deleted" — or to show a
 * warning — would be that same rule applied to the wrong window.
 * `showInactive()` puts the window on screen without making it key or
 * activating the app. `type: PANEL_WINDOW_TYPE` is kept anyway, for
 * consistency with every other floating surface in this app rather than
 * because this window is ever asked to take focus — it never calls
 * `focusPanel` or `win.focus()`.
 *
 * ## One instance
 *
 * A second toast — of either mode — while one is already up replaces it;
 * there is no stack here the way the panel has one. For the undo toast, the
 * promise the replaced toast was showing for is unaffected —
 * `pending-trash.ts` tracks it independently of whether anything is on
 * screen for it, so `main.ts`'s periodic sweep still commits it on schedule
 * even though its own toast never got to finish its bar.
 *
 * ## The two modes are NOT the same size or the same length
 *
 * They were, and that was a bug rather than a simplification: the message
 * mode carries multi-paragraph warnings and was clipping most of the longest
 * one inside the undo toast's 240x68 box, on the undo toast's 4 s clock.
 * `toast.ts` owns both numbers per mode now (and the reasoning behind each);
 * `buildToastWindow` takes the size as a parameter so neither mode can
 * silently inherit the other's.
 */

export interface ToastWindowOptions {
  corner: Corner;
  /** Where `toast-preload.cjs` lives (`here` in main.ts). */
  dist: string;
  /** Where `toast.html` lives (`join(here, "..", "renderer")`). */
  rendererDir: string;
}

export interface ShowUndoToastOptions extends ToastWindowOptions {
  /** The take this toast is about — never shown, only echoed back on Undo. */
  dir: string;
}

let current: { win: BrowserWindow; timer: NodeJS.Timeout } | undefined;

/**
 * Everything the undo and message toasts share: replacing whatever toast is
 * already up, positioning at the chosen corner, and the window's own
 * construction. Callers append their own mode's query params, hand in their
 * own mode's `size` (`toast.ts`), and own the timer that eventually takes the
 * window down — the one piece of behavior that genuinely differs between the
 * two (an undo toast tells the page first, so a click landing in the gap
 * cannot start an undo for a promise about to be committed; a message toast
 * has no such promise to protect).
 */
function buildToastWindow(opts: ToastWindowOptions, query: Record<string, string>,
                          size: Size): BrowserWindow {
  hideToast();
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const { x, y } = positionFor(opts.corner, workArea, size);
  const win = new BrowserWindow({
    x, y, width: size.width, height: size.height,
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
  win.loadFile(join(opts.rendererDir, "toast.html"), { query });
  win.once("ready-to-show", () => {
    // Rule 1: a notice, not a request for input — see the class doc above.
    win.showInactive();
  });
  win.on("closed", () => { if (current?.win === win) current = undefined; });
  return win;
}

/**
 * Show the undo toast, replacing whichever toast is already up.
 *
 * The window is loaded with `ms=UNDO_WINDOW_MS` on its own query string
 * (ruling 2, the task brief's own words): the page's CSS progress bar reads
 * its animation duration from that same value rather than a literal of its
 * own, and this function's own timer — which is what actually takes the
 * window away — is set from the identical import. One constant, never a
 * duration written twice.
 */
export function showUndoToast(opts: ShowUndoToastOptions): void {
  const win = buildToastWindow(opts, { mode: "undo", dir: opts.dir, ms: String(UNDO_WINDOW_MS) },
                               UNDO_TOAST_SIZE);
  const timer = setTimeout(() => {
    // Tell the page first: it disables its own Undo button, so a click that
    // lands in the instant between this firing and the window actually going
    // away cannot start an undo for a promise that is about to be committed.
    if (!win.isDestroyed()) win.webContents.send("toast:expire");
    hideToast();
  }, UNDO_WINDOW_MS);
  current = { win, timer };
}

/**
 * A plain notice — no Undo, no promise. Replaces the main window's inline
 * #alert banner (STC-412) for warnings that reach the user off the reliable
 * channel.
 *
 * It auto-dismisses on a clock derived from the message's own LENGTH
 * (`toast.ts`'s `messageToastMs`), not on a fixed 4 s: these are the
 * multi-paragraph warnings `renderer.ts` writes, and a paragraph telling
 * someone to grant a permission and reopen the app cannot be read in the time
 * "Deleted" needs. Computed ONCE here and handed to both the real timer and
 * the page's draining bar (`ms` on the query string), the same one-value rule
 * the undo toast's own `UNDO_WINDOW_MS` follows — the bar is what tells the
 * reader how long is left, so it may never name a different number than the
 * timer that actually takes the window away.
 *
 * The page also gets a ✕ in this mode (`toast.html`), which reaches
 * `hideToast` through `toast:dismiss` — a notice long enough to need reading
 * is long enough to want out of the way early, and unlike the undo toast
 * there is no promise that an early close would abandon.
 */
export function showMessageToast(text: string, opts: ToastWindowOptions): void {
  const ms = messageToastMs(text);
  const win = buildToastWindow(opts, { mode: "message", text, ms: String(ms) },
                               MESSAGE_TOAST_SIZE);
  const timer = setTimeout(hideToast, ms);
  current = { win, timer };
}

/**
 * Take the toast off screen right now, if one is up — undo or message alike.
 * Idempotent — safe to call from `panel:undoTrash` (main.ts) whether or not
 * the toast the undo belongs to is still the current one.
 */
export function hideToast(): void {
  if (!current) return;
  clearTimeout(current.timer);
  const { win } = current;
  current = undefined;
  if (!win.isDestroyed()) win.destroy();
}
