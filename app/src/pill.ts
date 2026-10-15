import type { SupervisorState } from "./supervisor-state.js";

/**
 * The floating pill's decisions (STC-375) — no DOM, no Electron.
 *
 * Same split this project already uses for a windowed interaction
 * (`selection.ts` / `overlay-session.ts`, `thumbnail.ts` / `thumbnail-window.ts`):
 * what the pill IS lives here, exercised with no window and no timer;
 * `pill-window.ts` owns the real `BrowserWindow` and the real resize calls
 * this module only describes.
 *
 * Also imported by `pill-renderer.ts` (`formatElapsedTimer`, `meterView`),
 * which is WHY the `SupervisorState` type comes from
 * `supervisor-state.ts` rather than `supervisor.ts` — the same node-drag
 * trap `library-items.ts` was split out of `library.ts` to avoid.
 *
 * ## Its own window (STC-550)
 *
 * STC-375 built the pill as the library window collapsed to 26px, which made
 * sense while the library was the window Record lived in. STC-502 made the
 * app launch to the menu bar, and every state the library could be in
 * (closed, minimized, hidden with ⌘H) then turned up as a pill bug. So the
 * pill is a window of its own now (`pill-window.ts`, `pill.html`), one per
 * take, top-centre of the display being recorded (`pillBounds`), and the
 * library only steps out of the way (`libraryAroundTake`).
 *
 * The state names below kept their STC-375 meaning so every rule written
 * against them still reads the same: `collapsed` is "the pill is showing",
 * `expanded` is "no pill". Nothing resizes between them any more.
 *
 * ## Trap 1 and 3 from the ticket, encoded rather than trusted
 *
 * "Collapse happens *after* `start` is answered, never inside it" and
 * "collapse must be driven by [the helper's heartbeat], not the click that
 * started it, or a take the helper stopped on its own leaves a pill on
 * screen for a recording that already ended." `decidePillAction` takes a
 * `SupervisorState` — the heartbeat-confirmed value `HelperSupervisor`
 * already self-heals against desync for (see its own `stats` handler) —
 * never a click event. There is no function here that takes anything named
 * "click" or "record-button"; `pill-window.ts`'s `attachPillToSupervisor`
 * only ever reconciles off that same confirmed state.
 */

export type PillWindowState = "expanded" | "collapsed";

/**
 * The ticket's own pseudocode number for the pill's height — the one
 * dimension that stays fixed regardless of which window this ends up being.
 * The restored size is NOT a fixed constant; see `pill-window.ts`'s header
 * for why "restore" means the window's own remembered bounds instead.
 */
export const PILL_HEIGHT_PX = 26;

/** A pill narrower than this could not hold the dot and a timer at all. */
export const MIN_PILL_WIDTH_PX = 96;

/**
 * A measured content width is trusted only as far as it is a finite,
 * positive number — the same "clamp a fed-in number, never trust it blind"
 * rule `clampCountdownMs` follows in `countdown.ts`. A failed measurement (a
 * NaN from an empty string, a negative from a stale layout) must not
 * produce a window with zero or negative width; it floors at
 * `MIN_PILL_WIDTH_PX` instead of propagating the garbage into `setSize`.
 */
export function clampPillWidth(measuredContentWidthPx: number, paddingPx = 16): number {
  const n = Number.isFinite(measuredContentWidthPx) && measuredContentWidthPx > 0
    ? measuredContentWidthPx : 0;
  return Math.max(MIN_PILL_WIDTH_PX, Math.round(n + paddingPx));
}

/**
 * What the pill's border and side padding add to its measured row
 * (`pill.html`: 10px each side plus a 1px ring each side).
 */
export const PILL_CHROME_PX = 22;

/**
 * The gap between the top of the work area (just under the menu bar) and the
 * pill. `--space-3` in `tokens.css`, which CSS cannot hand to the main process;
 * `pill.test.ts` reads the token so the two cannot drift.
 */
export const PILL_TOP_INSET_PX = 8;

export interface PillRect { x: number; y: number; width: number; height: number }

/**
 * Where a take's pill opens (STC-550): centred on the recorded display's work
 * area, `PILL_TOP_INSET_PX` below its top. Every take starts here; a drag
 * moves the window for that take only and is never stored.
 *
 * Whole pixels, and never wider than the work area: a pure function cannot
 * know how wide a real screen is, so the caller hands it in.
 */
export function pillBounds(workArea: PillRect, measuredContentWidthPx: number): PillRect {
  const width = Math.min(clampPillWidth(measuredContentWidthPx, PILL_CHROME_PX), Math.max(1, workArea.width));
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + PILL_TOP_INSET_PX),
    width,
    height: PILL_HEIGHT_PX,
  };
}

/**
 * The pill's content changed width (the timer gained an hour digit, or a stop
 * label stands in for it). It grows or shrinks about its CURRENT centre, so a
 * pill the user dragged stays where they put it, and is kept inside the work
 * area of the display it is on.
 */
export function resizePillBounds(current: PillRect, workArea: PillRect, measuredContentWidthPx: number): PillRect {
  const width = Math.min(clampPillWidth(measuredContentWidthPx, PILL_CHROME_PX), Math.max(1, workArea.width));
  const centre = current.x + current.width / 2;
  const left = Math.round(centre - width / 2);
  const x = Math.min(Math.max(left, workArea.x), workArea.x + workArea.width - width);
  return { x, y: current.y, width, height: current.height };
}

/** What the library window is doing at the moment a take is about to start. */
export interface LibraryAtTakeStart {
  /** A library window exists at all. Since STC-502 there often is none. */
  exists: boolean;
  /** `BrowserWindow.isVisible()`. */
  visible: boolean;
  minimized: boolean;
  /** The whole app is hidden (⌘H). */
  appHidden: boolean;
}

/**
 * What a take does to the library (STC-550, decided 2026-10-15).
 *
 * - Open and on screen: `hide()` it (never `minimize()`, which animates), and
 *   show it again, unfocused, when the take is over.
 * - Minimized: leave it in the Dock, untouched, before and after (STC-538).
 * - Hidden with the app (⌘H): main has to unhide the app for the pill to show
 *   at all, which would bring the library back mid-take, so it is `hide()`n
 *   too. It was not on screen when the take started, so it stays hidden after.
 * - None: nothing to do, and none is made (STC-524 made one to collapse).
 */
export function libraryAroundTake(s: LibraryAtTakeStart): { hide: boolean; showAfter: boolean } {
  if (!s.exists || s.minimized) return { hide: false, showAfter: false };
  if (s.appHidden) return { hide: true, showAfter: false };
  return { hide: s.visible, showAfter: s.visible };
}

/**
 * What the confirmed recording state means for the pill: `collapse` shows it,
 * `restore` puts it away (the names are STC-375's; see the header).
 *
 * Idempotent by construction: asking again once already in the state the
 * signal implies answers `"none"`, so a caller that re-derives this on every
 * heartbeat (rather than only on a transition) cannot show or hide twice.
 */
export function decidePillAction(
  current: PillWindowState,
  recordingState: SupervisorState,
  dwelling = false,
): "collapse" | "restore" | "none" {
  const recording = recordingState === "recording";
  if (recording && current === "expanded") return "collapse";
  // STC-531: a pill showing why its take stopped holds until the dwell ends.
  // Only a restore waits; a new take (`recording`) never does.
  if (!recording && current === "collapsed" && !dwelling) return "restore";
  return "none";
}

/**
 * How long the pill shows why the helper stopped a take (STC-531, the spec's
 * "about 2 s") before the window restores and the take's panel goes up. The
 * panel waits the SAME time (main.ts's `onTakeEnded`), so the label and the
 * panel are never on screen together.
 */
export const PILL_STOPPED_DWELL_MS = 2000;

/**
 * Whether a stop shows its label on the pill: only when there IS a label
 * (`stop-copy.ts`'s `pillLabel`, i.e. the helper stopped the take by itself)
 * and the window is the pill right now. A stop the user asked for, or one
 * that lands on an expanded window, restores exactly as it always did.
 */
export function shouldDwell(current: PillWindowState, label: string | undefined): boolean {
  return current === "collapsed" && label !== undefined && label !== "";
}

/**
 * STC-237: whether a mic or camera lost mid-take shows its label (`stop-copy.ts`'s
 * `trackLossPillLabel`) on the pill. Only while the take is still recording and the window
 * is the pill. Unlike `shouldDwell` this moves nothing: the label stands in for the timer
 * for `PILL_STOPPED_DWELL_MS`, the button stays Stop, and `decidePillAction` never sees it.
 */
export function shouldShowTrackNotice(
  current: PillWindowState, recordingState: SupervisorState, label: string | undefined,
): boolean {
  return current === "collapsed" && recordingState === "recording" && label !== undefined && label !== "";
}

/**
 * "The timer crossing an hour gains two digits" — mm:ss below an hour,
 * h:mm:ss at or above it. Takes milliseconds, matching this app's other
 * elapsed-time reads: a real duration rather than a counted tick.
 */
export function formatElapsedTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * The level meter (STC-528). It used to be hatched only, because there was no
 * audio signal to back a live one, and STC-375 was explicit that it must never
 * be drawn "at a plausible level where it would read as live." That rule still
 * holds: the only number a live meter draws is one the HELPER measured
 * (`MicSignal` in `helper/src/MicSignalDecisions.swift`, sent as a lossy
 * `level` event). So the meter is:
 *
 * - `hatched` — no reading has arrived this take: no mic, a mic that never
 *   delivered a sample, or one that was lost (STC-237). Never a guessed level.
 * - `live` — the bar's width is the last reading's peak.
 * - `no-signal` — the helper says the mic has been silent for 10 s. The bar
 *   flattens to a baseline and an amber dot sits at its end, tooltip
 *   `NO_SIGNAL_TOOLTIP` (Patrick, 2026-10-15). Warn only: no toast, no sound,
 *   no offer to stop (STC-505). It clears the moment signal returns.
 */
export type LevelMeterMode = "hatched" | "live" | "no-signal";

/** One `level` reading, as the helper sends it: peak 0..1 (linear) and the 10 s silence flag. */
export interface LevelReading { peak: number; silent: boolean }

export interface MeterView {
  mode: LevelMeterMode;
  /** The bar's width as a fraction of the meter, 0..1. Zero unless `live`. */
  fill: number;
}

/**
 * The meter's floor, the helper's silence floor (`MicSignal.silenceFloorDbfs`):
 * a reading at or under it draws an empty bar, so the bar is empty exactly when
 * the helper calls the buffer silent.
 */
export const METER_FLOOR_DB = -60;

/**
 * The tooltip on the no-signal dot. "10 s" is `MicSignal.silentSpanMinNs`;
 * `pill.test.ts` reads the Swift so the two cannot drift.
 */
export const NO_SIGNAL_TOOLTIP = "No mic signal for 10 s";

/**
 * A peak on a dB scale from `METER_FLOOR_DB` (empty) to 0 dBFS (full). Linear
 * would leave ordinary speech (-30 to -12 dBFS) as a sliver.
 */
export function meterFill(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 0;
  const db = 20 * Math.log10(Math.min(peak, 1));
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/**
 * What the meter draws. `reading` is the latest one this take, or undefined if
 * none has come; `micLost` is a lost mic (STC-237), after which a reading still
 * in flight on the lossy channel must not bring the meter back.
 */
export function meterView(reading: LevelReading | undefined, micLost = false): MeterView {
  if (!reading || micLost) return { mode: "hatched", fill: 0 };
  if (reading.silent) return { mode: "no-signal", fill: 0 };
  return { mode: "live", fill: meterFill(reading.peak) };
}

/** A `level` event's payload, or undefined when it is not one — the renderer trusts nothing. */
export function parseLevel(l: unknown): LevelReading | undefined {
  const o = l as { peak?: unknown; silent?: unknown } | null;
  if (typeof o?.peak !== "number" || !Number.isFinite(o.peak) || typeof o.silent !== "boolean") return undefined;
  return { peak: Math.max(0, Math.min(1, o.peak)), silent: o.silent };
}

/**
 * Snap vs. animate the resize is the ticket's own open question — snapping
 * is one `setSize`, animating means stepping bounds on a timer in main,
 * since CSS cannot move a window. Only `"snap"` is implemented here,
 * deliberately: resolving an open question while scaffolding ahead of
 * STC-374 would be a decision nobody asked for yet.
 *
 * Since STC-550 the pill also appears and goes with no transition at all,
 * which is how its requirement 10 (respect `prefers-reduced-motion`) is met:
 * there is no motion to reduce.
 */
export type ResizeStyle = "snap";
export const RESIZE_STYLE: ResizeStyle = "snap";

/**
 * Dark always, in both OS modes — "it floats over someone else's window for
 * the length of a session, where light chrome has nothing reliable to sit
 * against." Deliberately not the `--bg`/`--text`/etc. custom properties
 * STC-372 put on the main window: this is the one surface that does not
 * follow that token system, so it carries its own fixed palette rather than
 * reading tokens that would follow the OS into light mode.
 */
export const PILL_THEME = {
  background: "#0b0b0c",
  text: "#f5f5f5",
  dotLive: "#ff3b30",
  dotPaused: "#f5f5f5",
  meterHatch: "#3a3a3c",
  /** STC-528: the live bar, its empty track, the no-signal baseline, and its dot. */
  meterLevel: "#f5f5f5",
  meterTrack: "#2c2c2e",
  meterBaseline: "#636366",
  meterNoSignal: "#ff9f0a",
  /**
   * STC-447, answering the STC-375 runbook's open question: "is the whole
   * pill legible against whatever is likely to be behind it". A dark pill had
   * no edge of its own; a faint light hairline gives it one on any
   * background. Fixed, not a token, for the same reason as everything above.
   *
   * There is deliberately NO shadow value here. PR #220 had one, but the
   * pill fills an opaque window edge to edge (`pill.html`'s `#pill`), so a
   * CSS shadow is clipped to nothing. The
   * window's own native macOS shadow is the shadow.
   */
  ring: "rgba(255, 255, 255, 0.14)",
  /** The hover fill: says "this is a button" without a label. */
  hover: "#17171a",
} as const;
