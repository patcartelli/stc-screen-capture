# STC-418 — system audio, PR 2 (helper capture): what to run on the Mac

**Run this from the PR 2 branch, not `master`, until it merges:**

```
git fetch origin claude/optimistic-ride-ed374b
git checkout claude/optimistic-ride-ed374b
helper/build.sh && tools/test-host/build.sh
```

Written on a Linux session with no `swiftc` and no ScreenCaptureKit. The
Swift is compiled by CI (`macos-15`), so "it builds" is checked there, but
**none of it has recorded a sample of real audio.** Every claim below about
what ScreenCaptureKit actually does is a prediction until a section here
records a result under it — the way docs/STC-370-RUNBOOK.md kept its own.

## What changed

- `start` accepts `systemAudio: true`. Anything else, or absent, is off.
- When on, the helper opens a **second, dedicated `SCStream`**
  (`SystemAudioCapture.swift`): a whole-display filter excluding nothing,
  2×2 video at 1 fps (discarded), `capturesAudio`, 48 kHz stereo. It writes
  `system.m4a` beside `display.mp4`/`mic.m4a`. Not the video stream's own
  audio, because ScreenCaptureKit filters audio by APPLICATION: a window
  take's `desktopIndependentWindow` filter would (we believe — §3) carry
  only that window's app. Patrick's decision is "the whole machine, every
  scope".
- `anchors.json` writes a `system` block and `files.system`, at **version 6**,
  only when system audio was requested (`present:false` if it recorded
  nothing). A take that never asked is unchanged.
- The pause gate applies: a paused take records no system audio.
- The app has a `systemAudio` setting, **off by default**, sent to the
  helper only when on. **There is no control for it yet** — the options-bar
  toggle is PR 4, waiting on STC-388. To turn it on by hand, open DevTools
  on the main window (View → Toggle Developer Tools, or ⌥⌘I) and run
  `recorder.setSettings({ systemAudio: true })` — the same shipped channel
  every preference goes through; `{ systemAudio: false }` turns it back off.
  It persists across restarts.
- Nothing plays it back yet: preview and export ignore `system.m4a` until
  PR 3. Listen to the file directly.

## §1 — the automated grant test

```
npm run test:capture -- helper/test/system-audio-capture.grant.test.ts
```

Plays `Glass.aiff` six times during a 10 s take through the test host with
`--system-audio`. **Output volume must not be muted.** It checks anchors-6
validity, 48 kHz/2 ch, session-relative first/last PTS, and that the file
demuxes. Record: pass/fail, and `anchors.system` verbatim.

The PTS bounds are the one thing it checks that nothing else can: the code
**assumes** SCK's audio timestamps are on the same mach host clock as
`t0Ns`, as `MicCapture` assumes of AVCapture. If they are not, this fails on
`firstFramePtsNs >= 0` or `lastFramePtsNs <= stop.t`.

## §2 — listen to it, and check sync

1. Turn the setting on (above), open a YouTube video with a visible clock
   or a metronome, and record 20 s of the whole screen.
2. `open ~/Desktop/stc/<take>/system.m4a`. Is it the video's audio, clean,
   at normal level, with no crackle and no gaps?
3. Sync: `firstFramePtsNs` in anchors.json against the moment a sound starts
   on screen. Compare with the mic's measured +1.8 ms camera↔mic offset; a
   system-audio offset of tens of ms is worth writing down before PR 3 mixes
   it.

## §3 — window scope gets the WHOLE machine

The reason the dedicated stream exists. Record a **window** scope take of,
say, a Finder window while a browser in ANOTHER window plays audio.
`system.m4a` must contain the browser's audio. If it does, write that
down. It also confirms the per-app filtering belief was worth designing
around, or shows it was harmless either way. If it does NOT, the whole-display filter is not
doing what `SystemAudioCapture`'s header says, and that is a finding.

## §4 — silence: buffers, or nothing?

Deliberately unbuilt: a "no samples after 3 s" warning like the mic's
`mic-no-frames` (Patrick, 2026-09-25). Record 10 s with **nothing playing**
and look at `anchors.system`:

- `present: true` with first/last spanning the take → SCK delivers silence
  as buffers. A watchdog would then be safe to add later.
- `present: false` → SCK delivers nothing while silent. Then a silent take
  is indistinguishable from a broken stream, and the watchdog must stay out.
  PR 3 must also treat `present:false` as "silent", not as an error.

## §5 — pause, stop, and nothing left running

1. Record, pause for 5 s while audio plays, resume, stop. The paused span
   must be silent (absent) in `system.m4a`, not recorded.
2. Stop a take and check Activity Monitor / Console: no second capture
   indicator lingering, no repeated `SCStream` errors after stop.
3. Record twice in a row with system audio on: no `-3805` on the second
   start (docs/CORRECTNESS-TRAPS.md explains `-3805`).

## §6 — does the second stream cost anything visible?

Record a 60 s 4K take with system audio on and one with it off. Compare
`framesDropped` in the stop stats. A 2×2/1 fps stream should cost nothing;
if drops rise, that is a finding.
