/**
 * Taking the keyboard for an overlay panel WITHOUT activating the app.
 *
 * The problem this exists for, found on hardware 2026-09-16 (STC-391 runbook
 * §0/§3). `overlay-session.ts` called `app.focus({ steal: true })` so a
 * hotkey or menu-bar capture starting from the background could reach Escape.
 * That is an APPLICATION-level activation on macOS: it raises the app's
 * ordinary windows, and the main window is one of them. So every menu-bar
 * capture brought the library forward — and once the overlay was torn down,
 * the main window was the app's remaining ordinary window and took key status
 * back off the countdown panel, leaving Escape and Return dead in exactly the
 * place STC-391's §0 promised they would work.
 *
 * STC-292's own comment claimed the opposite ("the main window is not
 * activated by this; only the overlay is"). It was never true; nothing
 * depended on who held focus until the countdown did, so nobody looked.
 *
 * The mechanism that does work is an NSPanel — `type: "panel"` on the
 * BrowserWindow — which macOS will let become key WITHOUT making its
 * application active. `PANEL_WINDOW_TYPE` is that option, in one place, so the
 * overlay and the countdown cannot drift apart on it.
 *
 * WHY THERE IS A FALLBACK AT ALL. Panel key-window semantics are the OS's,
 * not ours, and this was written on Linux where they cannot be observed — the
 * failure mode if they differ is a dead Escape on an overlay covering the
 * screen, which is far worse than a raised library. So `focusPanel` asks for
 * the keyboard the polite way and then CHECKS whether it actually arrived,
 * escalating to the old app-level activation only if it did not. The cost of
 * the fallback firing is today's behaviour, which is a known quantity; the
 * cost of not having it is an overlay the user cannot dismiss.
 *
 * It reports which path it took, because "the library still comes forward" and
 * "the panel never got focus" are different faults with the same symptom, and
 * a hardware run needs to say which one it saw.
 */

/** Electron's `type` for a window that may take key without activating the app. */
export const PANEL_WINDOW_TYPE = "panel" as const;

/**
 * How long to let the window server answer before deciding the polite path
 * failed. A focus change is a round trip to the window server, so it is never
 * synchronous; this is long enough for one under load and short enough that a
 * user who has to press Escape is not waiting on it.
 */
export const PANEL_FOCUS_ESCALATE_MS = 250;

/** The little of a BrowserWindow this needs — so a test can drive it with no Electron. */
export interface FocusableWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  focus(): void;
}

export type PanelFocusOutcome = "panel" | "escalated" | "gone";

/**
 * The decision, apart from the waiting: given what the window reports once the
 * window server has had its chance, did the polite path work?
 *
 * Pure on purpose. The escalation is the part that can only be judged on a
 * Mac, and a rule nobody can state apart from its timer is a rule nobody can
 * mutation-test.
 */
export function needsActivation(destroyed: boolean, focused: boolean): boolean {
  if (destroyed) return false;
  return !focused;
}

/**
 * Give `win` the keyboard. Resolves with the path it took.
 *
 * `activate` is the escalation — `app.focus({ steal: true })` at the call site
 * — injected rather than imported so this module needs no Electron and can be
 * tested for real.
 */
export async function focusPanel(
  win: FocusableWindow,
  activate: () => void,
  opts: { escalateAfterMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PanelFocusOutcome> {
  const ms = opts.escalateAfterMs ?? PANEL_FOCUS_ESCALATE_MS;
  const sleep = opts.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n)));

  if (win.isDestroyed()) return "gone";
  win.focus();
  await sleep(ms);
  if (win.isDestroyed()) return "gone";
  if (!needsActivation(false, win.isFocused())) return "panel";

  // The polite path did not take. Fall back to what STC-292 always did: worse
  // for the library, but the overlay stays dismissable.
  activate();
  if (!win.isDestroyed()) win.focus();
  return "escalated";
}
