import { contextBridge, ipcRenderer } from "electron";

/**
 * The copy render's bridge (STC-488): exactly the take reads `session-io.ts`
 * needs, the capture id, and three ways to report back. It names no path;
 * `copy:write` writes to the one main chose for this window's job.
 */
contextBridge.exposeInMainWorld("copyRender", {
  read: (name: string) => ipcRenderer.invoke("preview:read", name),
  size: (name: string) => ipcRenderer.invoke("preview:size", name),
  chunk: (name: string, offset: number, length: number) =>
    ipcRenderer.invoke("preview:chunk", name, offset, length),
  captureId: () => ipcRenderer.invoke("take:captureId"),
  progress: (done: number, total: number) => ipcRenderer.send("copy:progress", done, total),
  write: (bytes: Uint8Array) => ipcRenderer.invoke("copy:write", bytes),
  failed: (detail: string) => ipcRenderer.send("copy:failed", detail),
});
