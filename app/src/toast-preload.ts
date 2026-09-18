import { contextBridge, ipcRenderer } from "electron";

/**
 * The undo toast's bridge (STC-392 Task 6) — narrower even than the panel's,
 * because a toast only ever asks main for ONE thing: take back a promised
 * deletion. `dir` and the undo window's length (`ms`) already arrive on the
 * page's own URL query string (`toast-window.ts` puts them there loading the
 * window), so nothing about a toast needs `contextBridge` for either.
 */
contextBridge.exposeInMainWorld("toast", {
  // Names the take, never a path to act on — the same rule every other
  // channel a renderer can reach follows (`thumbnail-preload.ts`'s `save`/
  // `edit`/`trash`). Main decides whether there is anything left to take
  // back (`PendingTrash.undo`).
  undo: (dir: string) => ipcRenderer.invoke("panel:undoTrash", dir),
  // Fire-and-forget from main, not request/response: the window is about to
  // be destroyed regardless of what the page does with this, so there is
  // nothing to hand back. Same `on`/return-an-unsubscribe shape
  // `thumbnail-preload.ts`'s `onHiddenCount` already uses.
  onExpire: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("toast:expire", listener);
    return () => ipcRenderer.removeListener("toast:expire", listener);
  },
});
