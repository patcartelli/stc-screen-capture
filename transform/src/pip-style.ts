import { fixedCornerPipUv, outputRect, uvRectToPixels, type Point, type Rect, type Size } from "./spaces.js";

/**
 * Every decision about a customised PiP (STC-461) — no DOM, no canvas, no clock.
 *
 * ## What lives here and what does not
 *
 * `render.ts` asks this module where the PiP goes and what part of the camera it
 * shows; `compositor.ts` draws the answer and decides nothing. The editor and the
 * Settings sheet ask it what a drag, a slider or a preset MEANS (`editPipStyle`,
 * `snapCenter`, `resizeFromCorner`, `panFraming`) and only report input.
 *
 * ## Why it imports nothing but spaces.ts
 *
 * `main.ts` (the write gate), `settings.ts` and `take-project.ts` validate a style
 * too, under `tsconfig.node.json`, which refuses anything that reaches the
 * DOM-typed `cursor-art.ts` — `trim.ts` does. So the fixed-corner default lives
 * here and `trim.ts` re-exports it, not the other way round.
 *
 * ## Absent style = the old PiP
 *
 * A project whose `pip` has no `style` renders through `fixedCornerPipUv` exactly
 * as before this module existed; `styleFromFixedCorner` is how the first edit
 * picks up from there without the PiP jumping.
 */

export type PipShape = "rect" | "square" | "circle";

/** Which part of the camera shows: a centre in UV over the CAMERA frame and a zoom
 * over the largest crop of the shape's aspect. A rect never appears here, so a
 * framing can never disagree with its shape. */
export interface PipFraming { x: number; y: number; zoom: number }

export interface PipBorder { widthPt: number; color: string }

/** Mirrors `pip.style` in schema/project-15.schema.json. */
export interface PipStyle {
  shape: PipShape;
  /** Fraction of the PiP's SHORT side, 0..0.5. Ignored for a circle. */
  cornerRadius: number;
  /** UV over the OUTPUT. A centre that would put the PiP off-frame is clamped at render. */
  center: Point;
  /** UV: fraction of the output width. Height is derived from the shape. */
  width: number;
  /** Absent = `DEFAULT_FRAMING`. Per take: Settings never stores one. */
  framing?: PipFraming;
  mirror: boolean;
  /** Width in display POINTS, scaled to output pixels the way the cursor is. */
  border: PipBorder | null;
  shadow: boolean;
}

export const PIP_WIDTH_MIN = 0.05;
export const PIP_WIDTH_MAX = 0.5;
export const PIP_RADIUS_MAX = 0.5;
/** 720p camera vs a ~480 px PiP at 4K: zoom 3 is the most the oversampling covers. */
export const PIP_FRAMING_ZOOM_MAX = 3;
export const PIP_BORDER_PT_MIN = 0.5;
export const PIP_BORDER_PT_MAX = 12;
export const PIP_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** Output pixels — the fixed corner's own margin, so a snapped corner is where the old PiP sat. */
export const PIP_SNAP_MARGIN_PX = 32;
/** SCREEN pixels; the caller converts into output pixels for its own zoom level. */
export const PIP_SNAP_THRESHOLD_SCREEN_PX = 12;

export const DEFAULT_FRAMING: Readonly<PipFraming> = Object.freeze({ x: 0.5, y: 0.5, zoom: 1 });

/** The one drop shadow. Sizes are fractions of the PiP's short side, so it scales with the PiP. */
export const PIP_SHADOW = Object.freeze({ color: "rgba(0, 0, 0, 0.35)", blurFraction: 0.08, offsetYFraction: 0.03 });

/** The fixed-corner PiP every camera take gets when its project says nothing (STC-232). */
export const DEFAULT_PIP_FIXED = Object.freeze({
  enabled: true as boolean, corner: "bottom-right" as const, widthPct: 0.125, marginPx: PIP_SNAP_MARGIN_PX,
});

/** What Settings holds until someone changes it. Equal to it = nothing is seeded into a take. */
export const DEFAULT_PIP_STYLE: Readonly<PipStyle> = Object.freeze({
  shape: "rect", cornerRadius: 0, center: Object.freeze({ x: 0.9, y: 0.86 }), width: 0.125,
  mirror: false, border: null, shadow: false,
}) as Readonly<PipStyle>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const inRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * The style, or null. Never corrects a value: the write gate refuses on null and
 * the loaders fall back on it, and both need to know the document said something
 * this build did not write.
 */
export function cleanPipStyle(v: unknown): PipStyle | null {
  if (!isObj(v)) return null;
  const { shape, cornerRadius, center, width, framing, mirror, border, shadow } = v;
  if (shape !== "rect" && shape !== "square" && shape !== "circle") return null;
  if (!inRange(cornerRadius, 0, PIP_RADIUS_MAX)) return null;
  if (!isObj(center) || !inRange(center.x, 0, 1) || !inRange(center.y, 0, 1)) return null;
  if (!inRange(width, PIP_WIDTH_MIN, PIP_WIDTH_MAX)) return null;
  if (typeof mirror !== "boolean" || typeof shadow !== "boolean") return null;
  let cleanBorder: PipBorder | null = null;
  if (border !== null) {
    if (!isObj(border) || !inRange(border.widthPt, PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX)
        || typeof border.color !== "string" || !PIP_COLOR_PATTERN.test(border.color)) return null;
    cleanBorder = { widthPt: border.widthPt, color: border.color };
  }
  const out: PipStyle = {
    shape, cornerRadius, center: { x: center.x, y: center.y }, width, mirror, border: cleanBorder, shadow,
  };
  if (framing !== undefined) {
    if (!isObj(framing) || !inRange(framing.x, 0, 1) || !inRange(framing.y, 0, 1)
        || !inRange(framing.zoom, 1, PIP_FRAMING_ZOOM_MAX)) return null;
    out.framing = { x: framing.x, y: framing.y, zoom: framing.zoom };
  }
  return out;
}

/** Output pixels. Width rounds FIRST and height derives from the rounded width —
 * the same order `fixedCornerPipUv` uses, so `styleFromFixedCorner` is exact. */
export function pipSize(style: PipStyle, output: Size, camera: Size): Size {
  const width = Math.round(output.width * style.width);
  const height = style.shape === "rect" ? Math.round((width * camera.height) / camera.width) : width;
  return { width, height };
}

/** Where the PiP lands, in whole output pixels, always inside the frame. Rounded
 * because it places a DECODED FRAME (render.ts's pipStateAt says why). */
export function pipRect(style: PipStyle, output: Size, camera: Size): Rect {
  const { width, height } = pipSize(style, output, camera);
  const x = clamp(Math.round(style.center.x * output.width - width / 2), 0, Math.max(0, output.width - width));
  const y = clamp(Math.round(style.center.y * output.height - height / 2), 0, Math.max(0, output.height - height));
  return { x, y, width, height };
}

function shapeAspect(shape: PipShape, camera: Size): number {
  return shape === "rect" ? camera.width / camera.height : 1;
}

/** The largest crop of the shape's aspect inside the camera frame, divided by zoom. */
function cropSize(shape: PipShape, zoom: number, camera: Size): Size {
  const aspect = shapeAspect(shape, camera);
  const base = camera.width / camera.height >= aspect
    ? { width: camera.height * aspect, height: camera.height }
    : { width: camera.width, height: camera.width / aspect };
  return { width: base.width / zoom, height: base.height / zoom };
}

/** The framing with its centre clamped so the crop stays inside the camera frame. */
export function clampFraming(framing: PipFraming, shape: PipShape, camera: Size): PipFraming {
  const s = cropSize(shape, framing.zoom, camera);
  const hx = s.width / 2 / camera.width;
  const hy = s.height / 2 / camera.height;
  return { x: clamp(framing.x, hx, 1 - hx), y: clamp(framing.y, hy, 1 - hy), zoom: framing.zoom };
}

/** `drawImage`'s source rect, in camera pixels. Not rounded: a source rect is sampled, not placed. */
export function framingSource(style: PipStyle, camera: Size): Rect {
  const f = clampFraming(style.framing ?? DEFAULT_FRAMING, style.shape, camera);
  const s = cropSize(style.shape, f.zoom, camera);
  return { x: f.x * camera.width - s.width / 2, y: f.y * camera.height - s.height / 2, width: s.width, height: s.height };
}

/** Today's fixed corner, as a style that lands on exactly the same pixels. */
export function styleFromFixedCorner(pip: { widthPct: number; marginPx: number }, output: Size, camera: Size): PipStyle {
  const r = uvRectToPixels(fixedCornerPipUv(pip, output, camera), outputRect(output));
  return {
    ...DEFAULT_PIP_STYLE,
    center: { x: (r.x + r.width / 2) / output.width, y: (r.y + r.height / 2) / output.height },
    width: clamp(pip.widthPct, PIP_WIDTH_MIN, PIP_WIDTH_MAX),
  };
}

export function pipStylesEqual(a: PipStyle, b: PipStyle): boolean {
  const fa = a.framing, fb = b.framing;
  return a.shape === b.shape && a.cornerRadius === b.cornerRadius && a.width === b.width
    && a.center.x === b.center.x && a.center.y === b.center.y
    && a.mirror === b.mirror && a.shadow === b.shadow
    && (a.border === null ? b.border === null
      : b.border !== null && a.border.widthPt === b.border.widthPt && a.border.color === b.border.color)
    && (fa === undefined ? fb === undefined
      : fb !== undefined && fa.x === fb.x && fa.y === fb.y && fa.zoom === fb.zoom);
}

export function isDefaultPipStyle(s: PipStyle): boolean {
  return pipStylesEqual(s, DEFAULT_PIP_STYLE);
}
