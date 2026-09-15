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

## §2 — does a real recording actually produce mic.m4a

Pick a real microphone (built-in is fine for the first run), record ~15s
with `tools/test-host`'s `--mic <uid>` flag (get the uid from `--out`'s
`devices` transcript, or from `AVCaptureDevice.devices(for: .audio)` in a
quick swift snippet), and check:

- `mic.m4a` exists and is non-zero bytes.
- `anchors.json` is version 4, has a `mic` block with `present: true`, and
  `files.mic == "mic.m4a"`.
- `mic.firstFramePtsNs` is small (the mic should open fast — no measured
  number exists yet the way the camera's ~1035ms warm-up was measured;
  **this run is what produces the first one**).
- Play `mic.m4a` in QuickTime. Is there audio? Does it sound like what was
  said during the take?

## §3 — camera + mic together

Record with both `--camera` and `--mic <uid>`. Does `anchors.json` carry
BOTH `camera` and `mic` blocks? Does the take still produce a valid
`display.mp4`, `camera.mp4` AND `mic.m4a` all in the same directory? The
three subsystems (display/camera/mic) each own a separate `AVAssetWriter`
and each tear down through the same `DispatchGroup` in `Capture.swift`'s
`stop()` — this is the first take that exercises all three writers
finalizing concurrently, and nothing here can produce that concurrency
without real hardware.

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
