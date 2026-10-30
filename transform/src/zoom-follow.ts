import type { Anchors, SessionEvent } from "./types.js";
import type { Rect } from "./spaces.js";
import { globalToCaptureUv } from "./spaces.js";
import { geometryAt } from "./display-geometry.js";
import { SIM_HZ, frameIndexAt, tickOf, tickTimeNs } from "./time.js";

/**
 * A zoom block that follows the cursor (STC-617; Patrick's calls, 2026-10-30).
 *
 * The block's rect supplies only the crop's SIZE (the editor's Amount). Where
 * the crop sits is decided here, per 120 Hz sim tick:
 *
 * 1. It OPENS centred on the cursor at the block's start (`startNs`), clamped
 *    so the crop lies inside the frame. A take with no positioned event at all
 *    keeps the rect's own centre.
 * 2. A GOAL centre moves only when the cursor leaves the dead zone, the middle
 *    `FOLLOW_DEAD_ZONE_FRACTION` of the crop on each axis, and then only far
 *    enough to put the cursor back on the dead zone's edge. Small moves never
 *    pan the picture.
 * 3. The crop's centre chases that goal through ONE critically damped spring,
 *    `FOLLOW_OMEGA`, the same for every block whatever its Ease (Ease governs
 *    zooming in and out, never the pan).
 * 4. Both goal and centre are clamped so the crop never leaves the frame.
 * 5. After `endNs` the goal freezes, so the zoom's release relaxes out of a
 *    crop that has stopped chasing.
 *
 * The cursor read is the RAW positioned events (move/down/up, "greatest t <=
 * this tick's start", pre-warmed at the first one), not the eased pointer:
 * the spring here already smooths, and reading `cursor.ts`'s sim per tick
 * would replay up to a checkpoint interval of its steps for every step of
 * this one.
 *
 * Pure and deterministic exactly as `cursor.ts` is: state is a function of
 * the tick only, walked from the block's first tick, with checkpoints every
 * `CHECKPOINT_INTERVAL` ticks so a seek replays the same float sequence a
 * continuous run produced.
 */

/** The share of the crop, per axis, the cursor may move in without panning it. Tuned by eye (runbook §2). */
export const FOLLOW_DEAD_ZONE_FRACTION = 0.5;
/** The pan spring's stiffness, rad/s, critically damped: settles in about 4.7 / 8 ≈ 0.6 s. Tuned by eye (runbook §2). */
export const FOLLOW_OMEGA = 8;

const CHECKPOINT_INTERVAL = 1024;
const DT = 1 / SIM_HZ;

/** A positioned event's place in CAPTURE UV, at its own session-relative time. */
export interface FollowPoint { t: number; x: number; y: number }

const hasPosition = (e: SessionEvent): e is Extract<SessionEvent, { x: number }> =>
  e.kind === "move" || e.kind === "down" || e.kind === "up";

/**
 * Every positioned event in capture UV, sorted by time. Each is mapped through
 * the geometry of the frame shown at its own time (STC-235), the same rule
 * `zoom-change.ts`'s `triggerPointsUv` follows, so a refit mid-take does not
 * throw the follow off.
 */
export function followPointsUv(
  events: readonly SessionEvent[], anchors: Anchors, frames: readonly number[],
): FollowPoint[] {
  return events.filter(hasPosition).map((e) => {
    const fi = frameIndexAt(frames, e.t);
    const g = geometryAt(anchors, fi === null ? null : frames[fi]!);
    const p = globalToCaptureUv(e, g.shown, g.contentRect, anchors.capture);
    return { t: e.t, x: p.x, y: p.y };
  }).sort((a, b) => a.t - b.t);
}

export interface FollowSim {
  /** The crop at sim tick `n`: the block's size, at the followed place. */
  cropAt(n: number): Rect;
}

/** A centre on one axis that keeps a crop of `size` inside 0..1. */
function clampCentre(c: number, size: number): number {
  if (size >= 1) return 0.5;
  return Math.min(1 - size / 2, Math.max(size / 2, c));
}

/** The goal after the cursor at `p` is seen: unchanged inside the dead zone, else just far enough. */
function goalFor(g: number, p: number, size: number): number {
  const half = (FOLLOW_DEAD_ZONE_FRACTION * size) / 2;
  if (p > g + half) return clampCentre(p - half, size);
  if (p < g - half) return clampCentre(p + half, size);
  return g;
}

interface Kinematics { gx: number; gy: number; cx: number; cy: number; vx: number; vy: number }

export function createFollowSim(
  points: readonly FollowPoint[], startNs: number, endNs: number, rect: Rect,
): FollowSim {
  const { width: w, height: h } = rect;

  function pointAt(tNs: number): { x: number; y: number } | null {
    if (points.length === 0) return null;
    let lo = 0, hi = points.length - 1, ans = 0; // before the first point, pre-warm at it
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid]!.t <= tNs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return points[ans]!;
  }

  const n0 = tickOf(startNs);
  const opening = pointAt(startNs) ?? { x: rect.x + w / 2, y: rect.y + h / 2 };
  const ox = clampCentre(opening.x, w), oy = clampCentre(opening.y, h);
  const checkpoints: Kinematics[] = [{ gx: ox, gy: oy, cx: ox, cy: oy, vx: 0, vy: 0 }];

  function step(s: Kinematics, n: number): Kinematics {
    // advance from tick n-1 to tick n; the cursor is read at tick n's start time
    const tNs = tickTimeNs(n);
    let { gx, gy } = s;
    if (tNs <= endNs) {
      const p = pointAt(tNs);
      if (p) { gx = goalFor(gx, p.x, w); gy = goalFor(gy, p.y, h); }
    }
    const ax = FOLLOW_OMEGA * FOLLOW_OMEGA * (gx - s.cx) - 2 * FOLLOW_OMEGA * s.vx;
    const ay = FOLLOW_OMEGA * FOLLOW_OMEGA * (gy - s.cy) - 2 * FOLLOW_OMEGA * s.vy;
    const vx = s.vx + ax * DT;
    const vy = s.vy + ay * DT;
    return { gx, gy, cx: clampCentre(s.cx + vx * DT, w), cy: clampCentre(s.cy + vy * DT, h), vx, vy };
  }

  function kinematicsAt(n: number): Kinematics {
    const rel = Math.max(0, n - n0);
    const k = Math.min(Math.floor(rel / CHECKPOINT_INTERVAL), checkpoints.length - 1);
    let cur = checkpoints[k]!;
    let i = k * CHECKPOINT_INTERVAL;
    while (i < rel) {
      i++;
      cur = step(cur, n0 + i);
      if (i % CHECKPOINT_INTERVAL === 0 && i / CHECKPOINT_INTERVAL === checkpoints.length) checkpoints.push(cur);
    }
    return cur;
  }

  return {
    cropAt(n: number): Rect {
      const s = kinematicsAt(n);
      return { x: s.cx - w / 2, y: s.cy - h / 2, width: w, height: h };
    },
  };
}
