import type { PcmChunk, PcmTrack } from "../src/audio-mix.js";

/**
 * `trackFromChunks` exactly as it was before STC-491, kept VERBATIM as the
 * oracle the new one-chunk-at-a-time path is held to. Never edit it to make a
 * test pass: the whole claim of STC-491 is "no sample changed", and that
 * claim is only as good as this copy is untouched.
 */
export function oracleTrackFromChunks(chunks: PcmChunk[], label: string): PcmTrack | null {
  if (chunks.length === 0) return null;
  const sorted = [...chunks].sort((a, b) => a.timestampUs - b.timestampUs);
  const first = sorted[0]!;
  const rate = first.sampleRate;
  const nch = first.channels.length;
  for (const c of sorted) {
    if (c.sampleRate !== rate || c.channels.length !== nch) {
      throw new Error(
        `${label}: decoded chunks are not uniform — ${nch}ch/${rate}Hz and ` +
        `${c.channels.length}ch/${c.sampleRate}Hz in one track`);
    }
  }
  const startUs = first.timestampUs;
  const offsetOf = (c: PcmChunk) => Math.round((c.timestampUs - startUs) * rate / 1e6);
  let length = 0;
  for (const c of sorted) length = Math.max(length, offsetOf(c) + (c.channels[0]?.length ?? 0));
  const out = Array.from({ length: nch }, () => new Float32Array(length));
  for (const c of sorted) {
    const at = offsetOf(c);
    for (let ch = 0; ch < nch; ch++) out[ch]!.set(c.channels[ch]!, at);
  }
  return { startNs: startUs * 1000, sampleRate: rate, channels: out };
}

/** A small deterministic PRNG, so a failing fuzz case reproduces from its seed. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Decoder-shaped chunks: AAC's 1024-frame blocks on timestamps rounded to
 * whole microseconds (demux-audio.ts's own rounding, so neighbours overlap or
 * gap by a rounding sample), with pauses, the occasional odd-sized block, and
 * a short last block — every case the placement rule has to agree on.
 */
export function decoderChunks(seed: number, opts: { rate: number; channels: number; count: number }): PcmChunk[] {
  const r = rng(seed);
  const out: PcmChunk[] = [];
  let frame = Math.floor(r() * 5000);
  for (let i = 0; i < opts.count; i++) {
    const last = i === opts.count - 1;
    const frames = last ? 1 + Math.floor(r() * 1024) : r() < 0.05 ? 1 + Math.floor(r() * 2048) : 1024;
    const jittered = Math.round((frame * 1e6) / opts.rate) + (r() < 0.1 ? Math.round(r() * 40 - 20) : 0);
    // A decoder's output never goes backwards (demux-audio.ts's timestamps only increase).
    const timestampUs = Math.max(jittered, out[out.length - 1]?.timestampUs ?? -Infinity);
    const channels = Array.from({ length: opts.channels }, () =>
      Float32Array.from({ length: frames }, () => r() * 2 - 1));
    out.push({ timestampUs, sampleRate: opts.rate, channels });
    frame += frames + (r() < 0.05 ? Math.floor(r() * 48_000) : 0);
  }
  return out;
}

/** Byte equality of two tracks — the same sample VALUES, length, start and rate. */
export function sameTrack(a: PcmTrack | null, b: PcmTrack | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.startNs !== b.startNs || a.sampleRate !== b.sampleRate || a.channels.length !== b.channels.length) return false;
  return a.channels.every((c, i) => {
    const d = b.channels[i]!;
    if (c.length !== d.length) return false;
    const x = new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
    const y = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
    return true;
  });
}
