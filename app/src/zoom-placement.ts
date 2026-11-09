/**
 * Where a NEW zoom block may go in the Zoom lane (STC-631). No DOM, no Electron.
 *
 * One rule, for the lane as a whole: a block added from the lane never lands
 * on any other block, Auto (derived) or manual. `zoom-override.ts` promises
 * nothing about disjointness (a manual window may overlap anything, and the
 * render composes overlaps by max per easing group, harmlessly and
 * invisibly), so the promise is made HERE, at the one door a user creates a
 * block through. A project that already holds overlapping blocks still loads
 * and renders; this only stops the lane making more.
 *
 * The hover ghost and the click both ask `placeNewBlock`, so the preview a
 * user sees is exactly the block a click creates: the span is the default
 * shape (`desired`), trimmed to the free gap around the pointer, and
 * refused — never silently shrunk to nothing — when the pointer is on a
 * block or the gap is under the floor.
 */

export interface Span { startNs: number; endNs: number }

export type Placement =
  | { ok: true; span: Span }
  /** `on-block`: the pointer is over an existing block. `no-room`: the free gap around it is under the floor. */
  | { ok: false; reason: "on-block" | "no-room" };

/** The sentence the lane shows for a refusal. */
export function refusalText(reason: "on-block" | "no-room"): string {
  return reason === "on-block" ? "Already a zoom here" : "Not enough room for a zoom";
}

/**
 * `desired` is the default-shaped span around `pointerNs`; `occupied` every
 * block in the lane (the one being edited included, at its draft bounds);
 * `minNs` the shortest block a user may have.
 */
export function placeNewBlock(
  pointerNs: number,
  desired: Span,
  occupied: readonly Span[],
  minNs: number,
): Placement {
  // Half-open: a block's end is the first instant it no longer covers, so
  // the pointer exactly on it is free and sits beside the block, not in it.
  for (const o of occupied) {
    if (pointerNs >= o.startNs && pointerNs < o.endNs) return { ok: false, reason: "on-block" };
  }
  let lo = desired.startNs;
  let hi = desired.endNs;
  for (const o of occupied) {
    if (o.endNs <= pointerNs) lo = Math.max(lo, o.endNs);
    else if (o.startNs > pointerNs) hi = Math.min(hi, o.startNs);
  }
  if (hi - lo < minNs) return { ok: false, reason: "no-room" };
  return { ok: true, span: { startNs: lo, endNs: hi } };
}

/** Two spans share any time. Touching edges do not overlap. */
export function overlaps(a: Span, b: Span): boolean {
  return a.startNs < b.endNs && b.startNs < a.endNs;
}

/**
 * Where an edge being dragged may go (STC-631): `wanted` held inside the take,
 * at least `minNs` from the block's other edge, and short of the nearest
 * OTHER block on that side — so a drag stops at a neighbour instead of
 * crossing it. `span` is the block's current draft and `others` every other
 * block. Only blocks wholly on the edge's side bound it: one the draft
 * already overlaps (a loaded project's) is not a wall to be stuck behind.
 */
export function clampEdge(
  edge: "start" | "end",
  wanted: number,
  span: Span,
  others: readonly Span[],
  durationNs: number,
  minNs: number,
): number {
  if (edge === "start") {
    let lo = 0;
    for (const o of others) if (o.endNs <= span.startNs) lo = Math.max(lo, o.endNs);
    return Math.max(lo, Math.min(wanted, span.endNs - minNs));
  }
  let hi = durationNs;
  for (const o of others) if (o.startNs >= span.endNs) hi = Math.min(hi, o.startNs);
  return Math.min(hi, Math.max(wanted, span.startNs + minNs));
}
