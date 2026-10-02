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
 * DOM-typed `cursor-art.ts` — `trim.ts` does. So the fixed-corner default
 * (`DEFAULT_PIP_FIXED`) lives here and `trim.ts` builds its `DEFAULT_PIP` from
 * it, not the other way round.
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

/**
 * What Settings holds until someone changes it. Equal to it = nothing is seeded into a take.
 *
 * It IS the fixed corner, expressed as a style: `DEFAULT_PIP_FIXED` at a 1920x1080
 * output with a 1280x720 camera — the Settings mock's own nominal sizes — is a
 * 240x135 PiP at (1648, 913), centred on (1768, 980.5). So the mock shows the
 * default where an untouched take puts it, and a take seeded from an edited
 * default starts from that spot instead of jumping. pip-style.test.ts holds this
 * equal to `styleFromFixedCorner(DEFAULT_PIP_FIXED, 1920x1080, 1280x720)`.
 */
export const DEFAULT_PIP_STYLE: Readonly<PipStyle> = Object.freeze({
  shape: "rect", cornerRadius: 0, center: Object.freeze({ x: 1768 / 1920, y: 980.5 / 1080 }), width: 0.125,
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

/** Output pixels, capped to fit inside the output while keeping the shape's aspect.
 * Width rounds FIRST and height derives from the rounded width — the same order
 * `fixedCornerPipUv` uses, so `styleFromFixedCorner` is exact. Only a PiP that
 * would overflow is touched (a portrait camera, an extreme-aspect output). */
export function pipSize(style: PipStyle, output: Size, camera: Size): Size {
  const rect = style.shape === "rect";
  const aspect = rect ? camera.width / camera.height : 1;
  let width = Math.round(output.width * style.width);
  let height = rect ? Math.round((width * camera.height) / camera.width) : width;
  if (height > output.height) {
    height = output.height;
    width = Math.round(height * aspect);
  }
  if (width > output.width) {
    width = output.width;
    height = rect ? Math.round(width / aspect) : width;
  }
  return { width, height };
}

/** Where the PiP lands, in whole output pixels, always inside the frame (the size is capped to fit). Rounded
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

export const DEFAULT_BORDER: Readonly<PipBorder> = Object.freeze({ widthPt: 2, color: "#ffffff" });

export type PipPresetName = "classic" | "circle" | "rounded-square" | "large-circle";
export interface PipPreset {
  name: PipPresetName;
  label: string;
  /** A LOOK only: a preset never moves the PiP, reframes it or flips it. */
  look: Pick<PipStyle, "shape" | "cornerRadius" | "width" | "border" | "shadow">;
}

/** Tuned by eye on hardware (docs/STC-461-RUNBOOK.md §1); change values here only. */
export const PIP_PRESETS: readonly PipPreset[] = Object.freeze([
  { name: "classic", label: "Classic",
    look: { shape: "rect", cornerRadius: 0.12, width: 0.16, border: null, shadow: true } },
  { name: "circle", label: "Circle",
    look: { shape: "circle", cornerRadius: 0, width: 0.14, border: { ...DEFAULT_BORDER }, shadow: true } },
  { name: "rounded-square", label: "Rounded square",
    look: { shape: "square", cornerRadius: 0.2, width: 0.14, border: null, shadow: true } },
  { name: "large-circle", label: "Large circle",
    look: { shape: "circle", cornerRadius: 0, width: 0.24, border: { widthPt: 3, color: "#ffffff" }, shadow: true } },
]);

export type PipEdit =
  | { kind: "preset"; name: PipPresetName }
  | { kind: "shape"; shape: PipShape }
  | { kind: "radius"; value: number }
  | { kind: "size"; value: number }
  | { kind: "border"; on: boolean }
  | { kind: "borderWidth"; pt: number }
  | { kind: "borderColor"; color: string }
  | { kind: "shadow"; on: boolean }
  | { kind: "mirror"; on: boolean }
  | { kind: "move"; center: Point }
  | { kind: "framing"; framing: PipFraming };

/**
 * What an inspector control or a drag MEANS. Always returns a style
 * `cleanPipStyle` accepts: out-of-range input is clamped, a bad colour is
 * ignored. The DOM only maps events to a `PipEdit`.
 */
export function editPipStyle(style: PipStyle, edit: PipEdit, camera: Size): PipStyle {
  const s: PipStyle = { ...style, center: { ...style.center } };
  switch (edit.kind) {
    case "preset": {
      const p = PIP_PRESETS.find((x) => x.name === edit.name);
      if (!p) return s;
      return { ...s, ...p.look, border: p.look.border ? { ...p.look.border } : null };
    }
    case "shape": return { ...s, shape: edit.shape };
    case "radius": return { ...s, cornerRadius: clamp(edit.value, 0, PIP_RADIUS_MAX) };
    case "size": return { ...s, width: clamp(edit.value, PIP_WIDTH_MIN, PIP_WIDTH_MAX) };
    case "border": return { ...s, border: edit.on ? { ...(s.border ?? DEFAULT_BORDER) } : null };
    case "borderWidth":
      return { ...s, border: { ...(s.border ?? DEFAULT_BORDER), widthPt: clamp(edit.pt, PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX) } };
    case "borderColor":
      if (!PIP_COLOR_PATTERN.test(edit.color)) return s;
      return { ...s, border: { ...(s.border ?? DEFAULT_BORDER), color: edit.color } };
    case "shadow": return { ...s, shadow: edit.on };
    case "mirror": return { ...s, mirror: edit.on };
    case "move": return { ...s, center: { x: clamp(edit.center.x, 0, 1), y: clamp(edit.center.y, 0, 1) } };
    case "framing": {
      const zoom = clamp(edit.framing.zoom, 1, PIP_FRAMING_ZOOM_MAX);
      return { ...s, framing: clampFraming({ ...edit.framing, zoom }, s.shape, camera) };
    }
  }
}

function nearestWithin(candidates: readonly number[], v: number, threshold: number): number | undefined {
  let best: number | undefined;
  let bestD = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - v);
    if (d <= bestD) { best = c; bestD = d; }
  }
  return best;
}

/**
 * Nine anchors, decided per axis: an edge's margin, the middle, the far edge's
 * margin. `size` and `thresholdPx` are OUTPUT pixels — the caller converts its
 * screen threshold for the stage's current scale.
 */
export function snapCenter(center: Point, size: Size, output: Size, thresholdPx: number): Point {
  const m = PIP_SNAP_MARGIN_PX;
  const xs = [m + size.width / 2, output.width / 2, output.width - m - size.width / 2];
  const ys = [m + size.height / 2, output.height / 2, output.height - m - size.height / 2];
  const px = center.x * output.width;
  const py = center.y * output.height;
  const sx = nearestWithin(xs, px, thresholdPx);
  const sy = nearestWithin(ys, py, thresholdPx);
  return { x: (sx ?? px) / output.width, y: (sy ?? py) / output.height };
}

/** A corner handle: aspect locked, centre fixed; the larger of the two axes wins. */
export function resizeFromCorner(style: PipStyle, pointer: Point, output: Size, camera: Size): PipStyle {
  const cx = style.center.x * output.width;
  const cy = style.center.y * output.height;
  const now = pipSize(style, output, camera);
  const aspect = now.width / now.height;
  const halfW = Math.max(Math.abs(pointer.x - cx), Math.abs(pointer.y - cy) * aspect);
  return { ...style, center: { ...style.center }, width: clamp((2 * halfW) / output.width, PIP_WIDTH_MIN, PIP_WIDTH_MAX) };
}

/** Pan by a delta in camera pixels as SEEN (a mirrored picture flips x back). */
export function panFraming(style: PipStyle, deltaCameraPx: Point, camera: Size): PipFraming {
  const f = style.framing ?? DEFAULT_FRAMING;
  const dx = (style.mirror ? -deltaCameraPx.x : deltaCameraPx.x) / camera.width;
  const dy = deltaCameraPx.y / camera.height;
  return clampFraming({ x: f.x + dx, y: f.y + dy, zoom: f.zoom }, style.shape, camera);
}

export function zoomFraming(style: PipStyle, zoom: number, camera: Size): PipFraming {
  const f = style.framing ?? DEFAULT_FRAMING;
  return clampFraming({ ...f, zoom: clamp(zoom, 1, PIP_FRAMING_ZOOM_MAX) }, style.shape, camera);
}

/**
 * Which side of the stage an inspector over it opens on: AWAY from the PiP, so
 * the PiP stays pressable while the inspector is open (the default PiP sits in
 * the bottom-right, exactly where a panel anchored to the timecode row lands).
 * A PiP dead centre counts as the left half, so the panel goes right.
 */
export function inspectorSide(style: Pick<PipStyle, "center">): "left" | "right" {
  return style.center.x > 0.5 ? "left" : "right";
}

/** The inspector's left edge in screen px for that side, `gap` in from the stage's edge. */
export function inspectorLeftPx(stage: { left: number; right: number }, side: "left" | "right",
                                panelWidth: number, gap: number): number {
  return side === "left" ? stage.left + gap : stage.right - gap - panelWidth;
}
