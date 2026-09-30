/**
 * The refit geometry timeline (STC-235) — WHICH display geometry and WHERE in
 * the capture frame applied to a given frame. Selection and validation only;
 * every conversion that USES it lives in spaces.ts (STC-314).
 *
 * Selected by the PTS of the frame being SHOWN, never by `t`: between a
 * physical display change and the first refitted frame the picture is still
 * the old geometry (held, never interpolated — the frame-selection rule), so
 * the cursor drawn over it must be mapped the old way too.
 */
import type { Anchors } from "./types.js";
import { scopedDisplay, type DisplayGeometry } from "./spaces.js";
import { SessionLoadError } from "./session-error.js";

export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface GeometryEntry { startNs: number; display: Anchors["display"]; contentRect: CaptureRect }

export function fullFrame(capture: { width: number; height: number }): CaptureRect {
  return { x: 0, y: 0, width: capture.width, height: capture.height };
}

/**
 * `display` is the real display; `shown` is that display narrowed to what the
 * take captured (STC-471 — `anchors.scope`, on THIS entry's display). Map
 * global points through `shown`; `display` is for identity and comparison.
 * With no scope `shown === display`.
 */
export function geometryAt(
  anchors: Anchors, frameNs: number | null,
): { display: Anchors["display"]; shown: DisplayGeometry; contentRect: CaptureRect } {
  const g = anchors.geometry;
  if (!g) return { display: anchors.display, shown: scopedDisplay(anchors.display, anchors.scope), contentRect: fullFrame(anchors.capture) };
  let pick = g[0]!;
  if (frameNs !== null) {
    for (const e of g) { if (e.startNs <= frameNs) pick = e; else break; }
  }
  return { display: pick.display, shown: scopedDisplay(pick.display, anchors.scope), contentRect: pick.contentRect };
}

const sameDisplay = (a: Anchors["display"], b: Anchors["display"]) =>
  (Object.keys(a) as (keyof Anchors["display"])[]).every((k) => a[k] === b[k]) &&
  Object.keys(a).length === Object.keys(b).length;

export function checkGeometry(anchors: Anchors): void {
  const g = anchors.geometry;
  if (anchors.version === 7 && !g) throw new SessionLoadError("anchors v7 has no geometry — a take with no refit is written as v6 or lower");
  if (!g) return;
  if (anchors.version !== 7) throw new SessionLoadError(`geometry is new at anchors v7, found on v${anchors.version}`);
  if (g.length < 2) throw new SessionLoadError("geometry has fewer than 2 entries");
  const { width: W, height: H } = anchors.capture;
  const e0 = g[0]!;
  if (!sameDisplay(e0.display, anchors.display)) throw new SessionLoadError("geometry[0].display differs from the top-level display");
  const f = e0.contentRect;
  if (f.x !== 0 || f.y !== 0 || f.width !== W || f.height !== H) throw new SessionLoadError("geometry[0].contentRect is not the full capture frame");
  if (e0.startNs !== anchors.capture.firstFrameNs) throw new SessionLoadError("geometry[0].startNs is not capture.firstFrameNs");
  for (let i = 0; i < g.length; i++) {
    const r = g[i]!.contentRect;
    if (i > 0 && !(g[i]!.startNs > g[i - 1]!.startNs)) throw new SessionLoadError(`geometry[${i}].startNs does not increase`);
    const even = [r.x, r.y, r.width, r.height].every((v) => Number.isInteger(v) && v % 2 === 0);
    if (!even || r.width < 2 || r.height < 2) throw new SessionLoadError(`geometry[${i}].contentRect must have even, positive edges`);
    if (r.x < 0 || r.y < 0 || r.x + r.width > W || r.y + r.height > H) throw new SessionLoadError(`geometry[${i}].contentRect lies outside the capture`);
  }
}
