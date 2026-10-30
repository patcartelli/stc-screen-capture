/**
 * The audio ceiling (STC-606, Figma 171:1546; decided by Patrick 2026-10-30).
 *
 * ## The decisions
 *
 * 1. **Limit peaks is a hard limit at the ceiling.** STC-418's rule (a plain
 *    sum, hard-limited, no compression) with the limit moved from full scale
 *    down to the ceiling. Off, the mix is limited at full scale exactly as
 *    before, so a take that never touched it mixes byte for byte as it did.
 * 2. **The ceiling is a guide either way.** The Audio lane's line and the
 *    "peaks over" count read the ceiling whether or not it limits: off, they
 *    show where the mix crosses it; on, where the limit acts.
 * 3. **A peak is a burst.** Consecutive waveform buckets over the ceiling are
 *    one peak, with one marker (`peaksOver`).
 *
 * project-18's `peakLimit`: `{ enabled, ceilingDb }`, written only when it
 * differs from the default. No imports, so the main process's write gate can
 * use `cleanPeakLimit` too (pip-style.ts's precedent).
 */

export interface PeakLimit {
  enabled: boolean;
  /** dBFS, CEILING_DB_MIN..CEILING_DB_MAX. */
  ceilingDb: number;
}

export const CEILING_DB_MIN = -12;
export const CEILING_DB_MAX = 0;
export const DEFAULT_PEAK_LIMIT: Readonly<PeakLimit> = Object.freeze({ enabled: false, ceilingDb: -1 });

/** A stored block, or null when it is malformed (the loader drops it; the write gate refuses it). */
export function cleanPeakLimit(v: unknown): PeakLimit | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") return null;
  const db = o.ceilingDb;
  if (typeof db !== "number" || !Number.isFinite(db) || db < CEILING_DB_MIN || db > CEILING_DB_MAX) return null;
  return { enabled: o.enabled, ceilingDb: db };
}

export function isDefaultPeakLimit(p: PeakLimit | undefined): boolean {
  return !p || (p.enabled === DEFAULT_PEAK_LIMIT.enabled && p.ceilingDb === DEFAULT_PEAK_LIMIT.ceilingDb);
}

/** The ceiling as a linear level (0..1): where the guide is drawn and peaks are counted. */
export function ceilingLevel(p: PeakLimit | undefined): number {
  const db = (p ?? DEFAULT_PEAK_LIMIT).ceilingDb;
  return Math.pow(10, Math.min(CEILING_DB_MAX, Math.max(CEILING_DB_MIN, db)) / 20);
}

/** What the mix is limited at: the ceiling when Limit peaks is on, full scale (1) otherwise. */
export function mixLimit(p: PeakLimit | undefined): number {
  return p?.enabled ? ceilingLevel(p) : 1;
}

/**
 * Float32 rounding margin, as waveform.ts's CLIP_PEAK: a bucket limited at the
 * ceiling reads the ceiling itself, which must count as reaching it.
 */
export const OVER_MARGIN = 0.999;

/**
 * The bursts of `peaks` (linear, one per bucket) at or over `level`: each run
 * of consecutive buckets is one peak, `[start, end)` in bucket indices.
 */
export function peaksOver(peaks: ArrayLike<number>, level: number): { start: number; end: number }[] {
  const at = level * OVER_MARGIN;
  const out: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i < peaks.length; i++) {
    const over = peaks[i]! >= at;
    if (over && start < 0) start = i;
    if (!over && start >= 0) { out.push({ start, end: i }); start = -1; }
  }
  if (start >= 0) out.push({ start, end: peaks.length });
  return out;
}

/** "−1 dB": the ceiling as the readout and the slider show it (a true minus sign). */
export function formatCeilingDb(db: number): string {
  const r = Math.round(db * 10) / 10;
  return `${r < 0 ? "−" : ""}${Math.abs(r)} dB`;
}
