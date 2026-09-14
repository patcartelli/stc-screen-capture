import { decodeAll } from "./decode.js";
import type { DemuxedVideo } from "./demux.js";
import { computeChangeDocument } from "./changes.js";
import type { Changes } from "./changes.js";
import type { Frame } from "./frame-diff-rule.js";

/**
 * STC-322's post-recording pass, browser-dependent half.
 *
 * `computeChangeDocument` (changes.ts) is the pure reduction and is unit
 * tested directly; this file is the glue that feeds it real decoded frames —
 * `decodeAll` (needs WebCodecs) plus a canvas readback (needs an
 * OffscreenCanvas 2D context), same idiom `harness/main.ts`'s `makeCtx` /
 * `getImageData` already uses for hashing. Nothing here can run END TO END
 * against a real take in this repo's own Linux sandbox: demuxing and
 * everything up through `VideoDecoder.configure()` works (confirmed by
 * driving `harness/change-track.ts` against `fixtures/basic` with the
 * bundled Playwright Chromium), and it fails exactly where every gate here
 * already fails — `NotSupportedError: H.264 decoding is not supported`,
 * the same blocker STC-319/320 documented, not a new one. See the STC-322
 * finding doc for the confirmed error and what it does and does not prove.
 */

/**
 * Draws each decoded bitmap into a reused OffscreenCanvas and reads its RGBA
 * back. One canvas rather than one per frame — reused for every bitmap in
 * a take, since they all share the display track's coded size.
 *
 * Closes every bitmap after extraction, matching decode.ts's and
 * harness/main.ts's own "never buffer a VideoFrame/ImageBitmap" discipline
 * (PHASE-0 §4b) — at grid-reduction resolution this pass still needs the
 * FULL-resolution pixels to visit every source pixel once (STC-320's whole
 * point), so a 4K take's bitmaps are exactly as large as an export's.
 */
export function extractFrames(bitmaps: readonly ImageBitmap[]): Frame[] {
  if (bitmaps.length === 0) return [];
  const { width, height } = bitmaps[0]!;
  const ctx = new OffscreenCanvas(width, height).getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  }) as OffscreenCanvasRenderingContext2D;

  const frames: Frame[] = [];
  for (const bitmap of bitmaps) {
    if (bitmap.width !== width || bitmap.height !== height) {
      // A display track's coded size is fixed for the life of the take
      // (STC-306: a resolution change stops the take rather than rebuilding
      // mid-stream) — a mismatch here means this function was handed frames
      // from more than one take, which is a caller bug, not data to work
      // around silently.
      throw new Error(
        `extractFrames: frame size ${bitmap.width}x${bitmap.height} does not match the first frame's ${width}x${height}`,
      );
    }
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    // Copied out of the ImageData: the next drawImage call reuses the same
    // canvas backing store, and getImageData's own buffer is not guaranteed
    // to survive it.
    frames.push({ data: new Uint8ClampedArray(data), width, height });
    bitmap.close();
  }
  return frames;
}

export interface ComputeChangesOptions {
  threshold?: number;
  gridWidth?: number;
  gridHeight?: number;
}

/**
 * The whole pass: decode a take's display track, extract every frame's RGBA,
 * and reduce consecutive pairs into a changes.json document.
 *
 * Takes an already-demuxed `DemuxedVideo` (the same `demuxTrack` output
 * `loadSession` and the harness both already produce) rather than raw MP4
 * bytes, so a caller that has already loaded a session for preview/export
 * does not demux the display track twice.
 */
export async function computeChangesForVideo(
  video: DemuxedVideo,
  opts: ComputeChangesOptions = {},
): Promise<Changes> {
  const bitmaps = await decodeAll(video);
  const frames = extractFrames(bitmaps);
  return computeChangeDocument(frames, video.framesNs, opts);
}
