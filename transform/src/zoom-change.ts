import type { SessionEvent } from "./types.js";
import type { Changes, ChangeFrame } from "./changes.js";
import type { ZoomWindow } from "./zoom.js";
import type { Rect } from "./spaces.js";
import { toDisplayLocal, pixelsToUv } from "./spaces.js";
import { clampRectToFrame } from "./zoom-override.js";

/**
 * Auto-zoom stage 2 (STC-326): WHERE to zoom, once stage 1 (`zoom.ts`) has
 * already decided WHEN. `deriveZoomCrop` is the pure function the ticket
 * asks for — `(window, changes, display) -> a crop in capture UV, or null`
 * — and it is the AUTOMATIC answer only: a manual override (STC-330,
 * `zoom-override.ts`) always wins over this, which is why `render.ts` calls
 * `resolvedCrop` first and falls back here only when a window has none.
 *
 * ## The signal the ticket actually asks for does not exist yet, and this
 * builds a reasoned first cut rather than waiting
 *
 * The ticket says to "apply the temporal-filter rules the lab study wrote"
 * (STC-319). That document's own deliverable — the rules list distinguishing
 * change that starts near an event from change that is continuous or
 * ambient — is NOT written; STC-319 itself says so (blocked on a Mac and
 * real footage, same as this ticket). So the classifier below is reasoned
 * directly from the FOUR OUTCOMES this ticket's own text states must be
 * right, not sourced from a document that does not exist. Every threshold is
 * a stated, provisional number — the same posture `zoom.ts`'s presets and
 * `zoom-override.ts`'s `DEFAULT_OVERRIDE_RECT_FRACTION` are already in —
 * and STC-319/326's own runbooks are where a Mac corrects them.
 *
 * ## Missing vs. uninformative vs. "don't zoom" are three different answers
 *
 * `changes` MISSING (no sidecar at all — true of every take today, since
 * nothing here can run STC-322's browser decode pass) or UNINFORMATIVE (a
 * sidecar exists but has no frames covering this window — should not happen
 * in practice, but a document from a future build might cover only part of
 * a take) falls through to the cursor-clustering fallback the ticket names.
 * `changes` PRESENT and covering the window, but concluding nothing survives
 * (everything changed, nothing changed, or the union is barely tighter than
 * the full frame) is a TRUSTED "don't zoom" and returns null WITHOUT falling
 * back — the changes track had its say and its say was no.
 */

const MS = 1_000_000;

/**
 * The window around a trigger event that counts as "near" it, for deciding
 * whether a cell's change is event-triggered rather than ambient. Leans
 * forward: a field updating or a dropdown opening happens mostly AFTER the
 * click, with only a small allowance before it for a hover state that was
 * already settling, or clock slop between the event tap and the frame grid.
 */
export const BURST_LEAD_NS = 100 * MS;
export const BURST_TRAIL_NS = 600 * MS;

/** A cell counts as "active" in a frame once this much of it changed. Below the per-pixel `changes.threshold` question — this is about a TILE, not a pixel. */
export const CELL_ACTIVE_FRACTION = 0.05;

/**
 * A cell active in at least this fraction of the window's frames is AMBIENT
 * — continuous motion (video playing, a page scrolling, an animation) rather
 * than a discrete reaction to the trigger — and is excluded regardless of how
 * much of its weight happens to fall in a burst window. This is what makes
 * "everything changes" (Music Network, a video) correctly decide not to zoom:
 * a cell that is busy almost every frame fails this test everywhere at once.
 */
export const AMBIENT_FRAME_FRACTION = 0.8;

/**
 * A cell counts as event-triggered once at least this fraction of its total
 * change-weight across the window falls inside SOME trigger's burst window.
 * Genuine reaction-to-a-click change concentrates almost entirely in the
 * burst; diffuse/uncorrelated noise spread evenly across a ~2.8s window does
 * not clear this unless the burst happens to cover most of the window.
 */
export const BURST_CONCENTRATION = 0.5;

/**
 * The union of surviving cells is treated as "no zoom" once its SHORTER axis
 * already covers this much of the full frame — the "barely tighter than the
 * full frame" floor the ticket names as its own outcome, distinct from (and
 * checked before) the 0.5/0.7 viewport clamp below. A crop whose tight axis
 * is still 85%+ of the frame does not read as a zoom, it reads as jitter.
 */
export const MIN_ZOOM_DELTA_FRACTION = 0.85;

/** The union bbox is padded by this fraction of its own size on every side before clamping, so a single discrete element (a field, a button) gets breathing room rather than a crop hugging its exact pixels. */
export const CROP_PAD_FRACTION = 0.2;

/**
 * The crop's width and height are independently clamped into this range of
 * the full frame — BRIEF.md's locked "0.5 / 0.7 of the visible viewport"
 * bound, carried over from the cursor-clustering design stage 2 supersedes.
 * A floor so a crop never reads as an uncomfortably tight zoom on a tiny
 * element; a ceiling so a crop that would barely differ from the full frame
 * is still capped rather than drawn at (say) 95%.
 */
export const VIEWPORT_MIN_FRACTION = 0.5;
export const VIEWPORT_MAX_FRACTION = 0.7;

/**
 * The dead zone a cursor-fallback cluster starts at, and the tolerance a
 * later point must clear before it grows the cluster — UV fraction of the
 * frame. A bare click (down and up at the same point, the common case) never
 * grows past this, so its cluster is exactly this size before padding.
 */
export const CURSOR_DEAD_ZONE_UV = 0.06;

interface DisplayGeom { originX: number; originY: number; pointWidth: number; pointHeight: number }

/**
 * The three-tier floor/pad/clamp every candidate crop goes through, whether
 * it came from the change track or the cursor fallback — one place so the
 * two signals cannot silently apply different rules to the same numbers.
 */
function finishCrop(bbox: Rect): Rect | null {
  if (Math.min(bbox.width, bbox.height) >= MIN_ZOOM_DELTA_FRACTION) return null;

  const padX = bbox.width * CROP_PAD_FRACTION;
  const padY = bbox.height * CROP_PAD_FRACTION;
  const padded: Rect = {
    x: bbox.x - padX, y: bbox.y - padY,
    width: bbox.width + 2 * padX, height: bbox.height + 2 * padY,
  };

  const cx = padded.x + padded.width / 2;
  const cy = padded.y + padded.height / 2;
  const width = Math.min(VIEWPORT_MAX_FRACTION, Math.max(VIEWPORT_MIN_FRACTION, padded.width));
  const height = Math.min(VIEWPORT_MAX_FRACTION, Math.max(VIEWPORT_MIN_FRACTION, padded.height));
  const clamped: Rect = { x: cx - width / 2, y: cy - height / 2, width, height };

  return clampRectToFrame(clamped);
}

/**
 * The change-based signal: for each grid cell, is its change concentrated
 * near a trigger event (include) or spread through most of the window
 * (ambient, exclude)? The union of surviving cells, or null if none survive
 * — which is itself a trusted "don't zoom" answer, not a reason to fall back.
 */
function deriveFromChanges(window: ZoomWindow, changes: Changes, framesInWindow: readonly ChangeFrame[]): Rect | null {
  const { gridWidth, gridHeight } = changes;
  const cellCount = gridWidth * gridHeight;
  const totalWeight = new Float64Array(cellCount);
  const burstWeight = new Float64Array(cellCount);
  const activeFrames = new Int32Array(cellCount);

  for (const f of framesInWindow) {
    const nearTrigger = window.events.some((e) => f.t >= e.t - BURST_LEAD_NS && f.t <= e.t + BURST_TRAIL_NS);
    for (let i = 0; i < cellCount; i++) {
      const v = f.cells[i]!;
      totalWeight[i]! += v;
      if (v >= CELL_ACTIVE_FRACTION) activeFrames[i]!++;
      if (nearTrigger) burstWeight[i]! += v;
    }
  }

  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (let row = 0; row < gridHeight; row++) {
    for (let col = 0; col < gridWidth; col++) {
      const i = row * gridWidth + col;
      if (activeFrames[i]! / framesInWindow.length >= AMBIENT_FRAME_FRACTION) continue; // continuous -> ambient
      if (totalWeight[i]! <= 0) continue; // nothing happened here
      if (burstWeight[i]! / totalWeight[i]! < BURST_CONCENTRATION) continue; // not concentrated near a trigger
      minCol = Math.min(minCol, col); maxCol = Math.max(maxCol, col);
      minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
    }
  }
  if (minCol > maxCol) return null; // no cell survived: everything changed, nothing did, or it was all diffuse

  return finishCrop({
    x: minCol / gridWidth, y: minRow / gridHeight,
    width: (maxCol - minCol + 1) / gridWidth, height: (maxRow - minRow + 1) / gridHeight,
  });
}

function hasPosition(e: SessionEvent): e is Extract<SessionEvent, { x: number; y: number }> {
  return e.kind !== "cursor";
}

/**
 * The locked fallback: greedy dead-zone clustering of the window's own
 * trigger positions (BRIEF.md's original "movement decides where", demoted
 * to second-best signal by this ticket). Global points -> capture UV needs
 * only the display block, since UV is scale-invariant over it.
 *
 * Greedy dead-zone, precisely: the cluster starts as a small rect centred on
 * the first point; a later point already inside the current rect is
 * ignored — jitter that should not grow the target — and one outside it
 * grows the rect to just include it. A bare click's down/up land on the same
 * point and the cluster never grows past the starting dead zone; a drag's
 * held moves grow it to the drag's own bounding box.
 */
function deriveFromCursor(window: ZoomWindow, display: DisplayGeom): Rect | null {
  const displayRect: Rect = { x: 0, y: 0, width: display.pointWidth, height: display.pointHeight };
  const points = window.events.filter(hasPosition)
    .map((e) => pixelsToUv(toDisplayLocal(e, { x: display.originX, y: display.originY }), displayRect));
  if (points.length === 0) return null;

  const z = CURSOR_DEAD_ZONE_UV;
  let rect: Rect = { x: points[0]!.x - z / 2, y: points[0]!.y - z / 2, width: z, height: z };
  for (const p of points) {
    if (p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height) continue;
    const x0 = Math.min(rect.x, p.x), y0 = Math.min(rect.y, p.y);
    const x1 = Math.max(rect.x + rect.width, p.x), y1 = Math.max(rect.y + rect.height, p.y);
    rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  return finishCrop(rect);
}

/**
 * The one entry point `render.ts` calls once a window has no manual
 * override. `display` is `session.anchors.display`; `changes` is
 * `session.changes`, absent on every take today.
 */
export function deriveZoomCrop(
  window: ZoomWindow, changes: Changes | undefined, display: DisplayGeom,
): Rect | null {
  if (changes) {
    const framesInWindow = changes.frames.filter((f) => f.t >= window.startNs && f.t <= window.endNs);
    if (framesInWindow.length > 0) return deriveFromChanges(window, changes, framesInWindow);
  }
  return deriveFromCursor(window, display);
}
