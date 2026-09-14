import type { CursorState, CursorStyle, Project, Session } from "./types.js";
import { frameIndexAt, tickOf } from "./time.js";
import {
  displayToOutput, fixedCornerPipUv, lerpRect, mapPoint, mapVector, outputRect, roundRect,
  uvRectToPixels, type Rect,
} from "./spaces.js";
import {
  ZOOM_PRESETS, createZoomSim, zoomWindows, type ZoomPreset, type ZoomSim, type ZoomWindow,
} from "./zoom.js";
import { groupByEasing, nearestWindow, resolvedCrop } from "./zoom-override.js";
import { DEFAULT_ZOOM } from "./trim.js";
import { createCursorSim, type CursorSim } from "./cursor.js";

/**
 * THE non-negotiable: render(project, session, t) → FrameState is a pure
 * function — no wall clock, no decoder scheduling, no live helper stats, no
 * current display state. Preview and export are two sinks that call this with
 * different t sequences; sinks may not fork it.
 *
 * The per-session sim cache below is a pure memo: every cursor state lives on
 * the one canonical trajectory from tick 0, so cached and fresh answers are
 * bit-identical (cursor.test.ts proves it).
 */

export interface FrameState {
  /** 120 Hz sim tick this t falls in */
  tick: number;
  /** index into session.frames of the source frame to show, or null before the first frame */
  frameIndex: number | null;
  /** that frame's session-relative PTS ns, or null */
  framePtsNs: number | null;
  /**
   * cursor in output pixel coordinates. `pxPerPoint` is how many output pixels
   * one cursor point covers: the display-to-output ratio times the project's
   * cursor scale, so the pointer keeps its on-screen size relative to the
   * content at any export size. `style` picks the artwork set or the circle.
   */
  cursor: CursorState & { pxPerPoint: number; style: CursorStyle };
  /** camera picture-in-picture, or null when there is none to draw */
  pip: PipState | null;
  /** auto-zoom (STC-325/330). Always present; `crop` is the whole frame unless an override supplies a target */
  zoom: ZoomState;
}

/**
 * Where the zoom is, at this instant.
 *
 * `amount` is stage 1's eased 0..1 — how far into the zoom we are. `crop` is
 * the CURRENT blended crop, as a UV rect over the CAPTURE: the same space a
 * redaction lives in (spaces.ts), so it moves with the picture rather than
 * with the canvas and needs no units of its own. It is already the result of
 * blending `FULL_FRAME_UV` toward whatever target applies at `lerpRect`'s own
 * `amount` — a caller (the compositor) draws exactly this rect and does not
 * need to know a target or a blend happened.
 *
 * **Automatic targets (stage 2, STC-326) are not built.** A window with no
 * MANUAL override (STC-330's `overrides` table) still crops to the whole
 * frame at every amount — the derivation runs and a document can change it,
 * but nothing derives a rectangle on its own yet. STC-326 supplies that;
 * until then, `crop` moves only for a window someone has explicitly tuned.
 */
export interface ZoomState {
  amount: number;
  crop: Rect;
}

/** The whole capture, in UV. What `crop` is until STC-326 decides otherwise. */
export const FULL_FRAME_UV: Rect = { x: 0, y: 0, width: 1, height: 1 };

export interface PipState {
  frameIndex: number;
  framePtsNs: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The PiP is drawn only while the camera track actually exists.
 *
 * "Greatest PTS <= t, hold" is right for gaps inside a track and wrong at its
 * end: a camera lost mid-take would otherwise hold its last frame for the rest
 * of the recording, leaving a frozen face on screen. Both bounds come from
 * anchors.camera, never from an assumed frame rate — the measured camera rate
 * varies run to run.
 */
function pipStateAt(project: Project, session: Session, tNs: number): PipState | null {
  const pip = project.pip;
  const cam = session.anchors.camera;
  const frames = session.cameraFrames;
  if (!pip?.enabled || !cam?.present || !frames?.length) return null;

  if (tNs < cam.firstFramePtsNs) return null;
  if (tNs > cam.lastFramePtsNs + cam.frameIntervalNs) return null;

  const frameIndex = frameIndexAt(frames, tNs);
  if (frameIndex === null) return null;

  // A crop in UV over the output, not a corner in output pixels (STC-314):
  // the camera lives in the same space as a zoom crop, so whatever comes to
  // move a zoom can move the camera without a second answer to "where does
  // the PiP go". Rounded because this rectangle places a DECODED FRAME, and a
  // frame at a half-pixel offset is a frame resampled across every edge.
  const rect = roundRect(uvRectToPixels(
    fixedCornerPipUv(pip, project.output, cam),
    outputRect(project.output),
  ));
  return { frameIndex, framePtsNs: frames[frameIndex]!, ...rect };
}

const simCache = new WeakMap<Session, CursorSim>();

/** The take's derived windows, memoised per session — independent of preset or overrides, unlike the sims below. */
const windowsCache = new WeakMap<Session, ZoomWindow[]>();

/**
 * The zoom sims, memoised per session exactly as the cursor's is, and for the
 * same reason: every sim replays one canonical trajectory from tick 0, so a
 * cached answer and a fresh one are bit-identical.
 *
 * ONE sim per resolved easing GROUP now, not one per project preset
 * (STC-330: `groupByEasing`'s own doc comment says why grouping rather than
 * a per-tick easing lookup is the correct composition). Keyed on the
 * session, then on a fingerprint of every input the grouping depends on —
 * the project's preset AND its overrides, since either can change which
 * window lands in which group. A cache keyed on the preset alone (as this
 * was before overrides existed) is how two documents with different
 * overrides would have shared one answer — the same "a cache that ignores
 * an input" trap this comment already warned about once.
 */
const zoomCache = new WeakMap<Session, Map<string, Map<ZoomPreset, ZoomSim>>>();

function windowsFor(session: Session): ZoomWindow[] {
  let windows = windowsCache.get(session);
  if (!windows) {
    windows = zoomWindows(session.events);
    windowsCache.set(session, windows);
  }
  return windows;
}

export function render(project: Project, session: Session, tNs: number): FrameState {
  let sim = simCache.get(session);
  if (!sim) {
    sim = createCursorSim(session.events);
    simCache.set(session, sim);
  }

  const zoom = project.zoom ?? DEFAULT_ZOOM;
  const windows = windowsFor(session);
  const overridesKey = JSON.stringify({ preset: zoom.preset, overrides: project.overrides ?? [] });
  let byKey = zoomCache.get(session);
  if (!byKey) { byKey = new Map(); zoomCache.set(session, byKey); }
  let groupSims = byKey.get(overridesKey);
  if (!groupSims) {
    groupSims = new Map();
    for (const [name, ws] of groupByEasing(windows, project.overrides, zoom.preset)) {
      groupSims.set(name, createZoomSim(ws, ZOOM_PRESETS[name]));
    }
    byKey.set(overridesKey, groupSims);
  }

  const tick = tickOf(tNs);
  const frameIndex = frameIndexAt(session.frames, tNs);
  const s = sim.stateAt(tick);

  // global points → display-local points → output pixels. spaces.ts owns the
  // rule; this stays the only event-space conversion in the transform.
  const m = displayToOutput(session.anchors.display, project.output);
  const at = mapPoint(m, s);
  // A velocity is a DIFFERENCE of global points, so it scales without
  // translating — hence the second call rather than a flag.
  const vel = mapVector(m, { x: s.vx, y: s.vy });

  // `enabled` short-circuits to a flat zero rather than skipping the sims,
  // so "off" and "on at intensity 0" are one code path to one visible
  // result — the cheaper of two paths to the same answer is the one that
  // never gets exercised. The max composes every easing group correctly
  // (`groupByEasing`'s own comment): at most one can be meaningfully
  // non-zero at any tick.
  let zoomAmount = 0;
  if (zoom.enabled) {
    for (const groupSim of groupSims.values()) zoomAmount = Math.max(zoomAmount, groupSim.amountAt(tick));
    zoomAmount *= zoom.intensity;
  }
  // Without an override this is a no-op on the pixels by construction: a
  // window may be found, but with no matching override `resolvedCrop` is
  // undefined, the target falls back to the whole frame, and lerping the
  // whole frame toward itself is the whole frame at every `zoomAmount` —
  // the same guarantee stage 1 shipped with, now resting on the lerp rather
  // than on `crop` being a hardcoded constant.
  const nearWindow = nearestWindow(windows, tNs);
  const zoomTarget = (nearWindow && resolvedCrop(project.overrides, nearWindow)) || FULL_FRAME_UV;

  return {
    tick,
    frameIndex,
    framePtsNs: frameIndex === null ? null : session.frames[frameIndex]!,
    cursor: {
      x: at.x,
      y: at.y,
      vx: vel.x,
      vy: vel.y,
      pressed: s.pressed,
      visible: s.visible,
      shape: s.shape,
      style: project.cursor.style,
      pxPerPoint: project.cursor.scale * m.sx,
    },
    pip: pipStateAt(project, session, tNs),
    zoom: { amount: zoomAmount, crop: lerpRect(FULL_FRAME_UV, zoomTarget, zoomAmount) },
  };
}
