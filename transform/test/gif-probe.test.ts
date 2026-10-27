import { describe, test, expect } from "vitest";
import { buildPalette, GifWriter } from "../src/gif-encode.js";
import { probeGif } from "../src/gif-probe.js";

const W = 24, H = 10;
function solid(r: number, g: number, b: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) a.set([r, g, b, 255], i * 4);
  return a;
}

/** A real GIF from this repo's own encoder: the probe must read what the app writes. */
function encode(delaysCs: number[]): Uint8Array {
  const frames = delaysCs.map((_, i) => solid(i * 40, 255 - i * 40, 128));
  const w = new GifWriter(W, H, buildPalette(frames), delaysCs);
  for (const f of frames) w.addFrame(f);
  return w.finish();
}

describe("probeGif (STC-592)", () => {
  test("reads size, frame count and duration from the app's own GIF", () => {
    expect(probeGif(encode([7, 6, 7, 7]))).toEqual({ width: W, height: H, frames: 4, durationMs: 270 });
  });

  test("a delay of 0 counts as the 10 cs a viewer plays it at", () => {
    const bytes = encode([7, 7]);
    // Rewrite every Graphic Control Extension's delay to 0.
    for (let i = 0; i + 5 < bytes.length; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 4) { bytes[i + 4] = 0; bytes[i + 5] = 0; }
    }
    expect(probeGif(bytes)?.durationMs).toBe(200);
  });

  test("a truncated GIF keeps its size and has no duration", () => {
    const whole = encode([7, 7, 7]);
    const cut = probeGif(whole.slice(0, whole.length - 20));
    expect(cut).toMatchObject({ width: W, height: H });
    expect(cut?.durationMs).toBeUndefined();
    expect(probeGif(whole)?.durationMs).toBe(210);   // control: the same file whole has one
  });

  test("anything that is not a GIF is undefined", () => {
    expect(probeGif(new Uint8Array(0))).toBeUndefined();
    expect(probeGif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
  });
});
