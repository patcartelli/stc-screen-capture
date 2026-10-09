// transform/src/gif-encode.ts
/**
 * The GIF encoder (STC-395): RGBA frames in, bytes out. Pure, so it is tested
 * in Node; the render window does the canvas readback.
 *
 * - ONE global palette, quantized from sample frames spread across the take
 *   (`buildPalette`). Per-frame palettes flicker, and screen content has few
 *   colours.
 * - Dither ONLY smooth gradients (`ditherSmooth`): a 4x4 ordered (Bayer) offset
 *   on pixels whose largest step to a neighbour is small but not zero. Text,
 *   edges and icons (a big step) and flat fills (no step) are indexed exactly
 *   as they are, so they stay crisp and clean. Ordered, not error-diffusion:
 *   the offset depends only on (x, y), so an unchanged pixel gets the same
 *   index every frame and the transparency diff below still works, and nothing
 *   shimmers between frames.
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
 * The largest per-channel step to a 4-neighbour at or below which a pixel counts
 * as part of a smooth gradient (shadows, soft fills, wallpaper). Above it is an
 * edge: text, icons, borders. TUNED BY EYE (runbook §2), not derived.
 */
export const SMOOTH_MAX = 12;
/**
 * Peak-to-peak size of the ordered-dither offset, in 8-bit levels, added equally
 * to R, G and B. TUNED BY EYE. Starting value: a 255-colour palette over a
 * screen take spends most of its entries on UI greys and accents, so a gradient
 * typically sees palette neighbours ~16-32 levels apart; an offset spanning ±8
 * (about half that step) moves a pixel across at most one band boundary, which
 * breaks the band edge into a pattern without adding visible grain.
 */
export const DITHER_SPREAD = 16;
/** 4x4 Bayer matrix, row-major by (y & 3, x & 3). */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const DITHER_OFFSET = BAYER4.map((b) => (b / 16 - 0.5 + 1 / 32) * DITHER_SPREAD);

/**
 * Write `src` into `out` with the ordered-dither offset added to every smooth
 * pixel (0 < d <= SMOOTH_MAX, d measured on `src`). `step` is scratch, one byte
 * per pixel. Pure in its inputs: the same frame always gives the same output.
 */
export function ditherSmooth(src: Uint8ClampedArray, w: number, h: number,
                             out: Uint8ClampedArray, step: Uint8Array): void {
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
  out.set(src);
  for (let y = 0; y < h; y++) {
    const row = y * w, by = (y & 3) * 4;
    for (let x = 0; x < w; x++) {
      const d = step[row + x]!;
      if (d === 0 || d > SMOOTH_MAX) continue;
      const o = DITHER_OFFSET[by + (x & 3)]!, i = (row + x) * 4;
      out[i] = src[i]! + o; out[i + 1] = src[i + 1]! + o; out[i + 2] = src[i + 2]! + o;   // clamped by the array
    }
  }
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

  constructor(readonly width: number, readonly height: number,
              private readonly palette: Palette, private readonly delaysCs: readonly number[],
              opts: GifWriterOptions = {}) {
    this.transparentIndex = palette.length;            // ≤ 255 by construction
    this.full = [...palette, [0, 0, 0]];
    const dither = opts.dither ?? true;
    this.scratch = dither ? new Uint8ClampedArray(width * height * 4) : null;
    this.step = dither ? new Uint8Array(width * height) : null;
  }

  get frameCount(): number { return this.n; }

  addFrame(rgba: Uint8ClampedArray): void {
    if (rgba.length !== this.width * this.height * 4) {
      throw new Error(`GifWriter: frame size ${rgba.length} is not ${this.width}x${this.height} RGBA`);
    }
    if (this.n >= this.delaysCs.length) {
      throw new Error(`GifWriter: more frames than the ${this.delaysCs.length} delays given`);
    }
    let src = rgba;
    if (this.scratch && this.step) {
      ditherSmooth(rgba, this.width, this.height, this.scratch, this.step);
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
