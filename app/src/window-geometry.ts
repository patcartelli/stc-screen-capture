import type { BrowserWindow, Rectangle } from "electron";

/**
 * Moving or resizing a window that is on its way out (STC-496).
 *
 * The crash this exists for, symbolicated from CI's own reports (runs
 * 36754523619 x3 and 37043431975, Electron 43.4.1, macOS 15.7.9 on a
 * GPU-less `VirtualMac2,1`):
 *
 *     BaseWindow::SetBounds -> NativeWindowMac::SetBounds
 *       -> -[NSWindow _setFrameCommon:] -> -[BridgedContentView setFrameSize:]
 *       -> NativeWidgetMacNSWindowHost::UpdateCompositorProperties
 *       -> ui::Layer::SetBounds   SIGSEGV at 0xcdcd...  (PartitionAlloc's freed-memory fill)
 *
 * A `setBounds` from JS reached a window whose compositor layer had already
 * been freed, every time at the moment the app was quitting. `isDestroyed()`
 * does not catch it: measured on Electron 43.4.1, it flips synchronously on
 * `destroy()`, but after `close()` — which is what quitting does to every
 * window — it stays false, and `setBounds` is accepted, until `closed`.
 * That window of time is when this fires; it did not crash on a GPU Mac,
 * where the layer outlives it, which is why only CI has seen it.
 *
 * So geometry changes go through `setBoundsUnlessClosing`, which refuses one
 * once the app has started quitting or the window has started closing, and
 * says so on stderr with WHO asked — on CI that line names which caller the
 * crash was coming from, which the stack alone could not (the JS frames are
 * unsymbolicated).
 *
 * The decision is `geometrySkip`, pure; the wrapper only reads the window and
 * this module's two pieces of state.
 */

export type GeometrySkip = "destroyed" | "quitting" | "closing";

export function geometrySkip(s: { destroyed: boolean; quitting: boolean; closing: boolean }): GeometrySkip | undefined {
  if (s.destroyed) return "destroyed";
  if (s.quitting) return "quitting";
  if (s.closing) return "closing";
  return undefined;
}

let appQuitting = false;
const closing = new WeakSet<BrowserWindow>();

/**
 * Call where main.ts commits to quitting (`quitting = true`), NOT on
 * `before-quit` itself: a quit the user cancels from the unsaved-takes dialog
 * keeps the app running, and its windows must keep moving.
 */
export function noteAppQuitting(): void {
  appQuitting = true;
}

/**
 * Mark `win` as closing from its own `close` event on. Only for windows
 * nothing cancels the close of — the toast and the thumbnail panels — since
 * a `close` someone prevents would leave the window marked while it stays up.
 */
export function trackClosing(win: BrowserWindow): void {
  win.on("close", () => { closing.add(win); });
}

/** `win.setBounds(bounds)`, unless the window or the app is on its way out. */
export function setBoundsUnlessClosing(win: BrowserWindow, bounds: Partial<Rectangle>, who: string): boolean {
  const skip = geometrySkip({ destroyed: win.isDestroyed(), quitting: appQuitting, closing: closing.has(win) });
  if (skip) {
    // A destroyed window is the ordinary, already-guarded case: not worth a line.
    if (skip !== "destroyed") console.error(`[geometry] skipped setBounds from ${who}: ${skip === "quitting" ? "the app is quitting" : "the window is closing"} (STC-496)`);
    return false;
  }
  win.setBounds(bounds);
  return true;
}
