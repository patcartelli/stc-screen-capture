/**
 * The export's audio mix (STC-418 PR 3): the recorded mic plus the recorded
 * system audio, scaled by the project's `systemAudioLevel`, summed into ONE
 * stereo track. Pure — no WebCodecs, no DOM, no clock — so every rule below is
 * tested in Node against sample values rather than trusted by ear.
 *
 * ## The decisions (Patrick, 2026-09-25, on the Linear ticket)
 *
 * 1. **One track.** Most players only play an MP4's first audio track, so two
 *    tracks would lose system audio for most viewers.
 * 2. **A plain sum with a hard limit.** `mic + system × level`, clamped to
 *    full scale. No fixed headroom (every take with both sources would come
 *    out quieter than either alone), no ducking, no compression — the ticket
 *    rules out audio editing. If the sum distorts, the level is the fix.
 * 3. **Attenuate only.** `level` is 0..1 (project-9's own range); a value
 *    outside it is clamped here too, so a hand-edited document cannot boost.
 *
 * ## Why plain TypeScript and not `OfflineAudioContext`
 *
 * The browser's graph would resample and mix in one call, but it cannot run
 * in Node, so the rules above would only ever be checked by listening. It is
 * also a second implementation of arithmetic this repo prefers to own
 * (render() is pure for the same reason). The common case — both tracks at
 * 48 kHz, which is what `SystemAudioCapture` writes and what a Mac mic almost
 * always runs at — needs no resampling at all, and takes an exact path: every
 * input sample reaches the output unaltered but for the gain and the sum.
 * Only a mic at another rate (44.1 kHz) is linearly interpolated.
 *
 * ## Time
 *
 * Everything is placed by SESSION-relative time, the same origin every other
 * track in export.ts uses: a track starts at its first sample's ns, and output
 * sample `i` of a window starting at `originNs` sits at
 * `originNs + i / MIX_SAMPLE_RATE` seconds. A gap in a track (a pause, which
 * the helper's pause gate leaves unrecorded) is silence, because samples are
 * placed by their own timestamps rather than packed end to end.
 */

/** What the mix is always written at: SystemAudioCapture's own format. */
export const MIX_SAMPLE_RATE = 48_000;
export const MIX_CHANNELS = 2;

/** One decoded chunk, planar: `channels[c][i]` is channel `c`, frame `i`. */
export interface PcmChunk {
  /** session-relative microseconds — `AudioData.timestamp` as demux-audio.ts produces it */
  timestampUs: number;
  sampleRate: number;
  channels: Float32Array[];
}

/** A whole track laid out contiguously from its first sample. */
export interface PcmTrack {
  /** session-relative ns of `channels[c][0]` */
  startNs: number;
  sampleRate: number;
  channels: Float32Array[];
}

/**
 * Lays decoded chunks into one contiguous track, each at the index its own
 * timestamp says — so a gap between chunks (a pause) comes out as zeros, and
 * a chunk that overlaps its predecessor by a rounding sample overwrites it
 * rather than shifting everything after it.
 *
 * Refuses a track whose chunks disagree on rate or channel count: export.ts
 * already refuses the same thing for the mic (a Bluetooth profile switch
 * mid-take is the suspected cause), and a mix built on a guess about which
 * chunk is right would be the quiet kind of wrong.
 */
export function trackFromChunks(chunks: PcmChunk[], label: string): PcmTrack | null {
  if (chunks.length === 0) return null;
  const sorted = [...chunks].sort((a, b) => a.timestampUs - b.timestampUs);
  const first = sorted[0]!;
  const rate = first.sampleRate;
  const nch = first.channels.length;
  for (const c of sorted) {
    if (c.sampleRate !== rate || c.channels.length !== nch) {
      throw new Error(
        `${label}: decoded chunks are not uniform — ${nch}ch/${rate}Hz and ` +
        `${c.channels.length}ch/${c.sampleRate}Hz in one track`);
    }
  }
  const startUs = first.timestampUs;
  const offsetOf = (c: PcmChunk) => Math.round((c.timestampUs - startUs) * rate / 1e6);
  let length = 0;
  for (const c of sorted) length = Math.max(length, offsetOf(c) + (c.channels[0]?.length ?? 0));
  const out = Array.from({ length: nch }, () => new Float32Array(length));
  for (const c of sorted) {
    const at = offsetOf(c);
    for (let ch = 0; ch < nch; ch++) out[ch]!.set(c.channels[ch]!, at);
  }
  return { startNs: startUs * 1000, sampleRate: rate, channels: out };
}

/** How many output frames a window `[fromNs, toNs)` holds at MIX_SAMPLE_RATE. */
export function mixFrameCount(fromNs: number, toNs: number): number {
  return Math.max(0, Math.round((toNs - fromNs) * MIX_SAMPLE_RATE / 1e9));
}

/**
 * Reads output channel `outCh` of `track` at output frame `i` of a window
 * starting at `originNs`. Mono is duplicated to both output channels; a track
 * with more than two channels contributes its first two.
 */
function sampleAt(track: PcmTrack, outCh: number, i: number, originNs: number): number {
  const src = track.channels[Math.min(outCh, track.channels.length - 1)]!;
  if (track.sampleRate === MIX_SAMPLE_RATE) {
    // Exact path: an integer offset, no interpolation. The offset rounds the
    // two tracks' start times onto the output grid — at most half a sample
    // (~10 µs), far below anything audible, and it keeps every sample value.
    const offset = Math.round((originNs - track.startNs) * MIX_SAMPLE_RATE / 1e9);
    const k = i + offset;
    return k >= 0 && k < src.length ? src[k]! : 0;
  }
  // Linear interpolation for a track at another rate.
  const pos = ((originNs - track.startNs) / 1e9 + i / MIX_SAMPLE_RATE) * track.sampleRate;
  if (pos < 0 || pos > src.length - 1) return 0;
  const k = Math.floor(pos);
  const frac = pos - k;
  const a = src[k]!;
  const b = k + 1 < src.length ? src[k + 1]! : a;
  return a + (b - a) * frac;
}

/**
 * `frames` output frames of the mix, starting at output frame `from` of a
 * window whose frame 0 sits at session time `originNs`. Stereo, planar.
 *
 * Called once per encoder block by export.ts rather than once for the whole
 * clip, so a long take never holds a second full-length copy of itself.
 */
export function mixBlock(opts: {
  mic: PcmTrack | null;
  system: PcmTrack | null;
  systemLevel: number;
  originNs: number;
  from: number;
  frames: number;
}): Float32Array[] {
  const level = Math.min(1, Math.max(0, Number.isFinite(opts.systemLevel) ? opts.systemLevel : 1));
  const out = Array.from({ length: MIX_CHANNELS }, () => new Float32Array(opts.frames));
  for (let ch = 0; ch < MIX_CHANNELS; ch++) {
    const dst = out[ch]!;
    for (let j = 0; j < opts.frames; j++) {
      const i = opts.from + j;
      let v = 0;
      if (opts.mic) v += sampleAt(opts.mic, ch, i, opts.originNs);
      if (opts.system && level > 0) v += level * sampleAt(opts.system, ch, i, opts.originNs);
      dst[j] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }
  return out;
}

/**
 * The level slider's TAPER (STC-418 PR 3, after Patrick's 2026-09-25
 * hardware pass: "the system audio is loud even when I exported at 30%").
 *
 * The slider used to BE the linear gain, and 30% of the signal is only
 * ~10 dB down — which ears hear as roughly half as loud, not a third. A
 * fader has to move in decibels to feel proportional. So the slider position
 * maps linearly onto `[LEVEL_FLOOR_DB, 0]` dB: 100% is 0 dB (untouched),
 * 50% is -20 dB, 30% is -28 dB, 1% is -39.6 dB — and 0% is a TRUE mute, a
 * special case, since -40 dB is quiet but not silent.
 *
 * Only the UI's mapping changed. The project still stores the LINEAR gain
 * (project-9's `systemAudioLevel`, 0..1), which is what `mixBlock` applies —
 * so no schema moved, and a stored value means the same thing it always did.
 */
export const LEVEL_FLOOR_DB = -40;

/** Slider position (0..100) → linear gain (0..1). */
export function levelFromSliderPct(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (pct >= 100) return 1;
  return 10 ** ((LEVEL_FLOOR_DB * (1 - pct / 100)) / 20);
}

/**
 * Linear gain (0..1) → the nearest slider position (0..100) — the inverse
 * of `levelFromSliderPct`, so a saved level reopens at the position that
 * saved it. A gain quieter than the floor but not silent sits at 1%, never
 * at 0%: 0% means muted, and a quiet track is not a muted one.
 */
export function sliderPctFromLevel(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  if (level >= 1) return 100;
  const pct = Math.round((1 + (20 * Math.log10(level)) / -LEVEL_FLOOR_DB) * 100);
  return Math.min(100, Math.max(1, pct));
}

/**
 * Which audio path an export takes (STC-418, STC-455) — the ONE place it is
 * decided, so the rule "a take that never asked for cleanup or system audio
 * exports exactly as before" is a tested function rather than a condition
 * read by inspection in export.ts.
 *
 * - `mix`: through `mixBlock` — the take has system audio, or its mic is
 *   being cleaned (`cleanMic`), mic-only takes included.
 * - `mic`: the original mic-only passthrough, at the mic's own format.
 * - `none`: nothing to encode, or not encoding at all.
 *
 * Cleanup on at strength 0 is an exact identity (narration-clean.ts), so it
 * is treated as off: it must not move a take onto the mix path.
 */
export function exportAudioPlan(opts: {
  encode: boolean;
  hasMic: boolean;
  hasSystem: boolean;
  cleanup?: { enabled: boolean; strength: number };
}): { path: "mix" | "mic" | "none"; cleanMic: boolean } {
  if (!opts.encode) return { path: "none", cleanMic: false };
  const cleanMic = opts.hasMic && !!opts.cleanup?.enabled && opts.cleanup.strength > 0;
  if (opts.hasSystem || cleanMic) return { path: "mix", cleanMic };
  return { path: opts.hasMic ? "mic" : "none", cleanMic: false };
}
