/**
 * The GIF sink (STC-395). Two passes over the ONE frame loop:
 *   1. palette: PALETTE_SAMPLES frames spread evenly across the window. The
 *      frame source is forward-only and decodes every frame on the way, so
 *      this pass costs a decode of the take; it composites only the samples.
 *   2. encode: every GIF frame, read back and handed to GifWriter.
 * Progress is one bar across both: pass 1 is the first quarter.
 *
 * The project is rendered at the GIF's own size (cursor and keycast drawn at
 * GIF scale, not shrunk afterwards); the trim applies exactly as for an MP4.
 */
import { compositeFrames } from "./export.js";
import { exportWindow, availableFrames } from "./trim.js";
import type { LoadedSession } from "./session.js";
import type { Project } from "./types.js";
import { type GifSettings, gifFrameStep, gifFrameCount, gifDelaysCs, gifSize } from "./gif-options.js";
import { buildPalette, GifWriter } from "./gif-encode.js";

export interface GifExportOptions {
  settings: GifSettings;
  /** done/total in "units" across both passes; the panel shows done/total as a percentage. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}
export interface GifExportResult {
  bytes: Uint8Array; frames: number; width: number; height: number;
  durationCs: number; elapsedMs: number;
}

export const PALETTE_SAMPLES = 8;
const PALETTE_SHARE = 0.25;

export async function exportGif(session: LoadedSession, project: Project,
                                opts: GifExportOptions): Promise<GifExportResult> {
  const t0 = performance.now();
  const size = gifSize(session.anchors.capture, opts.settings.maxWidth);
  const gp: Project = { ...project, output: { ...project.output, ...size } };
  const lastFrameNs = session.frames[session.frames.length - 1]!;
  // Exactly what exportSession does with the window.
  const clip = exportWindow(gp, lastFrameNs);
  const available = availableFrames(lastFrameNs, gp.output.fps);
  const from = Math.max(0, Math.min(clip.fromFrame, available - 1));
  const total = Math.min(clip.maxFrames, available - from);
  const step = gifFrameStep(opts.settings.fps);
  const count = gifFrameCount(total, opts.settings.fps);
  if (count === 0) throw new Error("the take has no frames to make a GIF from");
  // A GIF carries no colour profile and viewers assume sRGB, while the canvas may be
  // Display P3 (STC-510). getImageData defaults to the canvas's own space, so ask for
  // sRGB and let the browser convert. Every call returns a FRESH ImageData whose
  // array owns its whole buffer (offset 0), which gifenc requires — and which is
  // why pass 1 can keep the arrays it reads without copying them.
  const read = (ctx: OffscreenCanvasRenderingContext2D) =>
    ctx.getImageData(0, 0, size.width, size.height, { colorSpace: "srgb" }).data;
  const units = 1000;
  const report = (f: number) => opts.onProgress?.(Math.min(units, Math.round(f * units)), units);

  // Pass 1: sample frames, evenly spaced over the GIF frames (always includes frame 0).
  // CEIL, so there are at most PALETTE_SAMPLES of them: a floor gave 8-15 (a
  // 15-frame GIF sampled every frame), and at "original" on a 4K take each
  // sample is ~33 MB held until the palette is built.
  const sampleStep = Math.ceil(count / PALETTE_SAMPLES) * step;
  const samples: Uint8ClampedArray[] = [];
  for await (const { k, ctx } of compositeFrames(session, gp,
      { from, total, step: sampleStep, readback: true, signal: opts.signal })) {
    samples.push(read(ctx));
    report((PALETTE_SHARE * (k + 1)) / total);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
  const delays = gifDelaysCs(count, opts.settings.fps);
  const writer = new GifWriter(size.width, size.height, buildPalette(samples), delays);
  samples.length = 0;

  // Pass 2: every GIF frame.
  for await (const { i, ctx } of compositeFrames(session, gp,
      { from, total, step, readback: true, signal: opts.signal })) {
    writer.addFrame(read(ctx));
    if (i % 5 === 0) {
      report(PALETTE_SHARE + ((1 - PALETTE_SHARE) * (i + 1)) / count);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
  const bytes = writer.finish();
  report(1);
  return { bytes, frames: count, ...size, durationCs: delays.reduce((a, b) => a + b, 0),
           elapsedMs: Math.round(performance.now() - t0) };
}
