/**
 * An MP4 export's Quality, and the File size estimate that follows it (STC-613).
 *
 * **An export-time choice, not a project field** (Patrick, 2026-11-02), like
 * STC-614's rate and STC-615's Type: it never reaches `project.json`.
 *
 * A level is BITS PER PIXEL PER FRAME, not a bitrate (Patrick, 2026-11-02), so
 * the encoder's bitrate is `width × height × rate × bpp`. Before this the
 * encoder asked for a flat 12 Mbps at every size and rate: a 4K export got a
 * quarter of 1080p's bits per pixel, and 30 fps spent 60 fps's budget on half
 * the frames. High is 0.1, which is ~12.4 Mbps at 1080p60, so an untouched
 * export at that size is what it was.
 *
 * The estimate is that bitrate, plus the audio track's, over the trimmed
 * length. WebCodecs encodes at a VARIABLE bitrate by default, and a still
 * screen costs far less than its budget, so a real file usually comes in
 * UNDER the estimate; it is a ceiling-ish guide, shown with "≈".
 */
export const EXPORT_QUALITIES = ["low", "medium", "high"] as const;
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];
export const DEFAULT_EXPORT_QUALITY: ExportQuality = "high";

/** Bits per pixel per frame. */
export const QUALITY_BPP: Record<ExportQuality, number> = { low: 0.04, medium: 0.07, high: 0.1 };

export const QUALITY_LABELS: Record<ExportQuality, string> = { low: "Low", medium: "Medium", high: "High" };

/** Anything not a level is High: a quality arrives over IPC, a query string or a slider, untrusted. */
export function cleanExportQuality(v: unknown): ExportQuality {
  return (EXPORT_QUALITIES as readonly unknown[]).includes(v) ? (v as ExportQuality) : DEFAULT_EXPORT_QUALITY;
}

/** The slider's stop for a level, and back. The slider is `0..EXPORT_QUALITIES.length - 1`. */
export const qualityIndex = (q: ExportQuality): number => EXPORT_QUALITIES.indexOf(q);
export function qualityAtIndex(i: unknown): ExportQuality {
  const n = Number(i);
  return Number.isInteger(n) ? cleanExportQuality(EXPORT_QUALITIES[n]) : DEFAULT_EXPORT_QUALITY;
}

/** The video encoder's target, bits per second. */
export function videoBitrate(width: number, height: number, rate: number, quality: ExportQuality): number {
  return Math.round(width * height * rate * QUALITY_BPP[quality]);
}

/**
 * The audio encoder's bitrate for each of `exportAudioPlan`'s paths: the mix
 * is stereo at 192k, which is what SystemAudioCapture records at; the mic-only
 * path keeps its own 128k. `export.ts` configures the encoder from THIS, so
 * the estimate cannot drift from it.
 */
export function audioBitrate(path: "mix" | "mic" | "none"): number {
  return path === "mix" ? 192_000 : path === "mic" ? 128_000 : 0;
}

export interface SizeEstimateInput {
  width: number; height: number; rate: number; quality: ExportQuality;
  audio: "mix" | "mic" | "none";
  /** The trimmed window's length. */
  durationNs: number;
}

/** Bytes, from the two bitrates over the trimmed length. Container overhead is not counted. */
export function estimateExportBytes(i: SizeEstimateInput): number {
  const bps = videoBitrate(i.width, i.height, i.rate, i.quality) + audioBitrate(i.audio);
  return Math.round((bps * Math.max(0, i.durationNs)) / 8e9);
}

/** "≈ 18.4 MB", the Figma frame's form: decimal units, as Finder shows them; GB from 1000 MB. */
export function formatSizeEstimate(bytes: number): string {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `≈ ${(mb / 1000).toFixed(1)} GB` : `≈ ${mb.toFixed(1)} MB`;
}
