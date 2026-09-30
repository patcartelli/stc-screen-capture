/**
 * The Audio pane's level meters (STC-460) — the pure half. No DOM, no Web
 * Audio, no clock.
 *
 * ## Decisions (Patrick's ticket defaults, 2026-09-30)
 *
 * 1. **Per track.** One meter for the mic, one for system audio.
 * 2. **What is HEARD.** Peaks are measured inside `mixBlock` (`MixPeaks`),
 *    after narration cleanup, level and mute, from the very samples the
 *    preview plays and the export encodes. There is no second audio path:
 *    this file only turns those numbers into something drawable.
 * 3. **Clip = the hard limit engaging.** A block whose mix, before the limit,
 *    went past full scale is a clip. It lights the tracks that contributed to
 *    it and holds for `CLIP_HOLD_MS`, because 25 ms is too short to see.
 * 4. **Ballistics.** Instant attack (a peak must never be missed), a steady
 *    fall on release so the bar is readable rather than a flicker.
 */

/** Quietest level a meter shows; everything below is an empty bar. */
export const METER_FLOOR_DB = -60;
/** Release speed of the bar, in dB per second. */
export const METER_RELEASE_DB_PER_S = 30;
/** How long a clip mark stays lit after the last clipped block. */
export const CLIP_HOLD_MS = 2000;
/** Frames per peak block: 25 ms at 48 kHz. */
export const METER_BLOCK_FRAMES = 1200;

/** Linear peak → dBFS, floored at `METER_FLOOR_DB` (silence is the floor, not -Infinity). */
export function peakToDb(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return METER_FLOOR_DB;
  return Math.max(METER_FLOOR_DB, 20 * Math.log10(peak));
}

/** dBFS → how full the bar is, 0..1 (floor → 0, 0 dBFS → 1). */
export function meterFill(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/** One 25 ms block of measured peaks, placed on the audio clock (seconds). */
export interface MeterBlock {
  startS: number;
  endS: number;
  mic: number;
  system: number;
  mix: number;
}

/** The block being heard at audio-clock time `tS`, or null (paused, stopped, or not yet scheduled). */
export function blockAt(blocks: readonly MeterBlock[], tS: number): MeterBlock | null {
  for (const b of blocks) if (tS >= b.startS && tS < b.endS) return b;
  return null;
}

/** One track's meter state between frames. */
export interface MeterState {
  /** Bar level in dBFS (already released). */
  db: number;
  /** Wall-clock ms until which the clip mark stays lit; 0 = not lit. */
  clipUntilMs: number;
}

export const METER_IDLE: MeterState = { db: METER_FLOOR_DB, clipUntilMs: 0 };

/**
 * Advance one meter by one frame. `peak` is the linear peak now being heard
 * (0 when nothing is playing), `clipped` whether that block engaged the limit
 * while this track contributed to it.
 */
export function meterStep(prev: MeterState, peak: number, clipped: boolean, nowMs: number, dtMs: number): MeterState {
  const target = peakToDb(peak);
  const fallen = prev.db - (METER_RELEASE_DB_PER_S * Math.max(0, dtMs)) / 1000;
  const db = Math.max(METER_FLOOR_DB, Math.max(target, fallen));
  const clipUntilMs = clipped ? nowMs + CLIP_HOLD_MS : prev.clipUntilMs > nowMs ? prev.clipUntilMs : 0;
  return { db, clipUntilMs };
}

/** Whether a track's clip mark is lit at `nowMs`. */
export function clipLit(state: MeterState, nowMs: number): boolean {
  return state.clipUntilMs > nowMs;
}

/** Where a slider's "as recorded" mark sits along the track, 0..1 (its unity % / 100). */
export function unityFraction(unityPct: number): number {
  return Math.min(1, Math.max(0, unityPct / 100));
}

/**
 * While DRAGGING, a slider within `radius` percent of as-recorded lands on it
 * exactly — a detent, so 0 dB is easy to hit. Only ever applied to a pointer
 * drag: a key press moves one step at a time and a snap there would make the
 * neighbouring steps unreachable.
 */
export function snapToUnity(pct: number, unityPct: number, radius = 2): number {
  return Math.abs(pct - unityPct) <= radius ? unityPct : pct;
}
