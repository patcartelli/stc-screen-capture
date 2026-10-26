import { contextBridge, ipcRenderer } from "electron";

/**
 * The Settings window's bridge (STC-581). Narrower than the library's: it
 * reads and writes preferences and shortcuts, picks the two folders, and runs
 * Clean up. Every handler is the one `main.ts` already had for the old sheet;
 * none is reimplemented here.
 */
contextBridge.exposeInMainWorld("settingsBridge", {
  getSettings: () => ipcRenderer.invoke("recorder:getSettings"),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke("recorder:setSettings", patch),
  getShortcuts: () => ipcRenderer.invoke("shortcuts:get"),
  setShortcut: (action: string, accelerator: string | null) =>
    ipcRenderer.invoke("shortcuts:set", action, accelerator),
  resetShortcuts: () => ipcRenderer.invoke("shortcuts:reset"),
  chooseStillDestination: () => ipcRenderer.invoke("still:chooseDestination"),
  chooseShareDestination: () => ipcRenderer.invoke("share:chooseDestination"),
  resolvedSaveFolder: () => ipcRenderer.invoke("recorder:resolvedSaveFolder"),
  reclaimSpace: () => ipcRenderer.invoke("recorder:reclaimSpace"),
  showToast: (message: unknown) => ipcRenderer.send("toast:message", message),
  on: (event: string, cb: (payload: any) => void) => {
    // settings:changed: another window wrote a preference (the editor's "Use
    // as default", the record bar). settings:reduced-transparency: the
    // macOS setting, read by main from nativeTheme.
    const channels = ["settings:changed", "settings:reduced-transparency", "settings:show-pane"];
    if (!channels.includes(event)) throw new Error(`unknown channel: ${event}`);
    const listener = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
