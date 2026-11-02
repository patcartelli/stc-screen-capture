/**
 * The editor's export Type (STC-615): what Export and Copy produce. Pure and
 * Node-free, so the renderer, the preload's callers and main can share the one
 * validator and the one set of sentences.
 *
 * **Type is an export-time choice, not a saved project field** (Patrick,
 * 2026-11-02): it never reaches `project.json`, so no schema moved and a take
 * opens as an MP4 export every time. A GIF's own options (rate, max width) are
 * the app's `settings.gif` — the same ones the panel and Settings edit
 * (STC-395) — not a second copy of them here.
 */
import { gifSize, type GifSettings } from "@transform/gif-options";
import type { Size } from "@transform/spaces";

export const EXPORT_TYPES = ["mp4", "gif"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];
export const DEFAULT_EXPORT_TYPE: ExportType = "mp4";

/** Anything but "gif" is the MP4 default: main takes this off IPC, where a type is untrusted. */
export function cleanExportType(v: unknown): ExportType {
  return v === "gif" ? "gif" : DEFAULT_EXPORT_TYPE;
}

/** The Export button's label. */
export function exportButtonLabel(type: ExportType): string {
  return type === "gif" ? "Export GIF" : "Export";
}

/**
 * What a GIF export will be, in the Format group: its size (the max width
 * capped at the capture, `gifSize`) and rate. The trim and the project's output
 * size do not enter: a GIF is sized by its own width setting.
 */
export function gifFormatNote(capture: Size, settings: GifSettings): string {
  const s = gifSize(capture, settings.maxWidth);
  return `${s.width}×${s.height} · ${settings.fps} fps`;
}

/** The line after a GIF export: where it went and what it is. */
export function gifSavedLine(name: string, frames: number, bytes: number): string {
  const size = bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  return `Saved ${name} — ${frames} frames, ${size}`;
}

/** A GIF file starts with one of these; the writer refuses anything else rather than name it .gif. */
export function looksLikeGif(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 6) return false;
  const head = String.fromCharCode(...bytes.subarray(0, 6));
  return head === "GIF89a" || head === "GIF87a";
}
