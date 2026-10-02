# STC-469 — preview audio memory: fewer copies, a stated ceiling

Status: approved direction (Patrick, 2026-10-01: "A now, B later").

## Problem

STC-236 made the editor read video by range. Audio was left whole: `mic.m4a`
and `system.m4a` are decoded in full to float32 PCM (`decode-audio.ts`
`decodeAllAudio` → `pcmTrackOf` → `audio-mix.ts` `trackFromChunks`) and held
for the life of the open take. At source rate that is ≈ 11.5 MB/min for a mono
mic and ≈ 23 MB/min for stereo system audio.

The copies, today, on a take with mic + system and narration cleanup on:

| holder | what | size |
|---|---|---|
| `editor.ts` `rawMic` | decoded mic | 1× mic |
| `editor.ts` `cleanedMic` | worker's cleaned mic | 1× mic |
| `PreviewAudio.system` | decoded system | 1× system |
| `pumpClean` (transient) | `rawMic.channels.map(c => c.slice())` sent to the worker | 1× mic per strength change |
| `exportSession` (during export) | its own decode of mic + system, then `cleanNarration` on the MAIN thread | 1× system + 1× mic + ≈ 7× mic peak (Float64 STFT buffers) |

## Decision

Option A from the ticket's three, chosen by Patrick: **keep whole-track PCM
(so the preview stays exactly the export's mix, STC-454's promise), remove
the copies that buy nothing, and state a measured ceiling.** Option B (spill
decoded/cleaned PCM to a temp file read by range) is filed as a follow-up,
to be done only if the measured ceiling is not good enough. Option C (decode
around the playhead) is rejected: narration cleanup's noise profile is learned
from every pause in the take and its decision-directed prior carries history
block to block, so a streamed preview could not equal the export.

## Design

### 1. The worker decodes the mic itself; the main thread stops holding raw while cleaned plays

- `narration-worker.ts`'s request changes from `{ id, strength, track: PcmTrack }`
  to `{ id, strength, audio: DemuxedAudio }` — the COMPRESSED track
  (≈ 1 MB/min, already held by the session). The worker runs the same
  `decodeAllAudio` → `pcmTrackOf(…, "mic.m4a")` → `cleanNarration` the export
  runs. `AudioDecoder` is available in dedicated workers.
  `DemuxedAudio` is structured-cloned (its chunk `data` are `Uint8Array`s);
  it is not transferred, because the session keeps using it (export, re-clean).
- `editor.ts`:
  - First load is unchanged in feel: the main thread decodes the raw mic and
    plays it immediately (`rawMic`), and cleaning starts in the worker.
  - When the cleaned mic lands and is the one wanted, `useMic(cleanedMic)` and
    **`rawMic = null`**. Steady state with cleanup on: cleaned mic + system.
  - Cleanup switched OFF (or strength → 0, which `exportAudioPlan` already
    treats as "no clean") with `rawMic === null`: the raw mic is decoded again
    on the main thread; the cleaned mic keeps playing until it arrives, then
    is swapped in and `cleanedMic = null`. Same "whatever was playing keeps
    playing" rule cleanup already follows (Patrick, 2026-09-25).
  - Strength change while cleaned: the worker decodes and cleans from the
    compressed track again; no raw copy is needed on the main thread. The old
    cleaned mic keeps playing until the new one lands, then is replaced.
  - `audioGen` still drops any decode or clean that lands after its take closed.
- Net: steady state drops one full mic copy, and the per-strength-change
  transient raw copy is gone.

### 2. Export reuses the tracks the preview already holds

- `exportSession(session, project, opts)` gains
  `opts.decoded?: { system?: PcmTrack | null; mic?: { track: PcmTrack; cleanedAt: number | null } | null }`.
- A pure function in `audio-mix.ts`, next to `exportAudioPlan`, decides
  reuse — the ONE place the question "is this preview track the one this plan
  needs" is answered:
  - system: reusable when `plan.system` is true and a decoded system track is
    offered.
  - mic: reusable when `plan.mic` is true and either `plan.cleanMic` is false
    and the offered mic has `cleanedAt === null`, or `plan.cleanMic` is true
    and `cleanedAt === cleanup.strength`.
  - anything else → export decodes (and cleans) exactly as today.
- Only the MIX path (`plan.path === "mix"`) uses it. The mic-only passthrough
  path (`plan.path === "mic"`, raw `AudioData` → encoder) is untouched — it is
  hardware-verified and has no `PcmTrack` to reuse.
- `editor.ts` passes `{ system: previewAudio.systemTrack, mic: … }` from what
  it currently holds, tagging the mic with the strength it was cleaned at (or
  `null` for raw).
- Identity: the reused track is the output of the same functions over the same
  compressed bytes, so the encoded samples are the same. This is asserted by a
  test, not assumed (see Testing).
- The export never mutates a `PcmTrack` (`mixBlock` only reads), so sharing
  with a preview that keeps playing is safe.

### 3. Measure and state the ceiling

- `scripts/measure-preview-memory.mjs`:
  - stage `mic.m4a` / `system.m4a` too (today they are never copied, so a take
    whose anchors claim audio fails to load and the run times out);
  - after the picture shows, also wait for `#previewaudio[data-state]` to
    leave `loading` and for `data-cleaning` to be `false`, so the measurement
    includes the decoded audio and the cleaned mic;
  - add a run that also exports, sampling renderer RSS during the export and
    reporting its peak.
- Measure master vs this branch on a long take with mic + system and cleanup
  on. If a synthetic take can be built cleanly (`afconvert` → AAC `mic.m4a` /
  `system.m4a` added to an existing take with anchors to match), measure that
  here; otherwise the runbook carries it for Patrick.
- `docs/STC-469-RUNBOOK.md`: the numbers, the per-minute ceiling stated as a
  formula, and what only a Mac can settle (the cleanup-off swap on a long
  take, a real long take's RSS).
- TICKET-LOG row; file option B as a follow-up ticket (list Linear first).

## Out of scope

- The mic-only export path's "every `AudioData` alive for the whole export"
  cost.
- Streaming / temp-file PCM (option B).
- Compressed `DemuxedAudio` held by the session (≈ 1 MB/min; small).

## Testing

- Unit (Node): the reuse decision — each row above, including mute, strength
  mismatch, cleanup at 0, and cleanup on with a raw mic offered.
- e2e: a cleanup-on export of a take with mic + system, once with reuse and
  once without, produces identical audio sample bytes; and the preview drops
  `rawMic` once the cleaned mic is playing (exposed as a test hook in the
  same style as `__stcVideoBytesRead`).
- Existing `preview-audio.e2e.test.ts` and `narration-clean.test.ts` stay green.
- Per memory: run e2e in the VM first (`docs/VM-TESTING.md`).
