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
  through a temp file read by range is the filed follow-up (option B).

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

The controller fills this table from the run; every cell below reads "to be measured" until then.

| | master | this branch |
|---|---|---|
| Steady state, cleanup on (renderer RSS) | to be measured — see §1 | to be measured — see §1 |
| Export peak, `reuse=false` | same run as this branch's `reuse=false` (master never reuses) | to be measured — see §3 |
| Export peak, `reuse=true` | n/a (no reuse on master) | to be measured — see §3 |
| Take length / channel layout | 30 min, mic mono + system stereo | 30 min, mic mono + system stereo |

## The ceiling

Whole-track PCM is float32 at 48 kHz: 48 000 x 4 B x 60 = 11.5 MB per channel-minute.

    steady state ~= minutes x (mic channels x 11.5 + system channels x 11.5) MB

That is ~34.5 MB/min for a mono mic + stereo system take (~1 GB at 30 min, ~2 GB at an hour),
plus ~1 MB/min of compressed audio. The saving of this branch is one mono mic, ~11.5 MB/min,
~345 MB at 30 min, while cleanup is on. What remains is the ceiling of option B's reason to exist.

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
