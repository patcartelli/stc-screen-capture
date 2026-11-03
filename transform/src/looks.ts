/**
 * The looks catalogue (STC-608): the ONE place a look's colours live.
 *
 * Stills (`backgrounds.ts`, `still-decorate.ts`) and video framing
 * (`framing.ts`) wear the same looks. Each used to keep its own copy of the
 * fills, and the copies were held together by tests; now both READ this file,
 * so a colour is tuned once.
 *
 * ## A leaf, on purpose
 *
 * This module imports nothing. The Electron main process imports `framing.ts`
 * to validate a `framing` block, and `framing.ts` imports this, so anything
 * here that reached the DOM-typed code (`shot.ts`, `still-decorate.ts`) would
 * fail `tsconfig.node.json`. Fills are plain data for that reason.
 *
 * ## What lives here, and what does not
 *
 * Only the FILL of each look and the two shadow opacities that differ between
 * them. Padding, radius and shadow geometry are not shared: a still stores
 * points and video stores fractions of the short edge (see `backgrounds.ts`).
 * Values are provisional, judged on real captures.
 */

export type LookFill =
  | { kind: "solid"; color: string }
  | { kind: "linear"; colors: readonly string[]; angleDeg: number };

/** The looks that are a fill and nothing else. Wallpaper and Custom are not in it: they carry their own data. */
export type FillLookId = "clean" | "dark" | "solid" | "aurora" | "ember";

export const LOOK_FILLS: Readonly<Record<FillLookId, LookFill>> = {
  clean: { kind: "linear", colors: ["#e9edf2", "#cfd6e0"], angleDeg: 135 },
  dark: { kind: "linear", colors: ["#2a3040", "#0d1017"], angleDeg: 135 },
  solid: { kind: "solid", color: "#3b4252" },
  aurora: { kind: "linear", colors: ["#050a12", "#0d4a52", "#5b3fd1"], angleDeg: 135 },
  ember: { kind: "linear", colors: ["#12061a", "#7a1f5c", "#ff7a3d"], angleDeg: 160 },
};

/** The shadow opacity every look wears except Dark, which is deeper against a dark fill. */
export const BASE_SHADOW_OPACITY = 0.32;
export const DARK_SHADOW_OPACITY = 0.55;

/** A linear fill takes this many colour stops, inclusive. */
export const LINEAR_STOPS_MIN = 2;
export const LINEAR_STOPS_MAX = 8;
