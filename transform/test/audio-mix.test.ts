import { describe, test, expect } from "vitest";
import {
  MIX_SAMPLE_RATE, MIX_CHANNELS, mixBlock, mixFrameCount, trackFromChunks,
  LEVEL_FLOOR_DB, levelFromSliderPct, sliderPctFromLevel, exportAudioPlan,
  MIC_BOOST_DB, MIC_LEVEL_MAX, MIC_UNITY_PCT, micLevelFromSliderPct, sliderPctFromMicLevel, formatLevelDb,
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

describe("the level slider's decibel taper", () => {
  test("the ends: 0% is a true mute, 100% is untouched", () => {
    expect(levelFromSliderPct(0)).toBe(0);
    expect(levelFromSliderPct(100)).toBe(1);
  });

  test("the middle is in decibels, not linear: 50% is -20 dB, 30% is -28 dB", () => {
    const db = (g: number) => 20 * Math.log10(g);
    expect(db(levelFromSliderPct(50))).toBeCloseTo(-20, 6);
    expect(db(levelFromSliderPct(30))).toBeCloseTo(-28, 6);
    expect(db(levelFromSliderPct(1))).toBeCloseTo(LEVEL_FLOOR_DB * 0.99, 6);
    // The hardware complaint, pinned: 30% must be far quieter than the old
    // linear 0.3 (-10.5 dB) that still sounded loud.
    expect(levelFromSliderPct(30)).toBeLessThan(0.3 / 5);
  });

  test("monotonic: every step up the slider is louder", () => {
    for (let p = 1; p <= 100; p++) {
      expect(levelFromSliderPct(p)).toBeGreaterThan(levelFromSliderPct(p - 1));
    }
  });

  test("round trip: every slider position reopens where it was saved", () => {
    for (let p = 0; p <= 100; p++) expect(sliderPctFromLevel(levelFromSliderPct(p))).toBe(p);
  });

  test("a quiet-but-not-silent gain sits at 1%, never at mute; nonsense is mute or full", () => {
    expect(sliderPctFromLevel(1e-6)).toBe(1);
    expect(sliderPctFromLevel(0)).toBe(0);
    expect(sliderPctFromLevel(-1)).toBe(0);
    expect(sliderPctFromLevel(NaN)).toBe(0);
    expect(sliderPctFromLevel(5)).toBe(100);
    expect(levelFromSliderPct(NaN)).toBe(0);
  });
});

describe("exportAudioPlan: which path an export's audio takes", () => {
  const on = { enabled: true, strength: 0.5 }, off = { enabled: false, strength: 0.5 };

  test("a take that asked for neither cleanup nor system audio keeps the mic-only path", () => {
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: false })).toEqual({ path: "mic", cleanMic: false });
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, cleanup: off })).toEqual({ path: "mic", cleanMic: false });
  });

  test("cleanup on moves a mic-only take onto the mix path, cleaned", () => {
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, cleanup: on })).toEqual({ path: "mix", cleanMic: true });
  });

  test("cleanup on at strength 0 is off: an identity must not change the path", () => {
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, cleanup: { enabled: true, strength: 0 } }))
      .toEqual({ path: "mic", cleanMic: false });
  });

  test("system audio always mixes; cleanup decides only whether the mic is cleaned", () => {
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: true, cleanup: off })).toEqual({ path: "mix", cleanMic: false });
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: true, cleanup: on })).toEqual({ path: "mix", cleanMic: true });
  });

  test("no mic: cleanup has nothing to clean", () => {
    expect(exportAudioPlan({ encode: true, hasMic: false, hasSystem: false, cleanup: on })).toEqual({ path: "none", cleanMic: false });
    expect(exportAudioPlan({ encode: true, hasMic: false, hasSystem: true, cleanup: on })).toEqual({ path: "mix", cleanMic: false });
  });

  test("not encoding: no audio path at all", () => {
    expect(exportAudioPlan({ encode: false, hasMic: true, hasSystem: true, cleanup: on })).toEqual({ path: "none", cleanMic: false });
  });
});

describe("the mic level (STC-454 part 2)", () => {
  const db = (g: number) => 20 * Math.log10(g);

  test("mixBlock applies it to the mic only, and absent is as recorded", () => {
    const mic = track(0, f32(0.1));
    const sys = track(0, f32(0.2), f32(0.2));
    const base = { mic, system: sys, systemLevel: 1, originNs: 0, from: 0, frames: 1 };
    expect(mixBlock(base)[0]![0]).toBeCloseTo(0.3, 6);
    expect(mixBlock({ ...base, micLevel: 2 })[0]![0]).toBeCloseTo(0.4, 6);
    expect(mixBlock({ ...base, micLevel: 0 })[0]![0]).toBeCloseTo(0.2, 6);
  });

  test("it may BOOST, up to +12 dB and no further; nonsense is as recorded", () => {
    const mic = track(0, f32(0.1));
    const at = (micLevel: number) => mixBlock({ mic, system: null, systemLevel: 1, micLevel, originNs: 0, from: 0, frames: 1 })[0]![0]!;
    expect(at(MIC_LEVEL_MAX)).toBeCloseTo(0.1 * MIC_LEVEL_MAX, 5);
    expect(at(50)).toBeCloseTo(0.1 * MIC_LEVEL_MAX, 5);
    expect(at(-1)).toBe(0);
    expect(at(NaN)).toBeCloseTo(0.1, 6);
  });

  test("a boosted peak is caught by the hard limit, not wrapped", () => {
    const mic = track(0, f32(0.5, -0.5));
    const out = mixBlock({ mic, system: null, systemLevel: 1, micLevel: MIC_LEVEL_MAX, originNs: 0, from: 0, frames: 2 });
    expect(out[0]![0]).toBe(1);
    expect(out[0]![1]).toBe(-1);
  });

  test("the taper: 0% mutes, 75% is as recorded, 100% is +12 dB, and it is in dB either side", () => {
    expect(micLevelFromSliderPct(0)).toBe(0);
    expect(micLevelFromSliderPct(MIC_UNITY_PCT)).toBe(1);
    expect(db(micLevelFromSliderPct(100))).toBeCloseTo(MIC_BOOST_DB, 6);
    expect(db(micLevelFromSliderPct(87.5))).toBeCloseTo(MIC_BOOST_DB / 2, 6);
    expect(db(micLevelFromSliderPct(37.5))).toBeCloseTo(LEVEL_FLOOR_DB / 2, 6);
  });

  test("monotonic, and every slider position reopens where it was saved", () => {
    for (let p = 1; p <= 100; p++) {
      expect(micLevelFromSliderPct(p)).toBeGreaterThan(micLevelFromSliderPct(p - 1));
      expect(sliderPctFromMicLevel(micLevelFromSliderPct(p)), `pct ${p}`).toBe(p);
    }
    expect(sliderPctFromMicLevel(0)).toBe(0);
    expect(sliderPctFromMicLevel(1e-6)).toBe(1);
    expect(sliderPctFromMicLevel(99)).toBe(100);
  });

  test("formatLevelDb speaks one unit for both sliders", () => {
    expect(formatLevelDb(0)).toBe("Muted");
    expect(formatLevelDb(1)).toBe("0 dB");
    expect(formatLevelDb(MIC_LEVEL_MAX)).toBe("+12 dB");
    expect(formatLevelDb(levelFromSliderPct(40))).toBe("\u221224 dB");
    expect(formatLevelDb(NaN)).toBe("Muted");
  });

  test("the export plan: a mic level other than 1 takes the mix path, mic-only takes included", () => {
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, micLevel: 1 })).toEqual({ path: "mic", cleanMic: false });
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, micLevel: 2 })).toEqual({ path: "mix", cleanMic: false });
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, micLevel: 0 })).toEqual({ path: "mix", cleanMic: false });
    expect(exportAudioPlan({ encode: true, hasMic: false, hasSystem: false, micLevel: 2 })).toEqual({ path: "none", cleanMic: false });
  });
});
