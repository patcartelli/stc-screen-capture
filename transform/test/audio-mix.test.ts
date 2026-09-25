import { describe, test, expect } from "vitest";
import {
  MIX_SAMPLE_RATE, MIX_CHANNELS, mixBlock, mixFrameCount, trackFromChunks,
  type PcmChunk, type PcmTrack,
} from "../src/audio-mix.js";

const f32 = (...v: number[]) => Float32Array.from(v);
/** A track at MIX_SAMPLE_RATE starting at `startNs`. */
const track = (startNs: number, ...channels: Float32Array[]): PcmTrack =>
  ({ startNs, sampleRate: MIX_SAMPLE_RATE, channels });
const NS_PER_SAMPLE = 1e9 / MIX_SAMPLE_RATE; // 20833.33…

describe("trackFromChunks", () => {
  test("lays chunks end to end by their own timestamps", () => {
    const us = (n: number) => (n * 1e6) / MIX_SAMPLE_RATE;
    const chunks: PcmChunk[] = [
      { timestampUs: us(0), sampleRate: MIX_SAMPLE_RATE, channels: [f32(1, 2)] },
      { timestampUs: us(2), sampleRate: MIX_SAMPLE_RATE, channels: [f32(3, 4)] },
    ];
    const t = trackFromChunks(chunks, "t")!;
    expect(Array.from(t.channels[0]!)).toEqual([1, 2, 3, 4]);
    expect(t.startNs).toBe(0);
  });

  test("a gap between chunks (a pause) is silence, not packed away", () => {
    const us = (n: number) => (n * 1e6) / MIX_SAMPLE_RATE;
    const t = trackFromChunks([
      { timestampUs: us(0), sampleRate: MIX_SAMPLE_RATE, channels: [f32(1)] },
      { timestampUs: us(3), sampleRate: MIX_SAMPLE_RATE, channels: [f32(2)] },
    ], "t")!;
    expect(Array.from(t.channels[0]!)).toEqual([1, 0, 0, 2]);
  });

  test("chunks arriving out of order are placed by time", () => {
    const us = (n: number) => (n * 1e6) / MIX_SAMPLE_RATE;
    const t = trackFromChunks([
      { timestampUs: us(1), sampleRate: MIX_SAMPLE_RATE, channels: [f32(2)] },
      { timestampUs: us(0), sampleRate: MIX_SAMPLE_RATE, channels: [f32(1)] },
    ], "t")!;
    expect(Array.from(t.channels[0]!)).toEqual([1, 2]);
  });

  test("no chunks is no track", () => {
    expect(trackFromChunks([], "t")).toBeNull();
  });

  test("a non-uniform track is refused by name, never guessed at", () => {
    expect(() => trackFromChunks([
      { timestampUs: 0, sampleRate: 48_000, channels: [f32(0)] },
      { timestampUs: 100, sampleRate: 48_000, channels: [f32(0), f32(0)] },
    ], "mic.m4a")).toThrow(/mic\.m4a: decoded chunks are not uniform/);
  });
});

describe("mixFrameCount", () => {
  test("one second is MIX_SAMPLE_RATE frames; an empty or inverted window is 0", () => {
    expect(mixFrameCount(0, 1e9)).toBe(MIX_SAMPLE_RATE);
    expect(mixFrameCount(5e8, 5e8)).toBe(0);
    expect(mixFrameCount(1e9, 0)).toBe(0);
  });
});

describe("mixBlock", () => {
  test("always stereo at MIX_SAMPLE_RATE's grid", () => {
    const out = mixBlock({ mic: null, system: null, systemLevel: 1, originNs: 0, from: 0, frames: 4 });
    expect(out).toHaveLength(MIX_CHANNELS);
    expect(Array.from(out[0]!)).toEqual([0, 0, 0, 0]);
  });

  test("the exact path: a 48 kHz track at full level reaches the output sample for sample", () => {
    const L = f32(0.1, -0.2, 0.3), R = f32(0.4, 0.5, -0.6);
    const out = mixBlock({ mic: null, system: track(0, L, R), systemLevel: 1, originNs: 0, from: 0, frames: 3 });
    expect(Array.from(out[0]!)).toEqual(Array.from(L));
    expect(Array.from(out[1]!)).toEqual(Array.from(R));
  });

  test("system × level + mic, per sample", () => {
    const sys = track(0, f32(0.5, 0.5), f32(-0.5, -0.5));
    const mic = track(0, f32(0.1, 0.2));
    const out = mixBlock({ mic, system: sys, systemLevel: 0.5, originNs: 0, from: 0, frames: 2 });
    expect(out[0]![0]).toBeCloseTo(0.1 + 0.25, 6);
    expect(out[0]![1]).toBeCloseTo(0.2 + 0.25, 6);
    expect(out[1]![0]).toBeCloseTo(0.1 - 0.25, 6);
  });

  test("a mono mic is heard in BOTH channels", () => {
    const out = mixBlock({ mic: track(0, f32(0.3)), system: null, systemLevel: 1, originNs: 0, from: 0, frames: 1 });
    expect(out[0]![0]).toBeCloseTo(0.3, 6);
    expect(out[1]![0]).toBeCloseTo(0.3, 6);
  });

  test("level 0 mutes system audio and leaves the mic alone", () => {
    const out = mixBlock({
      mic: track(0, f32(0.2)), system: track(0, f32(0.9), f32(0.9)),
      systemLevel: 0, originNs: 0, from: 0, frames: 1,
    });
    expect(out[0]![0]).toBeCloseTo(0.2, 6);
    expect(out[1]![0]).toBeCloseTo(0.2, 6);
  });

  test("attenuate only: a level above 1 (a hand-edited document) is clamped, never a boost", () => {
    const sys = track(0, f32(0.25), f32(0.25));
    const out = mixBlock({ mic: null, system: sys, systemLevel: 3, originNs: 0, from: 0, frames: 1 });
    expect(out[0]![0]).toBeCloseTo(0.25, 6);
    const neg = mixBlock({ mic: null, system: sys, systemLevel: -1, originNs: 0, from: 0, frames: 1 });
    expect(neg[0]![0]).toBe(0);
    const nan = mixBlock({ mic: null, system: sys, systemLevel: NaN, originNs: 0, from: 0, frames: 1 });
    expect(nan[0]![0]).toBeCloseTo(0.25, 6);
  });

  test("the plain sum is hard-limited at full scale — no headroom scaling below it", () => {
    const out = mixBlock({
      mic: track(0, f32(0.8, -0.8, 0.4)), system: track(0, f32(0.8, -0.8, 0.4), f32(0.8, -0.8, 0.4)),
      systemLevel: 1, originNs: 0, from: 0, frames: 3,
    });
    expect(out[0]![0]).toBe(1);
    expect(out[0]![1]).toBe(-1);
    // Below full scale the sum is NOT scaled down.
    expect(out[0]![2]).toBeCloseTo(0.8, 6);
  });

  test("placement: a track that starts later is silent before its first sample", () => {
    const later = track(2 * NS_PER_SAMPLE, f32(0.5), f32(0.5));
    const out = mixBlock({ mic: null, system: later, systemLevel: 1, originNs: 0, from: 0, frames: 4 });
    expect(Array.from(out[0]!)).toEqual([0, 0, 0.5, 0]);
  });

  test("the export window: origin inside the take skips everything before it", () => {
    const sys = track(0, f32(0.1, 0.2, 0.3, 0.4), f32(0.1, 0.2, 0.3, 0.4));
    const out = mixBlock({ mic: null, system: sys, systemLevel: 1, originNs: 2 * NS_PER_SAMPLE, from: 0, frames: 3 });
    expect(Array.from(out[0]!).map((v) => +v.toFixed(6))).toEqual([0.3, 0.4, 0]);
  });

  test("blocks join seamlessly — mixing in two halves equals mixing at once", () => {
    const n = 2000;
    const a = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.4);
    const b = Float32Array.from({ length: n }, (_, i) => Math.cos(i / 11) * 0.3);
    const sys = track(1234.5, a, a), mic = track(5678.9, b);
    const args = { mic, system: sys, systemLevel: 0.7, originNs: 10_000 };
    const whole = mixBlock({ ...args, from: 0, frames: 1500 });
    const h1 = mixBlock({ ...args, from: 0, frames: 1024 });
    const h2 = mixBlock({ ...args, from: 1024, frames: 476 });
    for (let ch = 0; ch < 2; ch++) {
      expect(Array.from(h1[ch]!)).toEqual(Array.from(whole[ch]!.subarray(0, 1024)));
      expect(Array.from(h2[ch]!)).toEqual(Array.from(whole[ch]!.subarray(1024)));
    }
  });

  test("a 44.1 kHz mic is resampled onto the 48 kHz grid (linear), not played fast", () => {
    // A ramp: value = its own time in seconds. Resampled correctly, output
    // frame i must read ≈ i / 48000 — played at the wrong rate it would read
    // i / 44100, 9% fast.
    const rate = 44_100;
    const ramp = Float32Array.from({ length: rate }, (_, i) => i / rate);
    const mic: PcmTrack = { startNs: 0, sampleRate: rate, channels: [ramp] };
    const out = mixBlock({ mic, system: null, systemLevel: 1, originNs: 0, from: 0, frames: 48_000 });
    for (const i of [0, 1, 4800, 24_000, 47_000]) {
      expect(out[0]![i]).toBeCloseTo(i / MIX_SAMPLE_RATE, 4);
    }
  });
});
