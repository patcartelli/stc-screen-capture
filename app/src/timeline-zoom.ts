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
