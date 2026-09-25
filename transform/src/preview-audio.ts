/**
 * The editor preview's SOUND (STC-454): the export's own mix, played through
 * Web Audio in step with the picture.
 *
 * ## The decisions (Patrick, 2026-09-25, on the Linear ticket)
 *
 * 1. **Sound at 1x only** (`audibleAt`). Reverse and 2/4/8x shuttle are for
 *    finding a place, not for listening, and are silent.
 * 2. **Silent while dragging.** A seek during playback restarts the sound only
 *    once the playhead has settled (`preview.ts`'s `SEEK_SETTLE_MS`); a
 *    paused seek makes no sound at all.
 * 3. **A mute button**, remembered as an app setting and never written into
 *    the take or the export. Muting only turns the gain to zero: the sound
 *    keeps being scheduled, so the clock the picture follows never changes
 *    under it.
 * 4. **The preview plays what the export will**, narration cleanup included.
 *    The cleaned mic is made off the main thread and swapped in with
 *    `setMic` when it is ready.
 *
 * ## One mix, not two
 *
 * Every sample comes from `audio-mix.ts`'s `mixBlock`, the function export
 * encodes — never from a Web Audio graph doing its own gain and sum. The
 * phase-1 council review's warning was exactly this: "if preview mixes via
 * AudioContext with live drift and export mixes sample-accurately, A/V sync
 * differs between paths". `mixBlock` is random-access (any window, any
 * start), so the preview asks it for 100 ms at a time from wherever the
 * playhead is, and the system-audio level is read per chunk, so moving the
 * slider is heard within `PREVIEW_HORIZON_S`.
 *
 * ## One clock
 *
 * While sound plays, the PICTURE follows the SOUND: `start` hands the player
 * a clock read from the audio device's own output position
 * (`getOutputTimestamp`), and `preview.ts` runs its playhead on it instead of
 * `performance.now()`. Two clocks — the wall and the sound card — drift apart
 * by tens of parts per million, which is a lip-sync error that grows through
 * a long take; one clock cannot drift from itself. When nothing is audible
 * (another rate, no audio track, the context not running), the player keeps
 * the wall clock exactly as before.
 *
 * Chunks are scheduled at `anchor + from / sampleRate` exactly, so they butt
 * together with no gap and no overlap. One that would start late (the main
 * thread stalled past the horizon) is TRIMMED to start on time, never played
 * late: a late chunk would shift every sample after it against the picture.
 */
import { mixBlock, MIX_SAMPLE_RATE, MIX_CHANNELS, type PcmTrack } from "./audio-mix.js";

/** 100 ms at 48 kHz: short enough that a level change is heard promptly. */
export const PREVIEW_CHUNK_FRAMES = 4800;
/** How far ahead of the audio clock sound is kept scheduled. */
export const PREVIEW_HORIZON_S = 0.4;
/** The first chunk's head start, so it is never already late when scheduled. */
export const PREVIEW_START_LEAD_S = 0.06;
/** A chunk must start at least this far ahead of the audio clock to start whole. */
export const PREVIEW_MIN_LEAD_S = 0.01;
/** How often the scheduler tops the horizon up. */
const PUMP_MS = 30;

/** Rule 1: sound at 1x only. */
export function audibleAt(rate: number): boolean {
  return rate === 1;
}

/** One scheduled piece of the mix: output frames [from, from + frames) of this anchor, at `whenS`. */
export interface ChunkPlan { from: number; frames: number; whenS: number }

/**
 * Which chunks to schedule now. Pure: the audio clock is passed in.
 *
 * Frame `f` of the current anchor always plays at `anchorCtxS + f / rate`, so
 * sync holds whatever is skipped. A chunk whose start is already inside
 * `minLeadS` of `nowCtxS` loses its late head and starts on time; one that is
 * wholly late is dropped.
 */
export function planChunks(opts: {
  anchorCtxS: number;
  nextFrame: number;
  nowCtxS: number;
  horizonS?: number;
  chunkFrames?: number;
  sampleRate?: number;
  minLeadS?: number;
}): { chunks: ChunkPlan[]; nextFrame: number } {
  const horizon = opts.horizonS ?? PREVIEW_HORIZON_S;
  const chunk = opts.chunkFrames ?? PREVIEW_CHUNK_FRAMES;
  const rate = opts.sampleRate ?? MIX_SAMPLE_RATE;
  const minLead = opts.minLeadS ?? PREVIEW_MIN_LEAD_S;
  const earliest = opts.nowCtxS + minLead;
  const chunks: ChunkPlan[] = [];
  let next = opts.nextFrame;
  // Bounded: a clock that jumped hours ahead must not spin here.
  for (let guard = 0; guard < 10_000; guard++) {
    const whenS = opts.anchorCtxS + next / rate;
    if (whenS > opts.nowCtxS + horizon) break;
    let from = next;
    let frames = chunk;
    next += chunk;
    if (whenS < earliest) {
      const late = Math.ceil((earliest - whenS) * rate);
      if (late >= frames) continue;
      from += late;
      frames -= late;
    }
    chunks.push({ from, frames, whenS: opts.anchorCtxS + from / rate });
  }
  return { chunks, nextFrame: next };
}

/** A reader that never goes backwards: the playhead must not step back between frames. */
export function monotonic(read: () => number): () => number {
  let last = -Infinity;
  return () => {
    const v = read();
    if (v > last) last = v;
    return last;
  };
}

/** What `preview.ts` asks of a sound source. */
export interface AudioClock {
  /** The clock value (ms) at which the anchor's first sample is heard. */
  anchorMs: number;
  /** The clock now (ms), in the same units. */
  nowMs: () => number;
}

/**
 * The context time of the sample being HEARD now. `getOutputTimestamp` gives
 * it with a `performance.now()` stamp, updated per render quantum; the stamp
 * interpolates between updates so the picture does not step at 375 Hz.
 */
function heardNowS(ctx: AudioContext): number {
  const ts = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : null;
  if (ts && typeof ts.contextTime === "number" && typeof ts.performanceTime === "number" && ts.performanceTime > 0) {
    return ts.contextTime + Math.max(0, performance.now() - ts.performanceTime) / 1000;
  }
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
}

/** The preview's sound. Built once per opened take, after its audio decodes. */
export class PreviewAudio {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private muted = false;
  private live = new Set<AudioBufferSourceNode>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private anchorNs = 0;
  private anchorCtxS = 0;
  private nextFrame = 0;
  private closed = false;
  private mic: PcmTrack | null;
  private readonly system: PcmTrack | null;

  constructor(tracks: { mic: PcmTrack | null; system: PcmTrack | null },
              private readonly systemLevel: () => number) {
    this.mic = tracks.mic;
    this.system = tracks.system;
  }

  /** True when there is anything to hear at all. */
  get hasSound(): boolean { return !!this.mic || !!this.system; }

  /** Swap the mic (e.g. for the cleaned one). Takes effect from the next chunk scheduled. */
  setMic(track: PcmTrack | null): void { this.mic = track; }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
  }

  get isMuted(): boolean { return this.muted; }

  /**
   * Start sound at session time `tNs` for playback at `rate`. Returns the
   * clock the player must run on while it plays, or null when nothing will be
   * heard — and then the player keeps the wall clock.
   */
  start(tNs: number, rate: number): AudioClock | null {
    this.stop();
    if (this.closed || !audibleAt(rate) || !this.hasSound) return null;
    const ctx = this.context();
    if (!ctx) return null;
    if (ctx.state !== "running") {
      // Not running yet (a fresh context, or one the OS suspended): ask, and
      // stay silent THIS time rather than hand the player a clock that is
      // standing still — a stopped clock would freeze the picture.
      void ctx.resume().catch(() => {});
      return null;
    }
    this.anchorNs = tNs;
    this.anchorCtxS = ctx.currentTime + PREVIEW_START_LEAD_S;
    this.nextFrame = 0;
    this.pump();
    this.timer = setInterval(() => this.pump(), PUMP_MS);
    const now = monotonic(() => heardNowS(ctx));
    return { anchorMs: this.anchorCtxS * 1000, nowMs: () => now() * 1000 };
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const src of this.live) {
      try { src.stop(); } catch { /* already ended */ }
      src.disconnect();
    }
    this.live.clear();
  }

  close(): void {
    this.closed = true;
    this.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.gain = null;
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext({ sampleRate: MIX_SAMPLE_RATE, latencyHint: "interactive" });
    } catch {
      return null;
    }
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : 1;
    this.gain.connect(this.ctx.destination);
    return this.ctx;
  }

  private pump(): void {
    const ctx = this.ctx, gain = this.gain;
    if (!ctx || !gain) return;
    const plan = planChunks({ anchorCtxS: this.anchorCtxS, nextFrame: this.nextFrame, nowCtxS: ctx.currentTime });
    this.nextFrame = plan.nextFrame;
    const level = this.systemLevel();
    for (const c of plan.chunks) {
      const planes = mixBlock({
        mic: this.mic, system: this.system, systemLevel: level,
        originNs: this.anchorNs, from: c.from, frames: c.frames,
      });
      const buffer = ctx.createBuffer(MIX_CHANNELS, c.frames, MIX_SAMPLE_RATE);
      for (let ch = 0; ch < MIX_CHANNELS; ch++) buffer.copyToChannel(planes[ch]! as Float32Array<ArrayBuffer>, ch);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.onended = () => { this.live.delete(src); src.disconnect(); };
      src.start(c.whenS);
      this.live.add(src);
    }
  }
}
