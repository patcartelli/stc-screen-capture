/**
 * Capture previous area (STC-570): the last rectangle, retaken without a drag.
 *
 * Pure: no Electron, no helper, no disk. `main.ts` feeds it what the overlay
 * picked and what displays are connected, and acts on the answer.
 *
 * Decisions (Patrick, 2026-11-02 and 2026-11-03):
 * - One rectangle per display, and which display was LAST. A shot and a region
 *   recording both write it, so a retake uses whatever the last region was.
 *   A window shot never does.
 * - Keyed by display UUID. The numeric id can change when a display reconnects.
 * - The rectangle is DISPLAY-LOCAL POINTS, the space `capture-still`'s `crop`
 *   and `start`'s `region` already share (`selection.ts`), so the two sources
 *   are interchangeable without a conversion.
 * - A stored rectangle that no longer fits is never clamped: it falls back to
 *   the selection overlay. The display's point size is stored with it, because
 *   a resolution change leaves a rectangle that still fits but frames
 *   something else.
 */

import type { Rect } from "./selection.js";

/** A rectangle smaller than this in either direction is not worth remembering. */
export const MIN_REMEMBERED_POINTS = 1;

export interface RememberedArea {
  /** Display-local points. */
  crop: Rect;
  /** The display's size in points when this was picked. */
  displayWidth: number;
  displayHeight: number;
}

export interface PreviousAreas {
  /** The display whose rectangle was picked most recently. */
  last: string | null;
  byDisplay: Record<string, RememberedArea>;
}

export const NO_PREVIOUS_AREAS: PreviousAreas = { last: null, byDisplay: {} };

/** A connected display, as the helper's `devices` reply describes it. */
export interface ConnectedDisplay {
  id: number;
  uuid: string;
  /** Size in points. */
  width: number;
  height: number;
}

export type PreviousAreaAnswer =
  | { kind: "retake"; displayId: number; crop: Rect }
  | { kind: "overlay"; reason: "none" | "display-gone" | "layout-changed" };

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function fits(a: RememberedArea, d: ConnectedDisplay): boolean {
  const { x, y, width, height } = a.crop;
  return a.displayWidth === d.width && a.displayHeight === d.height
    && x >= 0 && y >= 0 && x + width <= d.width && y + height <= d.height;
}

/**
 * Note a region the user picked on `display`. Returns the same object when
 * there is nothing worth keeping (a degenerate rect, or a display with no
 * uuid), so a caller can compare by identity to skip a write.
 */
export function rememberArea(areas: PreviousAreas, display: ConnectedDisplay | undefined, crop: Rect): PreviousAreas {
  if (!display || !display.uuid) return areas;
  if (![crop.x, crop.y, crop.width, crop.height].every(finite)) return areas;
  if (crop.width < MIN_REMEMBERED_POINTS || crop.height < MIN_REMEMBERED_POINTS) return areas;
  const area: RememberedArea = {
    crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
    displayWidth: display.width, displayHeight: display.height,
  };
  return { last: display.uuid, byDisplay: { ...areas.byDisplay, [display.uuid]: area } };
}

/** What a retake does now: the stored rectangle on its display, or the overlay. */
export function resolvePreviousArea(areas: PreviousAreas, connected: readonly ConnectedDisplay[]): PreviousAreaAnswer {
  const area = areas.last === null ? undefined : areas.byDisplay[areas.last];
  if (!area) return { kind: "overlay", reason: "none" };
  const display = connected.find((d) => d.uuid === areas.last);
  if (!display) return { kind: "overlay", reason: "display-gone" };
  if (!fits(area, display)) return { kind: "overlay", reason: "layout-changed" };
  return { kind: "retake", displayId: display.id, crop: { ...area.crop } };
}

/** Read `settings.json`'s value back. Anything malformed is "nothing remembered", never a throw. */
export function cleanPreviousAreas(raw: unknown): PreviousAreas {
  if (typeof raw !== "object" || raw === null) return NO_PREVIOUS_AREAS;
  const doc = raw as Record<string, unknown>;
  const src = typeof doc.byDisplay === "object" && doc.byDisplay !== null
    ? doc.byDisplay as Record<string, unknown> : {};
  const byDisplay: Record<string, RememberedArea> = {};
  for (const [uuid, v] of Object.entries(src)) {
    if (!uuid || typeof v !== "object" || v === null) continue;
    const a = v as Record<string, unknown>;
    const c = (typeof a.crop === "object" && a.crop !== null ? a.crop : {}) as Record<string, unknown>;
    if (![c.x, c.y, c.width, c.height, a.displayWidth, a.displayHeight].every(finite)) continue;
    const crop = { x: c.x as number, y: c.y as number, width: c.width as number, height: c.height as number };
    if (crop.width < MIN_REMEMBERED_POINTS || crop.height < MIN_REMEMBERED_POINTS) continue;
    byDisplay[uuid] = { crop, displayWidth: a.displayWidth as number, displayHeight: a.displayHeight as number };
  }
  const last = typeof doc.last === "string" && doc.last in byDisplay ? doc.last : null;
  return last === null && Object.keys(byDisplay).length === 0 ? NO_PREVIOUS_AREAS : { last, byDisplay };
}
