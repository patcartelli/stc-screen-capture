import { describe, test, expect } from "vitest";
import { MIX_SAMPLE_RATE, mixBlock, mixFrameCount, type PcmTrack } from "../src/audio-mix.js";
import { mixPeaks, mixPeaksSync, WAVEFORM_BUCKETS } from "../src/waveform.js";

/** A mono track at MIX_SAMPLE_RATE from session time 0. */
const track = (samples: Float32Array, startNs = 0): PcmTrack =>
  ({ startNs, sampleRate: MIX_SAMPLE_RATE, channels: [samples] });
/** `seconds` of a constant value. */
const dc = (seconds: number, v: number) => new Float32Array(Math.round(seconds * MIX_SAMPLE_RATE)).fill(v);
const S = 1e9;

describe("mixPeaks", () => {
  test("nothing to draw: no tracks, zero duration, or every track at level 0", () => {
    const mic = track(dc(1, 0.5));
    expect(Array.from(mixPeaksSync({ mic: null, system: null, micLevel: 1, systemLevel: 1, durationNs: S, buckets: 4 }))).toEqual([0, 0, 0, 0]);
    expect(Array.from(mixPeaksSync({ mic, system: null, micLevel: 1, systemLevel: 1, durationNs: 0, buckets: 4 }))).toEqual([0, 0, 0, 0]);
    expect(Array.from(mixPeaksSync({ mic, system: mic, micLevel: 0, systemLevel: 0, durationNs: S, buckets: 4 }))).toEqual([0, 0, 0, 0]);
  });

  test("each bucket is the loudest sample in its span, placed by session time", () => {
    // 2 s timeline, 4 buckets of 0.5 s; the mic starts at 1 s and holds 0.25.
    const mic = track(dc(1, 0.25), 1 * S);
    const p = mixPeaksSync({ mic, system: null, micLevel: 1, systemLevel: 1, durationNs: 2 * S, buckets: 4 });
    expect(Array.from(p)).toEqual([0, 0, 0.25, 0.25]);
  });

  test("a single spike is caught, not averaged away", () => {
    const s = new Float32Array(MIX_SAMPLE_RATE);
    s[12_345] = -0.8;
    const p = mixPeaksSync({ mic: track(s), system: null, micLevel: 1, systemLevel: 1, durationNs: S, buckets: 8 });
    const at = Math.floor((12_345 * 8) / MIX_SAMPLE_RATE);
    expect(p[at]).toBeCloseTo(0.8, 6);
    expect(Array.from(p).filter((v) => v > 0)).toHaveLength(1);
  });

  test("it draws the EXPORT's mix: levels applied, the sum hard-limited", () => {
    const mic = track(dc(1, 0.5));
    const system = track(dc(1, 0.5));
    const half = mixPeaksSync({ mic, system, micLevel: 1, systemLevel: 0.5, durationNs: S, buckets: 2 });
    expect(half[0]).toBeCloseTo(0.75, 6);
    // +12 dB on 0.5 clips at full scale, as the export does.
    const boosted = mixPeaksSync({ mic, system: null, micLevel: 4, systemLevel: 1, durationNs: S, buckets: 2 });
    expect(boosted[0]).toBe(1);
  });

  test("a muted track (level 0) contributes nothing", () => {
    const mic = track(dc(1, 0.2));
    const system = track(dc(1, 0.6));
    const p = mixPeaksSync({ mic, system, micLevel: 1, systemLevel: 0, durationNs: S, buckets: 2 });
    expect(p[0]).toBeCloseTo(0.2, 6);
  });

  test("agrees with mixBlock sample for sample over the whole timeline", () => {
    // A ramp mic and a sine system at another start: the peaks must be the
    // max |sample| of mixBlock's own output over each bucket's span.
    const n = Math.round(0.7 * MIX_SAMPLE_RATE);
    const ramp = Float32Array.from({ length: n }, (_, i) => (i / n) * 0.9 - 0.3);
    const sine = Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin(i / 37));
    const mic = track(ramp, 0.1 * S);
    const system = track(sine, 0.25 * S);
    const durationNs = S;
    const buckets = 16;
    const p = mixPeaksSync({ mic, system, micLevel: 1.3, systemLevel: 0.7, durationNs, buckets, blockFrames: 777 });
    const total = mixFrameCount(0, durationNs);
    const mixed = mixBlock({ mic, system, micLevel: 1.3, systemLevel: 0.7, originNs: 0, from: 0, frames: total });
    const want = new Float32Array(buckets);
    for (const plane of mixed) {
      for (let i = 0; i < total; i++) {
        const b = Math.floor((i * buckets) / total);
        want[b] = Math.max(want[b]!, Math.abs(plane[i]!));
      }
    }
    expect(Array.from(p)).toEqual(Array.from(want));
  });

  test("yields once per block, so a long take can be spread across idle slices", () => {
    const mic = track(dc(3, 0.1));
    const it = mixPeaks({ mic, system: null, micLevel: 1, systemLevel: 1, durationNs: 3 * S });
    let yields = 0;
    for (let r = it.next(); !r.done; r = it.next()) yields++;
    expect(yields).toBe(3); // WAVEFORM_BLOCK_FRAMES is one second
  });

  test("defaults to WAVEFORM_BUCKETS", () => {
    const p = mixPeaksSync({ mic: track(dc(1, 0.1)), system: null, micLevel: 1, systemLevel: 1, durationNs: S });
    expect(p.length).toBe(WAVEFORM_BUCKETS);
  });
});
