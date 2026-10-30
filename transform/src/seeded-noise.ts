// Vendored from patcartelli/studio-cartelli, src/lib/seeded-noise.ts, as of commit 3ea1d6b
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
// Seeded 2D gradient noise — the CPU reference for STC-610's GLSL port.
//
// perlin-noise.ts already has this math, but it shuffles its table with
// Math.random() at module load, so it has no seed and nothing to compare a
// shader against. It is also what bayer-photo-dither.ts imports, and the
// gallery's look depends on it as it is, so this lives beside it rather
// than replacing it.
//
// Every intermediate goes through Math.fround: the shader computes in
// float32, and an f64 reference disagrees with it over arithmetic rather
// than over the rule (STC-320 found exactly that).

const f = Math.fround;

/** The table every mesh uses. A shot's own seed moves points and offset, never this. */
export const TABLE_SEED = 0x5ca1ab1e;

/** Small, fast, deterministic PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Fisher–Yates shuffle of 0..255, doubled to 512 so lookups never wrap. */
export function permutation(seed: number): Uint8Array {
  const rand = mulberry32(seed >>> 0);
  const source = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [source[i], source[j]] = [source[j]!, source[i]!];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = source[i & 255]!;
  return perm;
}

export interface SeededNoise {
  perm: Uint8Array;
  /** Roughly -1…1; exactly 0 on integer lattice points. */
  perlin2(x: number, y: number): number;
  /** Fractal sum: amplitude 0.5, frequency ×2 per octave. */
  fbm2(x: number, y: number, octaves?: number): number;
}

function fade(t: number): number {
  return f(f(f(t * t) * t) * f(f(t * f(f(t * 6) - 15)) + 10));
}

function lerp(a: number, b: number, t: number): number {
  return f(a + f(f(b - a) * t));
}

function grad2(hash: number, x: number, y: number): number {
  const h = hash & 3;
  const u = h < 2 ? x : y;
  const v = h < 2 ? y : x;
  return f(((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v));
}

export function createNoise(seed: number): SeededNoise {
  const perm = permutation(seed);

  function perlin2(x: number, y: number): number {
    x = f(x);
    y = f(y);
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const xi = fx & 255;
    const yi = fy & 255;
    const xf = f(x - fx);
    const yf = f(y - fy);
    const u = fade(xf);
    const v = fade(yf);

    const aa = perm[perm[xi]! + yi]!;
    const ab = perm[perm[xi]! + yi + 1]!;
    const ba = perm[perm[xi + 1]! + yi]!;
    const bb = perm[perm[xi + 1]! + yi + 1]!;

    const x1 = lerp(grad2(aa, xf, yf), grad2(ba, f(xf - 1), yf), u);
    const x2 = lerp(grad2(ab, xf, f(yf - 1)), grad2(bb, f(xf - 1), f(yf - 1)), u);
    return lerp(x1, x2, v);
  }

  function fbm2(x: number, y: number, octaves = 3): number {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1;
    for (let i = 0; i < octaves; i++) {
      value = f(value + f(perlin2(f(x * frequency), f(y * frequency)) * amplitude));
      amplitude *= 0.5;
      frequency *= 2;
    }
    return value;
  }

  return { perm, perlin2, fbm2 };
}
