# STC-236 — stream the preview's video by range (redirected from "N-minute segmentation")

Date: 2026-09-26. Status: design approved in chat, spec awaiting review.
Branch: `accounts/stc-236-n-minute-segmentation`. Related: STC-251 (the ceiling this removes), STC-307 (`recording.json`), STC-394 (fragmented-file PTS chain).

## Why the ticket was redirected

STC-236 was filed 2026-08-25 with three motivations. Checked against the code on 2026-09-26:

| motivation | status |
|---|---|
| `AVAssetWriter` holds video in memory until finalized → OOM on long takes | **no evidence.** The writer streams to disk; the 5-minute smoke test (9311 frames, 0 dropped) showed no growth and nothing in the repo measures one |
| crash recovery: only the last segment is lost | **already solved, better.** Every writer sets `movieFragmentInterval` = 2 s (`CaptureDecisions.swift` `movieFragmentIntervalSec`, tested by `helper/test/fragmented-writer.test.ts`): a kill loses ≤ ~2 s. Segments would lose up to N minutes |
| preview loads the whole video (+548 MB RSS for a 458 MB take; ~15 min at 4K is the ceiling) | **real** — this is STC-251, and it lives entirely in how the editor reads the file |

The one live problem does not need the file split on disk. Patrick chose (2026-09-26) to redirect STC-236 to streaming the preview. Segmentation stays deferred; `recording.json` keeps its re-take purpose (STC-235/307).

## Goal and success criterion

The editor (preview AND export, which run in the same renderer) never holds a whole `display.mp4` or `camera.mp4` in memory. It holds a sample index (tens of bytes per frame) and the bytes of the frames it is about to decode.

**Done means:** renderer RSS growth while previewing a take is roughly independent of the take's length, measured with `scripts/measure-preview-memory.mjs` (RSS via `app.getAppMetrics()`, never `performance.memory`) on a short and a long take on a Mac, and quoted as absolute growth (CORRECTNESS-TRAPS: ratios are regime-dependent). Preview scrub, playback and export behave exactly as today.

## Feasibility — measured, not assumed

A throwaway probe (2026-09-26, not committed) walked each file's top-level boxes and fed mp4box every box whole EXCEPT `mdat`, of which it got only the 8/16-byte header, with `discardMdatData = true`. mp4box skips to the next box (`appendBuffer` returns the post-`mdat` position) and builds `trak.samples` from `moov` alone:

| file | size | bytes fed | samples | byte mismatches vs full demux |
|---|---|---|---|---|
| real take `display.mp4` | 46.0 MB | 10.9 KB | 740 | 0 |
| real take `camera.mp4` | 11.5 MB | 2.7 KB | 342 | 0 |
| `fixtures/{basic,pip}` (3 files) | ~84–112 KB | ~1.3 KB each | 90–118 | 0 |

"Mismatch" = reading `size` bytes at `trak.samples[i].offset` from disk differs from the full demux's `samples[i].data`, or `is_sync`/`duration` differ. **Samples are NOT always contiguous within a GOP** (6 discontinuities in the real `display.mp4`, 5 in `camera.mp4`), so reads must follow the index, never assume one run per GOP.

Not probed: a crash-recovered fragmented file (`moov` + `moof`/`mdat` pairs), because none exists on disk. The design feeds every `moof` whole and skips every `mdat` body the same way; the plan must test it (see Testing).

## Design

### 1. `demuxTrack` builds the index from boxes, not bytes

`transform/src/demux.ts`:

```ts
export interface ByteSource {
  readonly size: number;
  /** Exactly `length` bytes at `offset`, or throws. Never short, never padded. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface VideoChunkRef {
  type: "key" | "delta";
  timestampUs: number;
  offset: number;   // absolute file offset
  size: number;
}

export interface DemuxedVideo {
  framesNs: number[];
  codec: string; codedWidth: number; codedHeight: number;
  description: Uint8Array;
  chunks: VideoChunkRef[];     // was { ...; data: Uint8Array }[]
  bytes: ByteSource;           // where chunk bytes come from
}

export function demuxTrack(src: ByteSource, what: string): Promise<DemuxedVideo>;
```

- Walk top-level boxes by reading 16-byte headers (`size`, `type`, 64-bit `largesize` when `size === 1`, to-end when `size === 0`). Refuse a box whose extent runs past `src.size` or has `size < 8` — a truncated or corrupt file fails loudly, as today.
- Feed mp4box every non-`mdat` box whole at its real `fileStart`; feed `mdat` its header only. `discardMdatData = true`.
- Read the index from `trak.samples` (`offset`, `size`, `is_sync`, `duration`, `cts`, `timescale`) instead of `setExtractionOptions`/`onSamples`.
- Everything that decides TIME is unchanged and stays in this function: the empty-edit offset, PTS chained from per-sample `duration` (STC-394), the integer-ns check, the "no track / no avcC / not an MP4" refusals, the watchdog.
- `session.ts`'s `SessionInput.displayMp4` / `cameraMp4` become `ByteSource`. Audio inputs (`micM4a`, `systemM4a`) stay `ArrayBuffer` — out of scope.

`demux-audio.ts` is untouched.

### 2. `chunk-reader.ts` — the one place chunk bytes come from

`transform/src/chunk-reader.ts`, no DOM, no Electron, Node-testable:

- `memorySource(buf: ArrayBuffer): ByteSource` — for Node tests, the harness, the gates, and `decodeAll`.
- `class ChunkReader { constructor(video: DemuxedVideo); read(first: number, count: number): Promise<Uint8Array[]> }` — returns chunk bytes for indices `[first, first+count)`. Coalesces index-adjacent chunks whose byte ranges touch into one `ByteSource.read`, issues one read per discontinuous run, and slices results per chunk. A small LRU keyed by run start (cap: 2 GOPs' worth) so a scrub back and forth inside one GOP does not refetch.
- Bounds: `first`/`count` outside `chunks` throws; the LRU's byte cap is a named constant with its reasoning in its comment.

`app/src/editor.ts` gets `ipcSource(name): Promise<ByteSource>` over the existing `takeFileSize` (`preview:size`) and `readTakeChunk` (`preview:chunk`). `preview:chunk` returns fewer bytes than asked at EOF (`bytesRead`), so `ipcSource.read` checks the length and throws with the file name and offset rather than handing a short chunk to the decoder. The renderer still never names a path; no new IPC channel; `readVideo` stays only for the audio files.

### 3. Frame sources fetch before they feed

`SeekingFrameSource` (preview) and `ForwardFrameSource` (export) each own a `ChunkReader` and `await` bytes before `decoder.decode(...)`. Their PHASE-0 §4b rules are unchanged: one in-flight request, supersession returns null, the bounded 50 ms wait, close-on-supersede.

- **Seeking:** `restartAt(key)` / `pump(target)` fetch `[nextFeed, min(feedLimit, keyframe-group end)]` in one `ChunkReader.read` before feeding. A superseded ticket that is awaiting bytes returns null without touching the decoder (check `mine !== this.ticket` after every await).
- **Forward (export):** prefetch the next GOP's bytes while the current one decodes, so export does not stall on an IPC round trip per GOP. At most two GOPs of encoded bytes held.
- `decodeAll` (`decode.ts`, used by `harness/main.ts` and `change-track.ts`) reads through a `ChunkReader` too; its callers pass `memorySource`.

### 4. Determinism

The bytes handed to `EncodedVideoChunk` are identical whichever source produced them, so `render()`, frame selection, `TRANSFORM_VERSION` and the sink-identity gate are unaffected — **no `TRANSFORM_VERSION` bump** (nothing pixel-deciding changes). The gates keep `memorySource`; the editor is the only `ipcSource` user.

## Error handling

- Short, failed or out-of-range read → throws with file name, offset, length. Never pad, never skip a chunk.
- Box walk hits a box extending past EOF, or `size < 8` → `could not parse <file>: …`. A file with no `moov` → the existing "not a readable MP4" refusal.
- Read failure mid-preview surfaces the same way a decoder failure does today (`this.failure`), mid-export aborts the export with that message.

## Testing

Node (`npm test`, runs on CI):
- **Index equivalence:** for every fixture MP4, the new `demuxTrack(memorySource(buf))` produces the same `framesNs`, `codec`, `description`, and per-chunk `type`/`timestampUs` as the pre-change demux, and `ChunkReader` returns byte-identical data. The oracle is a full mp4box extraction (`setExtractionOptions`/`onSamples` over the whole buffer, the pre-change path) written inside the test file — not a committed snapshot, so a fixture regenerated later is still checked.
- **Box walker:** truncated file, `size < 8`, 64-bit `largesize`, `size === 0` to-end, `mdat` before and after `moov`.
- **ChunkReader:** coalescing across a discontinuity (one read per run, asserted with a counting `ByteSource`), LRU hit on re-read, out-of-range throws, short read throws.
- **Fragmented file:** the crash-recovered file `helper/test/fragmented-writer.test.ts` produces (macOS CI) — the index matches the full demux, including the STC-394 PTS chain across the first real `moof`.

Browser/e2e:
- Sink-identity gate and `gate:seek`/`gate:export` unchanged and green.
- One editor e2e test opens a fixture take, shows frame 0, and asserts from `ipcSource`'s own byte counter that the bytes read from `display.mp4` are the index plus the first keyframe group's runs — strictly less than the file size — proving `readVideo` is no longer the video path.

Mac only (runbook):
- `scripts/measure-preview-memory.mjs` on a short and a long (≥ 15 min, 4K) take: before/after absolute RSS growth.
- Scrub feel and export time on a long take — IPC per GOP must not make scrubbing feel slower.

## Out of scope — follow-ups to file (after listing Linear for duplicates)

- **Preview audio memory.** Mic/system audio are held as decoded PCM: 48 kHz stereo float32 ≈ 23 MB/min, ~1.4 GB for an hour — now a larger ceiling than video.
- **N-minute segmentation** itself stays deferred with no current motivation.
- **No helper (Swift) change.** Capture output is unchanged.

## Doc updates the implementation must make

- `CORRECTNESS-TRAPS.md` "Preview holds the whole video in memory" → superseded; record the measured numbers.
- `docs/TICKET-LOG.md` row for STC-236 (redirect + outcome); STC-251 row points here.
- `CLAUDE.md` table: `chunk-reader.ts` and the runbook.
- Linear STC-236 title/description updated to the redirected scope.
