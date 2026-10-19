import { BrowserWindow, screen, type WebContents } from "electron";
import { join } from "node:path";
import { PRODUCT_NAME } from "./product.js";
import { setBoundsUnlessClosing } from "./window-geometry.js";
import { timelineZoomKeyIntent } from "./timeline-zoom.js";

/**
 * The editor's window (STC-373) — the second surface in the three-surface
 * split, and the first one built: preview, trim, export, legibility and share
 * move here, out of the main window's own in-page player.
 *
 * One instance at a time, the same shape `thumbnail-window.ts` uses for the
 * post-capture panel, but with conventional chrome (traffic lights,
 * resizable) rather than a frameless overlay — this is a real editing
 * surface, not a transient panel. Opening a second take re-navigates the SAME
 * window rather than spawning another: `editor.ts` always begins its boot
 * sequence with `closePreview()` before opening the new take (mirroring the
 * old `openPreviewOrThrow`'s own "close, then open"), so re-loading is safe
 * and there is never more than one take open in this window at once.
 *
 * The dir/name are passed as URL query params, the same choice
 * `thumbnail-window.ts` makes for the shot it presents: they are available
 * before any script runs, and no IPC round trip is needed just to learn what
 * to open.
 */

export interface EditorOptions {
  dir: string;
  name: string;
  /** Where editor-preload.cjs lives. */
  dist: string;
  /** Where editor.html lives. */
  rendererDir: string;
  /**
   * Run the Share flow as soon as the take is open (STC-429) — a library
   * tile's "Share" action, which has no publish surface of its own and routes
   * through the editor's existing one instead. Absent for every other caller.
   */
  autoShare?: boolean;
}

let win: BrowserWindow | undefined;

function load(opts: EditorOptions): void {
  win!.loadFile(join(opts.rendererDir, "editor.html"), {
    query: opts.autoShare
      ? { dir: opts.dir, name: opts.name, autoShare: "1" }
      : { dir: opts.dir, name: opts.name },
  });
}

/** Open the editor on this take, creating the window if it does not exist yet. */
export function openEditor(opts: EditorOptions): void {
  if (win && !win.isDestroyed()) {
    load(opts);
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1000, height: 760, minWidth: 640, minHeight: 480,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: join(opts.dist, "editor-preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
      // STC-454: the preview's sound. The take's audio finishes decoding a
      // moment after it opens — often mid-playback, outside any click — and
      // under the default policy an AudioContext made then starts SUSPENDED,
      // so the first play after opening would be silent.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.on("closed", () => { win = undefined; });
  // STC-484: ⌘= ⌘− ⌘0 are the default View menu's page-zoom items. In this
  // window they zoom the TIMELINE instead; claiming them here, ahead of the
  // menu, is the only reliable way (a page keydown can lose to the menu's key
  // equivalent). Every other window keeps the platform's behaviour.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const intent = timelineZoomKeyIntent({
      key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift,
    });
    if (!intent) return;
    event.preventDefault();
    win?.webContents.send("editor:timelineZoom", intent);
  });
  load(opts);
}

/** For tests and for main's own bookkeeping. */
export function editorIsOpen(): boolean {
  return win !== undefined && !win.isDestroyed();
}

/**
 * Take the editor off screen without closing it (STC-556): a take started with
 * the app hidden (⌘H) has to unhide the app for the pill to show, and that
 * restores every window hidden with it. Not gated on `isVisible()`, which a
 * window hidden with the app may report false; minimized is left alone.
 * Answers whether anything went off.
 */
export function hideEditor(): boolean {
  if (!win || win.isDestroyed() || win.isMinimized()) return false;
  win.hide();
  return true;
}

export function closeEditor(): void {
  if (win && !win.isDestroyed()) win.close();
}

/**
 * Grow the editor to show its whole content (STC-483: a take opened with a lane
 * below the fold made the user scroll). Never shrinks, never leaves the display's
 * work area, and only for a request from the editor's own page.
 */
export function fitEditorToContent(sender: WebContents, contentHeight: number): void {
  if (!win || win.isDestroyed() || win.webContents !== sender) return;
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
  const bounds = win.getBounds();
  const chrome = bounds.height - win.getContentBounds().height;
  const area = screen.getDisplayMatching(bounds).workArea;
  const want = Math.min(Math.ceil(contentHeight) + chrome, area.height);
  if (want <= bounds.height) return;
  const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - want));
  setBoundsUnlessClosing(win, { y, height: want }, "editor-fit");
}
