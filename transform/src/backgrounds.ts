import { DEFAULT_SOLID_COLOR, FRAMING_PRESETS } from "./framing.js";
import type { Background, Decoration, DecorationMode, Shadow } from "./shot.js";
import { decorationForMode, PRESET_SHADOW } from "./still-decorate.js";

/**
 * The still editor's background picker (STC-599, phase A): which LOOKS a window
 * shot can wear, and what each one means in `shot.json`.
 *
 * ## One place to tune
 *
 * Every value a swatch stands for lives here and nowhere else. `clean`, `dark`
 * and `solid` are READ from `FRAMING_PRESETS` (STC-396), so the stills cannot
 * drift from the video Frame control's colours or the dark preset's shadow
 * opacity; the house looks (Aurora, Ember) are defined once, below. A look
 * costs the document nothing new: it is a `decoration.mode` plus, where the
 * mode's own default is not the look, an explicit `background` and `shadow` —
 * both already in shot-1, so no version bump (`shotForWrite` still decides).
 *
 * ## What the document stores
 *
 * Nothing names a look. A document says what it DRAWS (mode, background,
 * shadow), as it always has, and `lookOf` recovers which swatch that is by
 * comparing what the mode would draw. That keeps `shot.json` the artefact and
 * means a hand-edited document still renders as written; it simply selects no
 * swatch (or Custom) in the picker.
 *
 * ## Shadow units
 *
 * Stills store points (`PRESET_SHADOW`), video stores fractions of the short
 * edge. The picker takes only the OPACITY from video's preset, which is the one
 * part of its shadow that is unitless; the blur and offset stay the still's own.
 *
 * No DOM, no Electron.
 */

export type LookId =
  | "window-only" | "window-shadow"
  | "clean" | "dark" | "solid" | "aurora" | "ember"
  | "custom";

export interface Look {
  id: LookId;
  label: string;
  mode: DecorationMode;
  /** Undefined: the mode's own default (none for the window-only modes, `PRESET_BACKGROUND` for `clean`). */
  background?: Background;
  /** Undefined: the mode's own default shadow. */
  shadow?: Shadow;
}

/** The fixed-fill value of the Custom swatch before the user types anything. */
export const CUSTOM_START_COLOR = DEFAULT_SOLID_COLOR;
/** A custom two-colour fill runs at the same angle as video's clean/dark. */
export const CUSTOM_ANGLE_DEG = 135;

const darkShadow: Shadow = { ...PRESET_SHADOW, opacity: FRAMING_PRESETS.dark.shadow.opacity };

const fromFraming = (b: (typeof FRAMING_PRESETS)["clean"]["background"]): Background =>
  b.kind === "linear"
    ? { kind: "linear", colors: [...b.colors], angleDeg: b.angleDeg }
    : { kind: "solid", colors: [b.color] };

/**
 * The picker's swatches, in display order. Custom is last and its background
 * is supplied at selection time (`lookWrite`), so it carries none here.
 */
export const LOOKS: readonly Look[] = [
  { id: "window-only", label: "Window only", mode: "window-only" },
  { id: "window-shadow", label: "Window + shadow", mode: "window-shadow" },
  // No explicit background: the mode derives PRESET_BACKGROUND, which is
  // video's clean (held equal by a test), so a clean shot stays a plain one.
  { id: "clean", label: "Clean", mode: "window-shadow-background" },
  { id: "dark", label: "Dark", mode: "window-shadow-custom-background",
    background: fromFraming(FRAMING_PRESETS.dark.background), shadow: darkShadow },
  { id: "solid", label: "Solid", mode: "window-shadow-custom-background",
    background: fromFraming(FRAMING_PRESETS.solid.background) },
  // House looks (Capture's Slate + Brass family). Stills only until video's
  // validator takes more than two stops (STC-608). Provisional: judged on real
  // window captures, light and dark windows both.
  { id: "aurora", label: "Aurora", mode: "window-shadow-custom-background",
    background: { kind: "linear", colors: ["#050a12", "#0d4a52", "#5b3fd1"], angleDeg: 135 } },
  { id: "ember", label: "Ember", mode: "window-shadow-custom-background",
    background: { kind: "linear", colors: ["#12061a", "#7a1f5c", "#ff7a3d"], angleDeg: 160 } },
  { id: "custom", label: "Custom", mode: "window-shadow-custom-background" },
];

const HEX6 = /^#[0-9a-f]{6}$/i;

/** True for `#rrggbb` only — the picker's rule, tighter than `parseShot`'s (which also takes `#rrggbbaa`). */
export const isHexColor = (v: unknown): v is string => typeof v === "string" && HEX6.test(v);

export type CustomResult =
  | { ok: true; background: Background }
  | { ok: false; reason: string };

/**
 * The Custom swatch's fill: a solid from one colour, a two-stop linear from
 * two. A blank second colour means "no second colour". Anything that is not
 * `#rrggbb` is refused with a sentence, so a bad value never gets as far as
 * the wire.
 */
export function customBackground(first: string, second?: string): CustomResult {
  const a = first.trim();
  const b = (second ?? "").trim();
  if (!isHexColor(a)) return { ok: false, reason: `"${a}" is not a colour. Use #rrggbb.` };
  if (b === "") return { ok: true, background: { kind: "solid", colors: [a.toLowerCase()] } };
  if (!isHexColor(b)) return { ok: false, reason: `"${b}" is not a colour. Use #rrggbb.` };
  return {
    ok: true,
    background: { kind: "linear", colors: [a.toLowerCase(), b.toLowerCase()], angleDeg: CUSTOM_ANGLE_DEG },
  };
}

/**
 * What goes over the wire for a look: the mode and the two decoration fields
 * the picker owns. `null` means "this document carries none" — the handler
 * deletes the key — which is how choosing Clean after Dark gets rid of Dark's
 * explicit background rather than leaving it to win over the mode's default.
 */
export interface LookWrite {
  mode: DecorationMode;
  background: Background | null;
  shadow: Shadow | null;
}

export function lookWrite(look: Look, custom?: Background): LookWrite {
  const background = look.id === "custom" ? custom : look.background;
  return {
    mode: look.mode,
    background: background ? { ...background, ...(background.colors ? { colors: [...background.colors] } : {}) } : null,
    shadow: look.shadow ? { ...look.shadow } : null,
  };
}

/** The decoration fields a `LookWrite` replaces, applied to a decoration. Used by the preview and by the main-side merge alike. */
export function applyLook(decoration: Decoration, write: LookWrite): Decoration {
  const { background: _b, shadow: _s, ...rest } = decoration;
  return {
    ...rest,
    mode: write.mode,
    ...(write.background ? { background: write.background } : {}),
    ...(write.shadow ? { shadow: write.shadow } : {}),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check a `LookWrite` that crossed the process boundary. Shape only: the
 * values inside `background` and `shadow` are `parseShot`'s to judge, and it
 * runs on the merged document before anything is written. Throws a sentence.
 */
export function parseLookWrite(raw: unknown): LookWrite {
  if (!isObj(raw)) throw new Error("look must be an object");
  for (const k of Object.keys(raw)) {
    if (k !== "mode" && k !== "background" && k !== "shadow") throw new Error(`look has an unknown field "${k}"`);
  }
  const { mode, background, shadow } = raw;
  if (typeof mode !== "string") throw new Error("look.mode must be a string");
  if (background !== null && !isObj(background)) throw new Error("look.background must be an object or null");
  if (shadow !== null && !isObj(shadow)) throw new Error("look.shadow must be an object or null");
  return { mode: mode as DecorationMode, background: background as Background | null, shadow: shadow as Shadow | null };
}

const sameBackground = (a: Background | undefined, b: Background | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Which swatch a decoration is wearing, or undefined when it matches none.
 *
 * Compared on what the mode DRAWS (`decorationForMode` fills the defaults), not
 * on the raw fields, so an explicit `PRESET_BACKGROUND` reads as Clean and a
 * Clean with no field reads the same. A custom-background shot whose fill is a
 * solid or a two-stop linear that is no named look is Custom; anything else a
 * hand-edit can produce (radial, three stops that are not ours) selects nothing.
 */
export function lookOf(decoration: Decoration): LookId | undefined {
  const drawn = decorationForMode(decoration.mode, decoration);
  for (const look of LOOKS) {
    if (look.id === "custom" || look.mode !== decoration.mode) continue;
    const want = decorationForMode(look.mode, { background: look.background, shadow: look.shadow });
    if (sameBackground(drawn.background, want.background) && JSON.stringify(drawn.shadow ?? null) === JSON.stringify(want.shadow ?? null)) {
      return look.id;
    }
  }
  const bg = drawn.background;
  if (decoration.mode === "window-shadow-custom-background" && bg
      && ((bg.kind === "solid" && bg.colors?.length === 1)
          || (bg.kind === "linear" && bg.colors?.length === 2))
      && bg.colors.every(isHexColor)) {
    return "custom";
  }
  return undefined;
}
