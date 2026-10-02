import type { Rect, Size } from "./spaces.js";

/**
 * Video framing (STC-396): static chrome around a moving picture — a
 * background, padding, rounded corners and a shadow — decided without a canvas.
 *
 * Same split the rest of this project uses (see `still-decorate.ts`, whose
 * stills this carries over from): this module works out WHERE the picture sits
 * and how big the chrome is, `render()` carries the answer in `FrameState`,
 * and `compositor.ts` draws it and decides nothing.
 *
 * ## An INSET, not a bigger canvas — and why that is the opposite of a still
 *
 * A still grows its canvas around a capture drawn at natural size. Video
 * cannot: H.264 and Chrome's decoder cap at 3840x2160, a 4K take is already at
 * the cap, and `output-size.ts` owns the even-dimension rule. So the output
 * size is whatever was chosen and the recording is fitted INSIDE it. The cost
 * is that text gets smaller, which `legibility.ts` accounts for through
 * `contentFraction`.
 *
 * ## Fractions of the SHORT EDGE
 *
 * Padding, radius and shadow are fractions of the output's short edge, never a
 * pixel count: the same document at 4K and at Embed size has to look the same.
 *
 * ## The values are provisional
 *
 * Like the stills' presets, these are reasoned rather than made — chosen by
 * looking at real exports on a Mac (docs/STC-396-RUNBOOK.md). Every parameter
 * is stored in the document and overridable; none has its own control yet.
 */

export type FramingPreset = "clean" | "dark" | "solid";

export type FramingBackground =
  | { kind: "solid"; color: string }
  | { kind: "linear"; colors: [string, string]; angleDeg: number };

export interface FramingShadow { offsetYPct: number; blurPct: number; opacity: number }

export interface Framing {
  preset: FramingPreset;
  /** Solid preset only: the fill. Ignored when `background` is given. */
  color?: string;
  paddingPct?: number;
  radiusPct?: number;
  shadow?: FramingShadow;
  background?: FramingBackground;
}

export interface FramingLayout {
  /** Where the recording is drawn, in output pixels, whole numbers. */
  content: Rect;
  radius: number;
  /** In output pixels. `blur` is the value for canvas `shadowBlur`. */
  shadow: { offsetY: number; blur: number; opacity: number };
  background: FramingBackground;
}

export const FRAMING_PADDING_MAX = 0.25;
export const FRAMING_RADIUS_MAX = 0.1;
export const DEFAULT_SOLID_COLOR = "#3b4252";

const SHADOW: FramingShadow = { offsetYPct: 0.012, blurPct: 0.03, opacity: 0.32 };

export const FRAMING_PRESETS: Readonly<Record<FramingPreset, {
  paddingPct: number; radiusPct: number; shadow: FramingShadow; background: FramingBackground;
}>> = {
  clean: {
    paddingPct: 0.06, radiusPct: 0.012, shadow: { ...SHADOW },
    background: { kind: "linear", colors: ["#e9edf2", "#cfd6e0"], angleDeg: 135 },
  },
  dark: {
    paddingPct: 0.06, radiusPct: 0.012, shadow: { ...SHADOW, opacity: 0.55 },
    background: { kind: "linear", colors: ["#2a3040", "#0d1017"], angleDeg: 135 },
  },
  solid: {
    paddingPct: 0.06, radiusPct: 0.012, shadow: { ...SHADOW },
    background: { kind: "solid", color: DEFAULT_SOLID_COLOR },
  },
};

// ---------------------------------------------------------------------------
// validation — one owner, used by trim.ts (drops) and main.ts (refuses)
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;
const TOP_KEYS = new Set(["preset", "color", "paddingPct", "radiusPct", "shadow", "background"]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const inRange = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const onlyKeys = (o: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(o).every((k) => keys.includes(k));

/** The reason a `framing` value is not acceptable, or undefined when it is. */
export function framingProblem(raw: unknown): string | undefined {
  if (!isObj(raw)) return "framing must be an object";
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) return `framing has an unknown field "${k}"`;
  }
  if (raw.preset !== "clean" && raw.preset !== "dark" && raw.preset !== "solid") {
    return 'framing.preset must be "clean", "dark" or "solid"';
  }
  if (raw.color !== undefined && !(typeof raw.color === "string" && HEX.test(raw.color))) {
    return "framing.color must be #rrggbb";
  }
  if (raw.paddingPct !== undefined && !inRange(raw.paddingPct, 0, FRAMING_PADDING_MAX)) {
    return `framing.paddingPct must be a number in 0..${FRAMING_PADDING_MAX}`;
  }
  if (raw.radiusPct !== undefined && !inRange(raw.radiusPct, 0, FRAMING_RADIUS_MAX)) {
    return `framing.radiusPct must be a number in 0..${FRAMING_RADIUS_MAX}`;
  }
  if (raw.shadow !== undefined) {
    const s = raw.shadow;
    if (!isObj(s) || !onlyKeys(s, ["offsetYPct", "blurPct", "opacity"])
        || !inRange(s.offsetYPct, 0, 0.1) || !inRange(s.blurPct, 0, 0.2) || !inRange(s.opacity, 0, 1)) {
      return "framing.shadow must be { offsetYPct 0..0.1, blurPct 0..0.2, opacity 0..1 }";
    }
  }
  if (raw.background !== undefined) {
    const b = raw.background;
    const solid = isObj(b) && b.kind === "solid" && onlyKeys(b, ["kind", "color"])
      && typeof b.color === "string" && HEX.test(b.color);
    const linear = isObj(b) && b.kind === "linear" && onlyKeys(b, ["kind", "colors", "angleDeg"])
      && Array.isArray(b.colors) && b.colors.length === 2
      && b.colors.every((c) => typeof c === "string" && HEX.test(c))
      && inRange(b.angleDeg, -360, 360);
    if (!solid && !linear) return "framing.background must be a solid or two-stop linear fill";
  }
  return undefined;
}

/** A `framing` the loader can trust, or undefined — a bad block must not cost the take. */
export function cleanFraming(raw: unknown): Framing | undefined {
  return framingProblem(raw) === undefined ? (raw as Framing) : undefined;
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

/**
 * Where the picture goes inside `output`, and how big the chrome is.
 *
 * `captureAspect` is the capture's width/height. The picture is fitted
 * (aspect kept, centred) inside the output minus the padding, so an output of
 * another aspect letterboxes into the background rather than stretching.
 *
 * Padding is clamped so at least 2 px of picture remain on the short axis, and
 * the shadow's reach (1.5x blur plus the offset — canvas `shadowBlur` is a
 * Gaussian with sigma = blur/2, dead by three sigma) is scaled down to fit the
 * padding. The latter is a CORRECTNESS bound: a shadow wider than its padding
 * is cut off by the canvas edge and reads as a hard band, which is exactly what
 * the stills gate caught in STC-291.
 */
export function framingLayout(
  framing: Framing | undefined, output: Size, captureAspect: number,
): FramingLayout | undefined {
  if (!framing || !(captureAspect > 0)) return undefined;
  const p = FRAMING_PRESETS[framing.preset];
  const paddingPct = framing.paddingPct ?? p.paddingPct;
  const radiusPct = framing.radiusPct ?? p.radiusPct;
  const shadowIn = framing.shadow ?? p.shadow;
  const background: FramingBackground = framing.background
    ?? (framing.preset === "solid"
      ? { kind: "solid", color: framing.color ?? DEFAULT_SOLID_COLOR }
      : p.background);

  const short = Math.min(output.width, output.height);
  const pad = Math.max(0, Math.min(Math.round(short * paddingPct), Math.floor((short - 2) / 2)));

  let blur = short * shadowIn.blurPct;
  let offsetY = short * shadowIn.offsetYPct;
  const reach = blur * 1.5 + Math.abs(offsetY);
  if (reach > pad) {
    const k = reach > 0 ? pad / reach : 0;
    blur *= k;
    offsetY *= k;
  }

  const availW = output.width - 2 * pad;
  const availH = output.height - 2 * pad;
  let width: number;
  let height: number;
  if (availW / availH > captureAspect) {
    height = availH;
    width = Math.round(height * captureAspect);
  } else {
    width = availW;
    height = Math.round(width / captureAspect);
  }
  width = Math.max(2, Math.min(width, availW));
  height = Math.max(2, Math.min(height, availH));

  const content: Rect = {
    x: Math.round((output.width - width) / 2),
    y: Math.round((output.height - height) / 2),
    width,
    height,
  };
  const radius = Math.min(Math.round(short * radiusPct), Math.floor(Math.min(width, height) / 2));
  return { content, radius, shadow: { offsetY, blur, opacity: shadowIn.opacity }, background };
}

/**
 * Canvas `createLinearGradient` endpoints for a CSS-style angle: 0 is
 * bottom-to-top, 90 left-to-right, 135 top-left to bottom-right, the line
 * passing through the centre and long enough that the corners take the end
 * stops exactly.
 */
export function gradientLine(angleDeg: number, w: number, h: number):
  { x0: number; y0: number; x1: number; y1: number } {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const cx = w / 2;
  const cy = h / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

/**
 * The picture's share of the output's width: 1 with no framing. What
 * `legibility.ts` multiplies by, because inset text is smaller by exactly this.
 */
export function contentFraction(
  framing: Framing | undefined, output: Size, captureAspect: number,
): number {
  const l = framingLayout(framing, output, captureAspect);
  return l ? l.content.width / output.width : 1;
}
