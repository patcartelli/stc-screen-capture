import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { decodeMicForMix, decodeSystemForMix } from "../src/decode-audio.js";
import type { DemuxedAudio } from "../src/demux-audio.js";
import type { PcmChunk } from "../src/audio-mix.js";
import { oracleTrackFromChunks, decoderChunks, sameTrack } from "./_pcm-oracle.js";

/**
 * STC-491: the decode path, driven by a FAKE `AudioDecoder` — Node has no
 * WebCodecs, and what is under test is not AAC but what decode-audio.ts does
 * with each output: copy it into its place, close it before the next one
 * arrives, and produce the very track the pre-STC-491 path (every `AudioData`
 * held to the flush, then `trackFromChunks`) would have.
 *
 * The fake emits one `AudioData`-shaped object per decoded chunk, each on its
 * own task (as a real decoder's output callbacks are), carrying the planes
 * `decoded` says that chunk decodes to.
 */
let decoded: PcmChunk[] = [];
let live = 0;
let maxLive = 0;
let opened = 0;
let closed = 0;
let decodersClosed = 0;

class FakeAudioData {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly timestamp: number;
  private open = true;
  constructor(private readonly c: PcmChunk) {
    this.numberOfFrames = c.channels[0]?.length ?? 0;
    this.numberOfChannels = c.channels.length;
    this.sampleRate = c.sampleRate;
    this.timestamp = c.timestampUs;
    opened++; live++; maxLive = Math.max(maxLive, live);
  }
  copyTo(dst: Float32Array, opts: { planeIndex: number; format: string }): void {
    if (!this.open) throw new Error("copyTo on a closed AudioData");
    expect(opts.format).toBe("f32-planar");
    expect(dst.length).toBe(this.numberOfFrames);
    dst.set(this.c.channels[opts.planeIndex]!);
  }
  close(): void { if (this.open) { this.open = false; live--; closed++; } }
}

class FakeAudioDecoder {
  state = "unconfigured";
  decodeQueueSize = 0;
  private next = 0;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly init: { output: (d: FakeAudioData) => void; error: (e: Error) => void }) {}
  configure(): void { this.state = "configured"; }
  decode(): void {
    const c = decoded[this.next++];
    // One output per task, in order — a real decoder's callbacks are tasks too.
    this.pending = this.pending.then(() => new Promise<void>((res) => setTimeout(() => {
      if (c && this.state !== "closed") this.init.output(new FakeAudioData(c));
      res();
    }, 0)));
  }
  flush(): Promise<void> { return this.pending; }
  close(): void { this.state = "closed"; decodersClosed++; }
}

const g = globalThis as any;
beforeEach(() => {
  live = maxLive = opened = closed = decodersClosed = 0;
  g.AudioDecoder = FakeAudioDecoder;
  g.EncodedAudioChunk = class { constructor(_: unknown) {} };
});
afterEach(() => { delete g.AudioDecoder; delete g.EncodedAudioChunk; });

/** The demuxed side: one encoded chunk per decoded chunk, on the same timestamps. */
function demuxed(chunks: PcmChunk[]): DemuxedAudio {
  return {
    framesNs: chunks.map((c) => c.timestampUs * 1000),
    codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: chunks[0]?.channels.length ?? 1,
    description: new Uint8Array([0x11, 0x88]),
    chunks: chunks.map((c) => ({ timestampUs: c.timestampUs, data: new Uint8Array(1) })),
  };
}

describe("decode-audio (STC-491): decoded straight into the track", () => {
  test("system: the same track as the old path, and no more than ONE AudioData alive at a time", async () => {
    decoded = decoderChunks(21, { rate: 48_000, channels: 2, count: 120 });
    const track = await decodeSystemForMix(demuxed(decoded));
    expect(sameTrack(track, oracleTrackFromChunks(decoded, "system.m4a"))).toBe(true);
    expect(maxLive).toBe(1);
    expect(closed).toBe(opened);
    expect(decodersClosed).toBe(1);
  });

  test("mic (raw): the same track as the old path", async () => {
    decoded = decoderChunks(22, { rate: 48_000, channels: 1, count: 120 });
    const track = await decodeMicForMix(demuxed(decoded), null);
    expect(sameTrack(track, oracleTrackFromChunks(decoded, "mic.m4a"))).toBe(true);
    expect(maxLive).toBe(1);
  });

  test("a mic decoded at a different rate than its container claims is sized from what DECODED", async () => {
    // export.ts's STC-233 note: the container's header and the bitstream are separate claims.
    decoded = decoderChunks(23, { rate: 44_100, channels: 1, count: 60 });
    const track = await decodeMicForMix(demuxed(decoded), null);
    expect(track!.sampleRate).toBe(44_100);
    expect(sameTrack(track, oracleTrackFromChunks(decoded, "mic.m4a"))).toBe(true);
  });

  test("a format change mid-take is refused with the old path's words, and every AudioData and the decoder are closed", async () => {
    decoded = decoderChunks(24, { rate: 48_000, channels: 1, count: 40 });
    decoded[25] = { ...decoderChunks(25, { rate: 48_000, channels: 2, count: 1 })[0]!, timestampUs: decoded[25]!.timestampUs };
    let want = "";
    try { oracleTrackFromChunks(decoded, "mic.m4a"); } catch (e: any) { want = e.message; }
    await expect(decodeMicForMix(demuxed(decoded), null)).rejects.toThrow(want);
    await new Promise((r) => setTimeout(r, 20)); // let any output still queued arrive
    expect(closed).toBe(opened);
    expect(decodersClosed).toBe(1);
  });

  test("a decoder that emits fewer chunks than it was given is refused, as before", async () => {
    decoded = decoderChunks(26, { rate: 48_000, channels: 2, count: 10 });
    const d = demuxed(decoded);
    d.chunks.push({ timestampUs: decoded[9]!.timestampUs + 30_000, data: new Uint8Array(1) });
    await expect(decodeSystemForMix(d)).rejects.toThrow(/decoded 10 audio chunks, expected 11/);
  });

  test("an empty track is no track", async () => {
    decoded = [];
    expect(await decodeSystemForMix(demuxed([]))).toBeNull();
  });
});
