import type { Rect } from "./spaces.js";
import type { ZoomOverride } from "./types.js";
import type { ZoomPreset, ZoomWindow } from "./zoom.js";
import { easingKey, resolveEasing, type EasingPair } from "./zoom-easing.js";

/**
 * Manual zoom overrides (STC-330): resolving what a DERIVED window (zoom.ts,
 * "WHEN only") actually looks like once a project's `overrides` table has had
 * its say. Everything here is pure and geometry/easing-only — zoom.ts still
 * owns WHEN, this module owns the manual half of WHERE, and STC-326 will own
 * the automatic half the same way, splicing in below this rather than above
 * it (an override always wins over a derivation, manual or automatic).
 */

/**
 * A derived window's override key: its `startNs`, as a string (types.ts) —
 * or, once `resolvedWindows` below has retimed it, the PINNED `id` it was
 * given at retime time, which is that original `startNs`. A window straight
 * out of `zoomWindows` never carries `.id`, so this is unchanged for one.
 */
export function windowId(window: Pick<ZoomWindow, "startNs" | "id">): string {
  return window.id ?? String(window.startNs);
}

/**
 * The geometry override for a window, if one exists.
 *
 * `overrides` may carry a `kind` this build does not implement (a later
 * phase's variant, read by an older build) — those are skipped rather than
 * throwing, the same "carry unread data forward" reasoning `pip`/`zoom`
 * already follow in trim.ts for a field a version does not fully own. This
 * only ever matches the `geometry` variant, deliberately: a `manual` window
 * (STC-331) IS its own override — see `CombinedZoomWindow` below — and is
 * never looked up here.
 */
export function overrideFor(
  overrides: readonly ZoomOverride[] | undefined,
  window: Pick<ZoomWindow, "startNs">,
): Extract<ZoomOverride, { kind: "geometry" }> | undefined {
  if (!overrides) return undefined;
  const id = windowId(window);
  return overrides.find(
    (o): o is Extract<ZoomOverride, { kind: "geometry" }> => o.kind === "geometry" && o.windowId === id,
  );
}

/**
 * Applies `removed` and `retime` (STC-329) to a take's DERIVED windows —
 * `zoom.ts`'s own `zoomWindows` output — before they are spliced together
 * with any manual windows and grouped/simmed. Called once per render, on the
 * RAW per-session memo (render.ts's `windowsFor`), so it must stay cheap and
 * must not itself be memoised: the window list it returns has to track
 * `project.overrides` live.
 *
 * `removed` drops the window outright — it never plays, not even at its old
 * crop, and a `retime` for the same id is moot. `retime` produces a NEW
 * window object with `startNs`/`endNs` shifted (either bound may be absent,
 * for a one-edge drag) and `id` PINNED to the window's original `startNs` —
 * `windowId()` reads `.id` first, precisely so a `geometry` override (or a
 * later re-edit's own `retime`) keyed on that original id still finds this
 * window after its bounds move. `events` — the window's own trigger events —
 * pass through unchanged: retiming moves WHEN a window plays, not what stage
 * 2 / the cursor fallback read to decide WHERE, which is why a `retime` and
 * a `geometry` override on the same window compose with no special case
 * (render.ts's own header says the same of a `geometry` override and stage
 * 2/the cursor fallback).
 */
export function resolvedWindows(
  windows: readonly ZoomWindow[],
  overrides: readonly ZoomOverride[] | undefined,
): ZoomWindow[] {
  if (!overrides) return windows.slice();
  const removed = new Set(
    overrides.filter((o): o is Extract<ZoomOverride, { kind: "removed" }> => o.kind === "removed")
      .map((o) => o.windowId),
  );
  const retimes = new Map(
    overrides.filter((o): o is Extract<ZoomOverride, { kind: "retime" }> => o.kind === "retime")
      .map((o) => [o.windowId, o]),
  );
  const out: ZoomWindow[] = [];
  for (const window of windows) {
    const id = windowId(window);
    if (removed.has(id)) continue;
    const retime = retimes.get(id);
    if (!retime) { out.push(window); continue; }
    out.push({
      ...window, id,
      startNs: retime.startNs ?? window.startNs,
      endNs: retime.endNs ?? window.endNs,
    });
  }
  return out;
}

type ManualOverride = Extract<ZoomOverride, { kind: "manual" }>;

/**
 * A window as `groupByEasing`/`nearestWindow`/`createZoomSim` see it, plus —
 * for a manually authored one (STC-331) — the override it came from.
 *
 * A derived window (`zoomWindows`'s own output) never carries `manual`; a
 * window built by `manualWindows` below always does. `resolvedCrop` and
 * `resolvedEasingName` check `manual` FIRST, before ever consulting the
 * overrides table, because a manual window's rect and easing are not
 * something to look up by matching a key — they ARE the window.
 */
export interface CombinedZoomWindow extends ZoomWindow {
  manual?: ManualOverride;
}

/**
 * The take's manually authored windows (STC-331), reshaped as
 * `CombinedZoomWindow`s so render.ts can splice them in alongside the
 * derived ones and feed the combined list to the same `groupByEasing` /
 * `nearestWindow` / `createZoomSim` machinery stage 1 already built.
 *
 * `events` is always empty: a manual window has no underlying trigger
 * events, and nothing reads the field for one — STC-326's cursor-clustering
 * fallback never runs for a window with its own crop (render.ts's
 * three-tier comment), which every manual window has by construction.
 */
export function manualWindows(overrides: readonly ZoomOverride[] | undefined): CombinedZoomWindow[] {
  if (!overrides) return [];
  const out: CombinedZoomWindow[] = [];
  for (const o of overrides) {
    if (o.kind !== "manual") continue;
    out.push({ startNs: o.startNs, endNs: o.endNs, events: [], manual: o });
  }
  return out;
}

/**
 * A window's crop, if an override supplies one — `undefined` otherwise, so
 * the caller decides what "no override" falls back to (render.ts: stage 2,
 * then the whole frame, `FULL_FRAME_UV`). A manual window's own rect wins
 * outright and is never `undefined` — there is nothing else for it to fall
 * back to, unlike a geometry override which may simply not exist for a
 * given derived window, or (project-20, STC-630) exist to carry only a
 * speed, with no rect: either way `undefined`, so stage 2 places it.
 *
 * Every rect out is inside the Amount limits and the frame (STC-653,
 * `withinZoomLimits`): this is the last place a zero-size or 200x region
 * could reach render()'s crop, and it cannot get past here.
 */
export function resolvedCrop(
  overrides: readonly ZoomOverride[] | undefined,
  window: CombinedZoomWindow,
): Rect | undefined {
  if (window.manual) return heldCrop(window.manual.rect);
  const rect = overrideFor(overrides, window)?.rect;
  return rect && heldCrop(rect);
}

/**
 * A tuned rect as render() may use it: held to the Amount limits (STC-653),
 * then frame-shaped (STC-629). In that order, so a rect with one side at zero
 * is given a size before anything reads its shape. Both steps hand back a
 * rect that needs neither as the same object, and widening never leaves the
 * limits: the longer side is what both of them measure.
 */
function heldCrop(rect: Rect): Rect {
  return frameShaped(withinZoomLimits(rect));
}

/**
 * Whether a window's crop follows the cursor (STC-617): its manual entry's
 * own flag, else its geometry override's. A window with no rect of its own
 * never follows: `follow` lives only on the two variants that carry one.
 */
export function followsCursor(
  overrides: readonly ZoomOverride[] | undefined,
  window: CombinedZoomWindow,
): boolean {
  if (window.manual) return window.manual.follow === true;
  return overrideFor(overrides, window)?.follow === true;
}

/**
 * A window's easing as a PAIR of preset names, one per direction (STC-619) —
 * the override's, side by side, else the project's own for any side it leaves
 * out. Names rather than the `{omega,zeta}` shoulders so callers can GROUP
 * windows by it (`groupByEasing` below) without comparing objects.
 *
 * A window with no easing at all resolves to the project preset on both
 * sides, which is the pair `{ in: p, out: p }` — exactly preset `p`'s own two
 * shoulders, so a document that predates per-direction speeds renders as it
 * always did.
 *
 * A manual window's easing is REQUIRED on the schema (types.ts's own note
 * says why) and complete (a name, or both sides), so it never falls back to
 * the project preset: "the project's own preset" is exactly the fallback a
 * geometry override without an opinion uses, and a manual window always has
 * one. The fallback passed to `resolveEasing` is therefore never read for it.
 */
export function resolvedEasing(
  overrides: readonly ZoomOverride[] | undefined,
  window: CombinedZoomWindow,
  projectPreset: ZoomPreset,
): EasingPair {
  if (window.manual) return resolveEasing(window.manual.easing, projectPreset);
  return resolveEasing(overrideFor(overrides, window)?.easing, projectPreset);
}

/**
 * Windows grouped by their RESOLVED easing name, in original order within
 * each group.
 *
 * Why grouping and not a per-tick easing lookup: `createZoomSim` steps ONE
 * spring across a whole window list with ONE easing, and that is correct
 * composition for any set of windows whose springs never overlap in time —
 * which stage 1's own merge rule guarantees for DERIVED windows alone
 * (`ZOOM_MERGE_GAP_NS`, 2500 ms, is comfortably larger than the slowest
 * preset's settling time, about 780 ms for Calm). A manual window (STC-331)
 * carries no such guarantee against another manual window, or against a
 * derived one, in the same group — the ticket that added them leaves
 * overlap unsolved on purpose. Composing group sims by max (render.ts)
 * still produces a well-defined answer either way: `inWindow` (zoom.ts) is
 * now a plain scan rather than a sorted bisect, precisely so a group that
 * turns out not to be disjoint is handled correctly rather than merely
 * silently. So rather than teaching the spring stepper to change its own
 * constants mid-flight — a real physics problem, since a spring
 * mid-transition has momentum a swapped omega/zeta would have to either
 * discard or carry incorrectly — each easing still gets its OWN independent
 * spring over just its own windows, unmodified from what STC-325 already
 * built and tested.
 */
export interface EasingGroup { pair: EasingPair; windows: CombinedZoomWindow[] }

/**
 * Keyed by `easingKey` (STC-619: a group is a PAIR of speeds now, not one
 * name), so blocks with the same in and out share a spring exactly as blocks
 * with the same preset always did.
 */
export function groupByEasing(
  windows: readonly CombinedZoomWindow[],
  overrides: readonly ZoomOverride[] | undefined,
  projectPreset: ZoomPreset,
): Map<string, EasingGroup> {
  const groups = new Map<string, EasingGroup>();
  for (const w of windows) {
    const pair = resolvedEasing(overrides, w, projectPreset);
    const key = easingKey(pair);
    const g = groups.get(key);
    if (g) g.windows.push(w); else groups.set(key, { pair, windows: [w] });
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
 * guarantees that for DERIVED windows), and when nothing is close the
 * choice does not matter because `amount` is ~0 anyway.
 *
 * A linear scan over every window, not a bisect — the same reasoning
 * `inWindow` (zoom.ts) now gives for itself. `windows` may include manually
 * authored ones (STC-331) that overlap a derived window or each other, so
 * the old "sorted, disjoint" precondition this used to lean on no longer
 * holds for the list render.ts actually passes. Ties (two windows
 * equidistant, or both containing `tNs`) resolve to whichever starts LATER
 * — matching the old neighbour-based rule's own "exactly equidistant leans
 * to after" — which is an arbitrary but DETERMINISTIC choice for the
 * overlapping case; getting overlap "right" is explicitly not this phase's
 * job (STC-331's own ticket text).
 */
export function nearestWindow<T extends ZoomWindow>(
  windows: readonly T[], tNs: number,
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const w of windows) {
    const dist = tNs < w.startNs ? w.startNs - tNs : tNs > w.endNs ? tNs - w.endNs : 0;
    if (best === null || dist < bestDist || (dist === bestDist && w.startNs > best.startNs)) {
      best = w;
      bestDist = dist;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// How big a zoom region may be (STC-653)
// ---------------------------------------------------------------------------

/**
 * How far a zoom region may zoom in: the frame over the region's longer side,
 * from just past no zoom to 4x (STC-606's Amount control, whose range these
 * are; `app/src/override-edit.ts` re-exports them for the slider).
 *
 * They live here because they are a rule about the REGION, not about one
 * control. Before STC-653 only the slider knew them: a drag from the frame's
 * edge outward saved a 0 x 0 rect, a 15 px drag saved a 32x one, and the
 * loader took any four finite numbers. At full zoom a zero-size crop is one
 * flat colour with no pointer, and at an amount of exactly 1 the pointer's
 * scale is `1 / 0`. Now the drag (`rectFromGesture`), the loader (`trim.ts`'s
 * `cleanOverrideRect`) and render() (`resolvedCrop`) all read this one pair.
 */
export const ZOOM_AMOUNT_MIN = 1.1;
export const ZOOM_AMOUNT_MAX = 4;

/** The same limits as a region's longer side, in capture UV: the most zoom is the smallest region. */
export const ZOOM_RECT_MIN_SIZE = 1 / ZOOM_AMOUNT_MAX;
export const ZOOM_RECT_MAX_SIZE = 1 / ZOOM_AMOUNT_MIN;

/**
 * Slack for arithmetic, not for taste: `rectAtAmount` writes a size of
 * `(1 / amount) / longer * longer`, which can land one ulp either side of the
 * limit, and `x + width` for a region flush against the far edge can be
 * 1.0000000000000002. Neither is a region outside the limits.
 */
const LIMIT_EPSILON = 1e-9;

/** Whether a rect is a real region of the frame: finite, positive on both sides, and inside 0..1. */
export function isRegionOfFrame(r: Rect): boolean {
  if (![r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n))) return false;
  if (!(r.width > 0) || !(r.height > 0)) return false;
  return r.x >= -LIMIT_EPSILON && r.y >= -LIMIT_EPSILON
    && r.x + r.width <= 1 + LIMIT_EPSILON && r.y + r.height <= 1 + LIMIT_EPSILON;
}

/**
 * A zoom region held to the Amount limits and to the frame.
 *
 * A region already inside both comes back as THE SAME OBJECT, so nothing a
 * valid document renders can move. Otherwise it is resized about its own
 * centre, keeping its shape, until its longer side is the nearest limit, and
 * slid back inside the frame: exactly what the Amount slider does when it is
 * touched (`rectAtAmount`), so a held region and a hand-set one agree.
 *
 * A rect that is no region at all (a side that is zero, negative or not
 * finite) has no shape to keep. It becomes the smallest allowed square about
 * whatever centre it names: the nearest thing to "a tiny region here". The
 * loader never lets one this far (it refuses, see `cleanOverrideRect`); this
 * branch is for a live document that never met the loader, and is what keeps
 * a zero-size crop from ever reaching render()'s divide.
 */
export function withinZoomLimits(r: Rect): Rect {
  const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
  const sized = Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 0 && r.height > 0;
  if (!sized) {
    const size = ZOOM_RECT_MIN_SIZE;
    const cx = finite(r.x + finite(r.width, 0) / 2, 0.5);
    const cy = finite(r.y + finite(r.height, 0) / 2, 0.5);
    return clampRectToFrame({ x: cx - size / 2, y: cy - size / 2, width: size, height: size });
  }
  const longer = Math.max(r.width, r.height);
  const sizeOk = longer >= ZOOM_RECT_MIN_SIZE - LIMIT_EPSILON && longer <= ZOOM_RECT_MAX_SIZE + LIMIT_EPSILON;
  if (sizeOk && isRegionOfFrame(r)) return r;
  const k = sizeOk ? 1 : Math.min(ZOOM_RECT_MAX_SIZE, Math.max(ZOOM_RECT_MIN_SIZE, longer)) / longer;
  const width = r.width * k;
  const height = r.height * k;
  const cx = finite(r.x + r.width / 2, 0.5);
  const cy = finite(r.y + r.height / 2, 0.5);
  return clampRectToFrame({ x: cx - width / 2, y: cy - height / 2, width, height });
}

// ---------------------------------------------------------------------------
// Authoring a rect: click sets a default size, drag defines a custom one
// ---------------------------------------------------------------------------

/**
 * Fraction of the capture a click-placed rect covers on each axis, centred
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
 * A UV rect widened to the frame's own shape (STC-629): the short side grows
 * to the long one about the same centre, and the result slides back inside
 * the frame. A UV rect's pixel aspect is (uvWidth/uvHeight) times the
 * frame's, and `compositor.ts` stretches the crop to fill a frame-shaped
 * output, so only a UV square keeps the picture's proportions. Widening
 * rather than narrowing keeps everything the region covered in view, the
 * rule `zoom-change.ts`'s `finishCrop` already follows for stage 2.
 *
 * render() applies this to every tuned crop (`resolvedCrop`), so a rect saved
 * before the editor locked its shape still renders unstretched. A rect that is
 * already frame-shaped comes back unchanged.
 */
export function frameShaped(r: Rect): Rect {
  if (r.width === r.height) return r;
  const size = Math.min(1, Math.max(r.width, r.height));
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return clampRectToFrame({ x: cx - size / 2, y: cy - size / 2, width: size, height: size });
}

/**
 * Two gesture points, in CAPTURE UV (0..1 over the whole frame — the same
 * space the canvas maps to 1:1 while a block is being edited, since editing
 * always shows the UNZOOMED frame; see `app/src/editor.ts`) → the rect an
 * override should carry.
 *
 * Every rect out is frame-shaped (a UV square, `frameShaped`'s note says
 * why), so the box drawn is exactly what the zoom shows (STC-629). A drag
 * whose extent (on its LONGER axis, so a mostly-horizontal or
 * mostly-vertical small drag is still judged the same way) clears
 * `MIN_DRAG_UV` grows a box from `a` toward `b`, sized by that longer axis,
 * and stops at the frame's edge. Its size is held to the Amount limits
 * (`ZOOM_RECT_MIN_SIZE`..`ZOOM_RECT_MAX_SIZE`, STC-653), so a drag can never
 * draw a region the Amount slider could not: `MIN_DRAG_UV` only decides
 * click-or-drag and puts no floor on the result. Anything smaller —
 * including a bare click, `a` === `b` — is a DEFAULT_OVERRIDE_RECT_FRACTION
 * box centred on `a` and clamped to the frame. Mirrors `still-redact.ts`'s
 * `normaliseRegion` (drag → normalised region, UV out) with the one
 * deliberate difference the ticket asks for: a small gesture here is a valid
 * outcome, not a refusal.
 */
export function rectFromGesture(
  a: { x: number; y: number }, b: { x: number; y: number },
): Rect {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < MIN_DRAG_UV) {
    const f = DEFAULT_OVERRIDE_RECT_FRACTION;
    return clampRectToFrame({ x: a.x - f / 2, y: a.y - f / 2, width: f, height: f });
  }
  const ax = clamp01(a.x);
  const ay = clamp01(a.y);
  // Room from the anchor to the edge the drag is heading for, per axis.
  const roomX = dx >= 0 ? 1 - ax : ax;
  const roomY = dy >= 0 ? 1 - ay : ay;
  const drawn = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), roomX, roomY);
  // Held to the Amount limits (STC-653). `drawn` alone has no floor: a drag
  // from the frame's edge outward has no room at all and was 0 x 0, and a
  // 15 px drag was a 32x zoom. The box still hangs off the anchor, and slides
  // back inside the frame only when the floor made it larger than the room.
  const size = Math.min(ZOOM_RECT_MAX_SIZE, Math.max(ZOOM_RECT_MIN_SIZE, drawn));
  return clampRectToFrame({
    x: dx >= 0 ? ax : ax - size,
    y: dy >= 0 ? ay : ay - size,
    width: size, height: size,
  });
}
