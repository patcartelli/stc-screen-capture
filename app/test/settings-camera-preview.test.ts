import { describe, test, expect } from "vitest";
import { SettingsCameraPreview } from "../src/settings-camera-preview.js";
import type { PreviewView } from "../src/camera-preview.js";

/** STC-638 slice 3: when Settings' live view runs, and how it yields to the record bar. */
function make(opts: { uid?: string | null } = {}) {
  const calls: string[] = [];
  const views: PreviewView[] = [];
  let blocked = false;
  const p = new SettingsCameraPreview({
    port: {
      start: (uid) => { calls.push(`start:${uid}`); return Promise.resolve(); },
      stop: () => { calls.push("stop"); return Promise.resolve(); },
    },
    uid: () => opts.uid ?? null,
    blocked: () => blocked,
    onView: (v) => views.push(v),
  });
  return { p, calls, views, block: (b: boolean) => { blocked = b; } };
}

describe("Settings' live view", () => {
  test("runs while the pane is looked at, on the stored camera", () => {
    const t = make({ uid: "cam-1" });
    t.p.request(true);
    expect(t.calls).toEqual(["start:cam-1"]);
    expect(t.p.view).toEqual({ kind: "starting" });
  });

  test("stops when the pane is left or the window loses focus", () => {
    const t = make();
    t.p.request(true); t.p.request(false);
    expect(t.calls).toEqual(["start:null", "stop"]);
    expect(t.p.view).toEqual({ kind: "off" });
  });

  test("asking twice starts once", () => {
    const t = make();
    t.p.request(true); t.p.request(true);
    expect(t.calls).toEqual(["start:null"]);
  });

  test("the record bar wins: Settings stops first, and returns after if still looked at", () => {
    const t = make();
    t.p.request(true);
    t.p.suspend();
    expect(t.calls).toEqual(["start:null", "stop"]);
    t.p.request(true);                       // a focus event while the bar is up changes nothing
    expect(t.calls).toEqual(["start:null", "stop"]);
    t.p.resume();
    expect(t.calls).toEqual(["start:null", "stop", "start:null"]);
  });

  test("resume with the pane no longer looked at starts nothing", () => {
    const t = make();
    t.p.request(true); t.p.suspend(); t.p.request(false); t.p.resume();
    expect(t.calls).toEqual(["start:null", "stop"]);
  });

  test("never during a take", () => {
    const t = make();
    t.block(true);
    t.p.request(true);
    expect(t.calls).toEqual([]);
  });

  test("closing the window stops it and forgets the request", () => {
    const t = make();
    t.p.request(true); t.p.close(); t.p.resume();
    expect(t.calls).toEqual(["start:null", "stop"]);
  });

  test("a frame is for the window only while a preview is wanted", () => {
    const t = make();
    expect(t.p.frame()).toBe(false);
    t.p.request(true);
    expect(t.p.frame()).toBe(true);
    expect(t.p.view).toEqual({ kind: "live" });
    t.p.request(false);
    expect(t.p.frame()).toBe(false);
  });

  test("the camera unplugged is shown, and the window is told", () => {
    const t = make();
    t.p.request(true); t.p.frame();
    t.p.stopped("device-lost");
    expect(t.views.at(-1)).toEqual({ kind: "unavailable", code: "device-lost" });
  });
});
