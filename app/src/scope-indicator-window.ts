import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import type { ScopeSettings } from "./settings.js";
import type { WindowInfo } from "./selection.js";
import { toDisplayInfo } from "./overlay-session.js";
import { resolveIndicatorTarget, type IndicatorTarget } from "./scope-indicator.js";

/**
 * The scope indicator's real window (STC-381). `scope-indicator.ts` decides
 * WHAT to outline; this creates the one non-interactive `BrowserWindow` that
 * draws it. Same split `pill.ts`/`pill-window.ts` and `selection.ts`/
 * `overlay-session.ts` already use.
 *
 * ## A confirmation flash, not a persistent affordance
 *
 * The ticket's original design showed the outline on every main-window
 * focus, for as long as Scope stayed Window/Area — CONFIRMED ON HARDWARE
 * (2026-09-15) to read as naggy rather than helpful once actually lived
 * with. What people actually wanted was narrower: confirm what was just
 * picked, then get out of the way. So `flashScopeIndicator` is the only way
 * this ever shows — called once, from `pickCaptureTarget`, right after the
 * overlay resolves a fresh window or area — and it hides itself again after
 * `FLASH_HOLD_MS` with no further input. There is no focus/blur wiring to
 * the main window at all now, which is also why this module no longer needs
 * a `HelperSupervisor` or `BrowserWindow` reference of its own:
 * `pickCaptureTarget` already refuses to run while a take is live, so
 * nothing here can fire during a recording by construction.
 *
 * ## One window, not one per display
 *
 * `overlay-session.ts` needs a window per display because a DRAG can cross a
 * bezel. This has no gesture at all — the target is always a single rect on
 * a single display — so the indicator window IS that rect (`setBounds` to
 * the target exactly) rather than a full-display window with an inner
 * highlight. That also means `scope-indicator.html` needs no coordinate
 * translation: its border sits at the window's own edge, which is already
 * the target's edge.
 *
 * ## Never present in a recording
 *
 * `hideScopeIndicator` DESTROYS the window rather than hiding it, and
 * `recorder:start` calls it before the helper is ever touched — belt to the
 * fact that `pickCaptureTarget` cannot even start a flash while recording.
 */

/**
 * How long the flash stays up once shown. Not tuned against anything — a
 * first guess pending a Mac look at whether it reads as too quick to
 * register or lingering. `docs/STC-381-RUNBOOK.md` is where that judgement
 * belongs once someone has looked.
 */
export const FLASH_HOLD_MS = 2000;

let indicatorWin: BrowserWindow | undefined;
let flashTimer: NodeJS.Timeout | undefined;

/** Destroys whatever is on screen and cancels any pending auto-hide. Safe
 * to call whether or not a flash is currently showing. */
export function hideScopeIndicator(): void {
  if (flashTimer !== undefined) { clearTimeout(flashTimer); flashTimer = undefined; }
  if (indicatorWin && !indicatorWin.isDestroyed()) indicatorWin.destroy();
  indicatorWin = undefined;
}

function showIndicator(target: IndicatorTarget, rendererDir: string): void {
  const w = new BrowserWindow({
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
  indicatorWin = w;
  // Click-through and never focusable: this is decoration, and stealing a
  // click or the keyboard would make it an input surface nobody asked for.
  w.setIgnoreMouseEvents(true, { forward: true });
  w.setAlwaysOnTop(true, "screen-saver");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.once("ready-to-show", () => { if (!w.isDestroyed()) w.showInactive(); });
  w.loadFile(join(rendererDir, "scope-indicator.html"));
}

export interface FlashOptions {
  scope: ScopeSettings;
  /**
   * The just-picked window's live bounds, when `scope.kind === "window"` —
   * `pickCaptureTarget` already has this in hand from the SAME `windows`
   * list it used to build the sticky `windowLabel`, so no second helper
   * round trip is needed for a flash fired the instant after a pick.
   */
  liveWindow?: WindowInfo;
  /** Where `scope-indicator.html` lives — `join(here, "..", "renderer")` in
   * `main.ts`, injected so a test could point elsewhere. */
  rendererDir: string;
}

/**
 * Show the outline around `opts.scope`'s target for `FLASH_HOLD_MS`, then
 * hide it automatically. The only caller is `pickCaptureTarget`, right after
 * a fresh pick resolves — never on focus, never on a timer of its own
 * outside this one. Cancels and replaces any flash already in progress
 * (a second pick before the first flash finished).
 */
export function flashScopeIndicator(opts: FlashOptions): void {
  hideScopeIndicator();
  const displays = screen.getAllDisplays().map(toDisplayInfo);
  const target = resolveIndicatorTarget(opts.scope, displays, opts.liveWindow);
  if (!target) return;
  showIndicator(target, opts.rendererDir);
  flashTimer = setTimeout(() => hideScopeIndicator(), FLASH_HOLD_MS);
}
