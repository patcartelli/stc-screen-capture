/**
 * The editor timeline's zoom and pan — every decision, pure (STC-484).
 *
 * `editor.ts` owns the DOM and the one `[spanStart, spanEnd]` pair; this file
 * decides what an input MEANS and what span results. No DOM, no Electron, no
 * clock, and importable from the main process (the ⌘= / ⌘− / ⌘0 chords are
 * claimed there, see `timelineZoomKeyIntent`).
 *
 * The rules, each one something Patrick decided on 2026-10-16:
 *
 *  1. Every input reaches the same three verbs — zoom in, zoom out, fit — plus
 *     pan. A wheel, a pinch, a button and a key are four doors to one room.
 *  2. Pointer inputs (wheel, pinch) zoom AROUND THE POINTER: the instant under
 *     the cursor stays under it. Buttons and keys have no pointer, so they zoom
 *     around the PLAYHEAD when it is on screen, else around the middle.
 *  3. ⌘-scroll and pinch zoom; plain scroll pans. Chromium reports a trackpad
 *     pinch as a wheel event with `ctrlKey` set, so `ctrlKey` and `metaKey`
 *     both mean "zoom".
 *  4. The span is clamped on both sides: never wider than the take (that is
 *     Fit), never narrower than `MIN_SPAN_FRACTION` of it.
 *  5. The readout is a sentence about the span, nothing more.
 *  6. The playhead is free to leave the view (STC-621), and the view never
 *     fences it; it only comes back to it. An explicit move reveals it, a
 *     playing one flips a page, and a marker plus a key bring it home. Pulling
 *     the view along stops when the person pans or zooms by hand.
 *
 * Reduced motion needs nothing from this file: a span change is a jump, never
 * an animation, so there is nothing to switch off. It is stated here so the
 * next person does not add a tween without reading rule 4 of the ticket.
 */

export interface Span {
  startNs: number;
  endNs: number;
}

/** The narrowest span a zoom can reach, as a fraction of the take. */
export const MIN_SPAN_FRACTION = 1 / 64;
/** What one press of + / − / ⌘= / ⌘− multiplies the span by. */
export const BUTTON_ZOOM_STEP = 1.5;
/** Wheel pixels per e-fold of zoom; the value the ruler has always used. */
const WHEEL_ZOOM_RATE = 0.0015;

export type ZoomIntent = "in" | "out" | "fit";

/** The whole take, i.e. Fit. */
export function fitSpan(durationNs: number): Span {
  return { startNs: 0, endNs: Math.max(0, durationNs) };
}

export function isFit(span: Span, durationNs: number): boolean {
  // A nanosecond of slack: zoom in then out is float arithmetic and lands a
  // hair short of the ends.
  return span.startNs <= 1 && span.endNs >= durationNs - 1;
}

export function isMinSpan(span: Span, durationNs: number): boolean {
  return span.endNs - span.startNs <= durationNs * MIN_SPAN_FRACTION + 1e-6;
}

/**
 * The CSS `scaleX(scale) translateX(translatePct%)` that stretches the
 * FULL-DURATION track so only `span` shows (editor.ts's applySpanTransform).
 *
 * Order matters and was wrong until STC-621. In a transform list the LAST
 * function applies first, so the translate happens in the track's own,
 * unscaled pixels and the scale then stretches it: x' = scale * (x + t). The
 * span's start sits at x = (startNs / durationNs) * W, so t is that, negated,
 * as a share of the track's width W: `-startNs / durationNs`. It was
 * `-startNs / spanWidth`, which is the same thing only at Fit or when the span
 * starts at 0, and otherwise throws every transformed layer (ruler, bookmarks,
 * blocks, the playhead's own position) off by a factor of the zoom while the
 * canvas lanes, which are redrawn rather than transformed, stayed right: the
 * "parallax" on a wheel pan, and a playhead that vanished when the view moved.
 */
export function spanTransform(span: Span, durationNs: number): { scale: number; translatePct: number } {
  const width = Math.max(1, span.endNs - span.startNs);
  if (!(durationNs > 0)) return { scale: 1, translatePct: 0 };
  return { scale: durationNs / width, translatePct: -(span.startNs / durationNs) * 100 };
}

/** A span of `width` starting at `start`, slid back inside the take. */
function placed(start: number, width: number, durationNs: number): Span {
  const s = Math.max(0, Math.min(durationNs - width, start));
  return { startNs: s, endNs: s + width };
}

/**
 * Zoom by `factor` (>1 zooms in) keeping the instant `anchorNs` at the same
 * place on screen. `anchorNs` outside the span is clamped into it first, so a
 * playhead that has scrolled off cannot throw the view across the take.
 */
export function zoomAbout(span: Span, durationNs: number, factor: number, anchorNs: number): Span {
  if (!(durationNs > 0) || !(factor > 0)) return span;
  const width = span.endNs - span.startNs;
  if (!(width > 0)) return fitSpan(durationNs);
  const next = Math.max(durationNs * MIN_SPAN_FRACTION, Math.min(durationNs, width / factor));
  const anchor = Math.max(span.startNs, Math.min(span.endNs, anchorNs));
  const fraction = (anchor - span.startNs) / width;
  return placed(anchor - fraction * next, next, durationNs);
}

/** Slide the span by a fraction of its OWN width (positive = later). */
export function panBy(span: Span, durationNs: number, deltaFraction: number): Span {
  const width = span.endNs - span.startNs;
  if (!(durationNs > 0) || !(width > 0)) return span;
  return placed(span.startNs + deltaFraction * width, width, durationNs);
}

/**
 * Zoom for a button or key. Anchored on the playhead when it is inside the
 * span, else on the middle of what is showing. `fit` ignores both.
 */
export function zoomByIntent(span: Span, durationNs: number, intent: ZoomIntent, playheadNs: number): Span {
  if (intent === "fit") return fitSpan(durationNs);
  const inside = playheadNs >= span.startNs && playheadNs <= span.endNs;
  const anchor = inside ? playheadNs : (span.startNs + span.endNs) / 2;
  return zoomAbout(span, durationNs, intent === "in" ? BUTTON_ZOOM_STEP : 1 / BUTTON_ZOOM_STEP, anchor);
}

// ---- keeping the playhead in reach (STC-621) -------------------------------
//
// Four doors, all jumps (never a tween), and none of them fences the playhead:
// it stays free to leave the view, these only bring the view back to it.
//
//  - `revealSpan`: an explicit move (a key, a bookmark jump, a scrub) slides
//    the view the least that shows the playhead. A seek already in view leaves
//    the span alone, so a drag inside the view never moves it.
//  - `followSpan`: during playback the view flips a page when the playhead
//    runs off an edge, landing it ahead of the way playback is going.
//  - `centreSpan`: "go to playhead", the same zoom re-centred on it.
//  - `playheadSide`: which edge the off-screen marker belongs on.

/** How far in from the edge `revealSpan` leaves the playhead, as a span fraction. */
export const REVEAL_MARGIN_FRACTION = 0.05;
/** Where a page flip lands the playhead, as a fraction of the span from the edge it entered by. */
export const FOLLOW_LANDING_FRACTION = 0.1;

export type PlayheadSide = "before" | "after";

/** Which side of the span the playhead is off, or null when it is in view. */
export function playheadSide(span: Span, tNs: number): PlayheadSide | null {
  if (tNs < span.startNs) return "before";
  if (tNs > span.endNs) return "after";
  return null;
}

/**
 * The least slide that keeps `tNs` in view with a small margin.
 *
 * Out of view, it comes back to `REVEAL_MARGIN_FRACTION` inside the edge it
 * left by. With `fromNs` (where the playhead was), a move that is still in view
 * but is heading INTO that margin at an edge also slides, by exactly what it
 * moved: a held arrow key scrolls the view a frame per step instead of
 * waiting for the playhead to leave and then jumping a margin's worth. A move
 * away from an edge never slides the view, whatever zone it ends in.
 */
export function revealSpan(span: Span, durationNs: number, tNs: number, fromNs?: number): Span {
  if (!(durationNs > 0)) return span;
  const width = span.endNs - span.startNs;
  if (!(width > 0)) return span;
  const margin = width * REVEAL_MARGIN_FRACTION;
  const later = tNs > span.endNs - margin && (tNs > span.endNs || (fromNs !== undefined && tNs > fromNs));
  if (later) return placed(tNs + margin - width, width, durationNs);
  const earlier = tNs < span.startNs + margin && (tNs < span.startNs || (fromNs !== undefined && tNs < fromNs));
  if (earlier) return placed(tNs - margin, width, durationNs);
  return span;
}

/** The same zoom, centred on `tNs` (as far as the take's ends allow). */
export function centreSpan(span: Span, durationNs: number, tNs: number): Span {
  const width = span.endNs - span.startNs;
  if (!(durationNs > 0) || !(width > 0)) return span;
  return placed(tNs - width / 2, width, durationNs);
}

/**
 * Playback's page flip, or null while the playhead is in view. The landing
 * follows the way playback is going, not which edge it left by: forward lands
 * the playhead `FOLLOW_LANDING_FRACTION` in from the left, reverse that far
 * from the right, so there is always room to run. (Pressing Play with the
 * playhead already off the left of the view therefore still lands it left.)
 */
export function followSpan(span: Span, durationNs: number, tNs: number, direction: 1 | -1): Span | null {
  if (playheadSide(span, tNs) === null || !(durationNs > 0)) return null;
  const width = span.endNs - span.startNs;
  if (!(width > 0)) return null;
  const inset = width * FOLLOW_LANDING_FRACTION;
  return placed(direction > 0 ? tNs - inset : tNs - width + inset, width, durationNs);
}

/**
 * "Go to playhead" is a bare G, so it follows the scrubber's rule 8: it is the
 * timeline's only when nothing is being typed and no modifier is down (⌘G and
 * the like stay the platform's, and none of ⌘= ⌘− ⌘0 is touched).
 */
export function playheadKeyIntent(c: KeyChord & { inTextField?: boolean }): boolean {
  if (c.inTextField || c.metaKey || c.ctrlKey || c.altKey) return false;
  return c.key.toLowerCase() === "g";
}

// ---- the wheel -------------------------------------------------------------

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

export type WheelIntent =
  | { kind: "zoom"; factor: number }
  | { kind: "pan"; deltaPx: number }
  | { kind: "none" };

/** deltaMode 1 is lines, 2 is pages; both are scaled to roughly pixels. */
function wheelPixels(delta: number, mode: number | undefined): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * 400;
  return delta;
}

/**
 * Rule 3. ⌘ or ctrl (a pinch) zooms by the vertical delta; anything else pans
 * by whichever axis moved more, so a two-finger sideways swipe and a plain
 * mouse wheel both scroll the timeline.
 */
export function wheelIntent(e: WheelLike): WheelIntent {
  const dy = wheelPixels(e.deltaY, e.deltaMode);
  const dx = wheelPixels(e.deltaX, e.deltaMode);
  if (e.ctrlKey || e.metaKey) {
    if (dy === 0) return { kind: "none" };
    // A pinch's deltas are small and fractional, a ⌘-scroll's are not; the
    // clamp keeps one fling of a free-spinning wheel from crossing the range.
    const clamped = Math.max(-120, Math.min(120, dy));
    return { kind: "zoom", factor: Math.exp(-clamped * WHEEL_ZOOM_RATE * (e.ctrlKey && !e.metaKey ? 4 : 1)) };
  }
  const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
  return d === 0 ? { kind: "none" } : { kind: "pan", deltaPx: d };
}

// ---- keys ------------------------------------------------------------------

export interface KeyChord {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * ⌘= and ⌘+ zoom in, ⌘− zoom out, ⌘0 fit. These are the chords Electron's
 * default View menu already owns (Zoom In / Zoom Out / Actual Size, which scale
 * the whole PAGE); `editor-window.ts` therefore takes them in
 * `before-input-event`, ahead of the menu, and sends the intent to the page.
 * ⌥ is refused so ⌥⌘0 and friends stay the platform's.
 */
export function timelineZoomKeyIntent(c: KeyChord): ZoomIntent | null {
  if (!(c.metaKey || c.ctrlKey) || c.altKey) return null;
  if (c.key === "=" || c.key === "+") return "in";
  if (c.key === "-" || c.key === "_") return "out";
  if (c.key === "0" && !c.shiftKey) return "fit";
  return null;
}

// ---- the overview strip ----------------------------------------------------

export interface OverviewBox {
  /** Percent of the strip, 0..100. */
  leftPct: number;
  widthPct: number;
}

/** The window drawn on the overview strip for a span. */
export function overviewBox(span: Span, durationNs: number): OverviewBox {
  if (!(durationNs > 0)) return { leftPct: 0, widthPct: 100 };
  const left = Math.max(0, Math.min(100, (span.startNs / durationNs) * 100));
  const right = Math.max(left, Math.min(100, (span.endNs / durationNs) * 100));
  return { leftPct: left, widthPct: right - left };
}

/**
 * Where the span goes when the strip is pressed or dragged. `pointerFraction`
 * is the pointer's place on the strip (0..1); `grabOffsetFraction` is where
 * inside the window it took hold (0 = its left edge, 1 = its right), so a drag
 * does not jump the window's edge to the pointer. A press OUTSIDE the window
 * takes hold of its middle (0.5): the window comes to you.
 */
export function overviewSpanFor(
  span: Span, durationNs: number, pointerFraction: number, grabOffsetFraction: number,
): Span {
  const width = span.endNs - span.startNs;
  if (!(durationNs > 0) || !(width > 0)) return span;
  const p = Math.max(0, Math.min(1, pointerFraction));
  return placed(p * durationNs - grabOffsetFraction * width, width, durationNs);
}

/** Where inside the window a press landed, or null when it landed outside. */
export function grabOffset(box: OverviewBox, pointerFraction: number): number | null {
  const l = box.leftPct / 100;
  const w = box.widthPct / 100;
  if (!(w > 0)) return null;
  const f = (pointerFraction - l) / w;
  return f >= 0 && f <= 1 ? f : null;
}

// ---- the readout -----------------------------------------------------------

function clock(ns: number): string {
  const total = Math.max(0, ns) / 1e9;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const sec = s < 10 ? `0${s.toFixed(1)}` : s.toFixed(1);
  return `${m}:${sec}`;
}

/** "3.2× · 0:12.0–0:25.5", or "Whole take" at Fit. */
export function zoomReadout(span: Span, durationNs: number): string {
  if (!(durationNs > 0) || isFit(span, durationNs)) return "Whole take";
  const width = span.endNs - span.startNs;
  const level = durationNs / width;
  const shown = level >= 10 ? level.toFixed(0) : level.toFixed(1);
  return `${shown}× · ${clock(span.startNs)}–${clock(span.endNs)}`;
}
