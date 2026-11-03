import { customBackground, LOOKS } from "@transform/backgrounds";
import {
  DEFAULT_SOLID_COLOR, FRAMING_PADDING_MAX, FRAMING_PRESETS, FRAMING_RADIUS_MAX, type Framing, type FramingBackground,
} from "@transform/framing";
import { BASE_SHADOW_OPACITY, DARK_SHADOW_OPACITY, LOOK_FILLS, type LookFill } from "@transform/looks";

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
 *
 * STC-608 replaces this row with the Look row (`VIDEO_LOOKS`, `withLook`,
 * `withCustom` below): the stills' looks, and Custom for any colour of one's
 * own. `framingColor`/`withColor` stay only until their last caller goes.
 */
export function backgroundOf(f: Framing): FramingBackground {
  return f.background
    ?? (f.preset === "solid"
      ? { kind: "solid", color: f.color ?? DEFAULT_SOLID_COLOR }
      : FRAMING_PRESETS[f.preset].background);
}

/** The colour the swatch shows: the fill, or the gradient's first stop. */
export function framingColor(f: Framing): string {
  const bg = backgroundOf(f);
  return bg.kind === "solid" ? bg.color : bg.colors[0]!;
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
    : { kind: "linear", colors: [hex, ...bg.colors.slice(1)], angleDeg: bg.angleDeg };
  return { ...f, background };
}

/**
 * The Look row (STC-608): the same looks a still wears, as video framing.
 * Picking one writes an EXPLICIT `background` copied from the catalogue, so
 * the document says what it paints and a later retune of the catalogue does
 * not move a take already framed. Aurora and Ember have no preset of their
 * own and ride on `clean`. "None" is no framing at all; "Custom" is any other
 * solid or two-stop fill, and is never a pick here (`withCustom` writes it).
 */
export type VideoLookId = "none" | "clean" | "dark" | "solid" | "aurora" | "ember" | "custom";

const stillLabel = (id: string): string => LOOKS.find((l) => l.id === id)!.label;

/** Spec order. Labels are the stills' own; video's first look is None. */
export const VIDEO_LOOKS: readonly { id: VideoLookId; label: string; fill?: LookFill }[] = [
  { id: "none", label: "None" },
  ...(["clean", "dark", "solid", "aurora", "ember"] as const).map((id) =>
    ({ id, label: stillLabel(id), fill: LOOK_FILLS[id] })),
  { id: "custom", label: stillLabel("custom") },
];

const fillAsBackground = (f: LookFill): FramingBackground =>
  f.kind === "linear"
    ? { kind: "linear", colors: [...f.colors], angleDeg: f.angleDeg }
    : { kind: "solid", color: f.color };

const sameFill = (a: FramingBackground, b: LookFill): boolean =>
  a.kind === "solid"
    ? b.kind === "solid" && a.color === b.color
    : b.kind === "linear" && a.angleDeg === b.angleDeg
      && a.colors.length === b.colors.length && a.colors.every((c, i) => c === b.colors[i]);

/**
 * `was` wearing look `id`. None removes the framing. Otherwise the look's fill
 * replaces the background (and any Solid `color`); padding and corners stay.
 * Shadow: one switched off stays off through every pick; otherwise Dark
 * writes its deeper shadow and any other look drops back to the preset's.
 */
export function withLook(was: Framing | undefined, id: Exclude<VideoLookId, "custom">): Framing | undefined {
  if (id === "none") return undefined;
  const { color: _color, shadow: _shadow, ...rest } = was ?? { preset: "clean" as const };
  const next: Framing = {
    ...rest,
    preset: id === "dark" || id === "solid" ? id : "clean",
    background: fillAsBackground(LOOK_FILLS[id]),
  };
  if (was && !framingShadowOn(was)) next.shadow = was.shadow;
  else if (id === "dark") next.shadow = { ...FRAMING_PRESETS.dark.shadow };
  return next;
}

/** `was` with a Custom fill: its preset, padding, corners and shadow are kept. */
export function withCustom(was: Framing | undefined, background: FramingBackground): Framing {
  const { color: _color, ...rest } = was ?? { preset: "clean" as const };
  return { ...rest, background };
}

/** The Custom row's fill from what was typed: the still's own rule and refusal, in framing's shape. */
export function customFraming(first: string, second?: string):
  { ok: true; background: FramingBackground } | { ok: false; reason: string } {
  const r = customBackground(first, second);
  if (!r.ok) return r;
  const b = r.background;
  return b.kind === "linear"
    ? { ok: true, background: { kind: "linear", colors: [...b.colors!], angleDeg: b.angleDeg! } }
    : { ok: true, background: { kind: "solid", color: b.colors![0]! } };
}

/**
 * Which swatch shows selected. A look matches on its FILL and, while the
 * shadow is on, on its shadow's opacity too (Dark's is deeper), so a Dark
 * with the shadow switched off is still Dark and a Clean fill under Dark's
 * shadow is not. No match: a solid or two-stop fill is Custom; a fill the row
 * cannot show (a retuned three-stop one) selects nothing.
 */
export function videoLookOf(f: Framing | undefined): VideoLookId | undefined {
  if (!f) return "none";
  const bg = backgroundOf(f);
  const opacity = shadowOf(f).opacity;
  for (const look of VIDEO_LOOKS) {
    if (!look.fill || !sameFill(bg, look.fill)) continue;
    const own = look.id === "dark" ? DARK_SHADOW_OPACITY : BASE_SHADOW_OPACITY;
    if (opacity === 0 || opacity === own) return look.id;
  }
  return bg.kind === "solid" || bg.colors.length === 2 ? "custom" : undefined;
}
