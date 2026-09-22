/**
 * Duration and dimensions, from HEADER BYTES ONLY (STC-413).
 *
 * Never reads a whole file. That is the constraint that keeps a 500-file
 * library scan affordable — STC-294's own acceptance criterion is 500 takes —
 * and it is why this module takes bytes rather than a path: the caller decides
 * how little to read, and `MP4_TAIL_PROBE_BYTES` tells it how much that is.
 *
 * Takes no capture id and knows nothing about one, deliberately: these facts
 * must be available for a FOREIGN file dropped into the folder by hand, which
 * carries no id at all.
 */
import { mp4BoxesIn, readBe32 } from "./media-tag.js";

export interface MediaFacts {
  width: number;
  height: number;
  /** Absent when the container declares no usable duration (any still). */
  durationMs?: number;
}

/**
 * How much of an MP4's tail to read before falling back to a front walk.
 *
 * `AVAssetWriter` and `mp4-muxer` both put `moov` at the END, so the tail is
 * where it is for every file this app produces. A faststart file from another
 * tool has it at the front, which the fallback covers.
 */
export const MP4_TAIL_PROBE_BYTES = 65536;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const be32 = (b: Uint8Array, at: number): number =>
  at + 4 <= b.length
    ? ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
    : 0;

const type4 = (b: Uint8Array, at: number): string =>
  String.fromCharCode(...b.subarray(at, at + 4));

export function probePng(bytes: Uint8Array): MediaFacts | undefined {
  if (bytes.length < 24 || !PNG_SIG.every((v, i) => bytes[i] === v)) return undefined;
  if (type4(bytes, 12) !== "IHDR") return undefined;
  const width = be32(bytes, 16), height = be32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Walk boxes within `[from, to)`, yielding `[type, payloadStart, payloadEnd]`.
 *
 * **Delegates to `media-tag.ts`'s walker rather than carrying a second one.**
 * A first draft of this module had its own copy, and it had the exact bug
 * that cost Task 3 a fix round: refusing a `size == 1` largesize instead of
 * reading it. This project's own `AVAssetWriter` writes `mdat` that way, so a
 * refusing walker stops at `mdat` and never reaches `moov` — and `probeMp4`
 * would quietly return `undefined` for every real capture the app has ever
 * made, which reads as "the probe is weak" rather than as a bug.
 *
 * Two walkers would be two places to get largesize right. There is one.
 */
function* boxes(b: Uint8Array, from: number, to: number):
    Generator<[string, number, number]> {
  for (const [type, start, size] of mp4BoxesIn(b, from, to)) {
    // media-tag yields [type, boxStart, totalSize]; this module wants the
    // PAYLOAD span, and a largesize box's payload begins 16 bytes in, not 8.
    const header = readBe32(b, start) === 1 ? 16 : 8;
    yield [type, start + header, start + size];
  }
}

/** Depth-first search for the first box of `type`. */
function find(b: Uint8Array, from: number, to: number, type: string,
              depth = 0): [number, number] | undefined {
  if (depth > 6) return undefined;             // containers here are shallow
  for (const [t, s, e] of boxes(b, from, to)) {
    if (t === type) return [s, e];
    if (CONTAINERS.has(t)) {
      const hit = find(b, s, e, type, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);

export function probeMp4(bytes: Uint8Array): MediaFacts | undefined {
  const moov = find(bytes, 0, bytes.length, "moov");
  if (!moov) return undefined;
  const [ms, me] = moov;

  let durationMs: number | undefined;
  const mvhd = find(bytes, ms, me, "mvhd");
  if (mvhd) {
    const [s] = mvhd;
    const v = bytes[s];
    const timescale = v === 1 ? be32(bytes, s + 20) : be32(bytes, s + 12);
    // A v1 duration is 64-bit; the low word is ample for any real take.
    const duration = v === 1 ? be32(bytes, s + 28) : be32(bytes, s + 16);
    if (timescale > 0 && duration > 0) durationMs = Math.round((duration / timescale) * 1000);
  }

  const tkhd = find(bytes, ms, me, "tkhd");
  if (!tkhd) return undefined;
  const [s] = tkhd;
  const at = bytes[s] === 1 ? s + 88 : s + 76;
  const width = Math.round(be32(bytes, at) / 65536);
  const height = Math.round(be32(bytes, at + 4) / 65536);
  if (width <= 0 || height <= 0) return undefined;

  return durationMs === undefined ? { width, height } : { width, height, durationMs };
}
