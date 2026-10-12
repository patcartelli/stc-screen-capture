import type { App, BrowserWindow } from "electron";

/**
 * Which window was it (STC-534).
 *
 * CI's Electron 43.4.1 crashes during the quit, on the main thread, in
 *
 *     -[NSApplication _handleActivatedEvent:] / _handleDeactivateEvent:
 *       -> -[NSWindow becomeKeyWindow] / resignKeyWindow
 *       -> -[ElectronNSWindowDelegate windowDidBecomeKey:/windowDidResignKey:]
 *       -> NativeWindow::NotifyWindowIsKeyChanged
 *       -> BrowserWindow::OnWindowIsKeyChanged   window()->SetActive(is_key)
 *          SIGSEGV at 0x3de: BaseWindow::window_ is null
 *
 * i.e. AppKit moved key status onto or off a window whose `BrowserWindow` was
 * being destroyed (electron/electron#54860). The stack cannot say WHICH
 * window, so from the moment the quit commits this logs every window's state,
 * then each window's focus/blur/show/hide/close/closed and the app's own
 * activation changes (the `_handleActivatedEvent:`/`_handleDeactivateEvent:`
 * frames) as they happen. The last lines before a crash name the window.
 *
 * Electron gives JS no key-window event, so `focus`/`blur` stand in for it. On
 * macOS those come from the same delegate (`windowDidBecomeMain:`/
 * `windowDidResignMain:`, posted alongside key changes for an ordinary
 * window); a `type: "panel"` window can become key without becoming main, so
 * for the overlay and the countdown the app activation lines are the signal.
 *
 * Lines go to stderr with a `[window]` prefix. `closeApp` (app/test/_quit-fixture.ts)
 * collects them and prints them only when the app died from a crash signal, so
 * a clean e2e run stays quiet.
 *
 * `describeWindow` and `pageName` are pure; `startQuitWindowLog` only reads
 * windows and attaches listeners — it never changes one.
 */

export interface WindowState {
  id: number;
  /** The loaded page's file name, e.g. `toast.html`. */
  page: string;
  destroyed: boolean;
  /** The window's `webContents` is destroyed while the window is not. */
  contentsGone: boolean;
  visible: boolean;
  focused: boolean;
}

/** `file:///…/renderer/toast.html?x#y` -> `toast.html`. */
export function pageName(url: string): string {
  if (!url) return "(no page)";
  const path = url.split(/[?#]/)[0] ?? "";
  return path.slice(path.lastIndexOf("/") + 1) || "(no page)";
}

export function describeWindow(s: WindowState): string {
  if (s.destroyed) return `#${s.id} destroyed`;
  return [
    `#${s.id}`,
    s.page,
    s.visible ? "visible" : "hidden",
    ...(s.focused ? ["focused"] : []),
    ...(s.contentsGone ? ["contents-gone"] : []),
  ].join(" ");
}

/** Every read is guarded: this runs on windows that are mid-teardown. */
function stateOf(win: BrowserWindow): WindowState {
  if (win.isDestroyed()) {
    return { id: win.id, page: "?", destroyed: true, contentsGone: true, visible: false, focused: false };
  }
  const contentsGone = win.webContents.isDestroyed();
  return {
    id: win.id,
    page: contentsGone ? "?" : pageName(win.webContents.getURL()),
    destroyed: false,
    contentsGone,
    visible: win.isVisible(),
    focused: win.isFocused(),
  };
}

const WINDOW_EVENTS = ["focus", "blur", "show", "hide", "close", "closed"] as const;
const APP_EVENTS = ["did-become-active", "did-resign-active"] as const;

let started = false;

/**
 * Call where the quit commits to tearing down (`runQuitTeardown`). One-way
 * and idempotent: a quit only starts once, and a second call must not double
 * every line.
 */
export function startQuitWindowLog(app: App, windows: BrowserWindow[], now: () => number = Date.now): void {
  if (started) return;
  started = true;
  const t0 = now();
  const at = () => `+${now() - t0}ms`;
  const log = (line: string) => { console.error(`[window] ${line}`); };

  log(`quit ${at()}: ${windows.length} window${windows.length === 1 ? "" : "s"}: `
    + (windows.map((w) => describeWindow(stateOf(w))).join(" | ") || "none"));

  const follow = (win: BrowserWindow) => {
    for (const event of WINDOW_EVENTS) {
      // `closed` is emitted after the window is destroyed; `stateOf` reads
      // that, so it never touches a dead window's webContents.
      win.on(event as never, () => { log(`${at()} ${describeWindow(stateOf(win))}: ${event}`); });
    }
  };
  for (const w of windows) follow(w);
  app.on("browser-window-created", (_e, win) => {
    log(`${at()} ${describeWindow(stateOf(win))}: created`);
    follow(win);
  });
  for (const event of APP_EVENTS) {
    app.on(event as never, () => { log(`${at()} app: ${event}`); });
  }
}
