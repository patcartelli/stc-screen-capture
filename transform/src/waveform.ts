/**
 * The editor's audio WAVEFORM (STC-454 part 4): one peak per bucket of the
 * EXPORT's mix, drawn on the ruler.
 *
 * ## The decisions (Patrick, 2026-09-25)
 *
 * 1. **A ruler overlay, not a lane.** STC-444's hardware pass found three
 *    stacked lanes cluttered and moved Clip activity onto the ruler; the
 *    waveform follows it there, behind its own toggle.
 * 2. **The export's mix, not the raw tracks.** One waveform of what the
 *    export will contain: the mic (cleaned when cleanup is on) and system
 *    audio at their levels, a muted track contributing nothing, hard-limited.
 *    So moving a slider or a mute changes the drawing, the same way it
 *    changes what is heard.
 *
 * ## One mix, not three
 *
 * Every sample comes from `audio-mix.ts`'s `mixBlock`, the function export
 * encodes and the preview plays. A waveform computed from its own gain-and-sum
 * would be a third implementation, and the first place a boosted mic's
 * clipping or a muted track could disagree with what is exported.
 *
 * ## Peaks, linear
 *
 * Each bucket is the largest absolute sample in its span, over both channels,
 * on a LINEAR scale: full height is full scale, the level the hard limit
 * clips at. A dB scale would flatten exactly the differences a level slider
 * makes; linear shows a -12 dB move as a quarter of the height.
 *
 * ## Not all at once
 *
 * A long take is millions of samples. `mixPeaks` is a generator that yields
 * after each block, so the editor can spread the work across idle slices
 * (and drop a stale run when a slider moves again) instead of stalling the
 * transport. Draining it synchronously gives the same answer.
 */
import { mixBlock, MIX_SAMPLE_RATE, mixFrameCount, type PcmTrack } from "./audio-mix.js";

/** Buckets across the full duration, independent of the canvas width, so a resize needs no recompute. */
export const WAVEFORM_BUCKETS = 1024;
/** One second of the mix per step: small enough to keep a slice short. */
export const WAVEFORM_BLOCK_FRAMES = MIX_SAMPLE_RATE;

export interface MixPeaksInput {
  mic: PcmTrack | null;
  system: PcmTrack | null;
  /** A muted track is passed as level 0 (or null): it contributes nothing, as in the export. */
  micLevel: number;
  systemLevel: number;
  /** The timeline's length; bucket `i` covers `[i, i + 1) * durationNs / buckets`. */
  durationNs: number;
  buckets?: number;
  blockFrames?: number;
}

/**
 * Peaks (0..1) of the mix over `[0, durationNs]`, in `buckets` equal spans.
 * Yields once per block of mixed audio; the return value is the peaks.
 */
export function* mixPeaks(opts: MixPeaksInput): Generator<void, Float32Array, void> {
  const n = Math.max(1, Math.floor(opts.buckets ?? WAVEFORM_BUCKETS));
  const peaks = new Float32Array(n);
  const total = opts.durationNs > 0 ? mixFrameCount(0, opts.durationNs) : 0;
  const micOn = !!opts.mic && opts.micLevel > 0;
  const sysOn = !!opts.system && opts.systemLevel > 0;
  if (total === 0 || (!micOn && !sysOn)) return peaks;
  const block = Math.max(1, Math.floor(opts.blockFrames ?? WAVEFORM_BLOCK_FRAMES));
  for (let from = 0; from < total; from += block) {
    const frames = Math.min(block, total - from);
    const planes = mixBlock({
      mic: micOn ? opts.mic : null,
      system: sysOn ? opts.system : null,
      micLevel: opts.micLevel,
      systemLevel: opts.systemLevel,
      originNs: 0,
      from,
      frames,
    });
    for (const plane of planes) {
      for (let j = 0; j < frames; j++) {
        const v = Math.abs(plane[j]!);
        const b = Math.min(n - 1, Math.floor(((from + j) * n) / total));
        if (v > peaks[b]!) peaks[b] = v;
      }
    }
    yield;
  }
  return peaks;
}

/** Drain `mixPeaks` in one go. For tests, and for callers that do not mind blocking. */
export function mixPeaksSync(opts: MixPeaksInput): Float32Array {
  const it = mixPeaks(opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}
