// Vendored from patcartelli/studio-cartelli, src/lib/gradient-mesh-cpu.ts, as of commit 3ea1d6b
// (STC-610, PRs #779 and #790) — NOT imported: the two are separate repos
// with no package published between them, the same arrangement as
// transform/src/frame-diff-rule.ts. Ported into Capture's still pipeline by
// STC-622. A re-sync is a deliberate, by-hand decision, never a silent drift.
//
// Changed on the way in, and nothing else: import specifiers end in .js
// rather than .ts, because this repo's tsconfig resolves the bundler way
// without allowImportingTsExtensions.
//
// A TEST REFERENCE ONLY, here and upstream: the shader is the renderer (the
// CPU costs 3.4 s at 4K against the GPU's 23 ms, docs/stc-610-decision.md).
// It lives under transform/test/ so nothing in src/ can reach for it. Its
// imports point back up into transform/src/ for the same reason.
//
// ── upstream file, verbatim from here ─────────────────────────────────────
//
// STC-610 session 2: the whole mesh on the CPU, line for line from
// MESH_FRAG in gradient-mesh-gl.ts.
//
// It exists to answer question 1 — can a Canvas 2D still pipeline, which
// promises preview equals export, carry this background without a GPU — by
// measurement: how close it lands to the shader, and what it costs. It is
// not wired into anything.
//
// The noise is seeded-noise.ts, which the shader is already held to. The
// rest runs in float64 where the shader runs in float32; the grain's hash is
// emulated in float32 (Math.fround) because a fract() of a product that size
// is decided by the low bits.

import { TABLE_SEED, createNoise } from '../src/seeded-noise.js';
import { foldScaleFor, type Point } from '../src/gradient-mesh-params.js';
import type { RenderInput } from '../src/gradient-mesh-gl.js';

/** Matches NOISE_GAIN in gradient-mesh-gl.ts. */
const GAIN = 2.0;
const f = Math.fround;

type Vec3 = [number, number, number];

function hexToRgb(hex: string): Vec3 {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Vec3;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function fract(x: number): number {
  return x - Math.floor(x);
}

/** The shader's grain hash, in float32 so the low bits behave the same. */
function hash(px: number, py: number): number {
  let x = f(fract(f(px * f(123.34))));
  let y = f(fract(f(py * f(456.21))));
  const d = f(f(x * f(x + f(45.32))) + f(y * f(y + f(45.32))));
  x = f(x + d);
  y = f(y + d);
  return f(fract(f(x * y)));
}

/**
 * RGBA8, BOTTOM row first — the order readPixels returns, so the two can be
 * compared byte for byte without a flip.
 */
export interface CpuRenderOptions {
  /**
   * Ordered 4x4 Bayer dither before the 8-bit rounding — the same matrix as
   * bayer-photo-dither.ts, applied as a ±half-step offset per channel rather
   * than a 1-bit threshold. For question 3 only.
   */
  dither?: 'bayer';
}

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16 - 0.5));

export function renderMeshCpu(
  input: RenderInput,
  width: number,
  height: number,
  options: CpuRenderOptions = {},
): Uint8ClampedArray {
  const noise = createNoise(TABLE_SEED);
  const nz = (x: number, y: number) => noise.fbm2(x, y, 3) * GAIN;
  const [c0, c1, c2] = input.palette.map(hexToRgb) as [Vec3, Vec3, Vec3];
  const t = input.t;
  const aspect = width / height;
  const foldScale = foldScaleFor(input.scale);

  const drift: Point[] = [
    [0.1 * Math.sin(t * 0.11), 0.08 * Math.cos(t * 0.13)],
    [0.08 * Math.cos(t * 0.09 + 1), 0.1 * Math.sin(t * 0.12 + 2)],
    [0.12 * Math.sin(t * 0.07 + 3), 0.08 * Math.cos(t * 0.1 + 1)],
    [0.06 * Math.cos(t * 0.08 + 4), 0.06 * Math.sin(t * 0.09)],
  ];
  const pts = input.points.map((b, i) => [b[0] + drift[i]![0], b[1] + drift[i]![1]] as Point);
  const cols: Vec3[] = [c2, c1, c0, c0];
  const sheenTint: Vec3 = [0, 1, 2].map((k) => c1[k]! * 0.4 + c2[k]! * 0.6 + 0.15) as Vec3;

  const out = new Uint8ClampedArray(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const u = (px + 0.5) / width;
      const v = (py + 0.5) / height;
      const sx = u * aspect * input.scale + input.offset[0];
      const sy = v * input.scale + input.offset[1];
      const wx = nz(sx, sy + t * 0.05);
      const wy = nz(sx + 5.2 - t * 0.04, sy + 1.3);
      const qx = u + wx * input.warp;
      const qy = v + wy * input.warp;

      let r = 0, g = 0, b = 0, ws = 0;
      for (let i = 0; i < 4; i++) {
        const dx = (qx - pts[i]![0]) * aspect;
        const dy = qy - pts[i]![1];
        const w = 1 / Math.pow(dx * dx + dy * dy + 0.02, 1.6);
        r += cols[i]![0] * w;
        g += cols[i]![1] * w;
        b += cols[i]![2] * w;
        ws += w;
      }
      r /= ws; g /= ws; b /= ws;

      if (input.sheen > 0) {
        const fold = nz(sx * foldScale + wx * 1.2 + t * 0.03, sy * foldScale + wy * 1.2 + t * 0.03);
        const sheen = smoothstep(0.05, 0.6, fold);
        const k = sheen * 0.28 * (0.4 + Math.hypot(r, g, b)) * input.sheen;
        r += sheenTint[0] * k;
        g += sheenTint[1] * k;
        b += sheenTint[2] * k;
        const dim = (1 - smoothstep(-0.5, -0.1, fold)) * input.sheen;
        r = r + (r * 0.85 - r) * dim;
        g = g + (g * 0.85 - g) * dim;
        b = b + (b * 0.85 - b) * dim;
      }

      r = c1[0] + (r - c1[0]) * input.valueRange;
      g = c1[1] + (g - c1[1]) * input.valueRange;
      b = c1[2] + (b - c1[2]) * input.valueRange;

      if (input.grain) {
        const n = (hash(px + 0.5, py + 0.5) - 0.5) * 0.035;
        r += n; g += n; b += n;
      }

      if (options.dither === 'bayer') {
        const d = BAYER[py & 3]![px & 3]! / 255;
        r += d; g += d; b += d;
      }

      const o = (py * width + px) * 4;
      out[o] = Math.round(Math.min(1, Math.max(0, r)) * 255);
      out[o + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
      out[o + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}
