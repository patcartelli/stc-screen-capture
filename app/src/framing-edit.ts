import {
  FRAMING_PADDING_MAX, FRAMING_PRESETS, FRAMING_RADIUS_MAX, type Framing,
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
