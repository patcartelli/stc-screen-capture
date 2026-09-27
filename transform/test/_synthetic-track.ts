import type { DemuxedVideo } from "../src/demux.js";
import { memorySource, type ByteSource, type VideoChunkRef } from "../src/chunk-reader.js";

/**
 * A synthetic track: `n` chunks, a keyframe every `gop`, chunk i filled with
 * the byte (i % 251). A 3-byte gap is left before every chunk whose index is
 * a multiple of `gapEvery`, so a keyframe group is NOT one contiguous range —
 * the shape a real take has (6 discontinuities in a real 740-frame display.mp4).
 */
export function syntheticTrack(n = 30, gop = 10, gapEvery = 7): { buf: ArrayBuffer; chunks: VideoChunkRef[] } {
  const chunks: VideoChunkRef[] = [];
  let off = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % gapEvery === 0) off += 3;
    const size = 10 + (i % 7);
    chunks.push({ type: i % gop === 0 ? "key" : "delta", timestampUs: i * 16_667, offset: off, size });
    off += size;
  }
  const bytes = new Uint8Array(off);
  chunks.forEach((c, i) => bytes.fill(i % 251, c.offset, c.offset + c.size));
  return { buf: bytes.buffer, chunks };
}

/** A DemuxedVideo built from a syntheticTrack, for the frame-source tests. */
export function syntheticVideo(bytes?: (buf: ArrayBuffer) => ByteSource, n = 30, gop = 10): DemuxedVideo {
  const { buf, chunks } = syntheticTrack(n, gop);
  return {
    framesNs: chunks.map((c) => c.timestampUs * 1000),
    codec: "avc1.fake", codedWidth: 16, codedHeight: 16,
    description: new Uint8Array(0),
    chunks,
    bytes: bytes ? bytes(buf) : memorySource(buf, "synthetic.mp4"),
  };
}

/** A source whose reads wait until `release()` — an IPC round trip we control. */
export function gated(buf: ArrayBuffer): { src: ByteSource; started(): number; release(): void } {
  const inner = memorySource(buf, "synthetic.mp4");
  let open!: () => void;
  let started = 0;
  const gate = new Promise<void>((r) => { open = r; });
  return {
    src: { size: inner.size, read: async (o, l) => { started++; await gate; return inner.read(o, l); } },
    started: () => started,
    release: () => open(),
  };
}
