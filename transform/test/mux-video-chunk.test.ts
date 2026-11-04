import { describe, test, expect, vi } from "vitest";
import { muxVideoChunk } from "../src/mux-video-chunk.js";

/** What a real chunk offers the muxer; `duration` is null on Chrome 157. */
function chunk(duration: number | null) {
  const bytes = [1, 2, 3];
  return {
    byteLength: bytes.length, type: "key", timestamp: 5000, duration,
    copyTo: (dest: Uint8Array) => dest.set(bytes),
  } as unknown as EncodedVideoChunk;
}

describe("muxVideoChunk", () => {
  const meta = {} as EncodedVideoChunkMetadata;

  test("a chunk with no duration is muxed as one frame long, at the export's rate", () => {
    const addVideoChunkRaw = vi.fn();
    muxVideoChunk({ addVideoChunkRaw }, chunk(null), meta, 60);
    expect(addVideoChunkRaw).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "key", 5000, 16667, meta);
    muxVideoChunk({ addVideoChunkRaw }, chunk(null), meta, 30);
    expect(addVideoChunkRaw.mock.lastCall![3]).toBe(33333);
  });

  test("a chunk that has a duration keeps it", () => {
    const addVideoChunkRaw = vi.fn();
    muxVideoChunk({ addVideoChunkRaw }, chunk(16666), meta, 60);
    expect(addVideoChunkRaw.mock.lastCall![3]).toBe(16666);
  });

  test("a duration of zero is a duration, not a missing one", () => {
    const addVideoChunkRaw = vi.fn();
    muxVideoChunk({ addVideoChunkRaw }, chunk(0), meta, 60);
    expect(addVideoChunkRaw.mock.lastCall![3]).toBe(0);
  });
});
