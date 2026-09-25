import { BrowserWindow } from "electron";
import { join } from "node:path";
import { PRODUCT_NAME } from "./product.js";

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
    },
  });
  win.on("closed", () => { win = undefined; });
  load(opts);
}

/** For tests and for main's own bookkeeping. */
export function editorIsOpen(): boolean {
  return win !== undefined && !win.isDestroyed();
}

export function closeEditor(): void {
  if (win && !win.isDestroyed()) win.close();
}
