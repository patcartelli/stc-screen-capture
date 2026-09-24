import { contextBridge, ipcRenderer } from "electron";

/**
 * The renderer gets a narrow, named surface — no ipcRenderer, no node. Every
 * channel is listed here explicitly so the UI cannot reach anything the main
 * process did not deliberately expose.
 */
contextBridge.exposeInMainWorld("recorder", {
  status: () => ipcRenderer.invoke("recorder:status"),
  devices: () => ipcRenderer.invoke("recorder:devices"),
  getSettings: () => ipcRenderer.invoke("recorder:getSettings"),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke("recorder:setSettings", patch),
  takes: () => ipcRenderer.invoke("recorder:takes"),
  // STC-413: the file IS the name now. `file` wins when present (a real
  // rename on disk); `dir` alone is the one remaining fallback, for a bundle
  // with no finished file yet to rename. Both pass through unresolved, the
  // same shape `deleteTake` below already uses for the same reason.
  renameCapture: (file: string | undefined, dir: string | undefined, name: string) =>
    ipcRenderer.invoke("take:rename", file, dir, name),
  // STC-413: an item may carry a finished file, its bundle, or both
  // (`LibraryItem.file`/`.dir`) — both are passed through and main resolves
  // nothing on its own; either may be `undefined`.
  deleteTake: (file: string | undefined, dir: string | undefined) =>
    ipcRenderer.invoke("take:delete", file, dir),
  // The take player now lives in its own window (STC-373) — this opens it
  // rather than an in-page preview. `openPreview`/`closePreview`/`writeProject`
  // /`writeExport` and the rest of the old in-page player's channels moved to
  // `editor-preload.ts`, which is the only bridge that still calls them.
  openEditor: (dir: string, name: string) => ipcRenderer.invoke("editor:open", dir, name),
  // `action` is STC-292's: the hotkey and the menu bar ask for a specific
  // capture mode, the button asks for none.
  captureStill: (action?: string) => ipcRenderer.invoke("still:capture", action),
  getShortcuts: () => ipcRenderer.invoke("shortcuts:get"),
  setShortcut: (action: string, accelerator: string | null) =>
    ipcRenderer.invoke("shortcuts:set", action, accelerator),
  resetShortcuts: () => ipcRenderer.invoke("shortcuts:reset"),
  // The one way out (STC-293). Composited RGBA in, a file and/or the
  // pasteboard out — the renderer never names a format's encoder, a
  // destination folder or a filename. `copyFrame` used to sit here and is
  // gone: it was a second encoder and a second clipboard, and the preview's
  // frame grab goes through `still:export` like everything else now.
  exportStill: (req: Record<string, unknown>) => ipcRenderer.invoke("still:export", req),
  chooseStillDestination: () => ipcRenderer.invoke("still:chooseDestination"),
  // The site folder (STC-444 slice 3, moved here from the editor window's
  // own bridge) — same handler either way, `main.ts` does not care which
  // window's sender asked.
  chooseShareDestination: () => ipcRenderer.invoke("share:chooseDestination"),
  // Where recordings and shots actually land, resolved (STC-412 final
  // review, I1). Not derivable on this side: an unset `saveFolder` falls
  // through to `STC_RECORDINGS_DIR`/~/Desktop/stc inside `takes.ts`, and the
  // renderer has neither the env nor a home directory to name.
  resolvedSaveFolder: () => ipcRenderer.invoke("recorder:resolvedSaveFolder"),
  // The library (STC-294): one index over both kinds. The renderer asks for a
  // filtered list and is handed items it renders without knowing what kinds
  // exist — the filtering happens on this side of the bridge for exactly that
  // reason, since `items.filter((i) => i.kind === sel)` in the view is the
  // branch the ticket's fourth acceptance criterion forbids.
  library: (filter?: string) => ipcRenderer.invoke("library:list", filter),
  writeThumbnail: (dir: string, bytes: ArrayBuffer) =>
    ipcRenderer.invoke("library:writeThumbnail", dir, bytes),
  // Reading a still's own files. `still:frame` already admits any .png inside
  // a take directory, which is what lets the cached thumbnail be read back
  // through the same door the capture is.
  getFrame: (dir: string, name: string) => ipcRenderer.invoke("still:frame", dir, name),
  getShot: (dir: string) => ipcRenderer.invoke("library:shot", dir),
  reopenStill: (dir: string) => ipcRenderer.invoke("still:reopen", dir),
  duplicateStill: (dir: string) => ipcRenderer.invoke("still:duplicate", dir),
  start: () => ipcRenderer.invoke("recorder:start"),
  // STC-374: choose what a recording scopes to — a region or a window — via
  // the same overlay `captureStill` uses. Persisted main-side; this only asks
  // for the pick and reports what was stored.
  pickCaptureTarget: (kind: "region" | "window") =>
    ipcRenderer.invoke("recorder:pickCaptureTarget", kind),
  stop: () => ipcRenderer.invoke("recorder:stop"),
  reveal: (dir: string) => ipcRenderer.invoke("recorder:reveal", dir),
  // STC-375: fire-and-forget, not invoke — nothing awaits an answer, and the
  // pill's width can change several times a minute (a digit added to the
  // timer). `send` rather than `invoke` is what keeps that cheap.
  reportPillWidth: (px: number) => ipcRenderer.send("pill:contentWidth", px),
  // STC-412: main-window warnings route through the toast.
  showToast: (text: string) => ipcRenderer.send("toast:message", text),
  // Share (STC-242) moved to the editor window with the rest of the player —
  // see `editor-preload.ts`. This window has no take open to publish.
  on: (event: string, cb: (payload: any) => void) => {
    const channels = ["helper:ready", "helper:stats", "helper:respawned",
                      "helper:gave-up", "helper:recording-lost", "helper:recording-ended",
                      "helper:warning", "helper:camera-started", "helper:mic-started",
                      // A capture the window did not ask for — a hotkey or the
                      // menu bar (STC-292). The shot is on disk either way;
                      // this is only so an open window stays truthful.
                      "still:captured",
                      // STC-375: the window just collapsed to (or restored
                      // from) the pill. The renderer has no other way to know
                      // its own window shrank — `pill-window.ts` drives the
                      // resize from main, not from anything in this page.
                      "pill:state",
                      // STC-433: `recorder:start` resolved a stale display
                      // or mic on this window's behalf. `settings:changed`
                      // says the stored value moved out from under the
                      // picker (an automatic display, a mic turned off);
                      // the `open*Picker` pair instead asks this window to
                      // open the profile sheet and focus the control that
                      // needs a new choice.
                      "settings:changed", "settings:openDisplayPicker", "settings:openMicPicker"];
    if (!channels.includes(event)) throw new Error(`unknown channel: ${event}`);
    const listener = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
