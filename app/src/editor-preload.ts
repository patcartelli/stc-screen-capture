import { contextBridge, ipcRenderer } from "electron";

/**
 * The editor's bridge (STC-373) — deliberately narrower than the main
 * window's `preload.ts`, the same reasoning `thumbnail-preload.ts` and
 * `overlay-preload.ts` give for their own windows: this window gets exactly
 * the channels preview/trim/export/legibility/share need, not the other 24
 * covering recording, capture, the library and hotkeys.
 *
 * Every one of these reaches the SAME main-process handler the main window's
 * own `preload.ts` calls (`main.ts` does not care which window's `sender`
 * asked) — reused rather than duplicated, per STC-293's Note: "no second
 * implementation hiding" anywhere a second window is added.
 */
contextBridge.exposeInMainWorld("editor", {
  openPreview: (dir: string) => ipcRenderer.invoke("preview:open", dir),
  closePreview: () => ipcRenderer.invoke("preview:close"),
  readTakeFile: (name: string) => ipcRenderer.invoke("preview:read", name),
  takeFileSize: (name: string) => ipcRenderer.invoke("preview:size", name),
  readTakeChunk: (name: string, offset: number, length: number) =>
    ipcRenderer.invoke("preview:chunk", name, offset, length),
  writeProject: (bytes: ArrayBuffer) => ipcRenderer.invoke("preview:writeProject", bytes),
  writeExport: (name: string, bytes: ArrayBuffer) => ipcRenderer.invoke("export:write", name, bytes),
  // STC-413: the open take's stable identity, so the export path can tag the
  // MP4 it writes without reaching node:fs itself.
  captureId: () => ipcRenderer.invoke("take:captureId"),
  // The frame-grab (STC-298/293) goes through the same one way out of the app
  // every still does.
  exportStill: (req: Record<string, unknown>) => ipcRenderer.invoke("still:export", req),
  getSettings: () => ipcRenderer.invoke("recorder:getSettings"),
  publish: () => ipcRenderer.invoke("share:publish"),
  chooseShareDestination: () => ipcRenderer.invoke("share:chooseDestination"),
  revealPublished: () => ipcRenderer.invoke("share:reveal"),
  // STC-399: the export manifest stamp's version half.
  getVersion: () => ipcRenderer.invoke("app:version"),
});
