import type { SessionEvent } from "@transform/types.js";

/**
 * The editor's Clip lane signal (STC-373): pointer activity, weighted for
 * clicks and drags — explicitly NOT frame difference. STC-319's study needs a
 * Mac and two fixtures that don't exist yet, so the Clip lane draws from
 * `events.json`, which is already loaded for every take.
 *
 * A click (`down`/`up`) counts far more than a bare `move`, so a burst of
 * clicking stands out against idle mouse travel. A drag is a `down`, many
 * `move`s and an `up` (`zoom.ts`'s own finding: `leftMouseDragged` is recorded
 * as `kind: "move"`), so its span reads as elevated rather than flat — the
 * bracketing clicks raise the buckets at each end and the moves between them
 * still contribute, just at a lower weight than a deliberate press.
 *
 * `cursor` (shape-only) events carry no activity of their own.
 */
export const CLICK_WEIGHT = 1;
export const MOVE_WEIGHT = 0.12;

/**
 * Bucket every event into `buckets` equal spans of `[0, durationNs]` and sum
 * weights, then normalise to the loudest bucket so the lane always has SOME
 * contrast — an absolute scale would draw a flat line for both "one click in
 * an hour" and "nothing happened at all", which look identical and are not.
 *
 * A take with zero weight anywhere (no events) returns all zeros rather than
 * dividing by zero.
 */
export function clipActivity(
  events: readonly SessionEvent[],
  durationNs: number,
  buckets: number,
): number[] {
  const n = Math.max(1, Math.floor(buckets));
  const out = new Array<number>(n).fill(0);
  if (!(durationNs > 0)) return out;
  for (const e of events) {
    if (e.kind === "cursor") continue;
    const frac = Math.max(0, Math.min(1, e.t / durationNs));
    const i = Math.min(n - 1, Math.floor(frac * n));
    out[i] = (out[i] ?? 0) + (e.kind === "move" ? MOVE_WEIGHT : CLICK_WEIGHT);
  }
  const max = Math.max(...out);
  if (!(max > 0)) return out;
  return out.map((v) => v / max);
}

/**
 * A read-only automation curve, sampled at `samples` evenly spaced points
 * across `[0, durationNs]`, inclusive of both ends.
 *
 * Takes a plain `(tNs) => amount` sampler rather than a zoom sim directly, so
 * the editor can pass `render(project, session, tNs).zoom.amount` — the same
 * answer `updateLegibilityUI` already reads `render()` for — instead of a
 * second computation of `enabled`/`intensity`/`preset` here. One reader of
 * the zoom pipeline's output, not two.
 */
export function zoomCurve(
  sampleAt: (tNs: number) => number,
  durationNs: number,
  samples: number,
): number[] {
  const n = Math.max(2, Math.floor(samples));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = sampleAt((i / (n - 1)) * Math.max(0, durationNs));
  }
  return out;
}
