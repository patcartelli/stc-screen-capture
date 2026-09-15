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
 * overlay resolves a fresh window or area — and it hides itself again, with
 * a fade rather than a hard cut, with no further input. There is no
 * focus/blur wiring to the main window at all now, which is also why this
 * module no longer needs a `HelperSupervisor` or `BrowserWindow` reference
 * of its own: `pickCaptureTarget` already refuses to run while a take is
 * live, so nothing here can fire during a recording by construction.
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
 * How long the flash stays fully visible before it starts fading. Both
 * numbers here have already moved from real-hardware feedback: a flat
 * 2000ms hold with a hard cut at the end read as lingering AND (once
 * shortened) the hard cut itself read as buggy — an outline present one
 * frame and gone the next looks like a rendering glitch, not a UI choice.
 * `FLASH_FADE_MS` fixed the cut; this was then judged too brief on its own
 * — held only long enough to look like a misclick rather than a deliberate
 * confirmation — and lengthened alongside a slower fade. Total time on
 * screen is `FLASH_HOLD_MS + FLASH_FADE_MS`. `docs/STC-381-RUNBOOK.md` is
 * where a further Mac judgement on either number belongs.
 */
export const FLASH_HOLD_MS = 450;
/** How long the fade-to-transparent takes, once the hold above ends. */
export const FLASH_FADE_MS = 350;
/** Roughly 60fps — smooth enough to read as a fade rather than a stepped
 * dimming, without waking the process more often than it needs to. */
const FADE_STEP_MS = 16;

let indicatorWin: BrowserWindow | undefined;
let holdTimer: NodeJS.Timeout | undefined;
let fadeInterval: NodeJS.Timeout | undefined;

/** Destroys whatever is on screen and cancels any pending hold or fade.
 * Safe to call whether or not a flash is currently showing. */
export function hideScopeIndicator(): void {
  if (holdTimer !== undefined) { clearTimeout(holdTimer); holdTimer = undefined; }
  if (fadeInterval !== undefined) { clearInterval(fadeInterval); fadeInterval = undefined; }
  if (indicatorWin && !indicatorWin.isDestroyed()) indicatorWin.destroy();
  indicatorWin = undefined;
}

/** Steps the window's opacity down to 0 over `FLASH_FADE_MS`, then
 * destroys it. Electron's `setOpacity` is a plain property, not an
 * animation — this is what makes it read as a fade instead of a cut. */
function startFade(w: BrowserWindow): void {
  const start = Date.now();
  fadeInterval = setInterval(() => {
    if (w.isDestroyed()) { hideScopeIndicator(); return; }
    const elapsed = Date.now() - start;
    if (elapsed >= FLASH_FADE_MS) { hideScopeIndicator(); return; }
    w.setOpacity(1 - elapsed / FLASH_FADE_MS);
  }, FADE_STEP_MS);
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
  w.once("ready-to-show", () => {
    if (w.isDestroyed()) return;
    w.setOpacity(1);
    w.showInactive();
  });
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
 * Show the outline around `opts.scope`'s target, hold it for
 * `FLASH_HOLD_MS`, then fade it out over `FLASH_FADE_MS` and destroy it.
 * The only caller is `pickCaptureTarget`, right after a fresh pick resolves
 * — never on focus, never on a timer of its own outside this one. Cancels
 * and replaces any flash already in progress (a second pick before the
 * first flash finished).
 */
export function flashScopeIndicator(opts: FlashOptions): void {
  hideScopeIndicator();
  const displays = screen.getAllDisplays().map(toDisplayInfo);
  const target = resolveIndicatorTarget(opts.scope, displays, opts.liveWindow);
  if (!target) return;
  showIndicator(target, opts.rendererDir);
  const w = indicatorWin!;
  holdTimer = setTimeout(() => { holdTimer = undefined; startFade(w); }, FLASH_HOLD_MS);
}
