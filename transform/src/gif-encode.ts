// transform/src/gif-encode.ts
/**
 * The GIF encoder (STC-395): RGBA frames in, bytes out. Pure, so it is tested
 * in Node; the render window does the canvas readback.
 *
 * - ONE global palette, quantized from sample frames spread across the take
 *   (`buildPalette`). Per-frame palettes flicker, and screen content has few
 *   colours.
 * - Dither ONLY smooth gradients (`ditherSmooth`): a 4x4 ordered (Bayer) offset
 *   on pixels whose largest step to a neighbour is small but real
 *   (SMOOTH_MIN..SMOOTH_MAX) and that have no edge anywhere in their 3x3
 *   neighbourhood. Text, edges and icons (a big step, and the ring around one,
 *   which covers an anti-aliased fringe), flat fills (no step) and codec noise
 *   on a flat fill (a step of 1) are indexed exactly as they are, so they stay
 *   crisp and clean. Ordered, not error-diffusion: the offset depends only on
 *   (x, y), and whether a pixel is dithered only on its own 3x3 neighbourhood,
 *   so an unchanged pixel in an unchanged neighbourhood gets the same index
 *   every frame and the transparency diff below still works. A static gradient
 *   pixel next to something that MOVES can switch between dithered and not for
 *   a frame (deterministic by position AND neighbourhood); that costs a few
 *   bytes at a moving edge, never a shimmer.
 * - From frame 1 on, a pixel whose palette index is the same as the previous
 *   frame's is written as the reserved transparent index, with disposal 1
 *   ("leave in place"). On a screen recording most of the screen is still most
 *   of the time; this is the largest size saving available.
 * - Loops forever.
 */
import { GIFEncoder, quantize, applyPalette } from "gifenc";

export type Palette = number[][];

/** Leaves index 255 free for the transparent slot. */
const MAX_COLOURS = 255;

export function buildPalette(samples: readonly Uint8ClampedArray[]): Palette {
  if (samples.length === 0) throw new Error("buildPalette: no frames to sample");
  const total = samples.reduce((n, s) => n + s.length, 0);
  const all = new Uint8ClampedArray(total);
  let at = 0;
  for (const s of samples) { all.set(s, at); at += s.length; }
  const p = quantize(all, MAX_COLOURS) as Palette;
  return p.length > 0 ? p : [[0, 0, 0]];
}

/**
 * STARTING VALUES, to be tuned by eye in runbook §2; none of the three is derived.
 *
 * SMOOTH_MIN / SMOOTH_MAX: the range of a pixel's largest per-channel step to a
 * 4-neighbour that counts as a smooth gradient (shadows, soft fills, wallpaper).
 * Below SMOOTH_MIN is a flat fill, or a flat fill carrying decode noise: real
 * frames are decoded H.264 and canvas-downscaled, so "flat" UI sits at a step
 * of 0-1 across whole surfaces, and dithering that is grain and bytes, not a
 * smoother picture. Above SMOOTH_MAX is an edge: text, icons, borders.
 */
export const SMOOTH_MIN = 2;
export const SMOOTH_MAX = 12;
/**
 * Peak-to-peak size of the ordered-dither offset, in 8-bit levels, added equally
 * to R, G and B. Chosen by eye on a real take (2026-10-09, frame 240 of the
 * Discord-over-dark-wallpaper take) after Patrick judged 16 as not subtle
 * enough: 16, 12, 10 and 8 were compared against no dither. The band edges
 * stay softened at every value, but the stipple on the near-flat dark areas
 * between them gets steadily fainter down to 8, at a little banding's cost.
 * 8 is about +-4 levels, under half a palette step on a gradient.
 */
export const DITHER_SPREAD = 8;
/** 4x4 Bayer matrix, row-major by (y & 3, x & 3). */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/**
 * Whole-level offsets, centred on zero: (b - 7.5) * SPREAD / 16 truncated toward
 * zero gives -3..3 at SPREAD 8 (-7..7 at 16), symmetric. Half-levels would be resolved by the
 * clamped array's round-half-to-even, which favours even levels.
 */
const DITHER_OFFSET = Int16Array.from(BAYER4, (b) => Math.trunc(((b - 7.5) * DITHER_SPREAD) / 16));

/**
 * Write `src` into `out` with the ordered-dither offset added to every smooth
 * pixel: SMOOTH_MIN <= d <= SMOOTH_MAX (d measured on `src`) and no pixel in its
 * 3x3 neighbourhood has d > SMOOTH_MAX. `step` and `near` are scratch, one byte
 * per pixel each. Returns how many pixels were dithered. Pure in its inputs: the
 * same frame always gives the same output.
 */
export function ditherSmooth(src: Uint8ClampedArray, w: number, h: number,
                             out: Uint8ClampedArray, step: Uint8Array, near: Uint8Array): number {
  step.fill(0);
  const diff = (a: number, b: number) => Math.max(
    Math.abs(src[a]! - src[b]!), Math.abs(src[a + 1]! - src[b + 1]!), Math.abs(src[a + 2]! - src[b + 2]!));
  // Each neighbour pair once: right, then down; both pixels take the max.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      if (x + 1 < w) {
        const d = diff(p * 4, (p + 1) * 4);
        if (d > step[p]!) step[p] = d;
        if (d > step[p + 1]!) step[p + 1] = d;
      }
      if (y + 1 < h) {
        const q = p + w;
        const d = diff(p * 4, q * 4);
        if (d > step[p]!) step[p] = d;
        if (d > step[q]!) step[q] = d;
      }
    }
  }
  // near = max step over the row neighbours (x-1..x+1); the 3x3 max is then
  // the max of `near` over y-1..y+1, read in the final pass. Separable, O(pixels).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      let m = step[p]!;
      if (x > 0 && step[p - 1]! > m) m = step[p - 1]!;
      if (x + 1 < w && step[p + 1]! > m) m = step[p + 1]!;
      near[p] = m;
    }
  }
  out.set(src);
  let n = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w, by = (y & 3) * 4;
    for (let x = 0; x < w; x++) {
      const p = row + x, d = step[p]!;
      if (d < SMOOTH_MIN || d > SMOOTH_MAX) continue;
      if (near[p]! > SMOOTH_MAX || (y > 0 && near[p - w]! > SMOOTH_MAX) ||
          (y + 1 < h && near[p + w]! > SMOOTH_MAX)) continue;
      const o = DITHER_OFFSET[by + (x & 3)]!, i = p * 4;
      out[i] = src[i]! + o; out[i + 1] = src[i + 1]! + o; out[i + 2] = src[i + 2]! + o;   // clamped by the array
      n++;
    }
  }
  return n;
}

/** How much of the GIF was dithered: a measurement, so SMOOTH_MIN/MAX are tuned on numbers. */
export interface DitherStats {
  /** Fraction of frame 0's pixels dithered. */
  firstFrame: number;
  /** Fraction of all pixels of all frames written so far. */
  overall: number;
}

export interface GifWriterOptions {
  /** Ordered dither on smooth gradients (default true). Off is for comparison only. */
  dither?: boolean;
}

export class GifWriter {
  private readonly gif = GIFEncoder();
  private readonly full: Palette;
  private readonly transparentIndex: number;
  private prev: Uint8Array | null = null;
  private n = 0;
  /** Reused every frame. Each owns its WHOLE buffer: gifenc's applyPalette reads `rgba.buffer`. */
  private readonly scratch: Uint8ClampedArray | null;
  private readonly step: Uint8Array | null;
  private readonly near: Uint8Array | null;
  private dithered = 0;
  private ditheredFirst = 0;

  constructor(readonly width: number, readonly height: number,
              private readonly palette: Palette, private readonly delaysCs: readonly number[],
              opts: GifWriterOptions = {}) {
    this.transparentIndex = palette.length;            // ≤ 255 by construction
    this.full = [...palette, [0, 0, 0]];
    const dither = opts.dither ?? true;
    this.scratch = dither ? new Uint8ClampedArray(width * height * 4) : null;
    this.step = dither ? new Uint8Array(width * height) : null;
    this.near = dither ? new Uint8Array(width * height) : null;
  }

  get frameCount(): number { return this.n; }

  get ditherStats(): DitherStats {
    const px = this.width * this.height;
    return { firstFrame: this.n > 0 ? this.ditheredFirst / px : 0,
             overall: this.n > 0 ? this.dithered / (px * this.n) : 0 };
  }

  addFrame(rgba: Uint8ClampedArray): void {
    if (rgba.length !== this.width * this.height * 4) {
      throw new Error(`GifWriter: frame size ${rgba.length} is not ${this.width}x${this.height} RGBA`);
    }
    if (this.n >= this.delaysCs.length) {
      throw new Error(`GifWriter: more frames than the ${this.delaysCs.length} delays given`);
    }
    let src = rgba;
    if (this.scratch && this.step && this.near) {
      const k = ditherSmooth(rgba, this.width, this.height, this.scratch, this.step, this.near);
      if (this.n === 0) this.ditheredFirst = k;
      this.dithered += k;
      src = this.scratch;
    }
    // Index against the palette WITHOUT the transparent slot, so no real pixel lands on it.
    const index = applyPalette(src, this.palette) as Uint8Array;
    const out = index.slice();
    const first = this.prev === null;
    if (!first) {
      const prev = this.prev!;
      for (let i = 0; i < out.length; i++) if (index[i] === prev[i]) out[i] = this.transparentIndex;
    }
    this.gif.writeFrame(out, this.width, this.height, {
      // gifenc takes MILLISECONDS and writes round(ms / 10) centiseconds.
      delay: this.delaysCs[this.n]! * 10,
      ...(first ? { palette: this.full, repeat: 0 } : {}),
      ...(first ? {} : { transparent: true, transparentIndex: this.transparentIndex }),
      dispose: 1,
    });
    this.prev = index;
    this.n++;
  }

  finish(): Uint8Array {
    if (this.n !== this.delaysCs.length) {
      throw new Error(`GifWriter: ${this.n} of ${this.delaysCs.length} frames were written`);
    }
    this.gif.finish();
    return this.gif.bytes();
  }
}
