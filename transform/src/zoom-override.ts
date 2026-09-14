import type { Rect } from "./spaces.js";
import type { ZoomOverride } from "./types.js";
import { ZOOM_PRESET_NAMES, type ZoomPreset, type ZoomWindow } from "./zoom.js";

/**
 * Manual zoom overrides (STC-330): resolving what a DERIVED window (zoom.ts,
 * "WHEN only") actually looks like once a project's `overrides` table has had
 * its say. Everything here is pure and geometry/easing-only — zoom.ts still
 * owns WHEN, this module owns the manual half of WHERE, and STC-326 will own
 * the automatic half the same way, splicing in below this rather than above
 * it (an override always wins over a derivation, manual or automatic).
 */

/** A derived window's override key: its `startNs`, as a string (types.ts). */
export function windowId(window: Pick<ZoomWindow, "startNs">): string {
  return String(window.startNs);
}

/**
 * The geometry override for a window, if one exists.
 *
 * `overrides` may carry a `kind` this build does not implement (a later
 * phase's variant, read by an older build) — those are skipped rather than
 * throwing, the same "carry unread data forward" reasoning `pip`/`zoom`
 * already follow in trim.ts for a field a version does not fully own.
 */
export function overrideFor(
  overrides: readonly ZoomOverride[] | undefined,
  window: Pick<ZoomWindow, "startNs">,
): ZoomOverride | undefined {
  if (!overrides) return undefined;
  const id = windowId(window);
  return overrides.find((o) => o.kind === "geometry" && o.windowId === id);
}

/**
 * A window's crop, if an override supplies one — `undefined` otherwise, so
 * the caller decides what "no override" falls back to (render.ts: the whole
 * frame, `FULL_FRAME_UV`, until STC-326 supplies an automatic answer). Kept
 * as a separate question from `overrideFor` because a later phase's
 * variant (STC-331, STC-329) matches a window without necessarily carrying
 * geometry.
 */
export function resolvedCrop(
  overrides: readonly ZoomOverride[] | undefined,
  window: Pick<ZoomWindow, "startNs">,
): Rect | undefined {
  return overrideFor(overrides, window)?.rect;
}

/**
 * A window's easing PRESET NAME — the override's, if it names one, else the
 * project's own. Returns a name rather than the `{omega,zeta}` pair so
 * callers can GROUP windows by it (`groupByEasing` below) without comparing
 * objects.
 */
export function resolvedEasingName(
  overrides: readonly ZoomOverride[] | undefined,
  window: Pick<ZoomWindow, "startNs">,
  projectPreset: ZoomPreset,
): ZoomPreset {
  const o = overrideFor(overrides, window);
  return o?.easing && ZOOM_PRESET_NAMES.includes(o.easing) ? o.easing : projectPreset;
}

/**
 * Windows grouped by their RESOLVED easing name, in original order within
 * each group.
 *
 * Why grouping and not a per-tick easing lookup: `createZoomSim` steps ONE
 * spring across a whole window list with ONE easing, and that is correct
 * composition for any set of windows whose springs never overlap in time —
 * which stage 1's own merge rule already guarantees (`ZOOM_MERGE_GAP_NS`,
 * 2500 ms, is comfortably larger than the slowest preset's settling time,
 * about 780 ms for Calm). So rather than teaching the spring stepper to
 * change its own constants mid-flight — a real physics problem, since a
 * spring mid-transition has momentum a swapped omega/zeta would have to
 * either discard or carry incorrectly — each easing gets its OWN independent
 * spring over just its own windows, unmodified from what STC-325 already
 * built and tested. Composing them (render.ts: the max of every group's
 * `amountAt`) is safe for the same reason splitting them is: at most one
 * group can be meaningfully non-zero at any tick, because the windows that
 * feed each group are drawn from one globally-ordered, non-overlapping list.
 */
export function groupByEasing(
  windows: readonly ZoomWindow[],
  overrides: readonly ZoomOverride[] | undefined,
  projectPreset: ZoomPreset,
): Map<ZoomPreset, ZoomWindow[]> {
  const groups = new Map<ZoomPreset, ZoomWindow[]>();
  for (const w of windows) {
    const name = resolvedEasingName(overrides, w, projectPreset);
    const g = groups.get(name);
    if (g) g.push(w); else groups.set(name, [w]);
  }
  return groups;
}

/**
 * The window nearest `tNs` in time — the one governing the crop at this
 * instant, whether `tNs` sits inside it, in its lead-in, or in its
 * post-`endNs` relaxation tail.
 *
 * `zoom.ts`'s own `inWindow` is membership only: true for the lead+hold
 * span, false the instant `endNs` passes. But the SPRING does not reach 0
 * at `endNs` — it keeps relaxing for roughly a preset's settling time after,
 * and during that tail `amount` is still meaningfully above zero while
 * `inWindow` already reports false. A crop that flips to full-frame the
 * moment `inWindow` does would visibly pop mid-relaxation. "Nearest window"
 * has no such edge: whichever window is closest in time is, by
 * construction, the only one that could be driving a non-negligible
 * `amount` right now (the merge-gap-vs-settling-time margin above is what
 * guarantees that), and when nothing is close the choice does not matter
 * because `amount` is ~0 anyway.
 *
 * Binary search over the sorted, disjoint window list — the same idiom
 * `inWindow` uses, extended to return a window instead of a boolean.
 */
export function nearestWindow(
  windows: readonly ZoomWindow[], tNs: number,
): ZoomWindow | null {
  if (windows.length === 0) return null;
  let lo = 0, hi = windows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = windows[mid]!;
    if (tNs < w.startNs) hi = mid - 1;
    else if (tNs > w.endNs) lo = mid + 1;
    else return w;
  }
  // Not inside any window: `lo` is the index of the first window starting
  // AFTER tNs (or windows.length, if tNs is after all of them), and `hi`
  // (= lo - 1) is the last window ending before tNs. Whichever of those two
  // real neighbours is closer wins; there is always at least one, since
  // the length-0 case already returned above.
  const after = windows[lo];
  const before = windows[hi];
  if (!before) return after!;
  if (!after) return before;
  const dAfter = after.startNs - tNs;
  const dBefore = tNs - before.endNs;
  return dAfter <= dBefore ? after : before;
}

// ---------------------------------------------------------------------------
// Authoring a rect: click sets a default size, drag defines a custom one
// ---------------------------------------------------------------------------

/**
 * Fraction of the capture's SHORT edge a click-placed rect covers, centred
 * on the click point. A round, generous-but-not-full number: big enough to
 * frame a paragraph or a toolbar without the user needing to drag for the
 * common case, small enough to still read as "zoomed in" rather than "the
 * whole picture, slightly cropped".
 */
export const DEFAULT_OVERRIDE_RECT_FRACTION = 0.4;

/**
 * The smallest drag that counts as intentional, in CAPTURE-UV units of the
 * SHORT edge — below this, a click (or a barely-moved pointer-down) is
 * treated as a CLICK, not a tiny custom drag. Unlike `still-redact.ts`'s
 * `MIN_REDACTION_PX` (below which a drag is refused outright, because a
 * bare click there means "dismiss this, don't redact"), a small gesture
 * HERE still produces a rect — the ticket's own "click sets a default-sized
 * rect at that point, drag defines a custom one, same gesture either way".
 */
export const MIN_DRAG_UV = 0.02;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Clamp a UV rect so it lies entirely within the 0..1 frame, preserving its
 * size where possible (only shrinking when the size itself exceeds 1, which
 * a click-default clamped by `rectFromGesture` below can never produce, but
 * a hand-edited project.json could). Exported for `zoom-change.ts` (STC-326),
 * whose derived crops need the identical rule rather than a second copy of it.
 */
export function clampRectToFrame(r: Rect): Rect {
  const width = Math.min(1, r.width);
  const height = Math.min(1, r.height);
  return {
    x: Math.min(Math.max(0, r.x), 1 - width),
    y: Math.min(Math.max(0, r.y), 1 - height),
    width, height,
  };
}

/**
 * Two gesture points, in CAPTURE UV (0..1 over the whole frame — the same
 * space the canvas maps to 1:1 while a block is being edited, since editing
 * always shows the UNZOOMED frame; see `app/src/editor.ts`) → the rect an
 * override should carry.
 *
 * A drag whose extent (on its LONGER axis, so a mostly-horizontal or
 * mostly-vertical small drag is still judged the same way) clears
 * `MIN_DRAG_UV` is the drag itself, clamped to the frame. Anything smaller —
 * including a bare click, `a` === `b` — is a DEFAULT_OVERRIDE_RECT_FRACTION
 * square of the capture's short edge, centred on `a` and clamped to the
 * frame. Mirrors `still-redact.ts`'s `normaliseRegion` (drag → normalised
 * region, UV out) with the one deliberate difference the ticket asks for:
 * a small gesture here is a valid outcome, not a refusal.
 */
export function rectFromGesture(
  a: { x: number; y: number }, b: { x: number; y: number }, aspectWH: number,
): Rect {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  if (Math.max(dx, dy) < MIN_DRAG_UV) {
    // Short edge, in UV: whichever axis the frame is narrower on. aspectWH
    // is width/height in pixels; a UV square (equal x and y extent) is only
    // a visual square once mapped through that aspect, so the SHORT edge's
    // UV fraction is what DEFAULT_OVERRIDE_RECT_FRACTION means to look
    // "the same size" on both a landscape and a portrait-ish capture.
    const shortEdgeIsWidth = aspectWH <= 1;
    const w = shortEdgeIsWidth ? DEFAULT_OVERRIDE_RECT_FRACTION : DEFAULT_OVERRIDE_RECT_FRACTION / aspectWH;
    const h = shortEdgeIsWidth ? DEFAULT_OVERRIDE_RECT_FRACTION * aspectWH : DEFAULT_OVERRIDE_RECT_FRACTION;
    return clampRectToFrame({ x: a.x - w / 2, y: a.y - h / 2, width: w, height: h });
  }
  const x0 = clamp01(Math.min(a.x, b.x));
  const x1 = clamp01(Math.max(a.x, b.x));
  const y0 = clamp01(Math.min(a.y, b.y));
  const y1 = clamp01(Math.max(a.y, b.y));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
