import type { SessionEvent } from "@transform/types.js";
import { tickOf, tickTimeNs } from "@transform/time.js";
import { ZOOM_AMOUNT_MAX } from "./override-edit.js";

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
 * The Frame section's hover tooltip (STC-606, Figma 171:78): how many clicks
 * and keys fall in `[startNs, endNs)`, the span the Clip lane bar under the
 * pointer stands for. A click is a `down` (its `up` is the same click). Keys
 * are commands only (STC-419: typing never reaches disk), so the count cannot
 * reveal what was typed. `keys` is undefined for a take recorded before keys
 * were captured, and the label then leaves keys out rather than claim zero.
 */
export function activityIn(
  events: readonly SessionEvent[],
  keys: readonly { t: number }[] | undefined,
  startNs: number,
  endNs: number,
): { clicks: number; keys: number | undefined } {
  const inSpan = (t: number) => t >= startNs && t < endNs;
  let clicks = 0;
  for (const e of events) if (e.kind === "down" && inSpan(e.t)) clicks++;
  return { clicks, keys: keys ? keys.filter((k) => inSpan(k.t)).length : undefined };
}

/** "2 clicks · 14 keys", singular at one; keys left out when the take has none recorded. */
export function activityLabel(a: { clicks: number; keys: number | undefined }): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return a.keys === undefined ? n(a.clicks, "click") : `${n(a.clicks, "click")} · ${n(a.keys, "key")}`;
}

/**
 * The Zoom lane draws only what rises above this. A sample at or under it is
 * "the zoom is out", so the lane needs no samples where the curve cannot be
 * above it (see `ZOOM_LANE_REACH_NS`).
 */
export const ZOOM_LANE_FLOOR = 0.002;

/**
 * How long after a block's end the curve can still be above the floor: its
 * ease-out tail. The springs are critically damped (zoom.ts), so the slowest
 * shoulder (Slow, omega 6) is back under the floor in ~1.6 s; this leaves
 * headroom, and `timeline-activity.test.ts` re-derives it from `ZOOM_PRESETS`,
 * so a slower preset fails there instead of drawing a clipped tail.
 */
export const ZOOM_LANE_REACH_NS = 2_000_000_000;
/** One sim tick is 1/120 s; the dense run samples every other tick (~16.7 ms). */
export const ZOOM_LANE_DENSE_STEP_NS = 16_666_667;
/** How far before an edge the dense run starts, so the foot of a ramp is drawn from zero. */
export const ZOOM_LANE_LEAD_NS = 4 * 8_333_334;

/**
 * The least a block that zooms at all rises to (STC-636, Patrick 2026-11-02:
 * about 15%), so a very gentle zoom never draws as a hairline.
 */
export const ZOOM_LANE_PEAK_FLOOR = 0.15;

/**
 * The Zoom lane's height at one instant (STC-636): how far in the picture is,
 * on a log scale, not how far through its ease the block is. 1x is the floor
 * of the lane, 2x halfway, `ZOOM_AMOUNT_MAX` (4x) the top, so each doubling is
 * the same step; a 4x block stands visibly taller than a 1.5x one, where the
 * old 0..1 progress drew every block to full height.
 *
 * `magnification` is 1 / the crop's longer side (`ZoomAmountSampler`'s
 * `magnificationsAt`), `amount` the ease progress at the same instant. The
 * floor is applied as `ZOOM_LANE_PEAK_FLOOR × amount` rather than as a flat
 * minimum: the block's plateau (amount 1) still sits at no less than the
 * floor, but its ramps keep rising from zero instead of jumping to 15% on the
 * first tick. A block whose crop is the whole frame (stage 2's trusted "don't
 * zoom") has magnification 1 throughout and draws nothing, even while its
 * ease runs.
 *
 * Never above `amount` for a block of at most 4x (log(1/(1-(1-c)a)) is convex
 * in a, so it lies under its chord), which keeps `ZOOM_LANE_REACH_NS` a bound
 * on the tail.
 */
export function zoomLaneHeight(magnification: number, amount: number): number {
  if (!(magnification > 1) || !(amount > 0)) return 0;
  const log = Math.log(magnification) / Math.log(ZOOM_AMOUNT_MAX);
  return Math.min(1, Math.max(log, ZOOM_LANE_PEAK_FLOOR * Math.min(1, amount)));
}

export interface CurveSamples {
  /** Strictly increasing, each the start of a sim tick, within a tick of the span. */
  tNs: number[];
  /** The lane's value at each time: `zoomLaneHeight` in the editor (STC-636). */
  value: number[];
}

/**
 * Where to read the zoom curve for the lane, and its values there (STC-620).
 *
 * The old lane took a fixed 480 samples across the span: one per ~1.5 s on a
 * 12 minute take, against ramps of 0.14 to 0.8 s, so a block drew as a step or
 * was missed. The curve is flat zero except in and just after a block, so:
 *
 *  - outside every block's zone (from a short lead before it to
 *    `ZOOM_LANE_REACH_NS` after it) there are NO samples: the curve is under
 *    the floor there and the lane draws nothing for it;
 *  - inside a zone, one sample per pixel (`baseSamples`) keeps plateaus and
 *    long ramps exact when zoomed in;
 *  - around each block edge there is a dense run (every other sim tick) so a
 *    ramp is covered by ~8 samples even at its fastest, whatever the zoom.
 *    It is skipped when the pixel rate is already that fine.
 *
 * `valuesAt` is called ONCE with every time (ascending), so the caller can
 * read them in a single pass. Nothing here models the curve: the values come
 * from whatever `valuesAt` answers, which the editor makes `render()`'s own
 * (its zoom amount and crop, as `zoomLaneHeight`, STC-636). Any value that is
 * zero wherever the zoom amount is works: these zones are where it can rise.
 *
 * A ramp narrower than a pixel is still narrower than a pixel at a coarse
 * zoom: this makes the shape right (edge positions, peaks, ramp geometry), not
 * wider. Slow and Fast resolve when the span is about a minute.
 */
export function zoomCurveSamples(args: {
  valuesAt: (tNs: readonly number[]) => number[];
  windows: readonly { startNs: number; endNs: number }[];
  /** The visible span. */
  startNs: number;
  endNs: number;
  /** One per pixel of the lane. */
  baseSamples: number;
}): CurveSamples {
  const a = Math.max(0, args.startNs);
  const b = Math.max(a, args.endNs);
  const n = Math.max(2, Math.floor(args.baseSamples));
  if (!(b > a) || args.windows.length === 0) return { tNs: [], value: [] };
  const spacing = (b - a) / (n - 1);

  // Zones, clipped to the span, merged.
  const raw: [number, number][] = [];
  for (const w of args.windows) {
    const lo = Math.max(a, w.startNs - ZOOM_LANE_LEAD_NS);
    const hi = Math.min(b, w.endNs + ZOOM_LANE_REACH_NS);
    if (hi > lo) raw.push([lo, hi]);
  }
  raw.sort((x, y) => x[0] - y[0]);
  const zones: [number, number][] = [];
  for (const z of raw) {
    const last = zones[zones.length - 1];
    if (last && z[0] <= last[1]) last[1] = Math.max(last[1], z[1]);
    else zones.push([z[0], z[1]]);
  }

  const times: number[] = [];
  for (const [lo, hi] of zones) {
    times.push(lo, hi);
    for (let i = Math.ceil((lo - a) / spacing); i <= n - 1; i++) {
      const t = a + i * spacing;
      if (t > hi) break;
      times.push(t);
    }
  }
  if (spacing > ZOOM_LANE_DENSE_STEP_NS) {
    for (const w of args.windows) {
      for (const edge of [w.startNs, w.endNs]) {
        const lo = Math.max(a, edge - ZOOM_LANE_LEAD_NS);
        const hi = Math.min(b, edge + ZOOM_LANE_REACH_NS);
        for (let t = lo; t <= hi; t += ZOOM_LANE_DENSE_STEP_NS) times.push(t);
        if (hi > lo) times.push(hi);
      }
    }
  }

  // Every time is snapped to the start of its sim tick. The sim (and so
  // render()) is a 120 Hz staircase: the value "at t" is the value at tick
  // floor(t*120), up to one tick EARLIER than t. A sample drawn at x = t with
  // that earlier value is off by the curve's slope times that lag (~0.04 on a
  // Fast ramp); at the tick's own start time it is exact, and the polygon only
  // has to interpolate between true points. A snapped time can sit up to one
  // tick outside the span; the canvas clips it.
  times.sort((x, y) => x - y);
  const tNs: number[] = [];
  for (const t of times) {
    const snapped = tickTimeNs(tickOf(t));
    if (tNs.length === 0 || snapped > tNs[tNs.length - 1]!) tNs.push(snapped);
  }
  return { tNs, value: args.valuesAt(tNs) };
}

/**
 * The pixel size of a lane's canvas bitmap on a display with the given
 * `devicePixelRatio` (STC-451). A bitmap sized in CSS pixels is stretched,
 * smoothed, by the browser on a 2x display, which turns the Zoom lane's crisp
 * 4 px dither into a soft flat fill — invisible on a 1x screen, which is
 * where it was compared. Draw at `width x height` after `ctx.scale(scale,
 * scale)` and the lane's own CSS size stays the layout's. A ratio under 1 or
 * not a number is 1: a shrunken bitmap is never the answer.
 */
export function laneBitmap(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): { width: number; height: number; scale: number } {
  const scale = Number.isFinite(dpr) && dpr >= 1 ? dpr : 1;
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
    scale,
  };
}

/**
 * A Zoom block's start or end as the pane shows it (STC-604): m:ss.t, the tenth
 * FLOORED so a time never reads later than it is (0:19.46 is 0:19.4, as the
 * seconds of a clock are).
 */
export function formatBlockTime(ns: number): string {
  const tenths = Math.floor(Math.max(0, ns) / 100_000_000);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

/**
 * The Export section's range chip (STC-606, Figma 171:2050): "In 0:02.8",
 * "Out 0:44.2", and the length as the clock shows it ("0:41", whole seconds
 * rounded, as the Export section's Length row does). The window is the one the
 * export renders, so it agrees with that row and with #triminfo.
 */
export function trimRangeParts(startNs: number, endNs: number): { in: string; out: string; length: string } {
  const s = Math.max(0, Math.round((endNs - startNs) / 1e9));
  return {
    in: formatBlockTime(startNs),
    out: formatBlockTime(endNs),
    length: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
  };
}

/**
 * Who decides where a Zoom block sits (STC-636): stage 2 (`zoom-change.ts`,
 * recomputed whenever the block plays) when it has no saved region, the user
 * when it has one. A manual block always has one.
 */
export type ZoomPlace = "auto" | "fixed";

export function zoomPlaceOf(rect: { width: number; height: number } | null): ZoomPlace {
  return rect ? "fixed" : "auto";
}

/**
 * How far a block zooms in, to one decimal ("2.0×"): the frame over the longer
 * side of the region it zooms to. That is the saved region on a Fixed block
 * and stage 2's on an Auto one (`autoRect`, `deriveZoomCrop`'s answer), so an
 * Auto block shows the amount it really plays at (STC-636), never a word.
 * Stage 2's null is its trusted "don't zoom", which is 1.0×.
 */
export function zoomAmountLabel(
  rect: { width: number; height: number } | null,
  autoRect: { width: number; height: number } | null = null,
): string {
  const r = rect ?? autoRect;
  const longer = r ? Math.max(r.width, r.height) : 1;
  return `${(1 / (longer > 0 ? longer : 1)).toFixed(1)}×`;
}
