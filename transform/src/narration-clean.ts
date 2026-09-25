/**
 * Narration cleanup (STC-455): the mic track, made to sound like it was not
 * recorded in a room with a fan in it. Pure — no WebCodecs, no DOM, no clock —
 * for the same reason `audio-mix.ts` is: every rule here is checked in Node
 * against synthetic signals, and export (and later STC-454's preview audio)
 * run THIS code rather than a second implementation.
 *
 ## Where it runs
 *
 * Export, when a take's project-10 `narrationCleanup` is on: `export.ts`
 * cleans the whole decoded mic track and hands it to `audio-mix.ts`
 * (`exportAudioPlan` decides the path). The editor's "Clean up voice" switch
 * and strength write that field. It was built sound-first (Patrick,
 * 2026-09-25): `scripts/clean-narration-one.mjs` writes cleaned WAVs from a
 * real `mic.m4a` at several strengths, and two listening rounds tuned it
 * before any plumbing existed. `docs/STC-455-RUNBOOK.md` has both rounds.
 *
 * ## The decisions (Patrick, 2026-09-25, on the Linear ticket)
 *
 * 1. **At export, adjustable, non-destructive.** `mic.m4a` is never rewritten.
 * 2. **One switch and ONE strength**, 0..1, driving the whole chain. There are
 *    no separate noise/harshness dials; `paramsForStrength` is the one
 *    place the strength fans out.
 * 3. **Off by default** — which here means the function is simply not called.
 *    A strength of 0 is also an exact identity, so "on at 0" cannot differ
 *    from "off".
 * 4. **Not macOS Voice Isolation**: a capture-time mode cannot be adjusted
 *    afterwards, and is nothing this repo can test.
 *
 * ## The chain
 *
 * Three stages attack what Patrick named — background noise/hiss and
 * harshness — and the last two share ONE short-time Fourier transform, so
 * each bin gets one combined gain rather than two passes of framing
 * artefacts:
 *
 * 1. **High-pass**, 2nd-order Butterworth at 80 Hz. Rumble, desk thumps and
 *    HVAC boom sit below any voice's fundamental.
 * 2. **Noise reduction** by a decision-directed Wiener gain (Ephraim &
 *    Malah, 1984) against a noise PROFILE learned from the take itself: the
 *    quietest `NOISE_PERCENTILE` of frames (the pauses between phrases)
 *    averaged per bin. It assumes the noise is steady — a fan, hiss, room
 *    tone — which is exactly the named complaint. A dog barking is not steady
 *    and is not removed.
 * 3. **De-essing**: when a frame's energy is dominated by the 4.5–9 kHz band
 *    (an "s", a "t"), that band is compressed toward `DEESS_THRESHOLD`. A
 *    vowel never trips it; only frames that ARE sibilance are touched.
 *
 * ## What the first listening pass changed (Patrick, 2026-09-25)
 *
 * The first cut used POWER SPECTRAL SUBTRACTION, and every strength had "a
 * sort of digital bubbling in the background" — musical noise: the pauses'
 * residual was isolated spectral peaks flickering in and out, not quieter
 * hiss. Smoothing the power and the gain did not cure it. The fix is the
 * estimator: the decision-directed prior leans 98% on the previous frame's
 * CLEAN estimate, so a lone frame where the noise peaks cannot open a bin.
 * `narration-clean.test.ts` measures it as the pauses' spectral kurtosis
 * (after vs before): 1.2–2.9 with subtraction, 0.04–0.12 now.
 *
 * Two more findings from the same pass. 75% and 100% "affect the voice the
 * most" while 50% removed about the right amount of noise — so the strength
 * was RESCALED: 100% now is roughly the old 50%.
 *
 * **There is no echo stage** (STC-458). Lebart-style late-reverb suppression
 * was tried twice: at a strength that cut a 0.5 s tail by 6 dB, Patrick
 * could not hear a difference and the voice paid for it; folded into the
 * Wiener estimator it crushed a steady vowel by 17 dB (the tail estimate
 * grows with the voice and traps the prior low); capped as its own gain it
 * took ~3 dB off, inaudible. Removed on round 2's answers rather than kept
 * as a stage that does nothing a person can hear.
 *
 * The noise gain never falls below the strength's floor, so the residual is
 * quieter, never gated to a dead silence that pumps.
 *
 * ## Determinism and blocks
 *
 * A whole track in, a whole track out: `cleanNarration` runs over the
 * contiguous `PcmTrack` that `trackFromChunks` already builds, BEFORE the mix.
 * The mixer's blocks then read the cleaned track, so "mixing in two halves
 * equals mixing at once" holds for free — no filter state crosses a block
 * boundary, because no filter runs per block. The cost is one more
 * full-length copy of the mic track (~115 MB for ten minutes of mono), which
 * the wiring PR should measure rather than assume.
 *
 * It runs at the mic's OWN sample rate (48 kHz or 44.1 kHz), not after the
 * mixer's resampling: every constant below is in Hz or seconds and converted
 * per rate, so the same strength sounds the same at either.
 */
import type { PcmTrack } from "./audio-mix.js";

/** STFT frame: ~21 ms at 48 kHz. Long enough to resolve voice harmonics. */
export const FFT_SIZE = 1024;
/** 75% overlap: a periodic Hann window squared sums to exactly 1.5 at this hop. */
export const HOP = FFT_SIZE / 4;
const BINS = FFT_SIZE / 2 + 1;
/** Σ w² over overlapping frames, for a periodic Hann at hop N/4. */
const OLA_NORM = 1.5;

export const HIGH_PASS_HZ = 80;
/** The quietest share of frames that defines "the room with nobody talking". */
export const NOISE_PERCENTILE = 0.1;
/** Frames quieter than this (~-120 dBFS) are digital silence, not room tone. */
const SILENCE_POWER = 1e-12;
export const DEESS_LOW_HZ = 4500;
export const DEESS_HIGH_HZ = 9000;
/** The de-esser ramps in over this width below DEESS_LOW_HZ, not as a wall. */
const DEESS_RAMP_HZ = 1000;
/** Share of a frame's energy in the sibilance band above which it is an "s". */
export const DEESS_THRESHOLD = 0.3;
/** Time constant of the power estimate's smoothing. */
const POWER_SMOOTH_S = 0.01;
/**
 * Time constants of a RISING and a FALLING gain, for the de-esser (the
 * noise gain is smoothed by its estimator instead). The attack is about one
 * hop:
 * fast enough to keep a consonant's onset, slow enough that one frame where
 * the noise happens to peak above its profile does not open the gain — an
 * instant attack with a slow release turns every such peak into 40 ms of
 * leaked hiss, which is what the first cut of this did.
 */
export const GAIN_ATTACK_S = 0.005;
export const GAIN_RELEASE_S = 0.04;
/** Decision-directed smoothing of the a-priori SNR (Ephraim & Malah's 0.98). */
const DD_WEIGHT = 0.98;
/** The de-esser's compression: the band's excess share is raised to this. */
const DEESS_EXPONENT = 0.4;

/** Everything one strength value turns into. */
export interface CleanupParams {
  highPass: boolean;
  /** How much the noise profile is over-estimated; 0 disables noise reduction. */
  noiseOversubtract: number;
  /** Deepest cut noise reduction can make to any bin, in dB (positive). */
  maxReductionDb: number;
  /** Deepest cut the de-esser can make, in dB (positive); 0 disables it. */
  deessMaxDb: number;
}

/**
 * The strength (0..1) fanned out into the chain. The ONE place that happens:
 * the switch-and-one-slider decision means every stage moves together.
 * 0 is an exact identity; out-of-range and non-finite values are clamped the
 * way `mixBlock` clamps a hand-edited level — a document cannot push past 1.
 */
export function paramsForStrength(strength: number): CleanupParams {
  const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
  if (s === 0) {
    return { highPass: false, noiseOversubtract: 0, maxReductionDb: 0, deessMaxDb: 0 };
  }
  // Rescaled after the first listening pass (2026-09-25): the old 50% was
  // "about right" for noise and 75/100% audibly damaged the voice, so 100%
  // here is roughly the old 50%, and every stage is gentler below it.
  return {
    highPass: true,
    // Fixed, not scaled: at 2x the pauses sit on the floor as a steady hiss
    // (measured: least bubbling of 1.5/2/2.5x), and the FLOOR sets how deep.
    noiseOversubtract: 2,
    maxReductionDb: 6 + 10 * s,
    deessMaxDb: 2 + 4 * s,
  };
}

/**
 * The cleaned track: same start, rate, channel count and length as `track`.
 * `overrides` exists for tests that need one stage alone.
 */
export function cleanNarration(
  track: PcmTrack, strength: number, overrides: Partial<CleanupParams> = {},
): PcmTrack {
  const p = { ...paramsForStrength(strength), ...overrides };
  const length = track.channels[0]?.length ?? 0;
  const identity = !p.highPass && p.noiseOversubtract === 0 && p.deessMaxDb === 0;
  if (identity || length === 0) {
    return { ...track, channels: track.channels.map((c) => Float32Array.from(c)) };
  }
  const rate = track.sampleRate;
  const input = track.channels.map((c) => {
    const x = Float64Array.from(c);
    if (p.highPass) highPassInPlace(x, rate, HIGH_PASS_HZ);
    return x;
  });
  const spectral = p.noiseOversubtract > 0 || p.deessMaxDb > 0;
  const out = spectral ? spectralStage(input, rate, p) : input;
  return { startNs: track.startNs, sampleRate: rate, channels: out.map((c) => Float32Array.from(c)) };
}

// ── 1. high-pass ──────────────────────────────────────────────────────────

/** RBJ cookbook biquad, Q = 1/√2 (Butterworth), direct form I, from rest. */
export function highPassInPlace(x: Float64Array, sampleRate: number, hz: number): void {
  const w0 = (2 * Math.PI * hz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0, b1 = -(1 + cos) / a0, b2 = b0;
  const a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
}

// ── 2–4. the shared STFT ──────────────────────────────────────────────────

/**
 * The input is padded by FFT_SIZE on both sides so every real sample is
 * covered by the full four overlapping frames, which is what makes the
 * window sum constant everywhere — including the first and last 21 ms.
 * Output sample i is input sample i: no latency, no shift.
 */
function spectralStage(input: Float64Array[], rate: number, p: CleanupParams): Float64Array[] {
  const length = input[0]!.length;
  const padded = input.map((c) => { const x = new Float64Array(length + 2 * FFT_SIZE); x.set(c, FFT_SIZE); return x; });
  const frames = Math.floor((padded[0]!.length - FFT_SIZE) / HOP) + 1;
  const win = hann(FFT_SIZE);
  const fft = makeFft(FFT_SIZE);

  const noise = p.noiseOversubtract > 0 ? noiseProfile(padded, frames, win, fft) : null;
  const floor = 10 ** (-p.maxReductionDb / 20);
  const deessFloor = 10 ** (-p.deessMaxDb / 20);
  const hopS = HOP / rate;
  const powerKeep = Math.exp(-hopS / POWER_SMOOTH_S);
  const attack = Math.exp(-hopS / GAIN_ATTACK_S);
  const release = Math.exp(-hopS / GAIN_RELEASE_S);
  const binHz = rate / FFT_SIZE;
  const lowBin = Math.ceil(HIGH_PASS_HZ / binHz);
  const deessWeight = new Float64Array(BINS);
  for (let k = 0; k < BINS; k++) {
    const hz = k * binHz;
    if (hz >= DEESS_LOW_HZ && hz <= DEESS_HIGH_HZ) deessWeight[k] = 1;
    else if (hz >= DEESS_LOW_HZ - DEESS_RAMP_HZ && hz < DEESS_LOW_HZ) deessWeight[k] = (hz - (DEESS_LOW_HZ - DEESS_RAMP_HZ)) / DEESS_RAMP_HZ;
  }

  const out = padded.map((c) => new Float64Array(c.length));
  const re = padded.map(() => new Float64Array(FFT_SIZE));
  const im = padded.map(() => new Float64Array(FFT_SIZE));
  const smoothed = new Float64Array(BINS);
  const gain = new Float64Array(BINS).fill(1);
  const noiseGain = new Float64Array(BINS).fill(1);
  const lastClean = new Float64Array(BINS); // the previous frame's estimated clean power, per bin
  let deessGain = 1;

  for (let f = 0; f < frames; f++) {
    const at = f * HOP;
    // Forward transforms, and the frame's power averaged over channels.
    const power = new Float64Array(BINS);
    for (let ch = 0; ch < padded.length; ch++) {
      const r = re[ch]!, i = im[ch]!, src = padded[ch]!;
      for (let n = 0; n < FFT_SIZE; n++) { r[n] = src[at + n]! * win[n]!; i[n] = 0; }
      fft(r, i, false);
      for (let k = 0; k < BINS; k++) power[k]! += (r[k]! * r[k]! + i[k]! * i[k]!) / padded.length;
    }
    for (let k = 0; k < BINS; k++) smoothed[k] = powerKeep * smoothed[k]! + (1 - powerKeep) * power[k]!;

    // Noise: a decision-directed Wiener gain per bin (Ephraim & Malah, 1984).
    // The a-priori SNR leans on the previous frame's CLEAN estimate, so a lone
    // frame where the noise happens to peak cannot open the gain. That is what
    // removes the "digital bubbling" (musical noise) the first cut had: power
    // subtraction left isolated spectral peaks in the pauses.
    for (let k = 0; k < BINS; k++) {
      const n = noise ? p.noiseOversubtract * noise[k]! : 0;
      if (!(n > 0)) { noiseGain[k] = 1; continue; }
      const posterior = power[k]! / n;
      const prior = DD_WEIGHT * (lastClean[k]! / n) + (1 - DD_WEIGHT) * Math.max(0, posterior - 1);
      const g = Math.max(floor, prior / (1 + prior));
      noiseGain[k] = g;
      lastClean[k] = g * g * power[k]!;
    }
    for (let k = 0; k < BINS; k++) {
      gain[k] = 0.25 * noiseGain[Math.max(0, k - 1)]! + 0.5 * noiseGain[k]! + 0.25 * noiseGain[Math.min(BINS - 1, k + 1)]!;
    }

    // De-essing: is this frame an "s"?
    let target = 1;
    if (p.deessMaxDb > 0) {
      let band = 0, total = 0;
      for (let k = lowBin; k < BINS; k++) { total += smoothed[k]!; if (deessWeight[k] === 1) band += smoothed[k]!; }
      const share = total > 0 ? band / total : 0;
      // Compress the band's share of the frame's energy toward the threshold.
      if (share > DEESS_THRESHOLD) target = Math.max(deessFloor, (DEESS_THRESHOLD / share) ** DEESS_EXPONENT);
    }
    // The reverse of the bins' gain: a cut engages fast and lets go slowly.
    const keepD = target >= deessGain ? release : attack;
    deessGain = keepD * deessGain + (1 - keepD) * target;

    // Apply, inverse, overlap-add.
    for (let ch = 0; ch < padded.length; ch++) {
      const r = re[ch]!, i = im[ch]!, dst = out[ch]!;
      for (let k = 0; k < BINS; k++) {
        const g = gain[k]! * (1 - deessWeight[k]! * (1 - deessGain));
        r[k]! *= g; i[k]! *= g;
        if (k > 0 && k < FFT_SIZE / 2) { r[FFT_SIZE - k]! *= g; i[FFT_SIZE - k]! *= g; }
      }
      fft(r, i, true);
      for (let n = 0; n < FFT_SIZE; n++) dst[at + n]! += (r[n]! * win[n]!) / OLA_NORM;
    }
  }
  return out.map((c) => c.subarray(FFT_SIZE, FFT_SIZE + length));
}

/**
 * The room with nobody talking: the per-bin mean power of the quietest
 * NOISE_PERCENTILE of frames, skipping digital silence (a take's leading
 * zeros would otherwise teach it that the room is silent). Null when there is
 * nothing to learn from — then only the high-pass and de-essing act.
 */
function noiseProfile(
  padded: Float64Array[], frames: number, win: Float64Array,
  fft: (re: Float64Array, im: Float64Array, inverse: boolean) => void,
): Float64Array | null {
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (const src of padded) for (let n = 0; n < FFT_SIZE; n++) { const v = src[f * HOP + n]! * win[n]!; e += v * v; }
    energy[f] = e / padded.length;
  }
  const audible = Array.from(energy).filter((e) => e > SILENCE_POWER * FFT_SIZE).sort((a, b) => a - b);
  if (audible.length === 0) return null;
  const threshold = audible[Math.floor(NOISE_PERCENTILE * (audible.length - 1))]!;
  const profile = new Float64Array(BINS);
  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
  let count = 0;
  for (let f = 0; f < frames; f++) {
    const e = energy[f]!;
    if (e <= SILENCE_POWER * FFT_SIZE || e > threshold) continue;
    for (const src of padded) {
      for (let n = 0; n < FFT_SIZE; n++) { re[n] = src[f * HOP + n]! * win[n]!; im[n] = 0; }
      fft(re, im, false);
      for (let k = 0; k < BINS; k++) profile[k]! += (re[k]! * re[k]! + im[k]! * im[k]!) / padded.length;
    }
    count++;
  }
  for (let k = 0; k < BINS; k++) profile[k]! /= count;
  return profile;
}

/** Periodic Hann: its squares overlap-add to exactly OLA_NORM at hop N/4. */
function hann(n: number): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
}

/**
 * In-place iterative radix-2 complex FFT of a fixed power-of-two size.
 * The inverse is scaled by 1/n, so forward-then-inverse is the identity.
 */
export function makeFft(n: number): (re: Float64Array, im: Float64Array, inverse: boolean) => void {
  const bits = Math.log2(n);
  if (!Number.isInteger(bits)) throw new Error(`FFT size must be a power of two, got ${n}`);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = Float64Array.from({ length: n / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / n));
  const sin = Float64Array.from({ length: n / 2 }, (_, i) => Math.sin((2 * Math.PI * i) / n));
  return (re, im, inverse) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
        const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step]!, wi = sign * sin[k * step]!;
          const a = start + k, b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr; im[b] = im[a]! - xi;
          re[a]! += xr; im[a]! += xi;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i]! /= n; im[i]! /= n; }
  };
}
