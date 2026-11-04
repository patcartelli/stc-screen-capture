/**
 * Hand an encoded chunk to the muxer, whether or not it says how long it lasts.
 *
 * The frames this repo encodes carry a timestamp and no duration. Through
 * Chrome 156 the encoder's chunks reported one anyway; on Chrome 157 they do
 * not, `addVideoChunk` refuses every one of them, and `finalize()` then dies on
 * the empty track (CI, 2026-11-03: `npm run gate`, on master too). This is
 * `addVideoChunk`'s own body with one frame's length standing in for a missing
 * duration, so a chunk that has one reaches the file exactly as it did before.
 */
interface VideoChunkSink {
  addVideoChunkRaw(data: Uint8Array, type: "key" | "delta", timestamp: number, duration: number,
                   meta?: EncodedVideoChunkMetadata): void;
}

export function muxVideoChunk(muxer: VideoChunkSink, chunk: EncodedVideoChunk,
                              meta: EncodedVideoChunkMetadata | undefined, fps: number): void {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, chunk.duration ?? Math.round(1_000_000 / fps), meta);
}
