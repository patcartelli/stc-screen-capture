import { describe, test, expect } from "vitest";
import { probePng, probeMp4, MP4_TAIL_PROBE_BYTES } from "../src/media-probe.js";

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, data: number[]) => [...be32(8 + data.length), ...chars(type), ...data];

function png(w: number, h: number): Uint8Array {
  const ihdr = [...be32(w), ...be32(h), 8, 6, 0, 0, 0];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(ihdr.length), ...chars("IHDR"), ...ihdr, 0, 0, 0, 0]);
}

/** timescale 600, duration 3000 → 5000 ms; track 1920x1080. */
function mp4(): Uint8Array {
  const mvhd = box("mvhd", [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(600), ...be32(3000)]);
  const tkhd = box("tkhd", [
    0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(1), ...be32(0), ...be32(0),
    ...new Array(8).fill(0), 0, 0, 0, 0, 0, 0, 0, 0,
    ...new Array(36).fill(0),
    ...be32(1920 * 65536), ...be32(1080 * 65536),
  ]);
  return new Uint8Array([...box("ftyp", chars("isom")), ...box("mdat", [1, 2, 3, 4]),
    ...box("moov", [...mvhd, ...box("trak", tkhd)])]);
}

describe("media probe", () => {
  test("png dimensions come from IHDR", () => {
    expect(probePng(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  test("mp4 duration and dimensions", () => {
    expect(probeMp4(mp4())).toEqual({ width: 1920, height: 1080, durationMs: 5000 });
  });

  test("a foreign file we cannot parse probes to undefined, never a throw", () => {
    for (const bad of [new Uint8Array(0), new Uint8Array([1, 2, 3]),
                       new Uint8Array(chars("not a media file at all"))]) {
      expect(() => probePng(bad)).not.toThrow();
      expect(() => probeMp4(bad)).not.toThrow();
      expect(probePng(bad)).toBeUndefined();
      expect(probeMp4(bad)).toBeUndefined();
    }
  });

  test("an mp4 with no moov yields undefined rather than zeroes", () => {
    const noMoov = new Uint8Array([...box("ftyp", chars("isom")), ...box("mdat", [1, 2])]);
    expect(probeMp4(noMoov)).toBeUndefined();
  });

  test("the tail probe window is big enough for a real moov", () => {
    // A 4K take's moov is tens of KB; 64 KB is the declared window.
    expect(MP4_TAIL_PROBE_BYTES).toBeGreaterThanOrEqual(64 * 1024);
  });

  test("THE REAL FIXTURE PROBES — its mdat uses a largesize", async () => {
    // The check that matters. A walker refusing `size == 1` stops at mdat and
    // never reaches moov, so this returns undefined for every capture this app
    // has ever produced. fixtures/basic/display.mp4 is real AVAssetWriter
    // output and reproduces that on the first try.
    const { readFile } = await import("node:fs/promises");
    const bytes = new Uint8Array(await readFile("fixtures/basic/display.mp4"));
    const facts = probeMp4(bytes);
    expect(facts).toBeDefined();
    expect(facts!.width).toBeGreaterThan(0);
    expect(facts!.height).toBeGreaterThan(0);
    expect(facts!.durationMs).toBeGreaterThan(0);
  });
});
