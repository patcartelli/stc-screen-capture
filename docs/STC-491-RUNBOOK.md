# STC-491 runbook — the audio decode peak

Branch: `accounts/stc-491-audio-decode-peak-preview-rss-is-65x-the-pcm-it-keeps` until merged, then `master`.

## What changed

- `decode-audio.ts`'s `decodeMicForMix`/`decodeSystemForMix` (still the ONE producer of each track)
  decode straight into the contiguous track. Each `AudioData` is copied into its place and closed
  INSIDE the decoder's output callback, so the track is the only full copy of the audio that ever
  exists. Before, three copies were alive at the load's peak: every `AudioData` held until the
  flush, a `Float32Array` per chunk (`pcmTrackOf`, now gone), then the contiguous track.
- `audio-mix.ts`'s `PcmTrackBuilder` does the placing. It applies `trackFromChunks`'s rule one chunk
  at a time, and `trackFromChunks` is now built on it. The track is sized at the first decoded
  chunk from the demuxed sample table's last timestamp, at the DECODED rate (the container's rate
  is a separate claim, export.ts STC-233). It grows if the guess was short and is trimmed to a
  view of its exact length if the guess was long.
- A mid-take rate or channel change is refused with the old path's own message, at the chunk where
  it happens. A chunk earlier than its predecessor is refused rather than placed under a different
  overwrite order (WebCodecs emits in order; demuxed timestamps only increase).
- `export.ts`'s mic-only passthrough still uses `decodeAllAudio`: it re-encodes the `AudioData`
  themselves and needs no PCM track.
- `measure-preview-memory.mjs` sets `STC_ASSUME_PERMISSIONS=granted`. Without it, the STC-476
  permissions sheet covers the window and swallows the Preview click.

## Samples did not change

`transform/test/_pcm-oracle.ts` keeps the pre-STC-491 `trackFromChunks` verbatim. The builder and
the new `trackFromChunks` are held to it byte for byte, across 120 random decoder-shaped tracks
(mono/stereo, 48/44.1 kHz, rounding overlaps, pauses, odd and short blocks) and across size
guesses that are too small, too large or absent. `transform/test/decode-audio.test.ts` drives
the real decode path through a fake `AudioDecoder`. It checks four things: the track equals the
oracle's, at most ONE `AudioData` is alive at a time (the old path held all of them), a format
change mid-take rejects with the old words and closes every `AudioData` and the decoder, and a
short decoder output is still refused.

## Measured

2026-10-16, dev Mac (host). The take is synthetic, made by `scripts/make-long-audio-take.mjs
fixtures/basic 30 <out>`: 30 min of mono mic + stereo system at 48 kHz, `mic.m4a` 14.5 MB and
`system.m4a` 23.1 MB. The command was `node scripts/measure-preview-memory.mjs <out>/basic-long30m`,
run on master and on this branch in alternation (master from a detached `origin/master` worktree
with this branch's copy of the script). Every sample settled by forced `gc()`. The take has no
camera, so the script's two rows are the same configuration and each run gives two samples.

| renderer RSS growth, cleanup off | samples | range | median |
|---|---|---|---|
| master (`54792a7`) | 12 | +3056 .. +4633 MB | ~+3.6 GB |
| this branch (parallel decode) | 6 | +1529 .. +1564 MB | **+1532 MB** |
| this branch, mic then system sequentially | 6 | +1516 .. +1629 MB | +1570 MB |

- **The peak fell by more than half and stopped wandering.** Master's growth varies by 1.6 GB from
  run to run, set by how far the load's transient copies happened to pile up. The branch's varies
  by 35 MB.
- **Sequential decoding did not help**, so it was not kept. With one copy per track there is no
  longer a transient peak for parallel decoding to stack.
- **What remains is ~1.5x the PCM floor.** That floor is 1.04 GB of float32 for this take. The
  rest, ~0.5 GB, is not three copies of PCM any more. It is the demuxed compressed samples (mp4box
  sample objects and their bytes, held by the session), the `EncodedAudioChunk`s queued into the
  decoder, and the decoder's own buffers. None of it was measured stage by stage.
- Master measured +3.1–4.6 GB here against STC-469's +6.7 GB on 2026-10-01. The take differs (a
  5 s fixture display against a real 13 s take) and so do the Electron build and the day. Compare
  rows within one table, never across runbooks.

### A real take (runbook item 1, 2026-10-16)

Patrick's own take `2026-10-16_13-22-55`: 25:50, system audio only (stereo, 48 kHz, `system.m4a`
37 MB, no mic), `display.mp4` 2.05 GB. It stopped itself with `stop.reason: "error"`, which is
unrelated to this ticket. Same command, master from a detached `origin/master` worktree (`79c8cce`)
with this branch's script.

| renderer RSS growth | samples |
|---|---|
| master (`79c8cce`) | +3508, +3859 MB |
| **this branch** | **+1047, +1048 MB** |

The decoded audio floor here is ~595 MB (1550 s x 48 000 x 2 ch x 4 B). The branch's +1047 MB
includes the 2 GB display read by range, which STC-236 measured at ~+143 MB on another take.
That leaves ~0.9 GB for audio, ~1.5x its floor: the synthetic take's ratio, on a real AAC file.

## STC-490

STC-490 is the temp-file PCM cache. It is no longer needed to fix this peak; this ticket fixed it.
What it would still remove is the PCM floor itself, ~34.5 MB/min for mono mic + stereo system,
now ~51 MB/min of RSS all in. That is ~1.5 GB at 30 min and ~3 GB at an hour. Whether that floor
is acceptable is a product call about how long takes get, not a defect.

## What only a Mac can settle

1. ~~A real long take~~ — done for system audio alone (25:50, above). A real take WITH a mic is
   still unmeasured; it is expected to land on the same ~1.5x.
2. Preview sound on a long take, by ear: it starts, it is in sync, and cleanup on/off still
   switches. The decode path changed underneath it, though no sample did.
