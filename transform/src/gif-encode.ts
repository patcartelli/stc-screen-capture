// transform/src/gif-encode.ts
/**
 * The GIF encoder (STC-395): RGBA frames in, bytes out. Pure, so it is tested
 * in Node; the render window does the canvas readback.
 *
 * - ONE global palette, quantized from sample frames spread across the take
 *   (`buildPalette`). Per-frame palettes flicker, and screen content has few
 *   colours.
 * - No dithering: dither makes UI text and flat fills noisy.
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

export class GifWriter {
  private readonly gif = GIFEncoder();
  private readonly full: Palette;
  private readonly transparentIndex: number;
  private prev: Uint8Array | null = null;
  private n = 0;

  constructor(readonly width: number, readonly height: number,
              private readonly palette: Palette, private readonly delaysCs: readonly number[]) {
    this.transparentIndex = palette.length;            // ≤ 255 by construction
    this.full = [...palette, [0, 0, 0]];
  }

  get frameCount(): number { return this.n; }

  addFrame(rgba: Uint8ClampedArray): void {
    if (rgba.length !== this.width * this.height * 4) {
      throw new Error(`GifWriter: frame size ${rgba.length} is not ${this.width}x${this.height} RGBA`);
    }
    if (this.n >= this.delaysCs.length) {
      throw new Error(`GifWriter: more frames than the ${this.delaysCs.length} delays given`);
    }
    // Index against the palette WITHOUT the transparent slot, so no real pixel lands on it.
    const index = applyPalette(rgba, this.palette) as Uint8Array;
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
