import { contextBridge, ipcRenderer } from "electron";

/**
 * The countdown's bridge (STC-391) — the narrowest in the app.
 *
 * The panel reads nothing, writes nothing and captures nothing: it draws a
 * number it is handed and reports two verbs. Everything it could be asked to
 * decide is decided in the main process by `countdown.ts`, so there is nothing
 * here for a compromised renderer to reach for — not even the take directory
 * the thumbnail's bridge needs.
 *
 * `onState`'s payload is `unknown` deliberately. A restated copy of the state
 * type here is the "one value, two copies" defect this repo keeps finding
 * (`thumbnail-preload.ts`'s own copy had silently drifted); the renderer
 * imports the real types from `countdown.ts` and narrows there.
 */
contextBridge.exposeInMainWorld("countdown", {
  send: (event: unknown) => ipcRenderer.send("countdown:event", event),
  onState: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("countdown:state", listener);
    return () => ipcRenderer.removeListener("countdown:state", listener);
  },
});
