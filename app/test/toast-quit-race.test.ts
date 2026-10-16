import { describe, test, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * The message toast vs the app's own quit (STC-496).
 *
 * Every stalled CI run on 2026-10-02 had exactly one Electron crash, and all
 * four were the same stack to the byte: a renderer's `ipcRenderer.send`
 * reaching a main-process listener that called `BaseWindow::SetBounds`, which
 * reached Chromium's `NativeWidgetMacNSWindowHost::UpdateCompositorProperties`
 * on a host already freed (`0xcdcd…`, PartitionAlloc's freed-memory byte) —
 * while `isDestroyed()` still said false. The only `ipcMain.on` handler in
 * this app that calls `setBounds` is `toast-window.ts`'s `toast:fit`.
 *
 * `runQuitTeardown` already hid the toast as its first step. It then awaits
 * pending trash, the panels and the helper's shutdown — seconds — before
 * `app.quit()`, and nothing stopped a NEW message toast being put up in that
 * gap. That toast is then closed by Electron's own quit, asynchronously, with
 * its page's `toast:fit` still in flight. These tests pin both halves of the
 * fix: no toast is built once the quit teardown has begun, and a toast that
 * has started closing never resizes in answer to its page.
 *
 * STC-509: with both of those in place CI still crashed on the same stack,
 * the guard never firing. So `toast:fit` is gone and the window is never
 * resized at all; the first test below pins that. Its replacement,
 * `toast:hover`, toggles click-through and gets the same close/quit refusal.
 *
 * Electron is faked because the defect is in THIS module's wiring of
 * Electron's events, not in anything a pure function could hold; the fake
 * models only what the module touches.
 */

class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  destroyed = false;
  setBoundsCalls = 0;
  ignoreMouse: boolean[] = [];
  webContents = { send: vi.fn() };
  constructor() { super(); FakeWindow.all.push(this); }
  isDestroyed() { return this.destroyed; }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  loadFile() {}
  showInactive() {}
  setBounds() { this.setBoundsCalls++; }
  setSize() { this.setBoundsCalls++; }
  setIgnoreMouseEvents(ignore: boolean) { this.ignoreMouse.push(ignore); }
  destroy() { this.destroyed = true; this.emit("closed"); }
}

const ipc = new EventEmitter();

vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  ipcMain: {
    on: (ch: string, fn: (...a: unknown[]) => void) => ipc.on(ch, fn),
    removeListener: (ch: string, fn: (...a: unknown[]) => void) => ipc.removeListener(ch, fn),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
}));

const OPTS = { corner: "bottom-right" as const, dist: "/d", rendererDir: "/r" };

async function freshModule() {
  vi.resetModules();
  FakeWindow.all = [];
  ipc.removeAllListeners();
  return import("../src/toast-window.js");
}

/** What the toast's page used to send once it had measured itself (STC-457). */
function fit(win: FakeWindow, px = 120): void {
  ipc.emit("toast:fit", { sender: win.webContents }, px);
}

/** What the toast's page sends as the pointer enters or leaves its card. */
function hover(win: FakeWindow, over: boolean): void {
  ipc.emit("toast:hover", { sender: win.webContents }, over);
}

describe("a message toast and the app's quit", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  test("a message toast is never resized, whatever its page sends (STC-509)", async () => {
    const t = await freshModule();
    t.showMessageToast("Camera could not be opened.", OPTS);
    const win = FakeWindow.all[0]!;
    fit(win);
    hover(win, true);
    hover(win, false);
    expect(ipc.listenerCount("toast:fit")).toBe(0);
    expect(win.setBoundsCalls).toBe(0);
  });

  test("control: the window starts click-through and takes clicks only while the card is hovered", async () => {
    const t = await freshModule();
    t.showMessageToast("Camera could not be opened.", OPTS);
    const win = FakeWindow.all[0]!;
    hover(win, true);
    hover(win, false);
    expect(win.ignoreMouse).toEqual([true, false, true]);
  });

  test("a hover from some other page is ignored", async () => {
    const t = await freshModule();
    t.showMessageToast("Camera could not be opened.", OPTS);
    const win = FakeWindow.all[0]!;
    ipc.emit("toast:hover", { sender: {} }, true);
    expect(win.ignoreMouse).toEqual([true]);
  });

  test("once the quit teardown has begun, no new message toast is built", async () => {
    const t = await freshModule();
    t.closeToastsForQuit();
    t.showMessageToast("The helper stopped.", OPTS);
    expect(FakeWindow.all).toHaveLength(0);
  });

  test("once the quit teardown has begun, no new undo toast is built either", async () => {
    const t = await freshModule();
    t.closeToastsForQuit();
    t.showUndoToast({ ...OPTS, dir: "/takes/a" });
    expect(FakeWindow.all).toHaveLength(0);
  });

  test("closeToastsForQuit takes down the toast that is already up", async () => {
    const t = await freshModule();
    t.showMessageToast("Moved 1 take to the Trash.", OPTS);
    const win = FakeWindow.all[0]!;
    t.closeToastsForQuit();
    expect(win.destroyed).toBe(true);
  });

  test("a toast:hover that lands after the window began closing does not touch it", async () => {
    const t = await freshModule();
    t.showMessageToast("Camera could not be opened.", OPTS);
    const win = FakeWindow.all[0]!;
    // Electron's own quit closes the window: "close" is emitted first, and
    // the native teardown runs while isDestroyed() is still false.
    win.emit("close", { preventDefault() {} });
    expect(win.isDestroyed()).toBe(false);
    hover(win, true);
    expect(win.ignoreMouse).toEqual([true]);
    expect(ipc.listenerCount("toast:hover")).toBe(0);
  });

  test("a toast:hover after the quit teardown began does not touch the window", async () => {
    const t = await freshModule();
    t.showMessageToast("Camera could not be opened.", OPTS);
    const win = FakeWindow.all[0]!;
    t.closeToastsForQuit();
    hover(win, true);
    expect(win.ignoreMouse).toEqual([true]);
  });
});
