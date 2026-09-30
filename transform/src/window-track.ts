/**
 * Where a window-scope take's window was over time (STC-482).
 *
 * A window capture shows only the window's own pixels, so dragging the window
 * leaves the PICTURE still while the cursor, which `events.json` carries in
 * global points, keeps travelling. Mapped through the bounds recorded at the
 * start (STC-471), the cursor is then off by exactly how far the window has
 * moved — a title-bar drag drew the pointer trailing away from the bar it was
 * holding.
 *
 * The rule: the cursor belongs to the window it is inside, so take the
 * window's displacement OUT of the events, and everything downstream keeps
 * mapping through the start bounds as if the window had never moved.
 *
 *     e' = e - (windowOrigin(e.t) - windowOrigin(0))
 *
 * Done to the EVENTS, once, at load — not in `geometryAt` per render — for two
 * reasons that both come from the cursor being a spring:
 *
 *   1. The spring lags its input by roughly `1 / OMEGA`. Subtracting the
 *      window's position AFTER the spring leaves a lag of `velocity / OMEGA`
 *      points between the pointer and the bar it is dragging (about 33 pt at
 *      1000 pt/s). Subtracting BEFORE it feeds the spring the cursor's
 *      position relative to the window, and the spring is linear, so what it
 *      returns is exactly the smoothed relative position.
 *   2. Auto-zoom's cursor fallback and the timeline read the same events. One
 *      correction at the door means none of them has a window rule of its own.
 *
 * A take with no `track` returns the very array it was given.
 *
 * What this does NOT cover: a window that moves with the mouse standing still
 * (an app moving its own window). The correction is applied at events, so the
 * pointer would not shift until the next one. A drag always produces events.
 *
 * Time here is the events clock (session ns), the same one `track[].t` is
 * stamped on — NOT the shown frame's PTS. `geometryAt` keys the display
 * geometry by frame PTS because that geometry describes the PICTURE; a window's
 * position describes the CURSOR, which has no frame.
 */
import type { Anchors, SessionEvent } from "./types.js";
import { SessionLoadError } from "./session-error.js";

export interface WindowTrackEntry { t: number; x: number; y: number }

/** The track, or undefined for anything that is not a moved window take. */
export function windowTrackOf(anchors: Anchors): readonly WindowTrackEntry[] | undefined {
  const s = anchors.scope;
  return s && s.kind === "window" ? s.window.track : undefined;
}

/**
 * Refuses rather than defaults, the loader's rule everywhere. Entry 0 must be
 * the start (t 0, the recorded bounds); times strictly increase; everything
 * finite. A `track` on anything but a v8 window take is a document that says
 * one thing in its version and another in its body.
 */
export function checkWindowTrack(anchors: Anchors): void {
  const s = anchors.scope;
  const track = s && s.kind === "window" ? s.window.track : undefined;
  if (anchors.version === 8 && !track) {
    throw new SessionLoadError("anchors v8 has no window track — a take whose window never moved is written as v7 or lower");
  }
  if (!track) return;
  if (anchors.version !== 8) throw new SessionLoadError(`window.track is new at anchors v8, found on v${anchors.version}`);
  if (track.length < 2) throw new SessionLoadError("window.track has fewer than 2 entries");
  const b = (s as Extract<NonNullable<Anchors["scope"]>, { kind: "window" }>).window.bounds;
  const first = track[0]!;
  if (first.t !== 0 || first.x !== b.x || first.y !== b.y) {
    throw new SessionLoadError("window.track[0] is not the take's start (t 0 at the recorded bounds)");
  }
  for (let i = 0; i < track.length; i++) {
    const e = track[i]!;
    if (![e.t, e.x, e.y].every(Number.isFinite)) throw new SessionLoadError(`window.track[${i}] is not finite`);
    if (i > 0 && !(e.t > track[i - 1]!.t)) throw new SessionLoadError(`window.track[${i}].t does not increase`);
  }
}

/**
 * The window's top-left at session ns `t`, linear between entries, held
 * before the first and after the last. Linear because the samples are ~30 Hz
 * and a title-bar drag is smooth: holding the last sample would step the
 * pointer 30 times a second against a picture that does not.
 */
export function windowOriginAt(track: readonly WindowTrackEntry[], t: number): { x: number; y: number } {
  const first = track[0]!;
  if (t <= first.t) return { x: first.x, y: first.y };
  const last = track[track.length - 1]!;
  if (t >= last.t) return { x: last.x, y: last.y };
  let lo = 0, hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.t <= t) lo = mid; else hi = mid;
  }
  const a = track[lo]!, c = track[hi]!;
  const f = (t - a.t) / (c.t - a.t);
  return { x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f };
}

/** The events with the window's displacement taken out. Identity without a track. */
export function stabiliseEvents<E extends SessionEvent>(
  anchors: Anchors, events: readonly E[],
): readonly E[] {
  const track = windowTrackOf(anchors);
  if (!track) return events;
  const first = track[0]!;
  return events.map((e) => {
    if (!("x" in e) || !("y" in e)) return e;
    const o = windowOriginAt(track, e.t);
    return { ...e, x: e.x - (o.x - first.x), y: e.y - (o.y - first.y) };
  });
}
