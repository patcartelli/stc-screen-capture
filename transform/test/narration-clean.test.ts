import { describe, test, expect } from "vitest";
import {
  cleanNarration, paramsForStrength, highPassInPlace, makeFft, FFT_SIZE,
} from "../src/narration-clean.js";
import type { PcmTrack } from "../src/audio-mix.js";

/**
 * Narration cleanup (STC-455), judged on SYNTHETIC signals whose clean
 * version is known: a harmonic "voice" in phrases, with white noise, a
 * room tail, or sibilance added. Each stage is tested alone (via the
 * overrides) so a failure names the stage, then the whole chain at the
 * strengths the listen script writes. What these cannot tell is whether a
 * real voice sounds natural afterwards — that is docs/STC-455-RUNBOOK.md.
 */
const RATE = 48_000;
const OFF = { highPass: false, noiseOversubtract: 0, reverbWeight: 0, deessMaxDb: 0 } as const;

/** Deterministic PRNG (mulberry32) so every run tests the same signal. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function whiteNoise(n: number, rms: number, seed: number): Float64Array {
  const r = rng(seed);
  // Uniform on [-a, a] has rms a/√3.
  return Float64Array.from({ length: n }, () => (r() * 2 - 1) * rms * Math.sqrt(3));
}
/** A 150 Hz voiced sound, 20 harmonics falling at 1/k. */
function voiced(n: number, rate = RATE): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => {
    let v = 0;
    for (let k = 1; k <= 20; k++) v += Math.sin((2 * Math.PI * 150 * k * i) / rate) / k;
    return v * 0.05;
  });
}
const sine = (n: number, hz: number, amp = 0.1, rate = RATE) =>
  Float64Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
/** Phrases: `on` seconds of signal, `off` seconds of nothing, repeated. */
function phrases(signal: Float64Array, on: number, off: number): { x: Float64Array; spans: [number, number][] } {
  const x = new Float64Array(signal.length);
  const spans: [number, number][] = [];
  const period = Math.round((on + off) * RATE), onN = Math.round(on * RATE);
  for (let start = 0; start < x.length; start += period) {
    const end = Math.min(x.length, start + onN);
    for (let i = start; i < end; i++) x[i] = signal[i]!;
    spans.push([start, end]);
  }
  return { x, spans };
}
const add = (a: Float64Array, b: Float64Array) => a.map((v, i) => v + b[i]!);
const mono = (x: Float64Array, rate = RATE): PcmTrack =>
  ({ startNs: 0, sampleRate: rate, channels: [Float32Array.from(x)] });
function rmsDb(x: ArrayLike<number>, from: number, to: number): number {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i]! * x[i]!;
  return 10 * Math.log10(e / (to - from) + 1e-30);
}
const s = (sec: number) => Math.round(sec * RATE);

describe("the strength", () => {
  test("0 is an exact identity — on at 0 cannot differ from off", () => {
    const x = add(voiced(s(1)), whiteNoise(s(1), 0.01, 1));
    const out = cleanNarration(mono(x), 0);
    expect(out.channels[0]).toEqual(Float32Array.from(x));
  });

  test("is clamped: above 1 is 1, below 0 and nonsense are off", () => {
    expect(paramsForStrength(3)).toEqual(paramsForStrength(1));
    expect(paramsForStrength(-1)).toEqual(paramsForStrength(0));
    expect(paramsForStrength(NaN)).toEqual(paramsForStrength(0));
  });

  test("every stage moves together: more strength never cuts less", () => {
    const a = paramsForStrength(0.25), b = paramsForStrength(0.75);
    expect(b.noiseOversubtract).toBeGreaterThanOrEqual(a.noiseOversubtract);
    expect(b.reverbWeight).toBeGreaterThan(a.reverbWeight);
    expect(b.maxReductionDb).toBeGreaterThan(a.maxReductionDb);
    expect(b.reverbMaxDb).toBeGreaterThan(a.reverbMaxDb);
    expect(b.deessMaxDb).toBeGreaterThan(a.deessMaxDb);
  });
});

describe("the STFT framing", () => {
  test("forward then inverse FFT is the identity", () => {
    const fft = makeFft(FFT_SIZE);
    const x = whiteNoise(FFT_SIZE, 0.3, 2);
    const re = Float64Array.from(x), im = new Float64Array(FFT_SIZE);
    fft(re, im, false);
    fft(re, im, true);
    for (let i = 0; i < FFT_SIZE; i++) expect(re[i]).toBeCloseTo(x[i]!, 12);
  });

  test("with every gain at 1, the spectral stage gives back its input, sample for sample, edges included", () => {
    const x = add(voiced(s(0.5)), whiteNoise(s(0.5), 0.05, 3));
    // reverbWeight > 0 forces the spectral path; both floors at 0 dB pin every gain at 1.
    const out = cleanNarration(mono(x), 1, { ...OFF, reverbWeight: 1, maxReductionDb: 0, reverbMaxDb: 0 }).channels[0]!;
    expect(out).toHaveLength(x.length);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(out[i]! - x[i]!));
    expect(worst).toBeLessThan(1e-6);
  });
});

describe("the high-pass", () => {
  test("80 Hz Butterworth: 30 Hz rumble falls ≥15 dB, 1 kHz is untouched", () => {
    const rumble = sine(s(1), 30);
    highPassInPlace(rumble, RATE, 80);
    expect(rmsDb(rumble, s(0.3), s(1)) - rmsDb(sine(s(1), 30), s(0.3), s(1))).toBeLessThan(-15);
    const tone = sine(s(1), 1000);
    highPassInPlace(tone, RATE, 80);
    expect(Math.abs(rmsDb(tone, s(0.3), s(1)) - rmsDb(sine(s(1), 1000), s(0.3), s(1)))).toBeLessThan(0.05);
  });

  test("is scaled by rate: the same cut at 44.1 kHz", () => {
    const r = 44_100;
    const a = sine(r, 30, 0.1, r);
    highPassInPlace(a, r, 80);
    expect(rmsDb(a, Math.round(0.3 * r), r) - rmsDb(sine(r, 30, 0.1, r), Math.round(0.3 * r), r)).toBeLessThan(-15);
  });
});

/** Voice phrases (0.8 s on, 0.7 s off) over 6 s, plus steady hiss. */
function noisyNarration(noiseRms: number) {
  const { x: clean, spans } = phrases(voiced(s(6)), 0.8, 0.7);
  return { clean, spans, noisy: add(clean, whiteNoise(clean.length, noiseRms, 4)) };
}
/** The middle of each gap, clear of where a phrase ends or starts. */
function gapLevel(x: ArrayLike<number>, spans: [number, number][]): number {
  const dbs = spans.slice(0, -1).map(([, end], i) => rmsDb(x, end + s(0.2), spans[i + 1]![0] - s(0.1)));
  return dbs.reduce((a, b) => a + b) / dbs.length;
}
function phraseLevel(x: ArrayLike<number>, spans: [number, number][]): number {
  const dbs = spans.map(([a, b]) => rmsDb(x, a + s(0.1), b - s(0.1)));
  return dbs.reduce((a, b) => a + b) / dbs.length;
}

describe("noise reduction", () => {
  test("steady hiss in the pauses drops to the strength's floor; the voice keeps its level", () => {
    const { clean, spans, noisy } = noisyNarration(0.003);
    const p = paramsForStrength(0.5);
    const out = cleanNarration(mono(noisy), 0.5, { ...OFF, noiseOversubtract: p.noiseOversubtract, maxReductionDb: p.maxReductionDb }).channels[0]!;
    const before = gapLevel(noisy, spans), after = gapLevel(out, spans);
    expect(after - before).toBeLessThan(-(p.maxReductionDb - 1));
    expect(Math.abs(phraseLevel(out, spans) - phraseLevel(clean, spans))).toBeLessThan(1);
  });

  test("more strength leaves less hiss", () => {
    const { spans, noisy } = noisyNarration(0.003);
    const at = (st: number) => gapLevel(cleanNarration(mono(noisy), st).channels[0]!, spans);
    expect(at(1)).toBeLessThan(at(0.5));
    expect(at(0.5)).toBeLessThan(at(0.25));
  });

  test("a take that starts in digital silence still learns the room, not the zeros", () => {
    const { spans, noisy } = noisyNarration(0.003);
    const lead = s(1);
    const x = new Float64Array(noisy.length + lead);
    x.set(noisy, lead);
    const out = cleanNarration(mono(x), 0.5).channels[0]!;
    const shifted = spans.map(([a, b]) => [a + lead, b + lead] as [number, number]);
    expect(gapLevel(out, shifted) - gapLevel(x, shifted)).toBeLessThan(-(paramsForStrength(0.5).maxReductionDb - 1));
  });

  // Patrick's first listening pass (2026-09-25): "a sort of digital bubbling
  // in the background" at EVERY strength — musical noise, the isolated
  // spectral peaks power subtraction leaves in the pauses. Its standard
  // measure is the kurtosis of the pauses' power spectrum, after vs before
  // (Uemura et al., 2009): peaks standing alone make the distribution
  // heavy-tailed. The log ratio is ~0 for a residual that is just quieter
  // noise. The power-subtraction chain measured 1.2 (25%) to 2.9 (100%) here;
  // the decision-directed gain measures 0.04 to 0.12.
  test("no digital bubbling: the pauses' residual is quieter noise, not isolated peaks", () => {
    const { spans, noisy } = noisyNarration(0.003);
    const before = pauseKurtosis(noisy, spans);
    for (const st of [0.25, 0.5, 1]) {
      const out = cleanNarration(mono(noisy), st).channels[0]!;
      expect(Math.log(pauseKurtosis(out, spans) / before), `strength ${st}`).toBeLessThan(0.3);
    }
  });
});

/**
 * Kurtosis of the power spectrum in the middle of each pause, 300 Hz–8 kHz,
 * each bin normalised by its own mean so a quieter bin weighs the same.
 */
function pauseKurtosis(x: ArrayLike<number>, spans: [number, number][]): number {
  const fft = makeFft(FFT_SIZE);
  const binHz = RATE / FFT_SIZE, lo = Math.round(300 / binHz), hi = Math.round(8000 / binHz);
  const perBin: number[][] = Array.from({ length: hi - lo }, () => []);
  for (let g = 0; g < spans.length - 1; g++) {
    for (let at = spans[g]![1] + s(0.25); at + FFT_SIZE < spans[g + 1]![0] - s(0.05); at += FFT_SIZE / 2) {
      const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
      for (let i = 0; i < FFT_SIZE; i++) re[i] = x[at + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
      fft(re, im, false);
      for (let k = lo; k < hi; k++) perBin[k - lo]!.push(re[k]! ** 2 + im[k]! ** 2);
    }
  }
  let m2 = 0, m4 = 0, n = 0;
  for (const b of perBin) {
    const mean = b.reduce((a, v) => a + v, 0) / b.length || 1;
    for (const v of b) { const z = v / mean; m2 += z * z; m4 += z ** 4; n++; }
  }
  return m4 / n / (m2 / n) ** 2;
}

describe("late-reverb suppression", () => {
  /** Dry phrases through a room: the direct sound plus an exponentially decaying noise tail. */
  function roomy() {
    const { x: dry, spans } = phrases(voiced(s(6)), 0.5, 1.0);
    const rt60 = 0.5, len = s(0.6);
    const r = rng(5);
    const ir = Float64Array.from({ length: len }, (_, i) =>
      i === 0 ? 1 : (r() * 2 - 1) * 0.08 * Math.exp((-3 * Math.LN10 * i) / (rt60 * RATE)));
    const wet = new Float64Array(dry.length);
    for (let i = 0; i < dry.length; i++) {
      const v = dry[i]!;
      if (v === 0) continue;
      for (let j = 0; j < len && i + j < wet.length; j++) wet[i + j]! += v * ir[j]!;
    }
    return { spans, wet };
  }
  const tail = (x: ArrayLike<number>, spans: [number, number][]) => {
    const dbs = spans.slice(0, -1).map(([, end]) => rmsDb(x, end + s(0.1), end + s(0.3)));
    return dbs.reduce((a, b) => a + b) / dbs.length;
  };

  // Deliberately GENTLE since the first listening pass (2026-09-25): at the
  // old 1.5x weight the tail fell 6 dB and Patrick still "couldn't tell",
  // while the voice took the damage. Now capped at reverbMaxDb (6 dB at 100%)
  // as its own gain: measured 2.8 dB off the tail, 1.0 dB off a STEADY vowel
  // (the worst case — its own past is always loud).
  test("at full strength the tail after a phrase is cut ≥2.5 dB; the phrase loses <1.5 dB", () => {
    const { spans, wet } = roomy();
    const out = cleanNarration(mono(wet), 1, { ...OFF, reverbWeight: paramsForStrength(1).reverbWeight }).channels[0]!;
    expect(tail(out, spans) - tail(wet, spans)).toBeLessThan(-2.5);
    expect(Math.abs(phraseLevel(out, spans) - phraseLevel(wet, spans))).toBeLessThan(1.5);
  });
});

describe("de-essing", () => {
  /** A dense 5–8.5 kHz hiss: what an "s" looks like to a spectrum. */
  function sibilance(n: number, amp: number): Float64Array {
    const r = rng(6);
    const parts = Array.from({ length: 60 }, () => ({ hz: 5000 + r() * 3500, ph: r() * 2 * Math.PI }));
    return Float64Array.from({ length: n }, (_, i) => {
      let v = 0;
      for (const p of parts) v += Math.sin((2 * Math.PI * p.hz * i) / RATE + p.ph);
      return (v * amp) / Math.sqrt(parts.length / 2);
    });
  }

  test("an 's' is pulled down; a vowel is not touched", () => {
    const n = s(3);
    const vowel = voiced(n);
    const ess = sibilance(n, 0.1);
    // 0–1 s vowel, 1–2 s "s", 2–3 s vowel.
    const x = Float64Array.from({ length: n }, (_, i) => (i >= s(1) && i < s(2) ? ess[i]! : vowel[i]!));
    const out = cleanNarration(mono(x), 1, { ...OFF, deessMaxDb: paramsForStrength(1).deessMaxDb }).channels[0]!;
    expect(rmsDb(out, s(1.2), s(1.8)) - rmsDb(x, s(1.2), s(1.8))).toBeLessThan(-3);
    expect(Math.abs(rmsDb(out, s(0.2), s(0.8)) - rmsDb(x, s(0.2), s(0.8)))).toBeLessThan(0.1);
    expect(Math.abs(rmsDb(out, s(2.2), s(2.8)) - rmsDb(x, s(2.2), s(2.8)))).toBeLessThan(0.1);
  });
});

describe("the whole chain", () => {
  test("keeps the track's shape: start, rate, channels and length, at 44.1 kHz stereo", () => {
    const r = 44_100;
    const L = Float32Array.from(voiced(r, r)), R = Float32Array.from(whiteNoise(r, 0.01, 7));
    const out = cleanNarration({ startNs: 123_456, sampleRate: r, channels: [L, R] }, 0.5);
    expect(out.startNs).toBe(123_456);
    expect(out.sampleRate).toBe(r);
    expect(out.channels).toHaveLength(2);
    expect(out.channels.every((c) => c.length === r)).toBe(true);
  });

  test("a track shorter than one frame survives", () => {
    const out = cleanNarration(mono(whiteNoise(100, 0.01, 8)), 1);
    expect(out.channels[0]).toHaveLength(100);
    expect(out.channels[0]!.every(Number.isFinite)).toBe(true);
  });

  test("an all-silent track stays silent and finite", () => {
    const out = cleanNarration(mono(new Float64Array(s(0.5))), 1);
    expect(out.channels[0]!.every((v) => v === 0)).toBe(true);
  });

  test("deterministic: two runs are bit-identical", () => {
    const { noisy } = noisyNarration(0.003);
    const a = cleanNarration(mono(noisy), 0.7).channels[0]!;
    const b = cleanNarration(mono(noisy), 0.7).channels[0]!;
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });

  test("does not touch its input", () => {
    const { noisy } = noisyNarration(0.003);
    const track = mono(noisy);
    const copy = Float32Array.from(track.channels[0]!);
    cleanNarration(track, 1);
    expect(track.channels[0]).toEqual(copy);
  });
});
