# STC-469 runbook — preview audio memory

Branch: `accounts/stc-469-preview-audio-memory` until merged, then `master`.

## What changed

- The editor no longer keeps a raw decoded mic while the cleaned one plays. The cleanup worker
  decodes the COMPRESSED mic itself (`decode-audio.ts`'s `decodeMicForMix`, the one mic-track
  producer), and the raw PCM is dropped while the cleaned one is what plays. Switching cleanup off
  decodes the raw mic back.
- Export reuses the preview's decoded tracks where `audio-mix.ts`'s `reusableTracks` says they are
  exactly what the export would have produced, instead of decoding the files a second time.
- Whole-track PCM is kept on purpose: the preview must stay the export's mix. Streaming PCM
  through a temp file read by range is the filed follow-up (option B, STC-490).

## Measured

Take: synthetic, from `scripts/make-long-audio-take.mjs` on a real 13 s display take, 30 min of
mic (mono, 48 kHz) + system (stereo, 48 kHz). `mic.m4a` 14.5 MB, `system.m4a` 23.1 MB.
Command (this branch): `node scripts/measure-preview-memory.mjs <takeDir> --cleanup --export`.

Master has no copy of this version of the script, so master is measured by COPYING this branch's
`scripts/measure-preview-memory.mjs` into a master worktree and running it there with `--cleanup`
only. `--cleanup` works on both (it falls back to the `#previewaudio[data-cleaning]` indicator
where master has no `__stcPreviewAudio` hook). `--export` is branch-only — it needs
`__stcExportForTest` — and the branch's `reuse=false` run IS master's export behaviour, so that
row's master cell is filled from it. Every steady-state and pre-export sample is taken after a
forced GC (or, if `gc` is not exposed, once RSS stops moving); the script prints which.

Measured 2026-10-01 on the dev Mac (host), same synthetic take for every run. Renderer RSS via
`app.getAppMetrics()`, each steady-state and pre-export sample after a forced `gc()` (the script
printed "settled by: gc" for every run). Display-only rows; display+camera agreed within ~80 MB.

| | master (`fd6e14a`) | this branch |
|---|---|---|
| Steady state, cleanup on (renderer RSS growth) | +7191 MB | +7214 MB |
| Steady state, cleanup off | not run | +6730 MB |
| Export, `reuse=false` (peak over pre-export RSS) | = branch's `reuse=false` (master never reuses) | +3336 MB (peak 10.7 GB) |
| Export, `reuse=true` (peak over pre-export RSS) | n/a | **+188 MB** |
| Take length / channel layout | 30 min, mic mono + system stereo | 30 min, mic mono + system stereo |

**What the numbers say.**

- **Export reuse is the real win**: the export's own audio cost falls from +3.3 GB to +0.2 GB on a
  30 min take — no second decode, no second `cleanNarration` (whose Float64 buffers dominate it).
- **The steady-state saving is invisible in RSS.** Master and branch agree within noise. The ~345 MB
  this branch frees is real (`__stcPreviewAudio().rawMicHeld` is false), but RSS does not shrink to
  show it: renderer RSS here is set by the LOAD's high-water mark, and freed ArrayBuffer memory is
  not handed back to the OS on this timescale even after a forced GC.
- **The ticket's ceiling formula is ~6.5x too low for RSS.** Whole-track PCM for this take is
  ~1.04 GB; steady-state RSS growth is ~6.7 GB with cleanup OFF (no worker involved), i.e.
  ~220 MB per minute of mic+system, against STC-236's ~+143 MB for a display-only take. The likely
  cause is the decode path's transients: `decodeAllAudio` keeps every `AudioData` alive until the
  flush, `pcmTrackOf` then copies each into its own chunk, and `trackFromChunks` copies those into
  one contiguous track — three full copies of each track alive at the peak, for both tracks at
  once (they decode in parallel). That is inference from the code, not yet measured per stage.
  It is the next thing to fix, and it is NOT option B (STC-490): decoding straight into the
  contiguous track, closing each `AudioData` in the output callback, would remove two of the
  three copies without changing a single sample.

Two script bugs were found by running it and are fixed on this branch: the app launched with the
REAL user profile, whose `saveFolder` (STC-412) overrides `STC_RECORDINGS_DIR`, so it opened a
take from the user's real library; and the pixel wait passed its timeout in the page-argument
slot, so it was silently Playwright's 30 s default, and sampled the top-left corner, which a
real take can legitimately have dark.

## The ceiling

Whole-track PCM is float32 at 48 kHz: 48 000 x 4 B x 60 = 11.5 MB per channel-minute.

    steady state ~= minutes x (mic channels x 11.5 + system channels x 11.5) MB

That is ~34.5 MB/min for a mono mic + stereo system take (~1 GB at 30 min, ~2 GB at an hour),
plus ~1 MB/min of compressed audio. The saving of this branch is one mono mic, ~11.5 MB/min,
~345 MB at 30 min, while cleanup is on. That is the PCM floor; the measured RSS above is ~6.5x it
(see "What the numbers say").

## What only a Mac can settle

1. A REAL >= 30 min take with mic + system: run the measure command above against it. The
   synthetic take's AAC is a tone over hiss; a real take's memory is the same (PCM is PCM) but its
   cleanup behaviour is not.
2. Cleanup off on a long take: the cleaned voice keeps playing, then switches to raw. It is a
   full re-decode, seconds on a long take. Does the gap feel right?
3. Export with the editor open on a long take: no visible stall beyond today's.

## Known behaviour

- After switching cleanup off on a long take, the cleaned voice keeps playing until the raw mic
  has re-decoded. There is no busy cue while it does.
- If that re-decode fails, the cleaned voice keeps playing while the project says cleanup is off,
  so preview and export differ until the next toggle.
- After a cleanup-worker error with cleanup on, the preview keeps playing what it had.
- A strength change followed by cleanup-off while a clean is in flight can briefly hold three mic
  copies (the old cleaned one playing, the new cleaned one landed, the raw one decoding). It
  converges when the raw mic lands; export reuse is unaffected, since it only reuses a track it
  can identify.
