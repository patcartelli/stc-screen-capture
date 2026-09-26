import { describe, test, expect } from "vitest";
import { ChunkReader, memorySource, type ByteSource, type VideoChunkRef } from "../src/chunk-reader.js";

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

/** Wraps a source and records every read. */
function counting(src: ByteSource): ByteSource & { reads: [number, number][] } {
  const reads: [number, number][] = [];
  return { size: src.size, reads, read: (o, l) => { reads.push([o, l]); return src.read(o, l); } };
}

describe("memorySource", () => {
  test("returns exactly the requested bytes", async () => {
    const src = memorySource(new Uint8Array([1, 2, 3, 4, 5]).buffer, "t.mp4");
    expect([...(await src.read(1, 3))]).toEqual([2, 3, 4]);
    expect(src.size).toBe(5);
  });
  test("a read past the end throws, naming the file and range", async () => {
    const src = memorySource(new Uint8Array(5).buffer, "t.mp4");
    await expect(src.read(3, 4)).rejects.toThrow(/t\.mp4.*\[3, 7\).*5-byte/);
    await expect(src.read(-1, 1)).rejects.toThrow(/t\.mp4/);
  });
});

describe("ChunkReader", () => {
  test("groupOf finds the keyframe group", () => {
    const { buf, chunks } = syntheticTrack();
    const r = new ChunkReader(chunks, memorySource(buf, "t"), "t");
    expect(r.groupOf(0)).toEqual({ start: 0, end: 10 });
    expect(r.groupOf(9)).toEqual({ start: 0, end: 10 });
    expect(r.groupOf(10)).toEqual({ start: 10, end: 20 });
    expect(r.groupOf(29)).toEqual({ start: 20, end: 30 });
  });

  test("returns each chunk's own bytes, across group boundaries", async () => {
    const { buf, chunks } = syntheticTrack();
    const r = new ChunkReader(chunks, memorySource(buf, "t"), "t");
    const got = await r.read(8, 5);            // spans groups 0 and 1
    expect(got.length).toBe(5);
    got.forEach((b, k) => {
      expect(b.byteLength).toBe(chunks[8 + k]!.size);
      expect(b.every((x) => x === (8 + k) % 251)).toBe(true);
    });
  });

  test("one read per contiguous run, never one blind range per group", async () => {
    const { buf, chunks } = syntheticTrack(10, 10, 7);   // one group, a gap before chunk 7
    const src = counting(memorySource(buf, "t"));
    await new ChunkReader(chunks, src, "t").read(0, 1);
    expect(src.reads).toEqual([
      [chunks[0]!.offset, chunks[6]!.offset + chunks[6]!.size - chunks[0]!.offset],
      [chunks[7]!.offset, chunks[9]!.offset + chunks[9]!.size - chunks[7]!.offset],
    ]);
  });

  test("cache hit: scrubbing inside one group does not re-read it", async () => {
    const { buf, chunks } = syntheticTrack();
    const src = counting(memorySource(buf, "t"));
    const r = new ChunkReader(chunks, src, "t");
    await r.read(3, 1);
    const after = src.reads.length;
    await r.read(0, 2);
    await r.read(9, 1);
    expect(src.reads.length).toBe(after);
  });

  test("keeps at most MAX_CACHED_GROUPS groups", async () => {
    const { buf, chunks } = syntheticTrack();
    const src = counting(memorySource(buf, "t"));
    const r = new ChunkReader(chunks, src, "t");
    expect(ChunkReader.MAX_CACHED_GROUPS).toBe(2);
    await r.read(0, 1); await r.read(10, 1); await r.read(20, 1);   // group 0 evicted
    const before = src.reads.length;
    await r.read(0, 1);
    expect(src.reads.length).toBeGreaterThan(before);
  });

  test("prefetch issues the group's reads before anyone asks", async () => {
    const { buf, chunks } = syntheticTrack();
    const src = counting(memorySource(buf, "t"));
    const r = new ChunkReader(chunks, src, "t");
    r.prefetch(15);
    expect(src.reads.some(([o]) => o === chunks[10]!.offset)).toBe(true);
    const before = src.reads.length;
    await r.read(12, 2);
    expect(src.reads.length).toBe(before);
  });

  test("a failed read is not cached: the next read tries again", async () => {
    const { buf, chunks } = syntheticTrack();
    const good = memorySource(buf, "t");
    let fail = true;
    const flaky: ByteSource = { size: good.size, read: (o, l) => fail ? Promise.reject(new Error("t: gone")) : good.read(o, l) };
    const r = new ChunkReader(chunks, flaky, "t");
    await expect(r.read(0, 1)).rejects.toThrow("t: gone");
    fail = false;
    expect((await r.read(0, 1))[0]!.byteLength).toBe(chunks[0]!.size);
  });

  test("a failed prefetch surfaces on the next read, not as an unhandled rejection", async () => {
    const { chunks } = syntheticTrack();
    const broken: ByteSource = { size: 1e6, read: () => Promise.reject(new Error("t: gone")) };
    const r = new ChunkReader(chunks, broken, "t");
    r.prefetch(0);
    await expect(r.read(0, 1)).rejects.toThrow("t: gone");
  });

  test("out-of-range requests throw", async () => {
    const { buf, chunks } = syntheticTrack();
    const r = new ChunkReader(chunks, memorySource(buf, "t"), "t");
    await expect(r.read(-1, 1)).rejects.toThrow(/out of range/);
    await expect(r.read(29, 2)).rejects.toThrow(/out of range/);
    await expect(r.read(0, 0)).rejects.toThrow(/out of range/);
  });
});
