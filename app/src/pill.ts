import type { SupervisorState } from "./supervisor.js";

/**
 * The floating pill's decisions (STC-375) — no DOM, no Electron.
 *
 * Same split this project already uses for a windowed interaction
 * (`selection.ts` / `overlay-session.ts`, `thumbnail.ts` / `thumbnail-window.ts`):
 * what the pill IS lives here, exercised with no window and no timer;
 * `pill-window.ts` owns the real `BrowserWindow` and the real resize calls
 * this module only describes.
 *
 * ## The pill is not a new window
 *
 * The ticket's own design: "one frameless `BrowserWindow`, created once and
 * alive for the whole session. Recording doesn't open anything; it changes
 * the window it already has." So there is no `open`/`close` here — only two
 * sizes one window moves between, `expanded` (the instrument) and
 * `collapsed` (the pill). `pill-window.ts` is written to operate on whatever
 * `BrowserWindow` it is handed, so it can be pointed at the app's real main
 * window once STC-374 has stripped that window down to capture + grid;
 * nothing here decides which window that is.
 *
 * ## SCAFFOLD, not yet wired in
 *
 * STC-375 depends on STC-374 (instrument strip) landing first — collapsing a
 * window that still shows still-capture prefs and the shortcuts editor has
 * "little point" (the ticket's own words), because `restore()` would bring
 * all of that back with it. STC-374 was still Backlog (blocked on STC-370,
 * which has an open PR) when this was written, so this module and
 * `pill-window.ts` are built and tested in isolation, not wired into
 * `main.ts`'s real window. Wiring it up is the small remaining step once
 * STC-374 merges.
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

/** The ticket's own pseudocode numbers. */
export const PILL_HEIGHT_PX = 26;
export const RESTORED_WIDTH_PX = 360;

/** A pill narrower than this could not hold the dot and a timer at all. */
export const MIN_PILL_WIDTH_PX = 96;

/**
 * A measured content width is trusted only as far as it is a finite,
 * positive number — the same "clamp a fed-in number, never trust it blind"
 * rule `clampTimeoutMs` follows in `thumbnail.ts`. A failed measurement (a
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
 * What the confirmed recording state means for the window's size.
 *
 * Idempotent by construction: asking again once already in the state the
 * signal implies answers `"none"`, so a caller that re-derives this on every
 * heartbeat (rather than only on a transition) cannot double-resize a window
 * that is already the right size.
 */
export function decidePillAction(
  current: PillWindowState,
  recordingState: SupervisorState,
): "collapse" | "restore" | "none" {
  const recording = recordingState === "recording";
  if (recording && current === "expanded") return "collapse";
  if (!recording && current === "collapsed") return "restore";
  return "none";
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
 * No audio capture exists anywhere in the helper — mic is deferred since
 * phase 1 — and the ticket is explicit that the level meter must draw
 * hatched, "not at a plausible level where it would read as live."
 * `"hatched"` is the only value this type admits, so a future caller cannot
 * wire in a fabricated number and have it typecheck; drawing a real meter
 * needs a real audio signal, which is a type change here, not a rendering
 * choice at the call site.
 */
export type LevelMeterMode = "hatched";
export const METER_MODE: LevelMeterMode = "hatched";

/**
 * Snap vs. animate the resize is the ticket's own open question — snapping
 * is one `setSize`, animating means stepping bounds on a timer in main,
 * since CSS cannot move a window. Only `"snap"` is implemented here,
 * deliberately: resolving an open question while scaffolding ahead of
 * STC-374 would be a decision nobody asked for yet.
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
} as const;
