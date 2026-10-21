import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describeWindow, pageName } from "../src/quit-window-log.js";
import { diedFromCrash } from "./_quit-fixture.js";

/**
 * STC-534: Electron crashes in `BrowserWindow::OnWindowIsKeyChanged` when the
 * app activates or deactivates while a window is being torn down at quit. The
 * stack cannot say WHICH window, so the quit logs every window's state and
 * every key/activation change from then on. These pin what a line says and
 * when `closeApp` prints them; whether it names the window is CI's to say.
 */
describe("pageName", () => {
  test("a bundled page is named by its file", () => {
    expect(pageName("file:///Applications/Capture.app/Contents/Resources/app/renderer/toast.html")).toBe("toast.html");
    expect(pageName("file:///x/renderer/editor.html?take=%2Ftmp%2Fa#t")).toBe("editor.html");
  });

  test("a window with nothing loaded says so rather than printing an empty name", () => {
    expect(pageName("")).toBe("(no page)");
  });
});

describe("describeWindow", () => {
  test("a live window: id, page, and only the states that are true", () => {
    expect(describeWindow({ id: 3, page: "toast.html", destroyed: false, contentsGone: false, visible: true, focused: true }))
      .toBe("#3 toast.html visible focused");
    expect(describeWindow({ id: 4, page: "index.html", destroyed: false, contentsGone: false, visible: false, focused: false }))
      .toBe("#4 index.html hidden");
  });

  test("a window whose page is gone but whose native window is not: the state the crash needs", () => {
    expect(describeWindow({ id: 7, page: "overlay.html", destroyed: false, contentsGone: true, visible: true, focused: false }))
      .toBe("#7 overlay.html visible contents-gone");
  });

  test("a destroyed window says only that — nothing else can be read from it", () => {
    expect(describeWindow({ id: 9, page: "?", destroyed: true, contentsGone: true, visible: false, focused: false }))
      .toBe("#9 destroyed");
  });
});

describe("startQuitWindowLog", () => {
  let mod: typeof import("../src/quit-window-log.js");
  let lines: string[];
  beforeEach(async () => {
    vi.resetModules();
    mod = await import("../src/quit-window-log.js");
    lines = [];
    vi.spyOn(console, "error").mockImplementation((l: string) => { lines.push(l); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function stubWindow(id: number, url: string) {
    const w = Object.assign(new EventEmitter(), {
      id,
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      isVisible: () => true,
      isFocused: () => false,
      webContents: { isDestroyed: () => false, getURL: () => url },
    });
    return w;
  }

  test("logs every window at the start, then each window and app event as it happens", () => {
    const app = new EventEmitter();
    const a = stubWindow(1, "file:///r/index.html");
    const b = stubWindow(2, "file:///r/toast.html");
    mod.startQuitWindowLog(app as never, [a, b] as unknown as BrowserWindow[], () => 0);

    expect(lines[0]).toBe("[window] quit +0ms: 2 windows: #1 index.html visible | #2 toast.html visible");
    b.emit("blur");
    app.emit("did-resign-active");
    b.destroyed = true;
    b.emit("closed");
    expect(lines.slice(1)).toEqual([
      "[window] +0ms #2 toast.html visible: blur",
      "[window] +0ms app: did-resign-active",
      "[window] +0ms #2 destroyed: closed",
    ]);
  });

  test("a window created after the quit started is followed too", () => {
    const app = new EventEmitter();
    mod.startQuitWindowLog(app as never, [], () => 0);
    const late = stubWindow(5, "file:///r/thumbnail.html");
    app.emit("browser-window-created", {}, late);
    late.emit("close");
    expect(lines).toContain("[window] +0ms #5 thumbnail.html visible: created");
    expect(lines).toContain("[window] +0ms #5 thumbnail.html visible: close");
  });

  test("a second call is a no-op: a quit that runs its teardown twice must not double every line", () => {
    const app = new EventEmitter();
    const a = stubWindow(1, "file:///r/index.html");
    mod.startQuitWindowLog(app as never, [a] as unknown as BrowserWindow[], () => 0);
    mod.startQuitWindowLog(app as never, [a] as unknown as BrowserWindow[], () => 0);
    a.emit("focus");
    expect(lines.filter((l) => l.endsWith(": focus"))).toHaveLength(1);
  });
});

describe("startWindowLog from launch (STC-568)", () => {
  let mod: typeof import("../src/quit-window-log.js");
  let lines: string[];
  beforeEach(async () => {
    vi.resetModules();
    mod = await import("../src/quit-window-log.js");
    lines = [];
    vi.spyOn(console, "error").mockImplementation((l: string) => { lines.push(l); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const stub = (id: number) => Object.assign(new EventEmitter(), {
    id, isDestroyed: () => false, isVisible: () => true, isFocused: () => false,
    webContents: { isDestroyed: () => false, getURL: () => "file:///r/countdown.html" },
  });

  test("the quit after a launch-started log adds its snapshot line, without doubling every event", () => {
    const app = new EventEmitter();
    let t = 0;
    mod.startWindowLog(app as never, [], mod.WINDOW_LOG_AT_LAUNCH, () => t);
    const panel = stub(3);
    app.emit("browser-window-created", {}, panel);
    t = 40;
    mod.startQuitWindowLog(app as never, [panel] as unknown as BrowserWindow[], () => t);
    panel.emit("hide");
    expect(lines).toEqual([
      "[window] launch +0ms: 0 windows: none",
      "[window] +0ms #3 countdown.html visible: created",
      "[window] quit +40ms: 1 window: #3 countdown.html visible",
      "[window] +40ms #3 countdown.html visible: hide",
    ]);
  });
});

describe("diedFromCrash", () => {
  test("a fault signal is a crash", () => {
    for (const s of ["SIGSEGV", "SIGBUS", "SIGABRT", "SIGILL", "SIGTRAP"] as const) expect(diedFromCrash(s)).toBe(true);
  });

  test("a clean exit, or a kill closeApp itself sent, is not", () => {
    expect(diedFromCrash(null)).toBe(false);
    expect(diedFromCrash("SIGKILL")).toBe(false);
    expect(diedFromCrash("SIGTERM")).toBe(false);
  });
});
