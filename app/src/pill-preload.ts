import { contextBridge, ipcRenderer } from "electron";

/**
 * The pill's bridge (STC-550). It draws what main sends and asks for exactly
 * one thing, stopping the take, which names nothing: main stops whatever take
 * is live, and only for this pill's own page (`pill-window.ts`).
 *
 * Payloads are `unknown` here, the countdown's rule: a restated copy of a type
 * in a preload is the "one value, two copies" defect this repo keeps finding.
 * `pill-renderer.ts` narrows them against `pill.ts`.
 */
const CHANNELS = new Set(["pill:elapsed", "pill:level", "pill:micLost", "pill:stopped", "pill:notice"]);

contextBridge.exposeInMainWorld("pill", {
  stop: () => ipcRenderer.invoke("pill:stop"),
  // Fire-and-forget: main only resizes the window to it.
  reportWidth: (px: number) => ipcRenderer.send("pill:contentWidth", px),
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!CHANNELS.has(channel)) throw new Error(`pill: no such channel ${channel}`);
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
