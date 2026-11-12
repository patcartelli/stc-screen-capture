/**
 * The selection scrim's decisions (STC-644). No DOM, no Electron.
 *
 * The dim that appears when Shot or Record opens the overlay is the first
 * thing anyone sees of a capture, so its rules live in one place:
 *
 * 1. ONE dim, in both modes. Window mode dims everything but the window under
 *    the pointer, with `--scrim`, exactly as Area mode dims everything but the
 *    marquee. Space changes the target, never the atmosphere. The level is
 *    fixed; it does not adapt to the desktop (Patrick, 2026-11-12).
 * 2. A paired edge: a light line with a dark line inside it, so the edge reads
 *    over a white window as well as over a dark desktop. The dark line is
 *    `--handle-edge`, the hairline the handles already wear for the same reason.
 * 3. The window cutout and its tint are rounded by `WINDOW_CUTOUT_RADIUS`. A
 *    compromise: the real radius differs per window and needs the window list
 *    to carry it, which is out of scope.
 * 4. The dim fades in over `SCRIM_FADE_IN_MS` and the whole overlay out over
 *    `SCRIM_FADE_OUT_MS`. The legend and bar are at full strength on their
 *    first frame. The windows still wait for `ready-to-show`, so the desktop
 *    never shows through before the overlay has painted. Reduced motion: no
 *    fades at all, and main does not wait for one.
 * 5. Guide lines: before the drag only, in Area mode, a full-width and a
 *    full-height line through the pointer. Drawn on the pointer event itself,
 *    never eased, so they cannot trail it. `guidesShown` is the whole rule.
 * 6. While a drag is in progress the chrome (legend, bar) backs off to
 *    `CHROME_DRAG_OPACITY`.
 */

import type { Rect } from "./selection.js";

/** Entrance of the dim. `--dur-quick`. */
export const SCRIM_FADE_IN_MS = 120;

/** Exit of the whole overlay, before main hides and destroys the windows. */
export const SCRIM_FADE_OUT_MS = 80;

/** The window cutout's corner radius, in points. macOS's own windows are close
 * to this; the true per-window value is not known here. */
export const WINDOW_CUTOUT_RADIUS = 10;

/** The guide lines' strength. The study's pick (Patrick, 2026-11-12). */
export const GUIDE_OPACITY = 0.3;

/** What the legend and bar fall back to while a marquee is being dragged. */
export const CHROME_DRAG_OPACITY = 0.35;

/** How long main waits for the exit fade before it hides the windows. */
export function scrimFadeOutMs(prefersReducedMotion: boolean): number {
  return prefersReducedMotion ? 0 : SCRIM_FADE_OUT_MS;
}

export interface GuideInputs {
  mode: "region" | "window";
  /** A marquee exists (drawn, or being drawn). */
  hasSelection: boolean;
  /** The reducer says a drag is in progress. */
  dragging: boolean;
  /** A button is down on THIS window — the drag has begun before the reducer's
   * answer has come back, and the lines must already be gone. */
  pressing: boolean;
  /** The pointer is over this window. */
  pointerInside: boolean;
}

/** Rule 5: the guide lines show only while there is nothing yet to adjust. */
export function guidesShown(g: GuideInputs): boolean {
  return g.mode === "region" && !g.hasSelection && !g.dragging && !g.pressing && g.pointerInside;
}

// ── the window cutout (rules 1-3) ─────────────────────────────────────────────

/** Radii in the order the path visits them: top-left, top-right, bottom-right,
 * bottom-left. */
export type Corners = readonly [number, number, number, number];

const n = (v: number) => String(Math.round(v * 100) / 100);

/** One closed, clockwise subpath. A zero radius is a square corner. Each radius
 * is clamped to half the rect's shorter side, so a sliver never folds over. */
export function roundedRectPath(r: Rect, radii: Corners): string {
  const cap = Math.max(0, Math.min(r.width, r.height) / 2);
  const clamp = (v: number) => Math.max(0, Math.min(v, cap));
  const tl = clamp(radii[0]), tr = clamp(radii[1]), br = clamp(radii[2]), bl = clamp(radii[3]);
  const x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
  const arc = (rad: number, x: number, y: number) => (rad > 0 ? `A${n(rad)} ${n(rad)} 0 0 1 ${n(x)} ${n(y)}` : "");
  return `M${n(x0 + tl)} ${n(y0)}H${n(x1 - tr)}${arc(tr, x1, y0 + tr)}`
    + `V${n(y1 - br)}${arc(br, x1 - br, y1)}`
    + `H${n(x0 + bl)}${arc(bl, x0, y1 - bl)}`
    + `V${n(y0 + tl)}${arc(tl, x0 + tl, y0)}Z`;
}

/** Within half a point: the helper's rects and the frame come from the same
 * CoreGraphics numbers, but a piece's edge is the result of a subtraction. */
const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

/**
 * The visible pieces of a window, as one path of disjoint holes. A piece's
 * corner is rounded only where it IS one of the frame's corners: an edge cut
 * by the window in front stays square, because that edge is the other
 * window's, not this one's.
 */
export function windowHolesPath(frame: Rect, visible: readonly Rect[], radius: number): string {
  const fx1 = frame.x + frame.width, fy1 = frame.y + frame.height;
  return visible.map((p) => {
    const px1 = p.x + p.width, py1 = p.y + p.height;
    const at = (x: number, y: number, fx: number, fy: number) => (near(x, fx) && near(y, fy) ? radius : 0);
    return roundedRectPath(p, [
      at(p.x, p.y, frame.x, frame.y),
      at(px1, p.y, fx1, frame.y),
      at(px1, py1, fx1, fy1),
      at(p.x, py1, frame.x, fy1),
    ]);
  }).join("");
}

/** The dim in Window mode: the whole viewport, with the window's visible
 * pieces cut out (fill-rule evenodd; the pieces are disjoint, `WindowInfo`). */
export function windowDimPath(viewport: Rect, frame: Rect, visible: readonly Rect[], radius: number): string {
  return roundedRectPath(viewport, [0, 0, 0, 0]) + windowHolesPath(frame, visible, radius);
}

/** The paired edge round the window frame, as two strokes 1 pt wide drawn
 * INSIDE the frame: light outermost, dark inside it. Clipped to the visible
 * pieces by the caller, so no edge is drawn over the window in front. */
export function windowEdgePaths(frame: Rect, radius: number): { light: string; dark: string } {
  const inset = (d: number): Rect =>
    ({ x: frame.x + d, y: frame.y + d, width: frame.width - 2 * d, height: frame.height - 2 * d });
  const ring = (d: number) => { const r = Math.max(0, radius - d); return [r, r, r, r] as const; };
  return { light: roundedRectPath(inset(0.5), ring(0.5)), dark: roundedRectPath(inset(1.5), ring(1.5)) };
}
