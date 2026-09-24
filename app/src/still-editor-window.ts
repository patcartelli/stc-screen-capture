import { BrowserWindow } from "electron";
import { join } from "node:path";

/**
 * The still editor's window (STC-300) — the answer, once STC-300's own gate
 * fired ("wanting to nudge a redaction rectangle"), to the format audit's own
 * open question: "own window, or a mode of the existing take editor?" The
 * audit's reasoning still holds — the still path already has its own
 * schema, its own transform, its own export funnel and its own window with
 * its own narrow preload (`thumbnail-window.ts`); a shared surface would
 * import the still modules exactly as a separate window would, while
 * additionally inheriting `editor.ts`'s chrome, built around a timeline a
 * still does not have.
 *
 * v1's whole job is Redact, moved here from the post-capture panel
 * (`thumbnail-renderer.ts`) because that card's compact size made placing a
 * box precisely hard — the panel now shows a shot's decoration read-only.
 * There is no Style picker here either: it was not moved, just removed as
 * redundant in the compact card, so there is still nowhere yet to change a
 * shot's decoration mode after capture.
 *
 * One instance at a time, the same shape `editor-window.ts`/
 * `thumbnail-window.ts` use — opening a second take re-navigates the SAME
 * window rather than spawning another.
 */

export interface StillEditorOptions {
  /** The shot's own (already-promoted) directory. */
  dir: string;
  /** Where still-editor-preload.cjs lives. */
  dist: string;
  /** Where still-editor.html lives. */
  rendererDir: string;
}

let win: BrowserWindow | undefined;

function load(opts: StillEditorOptions): void {
  win!.loadFile(join(opts.rendererDir, "still-editor.html"), { query: { dir: opts.dir } });
}

/** Open the still editor on this shot, creating the window if it does not exist yet. */
export function openStillEditor(opts: StillEditorOptions): void {
  if (win && !win.isDestroyed()) {
    load(opts);
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 900, height: 700, minWidth: 480, minHeight: 380,
    title: "Redact",
    webPreferences: {
      preload: join(opts.dist, "still-editor-preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.on("closed", () => { win = undefined; });
  load(opts);
}

/** For tests and for main's own bookkeeping. */
export function stillEditorIsOpen(): boolean {
  return win !== undefined && !win.isDestroyed();
}

export function closeStillEditor(): void {
  if (win && !win.isDestroyed()) win.close();
}
