/**
 * A GIF's settings and the arithmetic they imply (STC-395). Pure and
 * Node-safe: `app/src/settings.ts` validates against these lists, and the
 * render window computes size, step and delays from them, so the two cannot
 * disagree about what a valid GIF setting is.
 *
 * Rates are the divisors of EXPORT_FPS that make sense for a GIF, so every
 * GIF frame IS an export frame (`render()` is never asked for a time off the
 * grid). GIF delays are whole centiseconds; 15 fps cannot be exact, so frame
 * ends are rounded cumulatively and the total never drifts.
 */
import { EXPORT_FPS } from "./time.js";
import { outputSizeFor } from "./output-size.js";
import type { Size } from "./spaces.js";

export const GIF_FPS_OPTIONS = [10, 12, 15, 20, 30] as const;
export type GifFps = (typeof GIF_FPS_OPTIONS)[number];

export const GIF_WIDTH_OPTIONS = [480, 640, 960, 1280, "original"] as const;
export type GifMaxWidth = (typeof GIF_WIDTH_OPTIONS)[number];

export interface GifSettings { fps: GifFps; maxWidth: GifMaxWidth }

export const DEFAULT_GIF_SETTINGS: GifSettings = { fps: 15, maxWidth: 960 };

export function cleanGifSettings(v: unknown): GifSettings {
  const d = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return {
    fps: (GIF_FPS_OPTIONS as readonly unknown[]).includes(d.fps)
      ? d.fps as GifFps : DEFAULT_GIF_SETTINGS.fps,
    maxWidth: (GIF_WIDTH_OPTIONS as readonly unknown[]).includes(d.maxWidth)
      ? d.maxWidth as GifMaxWidth : DEFAULT_GIF_SETTINGS.maxWidth,
  };
}

export function gifFrameStep(fps: GifFps): number {
  if (!(GIF_FPS_OPTIONS as readonly number[]).includes(fps) || EXPORT_FPS % fps !== 0) {
    throw new Error(`${fps} is not a GIF frame rate (${GIF_FPS_OPTIONS.join(", ")})`);
  }
  return EXPORT_FPS / fps;
}

export function gifFrameCount(exportFrames: number, fps: GifFps): number {
  return Math.ceil(Math.max(0, exportFrames) / gifFrameStep(fps));
}

export function gifDelaysCs(count: number, fps: GifFps): number[] {
  gifFrameStep(fps);
  const end = (i: number) => Math.round((i * 100) / fps);
  return Array.from({ length: count }, (_, i) => end(i + 1) - end(i));
}

export function gifSize(capture: Size, maxWidth: GifMaxWidth): Size {
  const cap = maxWidth === "original" ? capture.width : Math.min(maxWidth, capture.width);
  // Floor to even BEFORE outputSizeFor: its own `even()` rounds to nearest, so an
  // odd capture width (1513) would come back as 1514 — a one-pixel upscale.
  return outputSizeFor(capture, cap - (cap % 2));
}
