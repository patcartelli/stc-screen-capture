import { ZOOM_PRESETS, ZOOM_PRESET_NAMES, type ZoomEasing, type ZoomPreset } from "./zoom.js";

/**
 * A zoom block's easing as SAVED (STC-619): either one preset name, or separate
 * speeds for pushing IN and releasing OUT, so a block can zoom in slowly and
 * zoom out fast.
 *
 * `zoom.ts` already runs the two directions on independent shoulders (STC-371:
 * a preset is `{ in, out }`, and the sim picks one by which way the target is
 * pulling), so there is no new spring here. A speed is a preset NAME, and it
 * supplies that preset's shoulder for ITS direction: `in: "calm"` is calm's
 * in-shoulder, `out: "snappy"` is snappy's out-shoulder. The three names are
 * the user-facing Slow / Medium / Fast.
 *
 * ```
 * "standard"                  both directions standard's own (today's behaviour)
 * { in: "calm", out: "snappy" }   slow in, fast out
 * { in: "calm" }              slow in; out falls back to the project's preset
 * ```
 *
 * A side left out falls back to the project's preset, exactly as a block with
 * no easing at all always has. A MANUAL window has nothing to fall back to
 * (types.ts: its easing is required), so its easing is complete: a name, or
 * both sides.
 *
 * This is the one place the shape is decided. `trim.ts` (the loader), main's
 * write gate, the resolution in `zoom-override.ts` and the editor's controls
 * all go through it; `main.ts` can import it because it needs only `zoom.ts`.
 */
export interface SpeedPair { in?: ZoomPreset; out?: ZoomPreset }
export type EasingSpec = ZoomPreset | SpeedPair;

/** An easing with both sides decided: what resolution produces, and what a manual window saves. */
export interface EasingPair { in: ZoomPreset; out: ZoomPreset }
export type CompleteEasing = ZoomPreset | EasingPair;

export const isPreset = (v: unknown): v is ZoomPreset => ZOOM_PRESET_NAMES.includes(v as ZoomPreset);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A speed pair's own shape: only `in` and `out`, each a preset name when present. */
function isSpeedPairShape(v: unknown): v is SpeedPair {
  if (!isObject(v)) return false;
  if (!Object.keys(v).every((k) => k === "in" || k === "out")) return false;
  return (v.in === undefined || isPreset(v.in)) && (v.out === undefined || isPreset(v.out));
}

/** A geometry override's easing: a name, or a pair naming at least one side. */
export function isEasingSpec(v: unknown): v is EasingSpec {
  if (isPreset(v)) return true;
  return isSpeedPairShape(v) && (v.in !== undefined || v.out !== undefined);
}

/** A manual window's easing: a name, or BOTH sides. */
export function isCompleteEasing(v: unknown): v is CompleteEasing {
  if (isPreset(v)) return true;
  return isSpeedPairShape(v) && v.in !== undefined && v.out !== undefined;
}

/** True for the object form: the one that needs a project version a plain name does not. */
export const isPairEasing = (v: unknown): v is SpeedPair => isObject(v);

/**
 * The saved form of what the controls chose. Nothing chosen is no easing; both
 * sides the same is that preset's NAME (a pair of equal sides IS the preset, so
 * it is written the way every older document writes it and needs no newer
 * version); anything else is an object holding only the sides that were set.
 */
export function normalizeEasing(pair: SpeedPair): EasingSpec | undefined {
  if (pair.in === undefined && pair.out === undefined) return undefined;
  if (pair.in !== undefined && pair.in === pair.out) return pair.in;
  const out: SpeedPair = {};
  if (pair.in !== undefined) out.in = pair.in;
  if (pair.out !== undefined) out.out = pair.out;
  return out;
}

/** The sides of a saved easing, as the controls show them. A name is both sides. */
export function speedsOf(spec: EasingSpec | undefined): SpeedPair {
  if (spec === undefined) return {};
  if (isPreset(spec)) return { in: spec, out: spec };
  return { ...(spec.in !== undefined ? { in: spec.in } : {}), ...(spec.out !== undefined ? { out: spec.out } : {}) };
}

/** Each side decided: a missing side is the fallback (the project's preset). */
export function resolveEasing(spec: EasingSpec | undefined, fallback: ZoomPreset): EasingPair {
  const s = speedsOf(spec);
  return { in: s.in ?? fallback, out: s.out ?? fallback };
}

/** Blocks with the same pair share a spring (zoom-override.ts's grouping); this is the group's identity. */
export const easingKey = (p: EasingPair): string => `${p.in}/${p.out}`;

/** The shoulders the sim steps with: that preset's in-shoulder, and that preset's out-shoulder. */
export const zoomEasingOf = (p: EasingPair): ZoomEasing => ({ in: ZOOM_PRESETS[p.in].in, out: ZOOM_PRESETS[p.out].out });
