// transform/test/gif-encode.test.ts
import { describe, test, expect } from "vitest";
import { GifReader } from "omggif";
import { buildPalette, GifWriter } from "../src/gif-encode.js";

const W = 16, H = 8;
function solid(r: number, g: number, b: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) a.set([r, g, b, 255], i * 4);
  return a;
}
function withBox(base: Uint8ClampedArray, x0: number, y0: number, rgb: [number, number, number]) {
  const a = base.slice();
  for (let y = y0; y < y0 + 2; y++) for (let x = x0; x < x0 + 2; x++) a.set([...rgb, 255], (y * W + x) * 4);
  return a;
}
/** Composite every frame the way a viewer does (disposal 1: keep the previous). */
function playAll(bytes: Uint8Array): Uint8ClampedArray[] {
  const r = new GifReader(bytes);
  const canvas = new Uint8ClampedArray(r.width * r.height * 4);
  const out: Uint8ClampedArray[] = [];
  for (let i = 0; i < r.numFrames(); i++) {
    r.decodeAndBlitFrameRGBA(i, canvas);   // leaves transparent pixels untouched
    out.push(canvas.slice());
  }
  return out;
}

describe("GifWriter", () => {
  const white = solid(255, 255, 255);
  const frames = [white, withBox(white, 2, 2, [255, 0, 0]), withBox(white, 10, 4, [0, 0, 255])];
  const palette = buildPalette(frames);

  function encode(fs = frames, delays = [7, 6, 7]) {
    const w = new GifWriter(W, H, palette, delays);
    for (const f of fs) w.addFrame(f);
    return w.finish();
  }

  test("is a looping GIF89a of the right size and frame count", () => {
    const bytes = encode();
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe("GIF89a");
    const r = new GifReader(bytes);
    expect([r.width, r.height, r.numFrames()]).toEqual([W, H, 3]);
    expect(r.loopCount()).toBe(0);                       // 0 = forever
  });

  test("delays are written as given, in centiseconds", () => {
    const r = new GifReader(encode());
    expect([0, 1, 2].map((i) => r.frameInfo(i).delay)).toEqual([7, 6, 7]);
  });

  test("one global palette, no local tables", () => {
    const r = new GifReader(encode());
    for (let i = 0; i < r.numFrames(); i++) expect(r.frameInfo(i).palette_offset).toBe(13);
  });

  test("unchanged pixels are transparent after frame 0, and frame 0 has none", () => {
    const r = new GifReader(encode());
    expect(r.frameInfo(0).transparent_index).toBe(null);
    expect(r.frameInfo(1).transparent_index).not.toBe(null);
    expect(r.frameInfo(1).disposal).toBe(1);
  });

  test("played back, every frame matches its input exactly (flat colours are in the palette)", () => {
    const played = playAll(encode());
    played.forEach((p, i) => expect(Buffer.from(p).equals(Buffer.from(frames[i]!))).toBe(true));
  });

  test("a single frame is a valid GIF (Review Focus 2)", () => {
    const w = new GifWriter(W, H, buildPalette([white]), [10]);
    w.addFrame(white);
    expect(new GifReader(w.finish()).numFrames()).toBe(1);
  });

  test("refuses a frame of the wrong size and a frame past the delay list", () => {
    const w = new GifWriter(W, H, palette, [10]);
    expect(() => w.addFrame(new Uint8ClampedArray(4))).toThrow(/size/);
    w.addFrame(white);
    expect(() => w.addFrame(white)).toThrow(/more frames/);
  });

  test("finish refuses a GIF missing frames, rather than writing a short one", () => {
    const w = new GifWriter(W, H, palette, [10, 10]);
    w.addFrame(white);
    expect(() => w.finish()).toThrow(/1 of 2/);
  });
});

describe("buildPalette", () => {
  test("at most 255 colours, leaving a slot for transparency", () => {
    const noisy = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 2654435761) >>> 24;
    expect(buildPalette([noisy]).length).toBeLessThanOrEqual(255);
  });
  test("refuses no samples", () => {
    expect(() => buildPalette([])).toThrow(/no frames/);
  });
});

describe("gradient-only dither", () => {
  const GW = 128, GH = 4;
  /** A palette with a 16-level grey step, twice DITHER_SPREAD: what a real 255-colour palette spent mostly elsewhere looks like to one gradient. */
  const greys: number[][] = [];
  for (let v = 0; v <= 240; v += 16) greys.push([v, v, v]);
  greys.push([255, 255, 255]);
  function frameOf(w: number, h: number, px: (x: number, y: number) => number): Uint8ClampedArray {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = px(x, y);
      a.set([v, v, v, 255], (y * w + x) * 4);
    }
    return a;
  }
  function encodeWith(w: number, h: number, palette: number[][], fs: Uint8ClampedArray[], dither: boolean) {
    const g = new GifWriter(w, h, palette, fs.map(() => 10), { dither });
    for (const f of fs) g.addFrame(f);
    return g.finish();
  }
  /** Frame `i`'s grey level per pixel (each palette entry is a distinct grey, so this IS its index). */
  function greysOf(bytes: Uint8Array, i: number): number[] {
    const r = new GifReader(bytes);
    const rgba = new Uint8ClampedArray(r.width * r.height * 4);
    r.decodeAndBlitFrameRGBA(i, rgba);
    return Array.from({ length: r.width * r.height }, (_, p) => rgba[p * 4]!);
  }
  function longestRun(row: number[]): number {
    let best = 1, run = 1;
    for (let i = 1; i < row.length; i++) { run = row[i] === row[i - 1] ? run + 1 : 1; best = Math.max(best, run); }
    return best;
  }
  /** Played back (disposal 1), every frame. */
  function playedWith(fs: Uint8ClampedArray[], palette: number[][], dither: boolean) {
    return playAll(encodeWith(GW, GH, palette, fs, dither));
  }
  const same = (a: ArrayLike<number> & ArrayBufferView, b: ArrayLike<number> & ArrayBufferView) => Buffer.from(a).equals(Buffer.from(b));
  function transitions(row: number[]): number {
    let n = 0;
    for (let i = 1; i < row.length; i++) if (row[i] !== row[i - 1]) n++;
    return n;
  }
  // 0..254, two levels per pixel: a step of 2, inside SMOOTH_MIN..SMOOTH_MAX.
  const gradient = frameOf(GW, GH, (x) => 2 * x);

  test("a flat fill and hard-edged text encode byte-identically with dither on and off", () => {
    const flat = frameOf(GW, GH, () => 200);
    const text = frameOf(GW, GH, (x, y) => ((x >> 2) % 3 === 0 && y > 0 ? 0 : 255));   // black glyph blocks on white
    for (const f of [flat, text]) {
      const p = buildPalette([f]);
      expect(Buffer.from(encodeWith(GW, GH, p, [f, f], true))
        .equals(Buffer.from(encodeWith(GW, GH, p, [f, f], false)))).toBe(true);
    }
  });

  test("a smooth gradient bands less with dither on than off", () => {
    const on = greysOf(encodeWith(GW, GH, greys, [gradient], true), 0);
    const off = greysOf(encodeWith(GW, GH, greys, [gradient], false), 0);
    const row = (a: number[], y: number) => a.slice(y * GW, (y + 1) * GW);
    for (let y = 0; y < GH; y++) expect(longestRun(row(off, y))).toBeGreaterThanOrEqual(8);     // posterized: 8-px bands
    // Band edges become a pattern: with dither off every row steps at the same x; with it on the Bayer rows stagger them.
    const edges = (a: number[]) => new Set(Array.from({ length: GH }, (_, y) => {
      const r = row(a, y);
      return r.findIndex((v, i) => i > 0 && v !== r[i - 1]);
    }));
    expect(edges(off).size).toBe(1);
    expect(edges(on).size).toBeGreaterThan(1);
  });

  test("dither is deterministic: a repeated gradient frame is entirely transparent", () => {
    const r = new GifReader(encodeWith(GW, GH, greys, [gradient, gradient], true));
    expect(r.frameInfo(1).transparent_index).not.toBe(null);
    const canvas = new Uint8ClampedArray(GW * GH * 4).fill(7);
    r.decodeAndBlitFrameRGBA(1, canvas);            // transparent pixels leave the canvas untouched
    expect(canvas.every((v) => v === 7)).toBe(true);
  });

  test("codec noise on a flat fill (a step of 1) is not dithered", () => {
    // Decoded H.264 + a canvas downscale: "flat" UI wobbles by a level.
    const noisy = frameOf(GW, GH, (x, y) => 200 + (((x * 7 + y * 13) % 5) < 2 ? 1 : 0));
    for (const palette of [buildPalette([noisy]), greys]) {
      expect(same(encodeWith(GW, GH, palette, [noisy, noisy], true),
                  encodeWith(GW, GH, palette, [noisy, noisy], false))).toBe(true);
    }
  });

  test("an anti-aliased glyph edge is not ringed with dither", () => {
    // A light background, then a soft edge 200 -> 190 -> 128 -> 0 into a black stem,
    // and back out. The background pixel beside the faint 190 fringe has a step of
    // 10, inside SMOOTH_MIN..SMOOTH_MAX; only the 3x3 edge check keeps it clean.
    // Not white: gifenc indexes through an RGB565 key, so 248..255 share one bucket
    // and a dithered white could never change index, hiding the ring.
    const edge = [200, 190, 128, 0, 0, 0, 128, 190];
    const glyph = frameOf(GW, GH, (x) => (x >= 40 && x < 48 ? edge[x - 40]! : 200));
    for (const palette of [buildPalette([glyph]), greys]) {
      expect(same(encodeWith(GW, GH, palette, [glyph, glyph], true),
                  encodeWith(GW, GH, palette, [glyph, glyph], false))).toBe(true);
    }
  });

  test("a gradient, then a different flat frame: the flat frame plays back the same with dither on and off", () => {
    const flat = frameOf(GW, GH, () => 96);
    const on = playedWith([gradient, flat], greys, true);
    const off = playedWith([gradient, flat], greys, false);
    expect(same(on[1]!, off[1]!)).toBe(true);
    expect(same(on[1]!, flat)).toBe(true);
  });

  test("writer reports how much it dithered, and nothing with dither off", () => {
    const g = new GifWriter(GW, GH, greys, [10, 10], { dither: true });
    g.addFrame(gradient); g.addFrame(frameOf(GW, GH, () => 96));
    const s = g.ditherStats;
    expect(s.firstFrame).toBeGreaterThan(0.9);       // all but the frame's own border-free gradient
    expect(s.overall).toBeCloseTo(s.firstFrame / 2, 5);
    const off = new GifWriter(GW, GH, greys, [10], { dither: false });
    off.addFrame(gradient);
    expect(off.ditherStats).toEqual({ firstFrame: 0, overall: 0 });
  });
});
