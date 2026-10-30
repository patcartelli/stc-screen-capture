import {
  DEFAULT_SOLID_COLOR, FRAMING_PADDING_MAX, FRAMING_PRESETS, FRAMING_RADIUS_MAX, type Framing, type FramingBackground,
} from "@transform/framing";

/**
 * What the Frame section's Padding, Corners and Shadow rows mean (STC-604) —
 * pure, so the DOM only maps a control to one of these. framing.ts owns the
 * document and its bounds; an explicit field wins over the preset's, and none
 * set is the preset's own. Every result passes `framingProblem`.
 *
 * Padding and corners are fractions of the output's SHORT edge (framing.ts),
 * so the readouts take that edge to say pixels.
 */

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const framingPadding = (f: Framing): number => f.paddingPct ?? FRAMING_PRESETS[f.preset].paddingPct;
export const framingRadius = (f: Framing): number => f.radiusPct ?? FRAMING_PRESETS[f.preset].radiusPct;
const shadowOf = (f: Framing) => f.shadow ?? FRAMING_PRESETS[f.preset].shadow;

/** The shadow is on while it has any opacity. */
export const framingShadowOn = (f: Framing): boolean => shadowOf(f).opacity > 0;

export const withPadding = (f: Framing, pct: number): Framing =>
  ({ ...f, paddingPct: clamp(pct, 0, FRAMING_PADDING_MAX) });

export const withRadius = (f: Framing, pct: number): Framing =>
  ({ ...f, radiusPct: clamp(pct, 0, FRAMING_RADIUS_MAX) });

/**
 * Off keeps the shadow's shape and zeroes its opacity; on returns to the
 * preset's own shadow (an explicit one that is already visible is kept).
 */
export function withShadow(f: Framing, on: boolean): Framing {
  if (!on) return { ...f, shadow: { ...shadowOf(f), opacity: 0 } };
  if (f.shadow && f.shadow.opacity > 0) return f;
  const next = { ...f };
  delete next.shadow;
  return next;
}

/** Corners in output pixels, for the readout. */
export const radiusPx = (f: Framing, shortEdge: number): number => Math.round(framingRadius(f) * shortEdge);

/**
 * The Colour row (STC-604, from the Figma Frame frame): one swatch for every
 * style. For Solid it is the fill; for Clean and Dark, which paint a two-stop
 * gradient, it is the FIRST colour of that gradient, the second and the angle
 * left as they are. The explicit `background` field is what holds it (the
 * document's own rule: an explicit field wins over the preset's), so there is
 * no schema change and a preset that is never edited stays exactly the preset.
 */
function backgroundOf(f: Framing): FramingBackground {
  return f.background
    ?? (f.preset === "solid"
      ? { kind: "solid", color: f.color ?? DEFAULT_SOLID_COLOR }
      : FRAMING_PRESETS[f.preset].background);
}

/** The colour the swatch shows: the fill, or the gradient's first stop. */
export function framingColor(f: Framing): string {
  const bg = backgroundOf(f);
  return bg.kind === "solid" ? bg.color : bg.colors[0];
}

/**
 * `f` with the swatch's colour changed. Solid with no explicit background is
 * written the way it always was (`color`); anything else writes `background`,
 * keeping a gradient's second colour and angle.
 */
export function withColor(f: Framing, hex: string): Framing {
  if (f.preset === "solid" && !f.background) return { ...f, color: hex };
  const bg = backgroundOf(f);
  const background: FramingBackground = bg.kind === "solid"
    ? { kind: "solid", color: hex }
    : { kind: "linear", colors: [hex, bg.colors[1]], angleDeg: bg.angleDeg };
  return { ...f, background };
}
