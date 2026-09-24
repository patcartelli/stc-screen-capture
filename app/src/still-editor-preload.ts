import { contextBridge, ipcRenderer } from "electron";

/**
 * The still editor's bridge (STC-300) — deliberately narrower than the main
 * window's, the same reasoning `thumbnail-preload.ts` and `editor-preload.ts`
 * give for their own windows.
 *
 * Every one of these reaches a main-process handler ANOTHER window's preload
 * already calls (`library:shot` is the main window's library reading a
 * shot's document; `still:frame`/`still:writeShot` are the thumbnail panel's
 * own channels) — reused rather than duplicated, per STC-293's Note: "no
 * second implementation hiding" anywhere a second window is added.
 */
contextBridge.exposeInMainWorld("stillEditor", {
  getShot: (dir: string) => ipcRenderer.invoke("library:shot", dir),
  getFrame: (dir: string, name: string) => ipcRenderer.invoke("still:frame", dir, name),
  // Redactions only — there is no mode to send, unlike the panel's old
  // `writeShot`, since this editor has no Style picker (none was moved here;
  // see `still-editor-window.ts`'s module doc). `undefined` for `mode` keeps
  // whatever the document already has, exactly as `still:writeShot`'s own
  // doc describes for "a redaction-only call".
  writeShot: (dir: string, redactions: unknown) => ipcRenderer.invoke("still:writeShot", dir, redactions),
  // STC-446: the editor can write the finished file now. Both channels are
  // the thumbnail panel's own (`still:export`, `recorder:getSettings`) — the
  // editor is the ONLY door to a still already in the library, and until
  // this it could not produce a deliverable from one.
  exportStill: (req: Record<string, unknown>) => ipcRenderer.invoke("still:export", req),
  getSettings: () => ipcRenderer.invoke("recorder:getSettings"),
});
