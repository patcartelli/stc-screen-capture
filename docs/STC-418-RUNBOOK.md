# STC-418 — system audio, PR 2 (helper capture): what to run on the Mac

**Run this from the PR 2 branch, not `master`, until it merges:**

```
git fetch origin claude/optimistic-ride-ed374b
git checkout claude/optimistic-ride-ed374b
helper/build.sh && tools/test-host/build.sh
```

Written on a Linux session with no `swiftc` and no ScreenCaptureKit. The
Swift is compiled by CI (`macos-15`), so "it builds" is checked there.
**§§2-4 are now RUN AND CONFIRMED on Patrick's Mac (2026-09-24, real takes
from the app, not the grant test)**; results are recorded under each section.
§1 (the grant test itself), §5 and §6 have not been run.

**One false start worth keeping:** the first attempt produced no
`system.m4a` at all. The cause was a stale build, not the code:
`npm run app:start` rebuilds the Electron app but NOT the Swift helper, so
an old helper silently ignored `systemAudio: true` and the take looked
normal. Rebuilding with `helper/build.sh` fixed it. When a new helper flag
"does nothing", check the helper binary's age first.

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

**Result (2026-09-24): the test itself was NOT run, but a real app take
answered its main question.** `2026-09-24_22-00-29` (camera + mic + system
audio together, whole screen, audio playing): anchors version 6,
`system: {present: true, sampleRate: 48000, channels: 2,
firstFramePtsNs: 385072125, lastFramePtsNs: 13245072125}`, all of
`files.camera/mic/system` present. First sample 0.385 s into the take, last
inside it: **the host-clock assumption holds.** `system.m4a` was 314 KB for
12.86 s, which is 192 kbps continuous: no gaps.

## §2 — listen to it, and check sync

1. Turn the setting on (above), open a YouTube video with a visible clock
   or a metronome, and record 20 s of the whole screen.
2. `open ~/Desktop/stc/<take>/system.m4a`. Is it the video's audio, clean,
   at normal level, with no crackle and no gaps?
3. Sync: `firstFramePtsNs` in anchors.json against the moment a sound starts
   on screen. Compare with the mic's measured +1.8 ms camera↔mic offset; a
   system-audio offset of tens of ms is worth writing down before PR 3 mixes
   it.

**Result (2026-09-24): "sounds great."** Clean, right level. Sync: no offset
noticed by ear. That is NOT a measurement; if PR 3's mix sounds early or late,
this is the number to go and measure properly.

## §3 — window scope gets the WHOLE machine

The reason the dedicated stream exists. Record a **window** scope take of,
say, a Finder window while a browser in ANOTHER window plays audio.
`system.m4a` must contain the browser's audio. If it does, write that
down. It also confirms the per-app filtering belief was worth designing
around, or shows it was harmless either way. If it does NOT, the whole-display filter is not
doing what `SystemAudioCapture`'s header says, and that is a finding.

**Result (2026-09-24): CONFIRMED.** A window-scope take captures the whole
machine's audio. What this does NOT show: that the video stream's own window
filter would have MISSED other apps. That alternative was never built, so the
per-app belief is still untested. It no longer matters, because the design that
shipped does the right thing either way.

## §4 — silence: buffers, or nothing?

Deliberately unbuilt: a "no samples after 3 s" warning like the mic's
`mic-no-frames` (Patrick, 2026-09-25). Record 10 s with **nothing playing**
and look at `anchors.system`:

- `present: true` with first/last spanning the take → SCK delivers silence
  as buffers. A watchdog would then be safe to add later.
- `present: false` → SCK delivers nothing while silent. Then a silent take
  is indistinguishable from a broken stream, and the watchdog must stay out.
  PR 3 must also treat `present:false` as "silent", not as an error.

**Result (2026-09-24): SCK delivers silence AS BUFFERS.**
`2026-09-24_22-04-58`, nothing playing: `system: {present: true,
firstFramePtsNs: 249916625, lastFramePtsNs: 13869916625}` against
`stop.t: 14004145208`. The track spans the whole take. So:

- A no-samples watchdog WOULD be safe to add: a healthy stream delivers even
  when the machine is quiet. v1 still ships without one (Patrick's call);
  this only says a later one would not false-alarm.
- PR 3 reads a quiet take's track as ordinary audio. `present:false` means
  the stream genuinely failed.
- **Do not judge silence by file size.** That take's `system.m4a` is 9 KB for
  13.6 s: AAC encodes digital silence to ~14 bytes a frame (~640 frames).
  Tiny, and still continuous. This runbook's first draft said to use size as
  the tell, and was wrong.

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
