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
