/**
 * Where the PiP is NOT drawn inside the camera track (STC-553, folding in STC-557).
 *
 * render() holds the newest camera frame at or before `t` (the frame-selection rule), which
 * is right across a camera's ordinary VFR jitter and wrong across a STALL: a camera that
 * stops delivering and comes back leaves a gap inside its track, and the export showed the
 * last good frame frozen for the whole of it. Since STC-562 that gap is filled in camera.mp4
 * with HELD frames (the writer cannot store one sample over 2^31 ns), so the file alone no
 * longer shows it; a frozen face is a frozen face either way.
 *
 * Two sources, because only takes recorded after STC-553 carry the first:
 *
 * 1. `anchors.camera.stalledSpans` (anchors-16): the helper's own record, last real frame
 *    to first real frame after. Explicit, and the only one that sees a stall through
 *    STC-562's hold frames.
 * 2. The camera's own frame grid (`session.cameraFrames`): any gap between two frames
 *    longer than `CAMERA_STALL_NS` of RECORDING time. For an older take, the gap is still
 *    in the file. On a newer one holds keep every gap near a second, so this never fires
 *    where (1) did not.
 *
 * Either way the PiP disappears one frame interval after the last real frame (so that
 * frame is shown for its own interval, as any frame is) and comes back at the first real
 * frame after.
 *
 * **Paused time is never a stall.** A pause drops camera frames (`PauseGate`) while the
 * export still plays the paused span as held frames (STC-240 PR B, the cut, has not
 * landed), so a pause leaves a camera gap that is not the camera's fault. Paused time does
 * not count toward a gap's length, and the PiP is never hidden INSIDE a pause: a pause
 * exports exactly as it did before this module. The helper closes a stall at a pause for
 * the same reason (CameraStallDecisions.swift).
 *
 * `CAMERA_STALL_NS` is the helper's own threshold, measured for STC-553 on 2026-10-16: an
 * Elgato under a load average of 121 never went more than ~33 ms between frames, and a
 * camera starved to 12 frames in 11 s (~0.9 s apart, camera-capture.grant.test.ts) is slow
 * but alive and must keep its PiP.
 *
 * Pure: no DOM, no clock. Cached per session, since render() is called per output frame
 * and the grid of a long take is tens of thousands of frames.
 */
import type { Session } from "./types.js";

/** A camera gap this long, in recording time, is a stall. Matches the helper's N. */
export const CAMERA_STALL_NS = 3_000_000_000;

/** Half-open `[startNs, endNs)`: the PiP is hidden for `startNs <= t < endNs`. */
export interface CameraGap { startNs: number; endNs: number }

type Span = { startNs: number; endNs: number };

const cache = new WeakMap<Session, readonly CameraGap[]>();

/** Recording time in `[a, b)`: its length minus whatever of it was paused. */
function liveNs(a: number, b: number, pauses: readonly Span[]): number {
  let paused = 0;
  for (const p of pauses) paused += Math.max(0, Math.min(b, p.endNs) - Math.max(a, p.startNs));
  return b - a - paused;
}

/** `span` with every paused stretch taken out of it. */
function minusPauses(span: Span, pauses: readonly Span[]): Span[] {
  let parts: Span[] = [span];
  for (const p of pauses) {
    parts = parts.flatMap((s) => {
      if (p.endNs <= s.startNs || p.startNs >= s.endNs) return [s];
      const out: Span[] = [];
      if (p.startNs > s.startNs) out.push({ startNs: s.startNs, endNs: p.startNs });
      if (p.endNs < s.endNs) out.push({ startNs: p.endNs, endNs: s.endNs });
      return out;
    });
  }
  return parts;
}

/** Sorted, overlapping or touching spans merged. */
function merged(spans: Span[]): CameraGap[] {
  const sorted = spans.filter((s) => s.endNs > s.startNs).sort((x, y) => x.startNs - y.startNs);
  const out: CameraGap[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.startNs <= last.endNs) last.endNs = Math.max(last.endNs, s.endNs);
    else out.push({ startNs: s.startNs, endNs: s.endNs });
  }
  return out;
}

/** Every stretch of the camera track where the PiP is hidden, in order. Empty for a take with no camera. */
export function cameraGaps(session: Session): readonly CameraGap[] {
  const hit = cache.get(session);
  if (hit) return hit;
  const cam = session.anchors.camera;
  const frames = session.cameraFrames;
  let gaps: CameraGap[] = [];
  if (cam?.present && frames && frames.length > 0) {
    const pauses = session.anchors.pauses ?? [];
    const fi = cam.frameIntervalNs;
    const raw: Span[] = [];
    for (const s of cam.stalledSpans ?? []) raw.push({ startNs: s.startNs + fi, endNs: s.endNs });
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1]!, b = frames[i]!;
      if (liveNs(a, b, pauses) > CAMERA_STALL_NS) raw.push({ startNs: a + fi, endNs: b });
    }
    gaps = merged(raw.flatMap((s) => minusPauses(s, pauses)));
  }
  cache.set(session, gaps);
  return gaps;
}

/** Whether the PiP is hidden at `tNs` for a stall inside the camera track. */
export function inCameraGap(session: Session, tNs: number): boolean {
  for (const g of cameraGaps(session)) {
    if (tNs < g.startNs) return false;
    if (tNs < g.endNs) return true;
  }
  return false;
}
