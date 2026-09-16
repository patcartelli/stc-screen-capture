# STC-233 — microphone capture: what only a Mac can settle

Written on Linux; no `swiftc`, no real Chrome, no microphone. Everything
below is reasoned from the API contracts and from this codebase's existing
camera pipeline (STC-232/STC-286/STC-287), which this ticket mirrors as
closely as the two subsystems' real differences allow. **None of it has run.**

## Before anything else

```
helper/build.sh
npm run typecheck
npm test
```

If `helper/build.sh` fails, everything below is moot — fix the compile first.
`MicCapture.swift`, `AudioWriterGate.swift` and the `CaptureDecisions.swift`/
`AnchorsDoc.swift`/`Capture.swift` edits have never been through `swiftc`.

## §1 — grant the two permissions this needs

Screen Recording (already required) plus **Microphone**, for the test-host
bundle (`STC Signing Probe`) if driving the grant test, or for the packaged
app if driving it from `npm run app:start`.

The Microphone pane, like Camera, only lists apps that have already
REQUESTED access:

```
open -W tools/test-host/STCTestHost.app --args --mic-request --out /tmp/mic-request.json
```

Click Allow, then grant Screen Recording too if not already granted, then:

```
npm run test:capture
```

`helper/test/mic-capture.grant.test.ts` needs both. If it prints
`SKIP-GRANT`, the message says which grant is missing and how to raise the
prompt.

## §2 — does a real recording actually produce mic.m4a — DONE 2026-09-16

Pick a real microphone (built-in is fine for the first run), record ~15s
with `tools/test-host`'s `--mic <uid>` flag (get the uid from `--out`'s
`devices` transcript, or from `AVCaptureDevice.devices(for: .audio)` in a
quick swift snippet), and check:

- `mic.m4a` exists and is non-zero bytes. **CONFIRMED** — a real device
  (Elgato Wave:3) produced a non-empty file.
- `anchors.json` is version 4, has a `mic` block with `present: true`, and
  `files.mic == "mic.m4a"`. **CONFIRMED**.
- `mic.firstFramePtsNs` is small (the mic should open fast — no measured
  number exists yet the way the camera's ~1035ms warm-up was measured;
  **this run is what produces the first one**). **MEASURED: 758031792 ns**
  on the same take whose `camera.firstFrameNs` was 255209000 — both on the
  same clock, plausible relative to each other. Not yet compared against a
  session-zero origin to say whether ~758ms is a *good* mic warm-up number,
  only that it recorded.
- Play `mic.m4a` in QuickTime. Is there audio? Does it sound like what was
  said during the take? **Not yet confirmed by ear** — recording and the
  anchors document were verified; nobody has listened to the file yet.

## §3 — camera + mic together — DONE 2026-09-16

Record with both `--camera` and `--mic <uid>`. Does `anchors.json` carry
BOTH `camera` and `mic` blocks? **CONFIRMED** — a real take carried both
blocks with plausible values. Does the take still produce a valid
`display.mp4`, `camera.mp4` AND `mic.m4a` all in the same directory? The
three subsystems (display/camera/mic) each own a separate `AVAssetWriter`
and each tear down through the same `DispatchGroup` in `Capture.swift`'s
`stop()` — this is the first take that exercises all three writers
finalizing concurrently, and nothing here can produce that concurrency
without real hardware. **This concurrent-teardown path ran on real
hardware and produced a clean, valid anchors document — not separately
re-verified file-by-file (`display.mp4`/`camera.mp4` playability was not
re-checked here, only that all three tracks were requested and the
document was consistent), but nothing pointed at a partial or corrupt
take.**

**Already found and fixed here, on real hardware, 2026-09-16**: the
app-packaged build crashed the whole helper (`EXC_CRASH`/`SIGABRT`, an
uncaught `NSException`) the instant camera+mic were both enabled, every
time — camera alone worked, mic alone was untested but the crash was in
mic's own writer setup. `MicCapture.setupWriter()` had copied
`inp.mediaTimeScale = 1_000_000_000` verbatim from `Capture.swift`'s VIDEO
writer; that property is video-only (an audio input infers its own time
scale from its samples), and setting it left the audio
`AVAssetWriterInput` unable to resolve a real backing helper
(`AVAssetWriterInputUnknownHelper` in the crash report), so the very next
property touch threw and took the whole process down — camera and display
included, not just the mic. Removed; `retimed()` already stamps each
sample buffer with an exact-ns PTS before the gate sees it, so the file's
sample table needed no help from this property the way the video track
does. **Re-verified fresh, same day, after the fix**: camera+mic together
recorded cleanly with both anchors blocks present (see the confirmation at
the top of this section) — the crash is gone, not just theorized fixed.

**Second thing found and fixed here, same day, once §3 could actually be
reached**: a real camera+mic take recorded fine (both anchors blocks
present, correct values) but the editor refused to open it —
`could not parse mic.m4a: Error: non-integer ns PTS: cts=1024
timescale=48000`. Direct consequence of the crash fix above:
`demux-audio.ts` assumed mic.m4a's sample grid was exact nanoseconds, the
same guarantee `demux.ts` correctly relies on for video — but that
guarantee comes from `Capture.swift`/`CameraCapture.swift` forcing
`mediaTimeScale = 1_000_000_000` on the video input, the exact property
that crashes when set on audio. So an AAC track's grid is its own sample
rate instead (48000 Hz, 1024-sample frames — 1024/48000 s = 21.333... ms,
not an integer number of ns). `demux-audio.ts` now rounds rather than
throws; the worst-case error (~20.8 us) is two orders of magnitude inside
`session.ts`'s own 50 us `OFFSET_TOLERANCE_NS` check and three inside this
app's measured camera<->mic tolerance (1.8 ms median). **Re-verify §4
fresh too** — the take that surfaced this never got past opening in the
editor, so export-with-audio is still unreached.

**Third thing found and fixed here, same day, once the PTS-rounding fix
let a take open far enough to hit it**: the editor refused a real
camera+mic take (audio recorded fine, both anchors blocks present) with
`mic.m4a frame-time offset disagreement: helper measured 568894376 ns,
file yields 0 ns (568.9 ms apart)`. Diagnosed from the actual file rather
than reasoned about blind — a throwaway diagnostic script
(`scripts/inspect-mic-track.mjs`, never merged) dumped the same take's
`display.mp4` and `mic.m4a` side by side. `display.mp4`'s video track
carried a real two-entry edit list (an empty edit for the ~216ms startup
gap, then the actual content) — exactly what `demux.ts` expects.
`mic.m4a`'s `trak.edts` was entirely **absent**, even though
`MicCapture.swift` retimes every sample buffer to an exact session-relative
PTS before appending it: `AVAssetWriter`'s real-time AAC pipeline resets
the track's own timeline to whichever sample it first receives rather than
preserving that PTS as a recoverable offset. So `session.ts`'s
`checkFrameOffset` — right for display/camera, where the file DOES recover
the gap — was structurally unable to pass for mic: the file's own first
sample always lands near its own zero regardless of how late the mic
actually opened, so it would throw on every take with a mic, not just this
one. Fixed by no longer cross-checking mic's offset against the file at
all; `anchors.mic.firstFramePtsNs` is now trusted as the sole origin and
every demuxed mic timestamp is **rebased** onto it (`rebaseMicAudio` in
`session.ts`), measured against the file's own first sample rather than
assumed to be exactly 0 — self-correcting if a future macOS version starts
writing a real edit list for audio. **Re-verify §4 yet again** — no take
has ever gotten past opening in the editor with a correct mic offset, so
export-with-audio, sync, and trimmed-export clipping are all still
completely unreached.

## §4 — export with audio, and LISTEN to it

This is the part that matters most and is the least reasoned-about, because
`transform/src/export.ts`'s audio path (`decodeAllAudio`, `retimeAudioData`,
the `AudioEncoder`/muxer wiring) has never run against a real browser.

```
node scripts/export-one.mjs <sessionDir> [seconds]
```

Watch AND listen to the output:

- Is there audio at all?
- Is it in sync with the video? (No sync measurement like STC-232's
  camera-to-display 65ms number exists yet for mic-to-display — if this
  export sounds obviously desynced, that is the first thing to chase.)
- Does a TRIMMED export (open in the editor, trim in/out, export) correctly
  clip the audio to the trim window, not the whole track?
- `micEncodedChunks` in the export result — does it look like a plausible
  count for the take's duration and sample rate?

If the gates can run on this hardware (`npm run gate:identity` etc. need
real Chrome, which this sandbox does not have — see CLAUDE.md's own
H.264-on-Linux note), run them against a take WITH a mic track and confirm
they still pass. Nothing here specifically exercises `demux-audio.ts`'s
`esds`-box parsing — **that is the single most likely thing to be wrong**,
reasoned from memory of mp4box.js's AAC handling rather than verified
against a real file. If `AudioDecoder.configure()` throws or `decodeAllAudio`
fails, start there.

## §5 — the picker, and the "never auto-grab" rule

Open the app, look at the Mic dropdown beside Camera. Does it list real
microphones, Bluetooth ones flagged as such? Pick one, record, does
`mic-state` in the debug table say the right device name once it opens?

Unplug/disconnect the chosen mic and relaunch the app — does the picker show
"Mic (not connected)" rather than silently falling back to another device or
to "Off"? Press Record anyway — does `anchors.mic` come back
`present: false` with a `mic-not-found` warning surfaced in the UI, rather
than the take silently having no mic and no explanation?

**The one thing to watch for and refuse if seen:** any path where a
Bluetooth mic gets recorded without the user having picked it by name in the
dropdown first. That is the whole reason this ticket exists as a picker
rather than a camera-style on/off toggle — phase 0's note about a stalled
capture wedging CoreAudio system-wide is why `MicCapture.start()` takes an
exact `uniqueID` and refuses (`mic-not-found`) rather than falling back to
"whichever mic AVFoundation would pick," the same way `pickCamera`'s ranking
is deliberately NOT reused here.

## §6 — what is NOT built, on purpose (ticket's own "out of scope")

- System audio — a separate ticket.
- Mix/levels/mute UI — future. The pill's level meter (STC-375) stays
  hatched/static; wiring it to a real signal is explicitly deferred.
- Volume normalization, noise suppression, or any DSP at all — the mic
  track is captured and muxed in unmodified.

## Known gaps this checkout could not close

- No `fixtures/*/mic.m4a` fixture exists — producing one needs macOS +
  ffmpeg + a matching PTS table, the same gap CLAUDE.md already records for
  a synthetic `fixtures/pip/camera.mp4`. `transform/test/session.test.ts`'s
  new mic tests cover only the validation paths that never touch a real
  file; `demux-audio.ts`/`decode-audio.ts` are unexercised by any test in
  this repo until a real fixture exists.
- No camera<->mic or display<->mic sync measurement exists (the camera has
  one: 65ms median, `scripts/measure-camera-sync.mjs`). Worth building the
  audio equivalent once a real take exists to measure.
- `gate:identity`/`gate:export` etc. have never run against a mic-bearing
  take — this sandbox cannot run the gates at all (no real Chrome).
