/**
 * An MP4 export's frame rate (STC-614): 60 or 30.
 *
 * **An export-time choice, not a project field** (Patrick, 2026-11-02), like
 * STC-615's Type: it never reaches `project.json`, so no schema moved and
 * `project.output.fps` stays the 60 fps export GRID that trim, the scrubber and
 * `exportFrameTimeNs` are built on. A rate here only chooses WHICH grid frames
 * a sink asks for — every `step`-th one, through `compositeFrames` — so a 30 fps
 * export's frames are exactly the 60 fps export's even frames, and the
 * transform does not know the rate exists.
 *
 * The rule a rate must keep is the GIF sink's (STC-395): it DIVIDES
 * `EXPORT_FPS`, or its frames would fall between grid frames and need a `t` no
 * preview ever samples.
 */
import { EXPORT_FPS } from "./time.js";

export const EXPORT_RATES = [60, 30] as const;
export type ExportRate = (typeof EXPORT_RATES)[number];
export const DEFAULT_EXPORT_RATE: ExportRate = 60;

/** Anything but 30 is the 60 fps default: a rate arrives over IPC or a query string, untrusted. */
export function cleanExportRate(v: unknown): ExportRate {
  return v === 30 || v === "30" ? 30 : DEFAULT_EXPORT_RATE;
}

/** Export-grid frames per output frame: 1 at 60 fps, 2 at 30. */
export function exportRateStep(rate: number): number {
  if (!(EXPORT_RATES as readonly number[]).includes(rate) || EXPORT_FPS % rate !== 0) {
    throw new Error(`${rate} is not an export frame rate (${EXPORT_RATES.join(", ")})`);
  }
  return EXPORT_FPS / rate;
}

/** Output frames for a window of `exportFrames` grid frames: the grid frames at 0, step, 2·step, … */
export function exportRateFrameCount(exportFrames: number, rate: number): number {
  return Math.ceil(Math.max(0, exportFrames) / exportRateStep(rate));
}
