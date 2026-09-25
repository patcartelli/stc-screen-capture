import { describe, test, expect } from "vitest";
import {
  audibleAt, planChunks, monotonic,
  PREVIEW_CHUNK_FRAMES, PREVIEW_HORIZON_S, PREVIEW_MIN_LEAD_S,
} from "../src/preview-audio.js";
import { MIX_SAMPLE_RATE, mixBlock, type PcmTrack } from "../src/audio-mix.js";

/**
 * The preview's sound (STC-454), the parts that decide rather than play:
 * when there is sound at all, which slices of the mix go to the audio clock
 * and when, and a clock that cannot step backwards. The Web Audio half needs
 * a real audio device — docs/STC-454-RUNBOOK.md.
 */
const SR = MIX_SAMPLE_RATE;

describe("audibleAt: sound at 1x only (Patrick, 2026-09-25)", () => {
  test("1x plays; every other rung of the shuttle ladder is silent", () => {
    expect(audibleAt(1)).toBe(true);
    for (const r of [-8, -4, -2, -1, 0, 2, 4, 8]) expect(audibleAt(r), `rate ${r}`).toBe(false);
  });
});

describe("planChunks", () => {
  test("from a fresh anchor it fills exactly the horizon, chunk after chunk, with no gaps", () => {
    const { chunks, nextFrame } = planChunks({ anchorCtxS: 10.06, nextFrame: 0, nowCtxS: 10 });
    expect(chunks.length).toBeGreaterThan(0);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.from).toBe(i * PREVIEW_CHUNK_FRAMES);
      expect(chunks[i]!.frames).toBe(PREVIEW_CHUNK_FRAMES);
    }
    const last = chunks[chunks.length - 1]!;
    expect(last.whenS).toBeLessThanOrEqual(10 + PREVIEW_HORIZON_S);
    expect(last.whenS + PREVIEW_CHUNK_FRAMES / SR).toBeGreaterThan(10 + PREVIEW_HORIZON_S);
    expect(nextFrame).toBe(chunks.length * PREVIEW_CHUNK_FRAMES);
  });

  test("SYNC: every chunk plays at anchor + from / sampleRate, exactly", () => {
    let next = 0;
    for (let now = 5; now < 7; now += 0.03) {
      const plan = planChunks({ anchorCtxS: 5.06, nextFrame: next, nowCtxS: now });
      for (const c of plan.chunks) expect(c.whenS).toBe(5.06 + c.from / SR);
      next = plan.nextFrame;
    }
  });

  test("topping up schedules only what is new: no chunk twice, none missed", () => {
    const seen: number[] = [];
    let next = 0;
    for (let now = 0; now < 3; now += 0.03) {
      const plan = planChunks({ anchorCtxS: 0.06, nextFrame: next, nowCtxS: now });
      for (const c of plan.chunks) seen.push(c.from);
      next = plan.nextFrame;
    }
    expect(seen).toEqual(seen.map((_, i) => i * PREVIEW_CHUNK_FRAMES));
  });

  test("already scheduled past the horizon: nothing to do", () => {
    const first = planChunks({ anchorCtxS: 1.06, nextFrame: 0, nowCtxS: 1 });
    const again = planChunks({ anchorCtxS: 1.06, nextFrame: first.nextFrame, nowCtxS: 1.001 });
    expect(again.chunks).toEqual([]);
  });

  test("a stalled main thread: a late chunk loses its late head and still starts ON TIME", () => {
    // The chunk at frame 4800 was due at anchor + 0.1 s; the clock is 30 ms past that.
    const anchor = 2;
    const now = anchor + 0.1 + 0.03;
    const plan = planChunks({ anchorCtxS: anchor, nextFrame: PREVIEW_CHUNK_FRAMES, nowCtxS: now });
    const c = plan.chunks[0]!;
    expect(c.whenS).toBeGreaterThanOrEqual(now + PREVIEW_MIN_LEAD_S - 1 / SR);
    expect(c.whenS).toBe(anchor + c.from / SR);
    expect(c.from + c.frames).toBe(2 * PREVIEW_CHUNK_FRAMES);
    expect(c.from).toBeGreaterThan(PREVIEW_CHUNK_FRAMES);
  });

  test("a chunk wholly in the past is dropped, not played late", () => {
    const plan = planChunks({ anchorCtxS: 0, nextFrame: 0, nowCtxS: 0.5 });
    expect(plan.chunks.every((c) => c.whenS >= 0.5 + PREVIEW_MIN_LEAD_S - 1 / SR)).toBe(true);
    expect(plan.chunks.some((c) => c.from < 4 * PREVIEW_CHUNK_FRAMES)).toBe(false);
  });

  test("the chunks mixed one by one are the same samples as the window mixed at once", () => {
    const n = SR;
    const ramp = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 9) * 0.3);
    const mic: PcmTrack = { startNs: 0, sampleRate: SR, channels: [ramp] };
    const originNs = 123_456_789;
    const plan = planChunks({ anchorCtxS: 0.06, nextFrame: 0, nowCtxS: 0, horizonS: 0.9 });
    const total = plan.nextFrame;
    const whole = mixBlock({ mic, system: null, systemLevel: 1, originNs, from: 0, frames: total });
    for (const c of plan.chunks) {
      const part = mixBlock({ mic, system: null, systemLevel: 1, originNs, from: c.from, frames: c.frames });
      expect(Array.from(part[0]!)).toEqual(Array.from(whole[0]!.subarray(c.from, c.from + c.frames)));
    }
  });
});

describe("monotonic", () => {
  test("never reports an earlier time than it already has", () => {
    const readings = [1, 2, 1.5, 3, 2.9, 4];
    let i = 0;
    const read = monotonic(() => readings[i++]!);
    expect(readings.map(() => read())).toEqual([1, 2, 2, 3, 3, 4]);
  });
});
