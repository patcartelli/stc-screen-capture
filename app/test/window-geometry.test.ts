import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { geometrySkip } from "../src/window-geometry.js";

/**
 * STC-496: a resize of a window on its way out crashed Electron on CI
 * (`window-geometry.ts` has the symbolicated stack). These pin the decision
 * and the wrapper; whether it actually stops the crash is CI's to say.
 */
describe("geometrySkip", () => {
  test("a live window in a running app is moved", () => {
    expect(geometrySkip({ destroyed: false, quitting: false, closing: false })).toBeUndefined();
  });

  test("destroyed, quitting and closing each refuse — destroyed first, since it is the ordinary case", () => {
    expect(geometrySkip({ destroyed: true, quitting: true, closing: true })).toBe("destroyed");
    expect(geometrySkip({ destroyed: false, quitting: true, closing: true })).toBe("quitting");
    expect(geometrySkip({ destroyed: false, quitting: false, closing: true })).toBe("closing");
  });
});

describe("every setBounds in the main process goes through the guard", () => {
  const src = join(__dirname, "..", "src");
  const RAW = /\.setBounds\(/;

  test("no other file in app/src calls setBounds directly", () => {
    const offenders = readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "window-geometry.ts")
      .filter((f) => readFileSync(join(src, f), "utf8").split("\n")
        .some((l) => RAW.test(l) && !/^\s*(\/\/|\*)/.test(l)));
    expect(offenders, "route these through setBoundsUnlessClosing (window-geometry.ts)").toEqual([]);
  });

  test("control: the pattern fires on the call the guard wraps", () => {
    expect(RAW.test("  win.setBounds({ ...positionFor(opts.corner, workArea, size), ...size });")).toBe(true);
    expect(RAW.test(readFileSync(join(src, "window-geometry.ts"), "utf8"))).toBe(true);
  });
});

describe("setBoundsUnlessClosing", () => {
  // Fresh module state per test: `noteAppQuitting` is one-way by design.
  let mod: typeof import("../src/window-geometry.js");
  beforeEach(async () => { vi.resetModules(); mod = await import("../src/window-geometry.js"); });
  afterEach(() => { vi.restoreAllMocks(); });

  function stubWindow(destroyed = false) {
    const calls: unknown[] = [];
    const w = Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      setBounds: (b: unknown) => { calls.push(b); },
    });
    return { win: w as unknown as BrowserWindow, emitter: w, calls };
  }

  test("moves a live window, and says nothing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { win, calls } = stubWindow();
    expect(mod.setBoundsUnlessClosing(win, { x: 1, y: 2, width: 3, height: 4 }, "test")).toBe(true);
    expect(calls).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
    expect(err).not.toHaveBeenCalled();
  });

  test("once the window's close has begun, refuses and names the caller", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { win, emitter, calls } = stubWindow();
    mod.trackClosing(win);
    emitter.emit("close");
    expect(mod.setBoundsUnlessClosing(win, { x: 0 }, "toast:fit")).toBe(false);
    expect(calls).toEqual([]);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/\[geometry\] skipped setBounds from toast:fit: the window is closing/);
  });

  test("once the app has committed to quitting, refuses for every window", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { win, calls } = stubWindow();
    mod.noteAppQuitting();
    expect(mod.setBoundsUnlessClosing(win, { x: 0 }, "thumbnail moveTo")).toBe(false);
    expect(calls).toEqual([]);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/from thumbnail moveTo: the app is quitting/);
  });

  test("a destroyed window is refused silently — that case was already guarded", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { win, calls } = stubWindow(true);
    expect(mod.setBoundsUnlessClosing(win, { x: 0 }, "x")).toBe(false);
    expect(calls).toEqual([]);
    expect(err).not.toHaveBeenCalled();
  });
});
