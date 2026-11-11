import { contextBridge, ipcRenderer } from "electron";

/**
 * The overlay's bridge (STC-290) — deliberately smaller than the main window's.
 *
 * The overlay reads nothing and writes nothing. It reports input and receives
 * state to draw, and that is the whole surface: no file access, no capture, no
 * settings. Everything it could be asked to decide is decided in the main
 * process by `selection.ts`, so there is nothing here for a compromised
 * renderer to reach for.
 */
contextBridge.exposeInMainWorld("overlay", {
  send: (event: unknown) => ipcRenderer.send("overlay:event", event),
  onState: (cb: (payload: any) => void) => {
    const listener = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on("overlay:state", listener);
    return () => ipcRenderer.removeListener("overlay:state", listener);
  },
  // STC-638: a picture for the camera menu's live view. Frames are lossy by design;
  // the view draws the newest and forgets the rest.
  onCameraFrame: (cb: (f: { w: number; h: number; jpeg: string }) => void) => {
    const listener = (_e: unknown, f: { w: number; h: number; jpeg: string }) => cb(f);
    ipcRenderer.on("overlay:camera-frame", listener);
    return () => ipcRenderer.removeListener("overlay:camera-frame", listener);
  },
});
