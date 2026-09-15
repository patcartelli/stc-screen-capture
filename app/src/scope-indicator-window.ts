import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import type { HelperSupervisor } from "./supervisor.js";
import type { ScopeSettings } from "./settings.js";
import type { WindowInfo } from "./selection.js";
import { toDisplayInfo } from "./overlay-session.js";
import { resolveIndicatorTarget, type IndicatorTarget } from "./scope-indicator.js";

/**
 * The persistent scope indicator's real window (STC-381). `scope-indicator.ts`
 * decides WHAT to outline; this creates the one non-interactive `BrowserWindow`
 * that draws it, and wires it to the main window's focus/blur and to the two
 * other events that must clear it — a scope change and Record being pressed.
 * Same split `pill.ts`/`pill-window.ts` and `selection.ts`/`overlay-session.ts`
 * already use.
 *
 * ## One window, not one per display
 *
 * `overlay-session.ts` needs a window per display because a DRAG can cross a
 * bezel. This has no gesture at all — the target is always a single rect on a
 * single display — so the indicator window IS that rect (`setBounds` to the
 * target exactly) rather than a full-display window with an inner highlight.
 * That also means `scope-indicator.html` needs no coordinate translation: its
 * border sits at the window's own edge, which is already the target's edge.
 *
 * ## Never present in a recording
 *
 * The window is DESTROYED, not merely hidden, the instant any hide trigger
 * fires, and `recorder:start` calls `hideScopeIndicatorForRecording()` before
 * it ever touches the helper — the ticket's own "closed before start()".
 * `reconcile` also refuses to draw while `sup.state` is `"recording"` or
 * `"starting"`, which is the one path a focus event can still fire during a
 * live take (clicking the collapsed pill to check on it). An indicator that
 * only ever exists between a focus and the next blur/change/Record/take-start
 * needs none of the selection overlay's exclude-and-hide belt-and-braces
 * (STC-290) — see the ticket's "Decided approach" for why that dance would be
 * solving a problem this design does not have.
 */

interface AttachOptions {
  /** Where `scope-indicator.html` lives — `join(here, "..", "renderer")` in
   * `main.ts`, injected so a test could point elsewhere. */
  rendererDir: string;
  /** Read fresh on every reconcile, never cached — the current scope is
   * `main.ts`'s settings file, not this module's business to track. */
  getScope: () => ScopeSettings;
}

interface ActiveSession extends AttachOptions {
  win: BrowserWindow;
  sup: HelperSupervisor;
}

/** One indicator for one main window at a time, the same singleton shape
 * `overlay-session.ts`'s `active` uses — there is only ever one main window. */
let active: ActiveSession | undefined;
let indicatorWin: BrowserWindow | undefined;
/** Guards a `listWindows()` reply landing after a newer reconcile (or a
 * blur) has already superseded it — the same race `OverlaySession` guards by
 * keeping its display list live rather than trusting a stale snapshot. */
let reconcileToken = 0;

function hideScopeIndicator(): void {
  reconcileToken++;
  if (indicatorWin && !indicatorWin.isDestroyed()) indicatorWin.destroy();
  indicatorWin = undefined;
}

function showIndicator(target: IndicatorTarget, rendererDir: string): void {
  if (!indicatorWin || indicatorWin.isDestroyed()) {
    indicatorWin = new BrowserWindow({
      x: target.rect.x, y: target.rect.y, width: target.rect.width, height: target.rect.height,
      transparent: true, frame: false, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, focusable: false,
      // Not shown until painted, same reason `overlay-session.ts` waits: a
      // transparent window flashing the desktop through on its first frame
      // reads as a glitch, not an affordance appearing.
      show: false,
      enableLargerThanScreen: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    const w = indicatorWin;
    // Click-through and never focusable: this is decoration, and stealing a
    // click or the keyboard would make it an input surface nobody asked for.
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setAlwaysOnTop(true, "screen-saver");
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.once("ready-to-show", () => { if (!w.isDestroyed()) w.showInactive(); });
    w.loadFile(join(rendererDir, "scope-indicator.html"));
  } else {
    indicatorWin.setBounds(target.rect);
  }
}

async function reconcile(): Promise<void> {
  const token = ++reconcileToken;
  const session = active;
  if (!session || session.win.isDestroyed() || !session.win.isFocused()) return hideScopeIndicator();
  if (session.sup.state === "recording" || session.sup.state === "starting") return hideScopeIndicator();

  const scope = session.getScope();
  if (scope.kind !== "window" && scope.kind !== "region") return hideScopeIndicator();

  let liveWindow: WindowInfo | undefined;
  if (scope.kind === "window" && scope.windowId != null) {
    try {
      const r = await session.sup.listWindows();
      const found = ((r.windows as any[]) ?? []).find((w) => w.id === scope.windowId);
      liveWindow = found
        ? { id: found.id, app: found.app, title: found.title,
            bounds: { x: found.x, y: found.y, width: found.width, height: found.height } }
        : undefined;
    } catch {
      // No Screen Recording grant, or the helper is otherwise unreachable —
      // "not found" is the correct read: don't draw a stale rect.
      liveWindow = undefined;
    }
  }

  // Superseded by a newer reconcile — or a blur/hide that ran while the
  // lookup above was in flight — which already owns whatever the window
  // should show now. Do NOT hide here; that would race a target the newer
  // call is about to draw.
  if (token !== reconcileToken) return;
  if (!active || active.win.isDestroyed() || !active.win.isFocused()) return hideScopeIndicator();
  if (active.sup.state === "recording" || active.sup.state === "starting") return hideScopeIndicator();

  const displays = screen.getAllDisplays().map(toDisplayInfo);
  const target = resolveIndicatorTarget(scope, displays, liveWindow);
  if (!target) return hideScopeIndicator();
  showIndicator(target, active.rendererDir);
}

/**
 * Wires the indicator to `win`'s focus/blur. Returns an unsubscribe function;
 * the caller owns the window's lifetime and must re-attach after replacing
 * `win`, same as `attachPillToSupervisor` — STC-292 made the main window
 * closable and re-creatable, and this does not survive that on its own.
 */
export function attachScopeIndicator(
  win: BrowserWindow,
  sup: HelperSupervisor,
  opts: AttachOptions,
): () => void {
  active = { win, sup, ...opts };
  const onFocus = () => void reconcile();
  const onBlur = () => hideScopeIndicator();
  win.on("focus", onFocus);
  win.on("blur", onBlur);
  return () => {
    win.removeListener("focus", onFocus);
    win.removeListener("blur", onBlur);
    hideScopeIndicator();
    if (active?.win === win) active = undefined;
  };
}

/**
 * Call after any settings write that could change scope or its target — a
 * kind change, a pick, or a clear. Re-evaluates rather than blindly hiding,
 * so picking a NEW target while already focused shows it at once instead of
 * needing a blur/refocus round trip; a change that leaves nothing to show
 * (or that fires with no window focused at all) hides it.
 */
export function scopeIndicatorScopeChanged(): void {
  if (active && !active.win.isDestroyed() && active.win.isFocused()) void reconcile();
  else hideScopeIndicator();
}

/** `recorder:start` calls this before the helper is ever touched — the
 * ticket's "closed before start()". */
export function hideScopeIndicatorForRecording(): void {
  hideScopeIndicator();
}

/** Used by the quit sequence, alongside `closeOverlay`/`closeThumbnail`. */
export function closeScopeIndicator(): void {
  hideScopeIndicator();
}
