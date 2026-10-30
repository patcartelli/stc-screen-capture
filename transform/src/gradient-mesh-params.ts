// Vendored from patcartelli/studio-cartelli, src/lib/gradient-mesh-params.ts, as of commit 3ea1d6b
// (STC-610, PRs #779 and #790) — NOT imported: the two are separate repos
// with no package published between them, the same arrangement as
// transform/src/frame-diff-rule.ts. Ported into Capture's still pipeline by
// STC-622. A re-sync is a deliberate, by-hand decision, never a silent drift.
//
// Changed on the way in, and nothing else: import specifiers end in .js
// rather than .ts, because this repo's tsconfig resolves the bundler way
// without allowImportingTsExtensions.
//
// ── upstream file, verbatim from here ─────────────────────────────────────
//
// STC-610: every decision the gradient mesh makes that is not a pixel.
//
// The looks Patrick picked, where a seed puts the colour points, what `calm`
// does, and how the surface settles. Pure and DOM-free, so
// scripts/check-gradient-mesh.mjs can hold it to arithmetic in node and the
// lab page and shader only draw what this file has already decided.

import { mulberry32 } from './seeded-noise.js';

/** UV, y up, 0..1. */
export type Point = [number, number];
export type Look = 'folded' | 'glossy';
export type PaletteName = 'aurora' | 'ember';

/** Darkest first: [dark, mid, bright]. STC-599's house looks. */
export const PALETTES: Record<PaletteName, [string, string, string]> = {
  aurora: ['#050a12', '#0d4a52', '#5b3fd1'],
  ember: ['#12061a', '#7a1f5c', '#ff7a3d'],
};

export interface LookParams {
  warp: number;
  scale: number;
  /** 0 = no light on the folds (C), 1 = full gloss (D2). */
  sheen: number;
  grain: boolean;
}

/**
 * C ("folded", the lead) and D2 ("glossy", the secondary), as approved
 * against the mockups on 2026-10-29. They are no longer modes: Patrick
 * replaced the Folded/Glossy toggle with a Sheen slider (2026-10-29), so
 * these are two recorded points on continuous controls, and C is the
 * page's starting point.
 */
export const LOOKS: Record<Look, LookParams> = {
  folded: { warp: 0.18, scale: 1.4, sheen: 0, grain: false },
  glossy: { warp: 0.22, scale: 0.75, sheen: 1, grain: true },
};

/**
 * The sheen's fold field runs at this fraction of the warp's scale. Both
 * approved looks share it (C 1.3 / 1.4, D2 0.7 / 0.75). D's ripples were the
 * same ratio at scale 1.4; D2 fixed them by halving the scale and letting the
 * folds follow. So Scale alone sizes the folds.
 */
export const FOLD_RATIO = 0.93;

export function foldScaleFor(scale: number): number {
  return scale * FOLD_RATIO;
}

/** Point 0 is the bright stop, 1 the mid stop, 2 and 3 the dark stop. */
export interface Arrangement {
  points: [Point, Point, Point, Point];
  offset: Point;
}

/** Where a shot's seed puts the colours, and where it samples the noise. */
export function arrangementFor(seed: number): Arrangement {
  const rand = mulberry32(seed >>> 0);
  const inset = (): number => 0.05 + rand() * 0.9;
  const points: [Point, Point, Point, Point] = [
    [inset(), inset()],
    [inset(), inset()],
    [inset(), inset()],
    [inset(), inset()],
  ];
  const offset: Point = [rand() * 100, rand() * 100];
  return { points, offset };
}

/**
 * `calm` 0 is expressive, 1 is quiet: it pulls warp down and the value
 * range in toward the middle stop together. A starting mapping; the
 * session 1 findings retune it.
 */
export function applyCalm(warp: number, calm: number): { warp: number; valueRange: number } {
  const c = Math.min(1, Math.max(0, calm));
  return { warp: warp * (1 - 0.8 * c), valueRange: 1 - 0.6 * c };
}

export const SETTLE_MS = 2500;

/** Cubic ease-out from `from` to `to`, then hold. A function of elapsed time only. */
export function settle(from: number, to: number, elapsedMs: number, durationMs = SETTLE_MS): number {
  const k = Math.min(1, Math.max(0, elapsedMs / durationMs));
  if (k === 1) return to;
  return from + (to - from) * (1 - (1 - k) ** 3);
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** Exact at both ends, so a finished Shuffle lands on the seed's arrangement and not near it. */
export function lerpArrangement(a: Arrangement, b: Arrangement, k: number): Arrangement {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const p = (i: number): Point => [
    lerp(a.points[i]![0], b.points[i]![0], k),
    lerp(a.points[i]![1], b.points[i]![1], k),
  ];
  return {
    points: [p(0), p(1), p(2), p(3)],
    offset: [lerp(a.offset[0], b.offset[0], k), lerp(a.offset[1], b.offset[1], k)],
  };
}

export function clampPoint(p: Point): Point {
  return [Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1]))];
}

/**
 * Everything one still needs. `points: null` means untouched: the seed's
 * arrangement applies. The page's readout prints this, and it is session
 * 2's candidate for what shot.json stores.
 */
export interface MeshState {
  seed: number;
  palette: PaletteName;
  calm: number;
  sheen: number;
  warp: number;
  scale: number;
  grain: boolean;
  points: [Point, Point, Point, Point] | null;
  t: number;
}
