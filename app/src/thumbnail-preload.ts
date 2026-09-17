import { contextBridge, ipcRenderer } from "electron";
import type { PanelTake } from "./panel-actions.js";
import type { DecorationMode } from "@transform/shot.js";

/**
 * The floating thumbnail's bridge (STC-296) — deliberately narrower than the
 * main window's, the same reasoning `overlay-preload.ts` gives for the
 * selection overlay: this window gets exactly the channels it needs and
 * nothing a compromised renderer here could use to reach further.
 *
 * `exportStill` and `getFrame` are the SAME main-process handlers the main
 * window's own preload calls (`still:export`, `still:frame` in `main.ts`) —
 * reused rather than duplicated, per STC-293's Note: "no second
 * implementation hiding in the thumbnail."
 */
contextBridge.exposeInMainWorld("thumb", {
  getFrame: (dir: string, name: string) => ipcRenderer.invoke("still:frame", dir, name),
  getSettings: () => ipcRenderer.invoke("recorder:getSettings"),
  // Redactions and the decoration mode — main re-reads the stored document
  // and re-validates it, so this window can change a shot's redactions and
  // its mode and nothing else about it (STC-297; widened for `mode` by
  // STC-392 review, I2 — see the handler's own note for why that widening
  // is still safe: `mode` is a closed enum `parseShot` already checks).
  writeShot: (dir: string, redactions: unknown, mode?: DecorationMode) =>
    ipcRenderer.invoke("still:writeShot", dir, redactions, mode),
  exportStill: (req: Record<string, unknown>) => ipcRenderer.invoke("still:export", req),
  reveal: () => ipcRenderer.invoke("still:reveal"),
  // The right-click menu (STC-296 follow-up). Main builds and pops it up and
  // answers with the chosen id, so this window never holds a `Menu` and the
  // template stays checkable in one place.
  menu: (ctx: { take: PanelTake; redacting: boolean; busy: boolean }) =>
    ipcRenderer.invoke("thumbnail:menu", ctx),
  // A DIRECTORY, which main validates against the recordings root before it
  // touches anything — the renderer names a take, never a path to act on.
  revealShot: (dir: string) => ipcRenderer.invoke("still:revealShot", dir),
  // The three actions that CHANGE where a take lives. Each names a directory
  // and main validates it, the same rule `still:revealShot` follows: this
  // window names a take, never a path to act on.
  save: (dir: string) => ipcRenderer.invoke("panel:save", dir),
  edit: (dir: string) => ipcRenderer.invoke("panel:edit", dir),
  trash: (dir: string) => ipcRenderer.invoke("panel:trash", dir),
  // Drag-out (STC-296 follow-up). Two steps on purpose: the FILE is written
  // ahead of time (it takes long enough that a drag cannot wait for it), and
  // `startDrag` is the instant hand-over once the gesture commits.
  dragFile: (req: Record<string, unknown>) => ipcRenderer.invoke("still:dragFile", req),
  startDrag: (file: string) => ipcRenderer.send("still:startDrag", file),
  // Fire-and-forget notices to the window that owns this panel
  // (`thumbnail-window.ts`), not request/response: it reacts by resizing or
  // destroying the window, and has nothing to hand back.
  //
  // `unknown` rather than a restated union: this file's own copy of the
  // event shape had already fallen out of sync with the real one once before
  // — missing `"redact"`, which `thumbnail-renderer.ts`'s `declare global`
  // had and this did not — silently, because nothing ever checks a preload's
  // declared type against what a renderer actually sends across
  // `contextBridge`. `overlay-preload.ts`'s `send` already uses `unknown` for
  // the identical reason; `thumbnail-window.ts`'s `ThumbEvent` is the one
  // place this shape is decided.
  event: (ev: unknown) => ipcRenderer.send("thumbnail:event", ev),
  // The overflow badge's count (Task 5b / STC-392 D7) — `thumbnail.ts`'s
  // `hiddenCount` is its only source; this channel just carries the answer
  // across the process boundary, the same `on`/return-an-unsubscribe shape
  // `overlay-preload.ts`'s `onState` already uses.
  onHiddenCount: (cb: (n: number) => void) => {
    const listener = (_e: unknown, n: number) => cb(n);
    ipcRenderer.on("thumbnail:hiddenCount", listener);
    return () => ipcRenderer.removeListener("thumbnail:hiddenCount", listener);
  },
});
