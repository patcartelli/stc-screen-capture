# STC-394 — fragmented recording, on a Mac

Written and VERIFIED in a real macOS sandbox (arm64, swiftc 6.4) — this ticket
was unusually answerable from here: no ScreenCaptureKit or grant is needed to
test what `AVAssetWriter` does with `movieFragmentInterval`, only real
synthetic pixel buffers. `helper/test/fragmented-writer.test.ts` drives the
exact writer configuration `Capture.swift` uses (`helper/test/
fragmented-writer/main.swift` mirrors `setupWriter()` line for line, plus
the one new property) through a real crash (`_exit()`, no `finishWriting`)
and feeds the result through the real `demuxTrack` — no mock at any layer.

```
npm test                          # includes fragmented-writer.test.ts, library.test.ts's new case
./helper/build.sh                 # confirms all three writers still compile
npm run test:capture              # needs Screen Recording — see §1 below
```

## The finding this ticket rests on

**A cleanly-finished fragmented recording is byte-shape-identical to today's
output.** Measured directly: a finished `movieFragmentInterval` file has
**no `moof` boxes at all** — `ftyp`, one `mdat`, then `moov`, same as a
non-fragmented file. AVAssetWriter only leaves visible fragments (`moof`/
`mdat` pairs) behind when the process never reaches `finishWriting` — which is
exactly the case this ticket exists for. That is why "normal-stop output is
unchanged" holds by construction, not by a coincidence this repo just
happened not to break.

**A crash-truncated file needed a real fix, not just a config change.**
`demuxTrack` (and its audio twin `demuxAudioTrack`) used to trust each
sample's own `cts` directly. mp4box.js's cross-fragment accumulation is keyed
on having seen a real `traf`, and a crashed file's FIRST segment (whatever
was captured before the first `movieFragmentInterval` elapsed) lives in the
initial `moov`'s own sample table, not a `moof` — so the first REAL fragment
after that resets mp4box's running decode time back near zero instead of
continuing it. Both demuxers now chain PTS from each sample's own `duration`
(a per-sample delta, never an accumulated base) instead of trusting the
possibly-reset `cts`/`dts`. Reproduced and fixed in this sandbox; see
`helper/test/fragmented-writer.test.ts`'s middle test for the exact numbers
(181 of 210 attempted frames recovered, `cts` resetting to 0 exactly at
sample 61 before the fix, monotonic afterward).

## §1 — a real crash, on real hardware

Nothing here can substitute for killing the REAL helper mid-recording against
real ScreenCaptureKit output — the synthetic harness proves the container
format and the demux fix; it does not prove the real capture path.

1. `npm run app:start`, start a recording, let it run at least 10 seconds
   (past several 2s fragment boundaries — `movieFragmentIntervalSec` in
   `helper/src/CaptureDecisions.swift`).
2. `kill -9 $(pgrep stc-helper)`.
3. Open `display.mp4` directly in QuickTime Player. **Expected:** it plays,
   up to within ~2 seconds of the kill — not "file damaged", not silence.
4. Run it through this app's own pipeline for real: `node scripts/
   export-one.mjs <the take's dir>` (or point `harness/` at it) and confirm
   `demuxTrack` reads a sane, monotonic frame count close to the kill point —
   the synthetic test already proves the CODE path; this proves the REAL
   encoder's fragments look the same shape.
5. Confirm `anchors.json`/`events.json` are absent (STC-376's fix means a
   CLEAN stop always writes both; only a genuine crash should ever produce
   video with no sidecars) and that the library correctly refuses the
   directory as "no anchors.json — not a recording" rather than listing it —
   `app/test/library.test.ts`'s new case pins this from a fixture, but the
   real question is whether a real crash produces exactly this shape and
   nothing stranger (a half-written anchors.json, say).

## §2 — normal-stop output really is unchanged, for a real take

1. Record and stop cleanly (no kill).
2. `npm run gate:identity` (or `scripts/export-one.mjs`) — should behave
   exactly as before this ticket. If it does not, the "no moof boxes on a
   clean finish" claim above does not hold on this machine's AVFoundation
   version, and that is the finding to chase, not a demux bug.
3. Look at the file size and a quick byte count of `mdat` vs the whole
   file — should be indistinguishable from a take recorded on `master`
   before this ticket, modulo ordinary encode variance.

## §3 — the camera and mic tracks

`CameraCapture.swift` and `MicCapture.swift` got the identical one-line
change. Neither has its own harness here — extending
`fragmented-writer/main.swift` to audio and a second video track was judged
not worth the additional harness complexity, since the video, audio and
camera writers are all the SAME `AVAssetWriter` API with the SAME property,
and the finding (`movieFragmentInterval` de-fragments on a clean finish,
fragments survive a crash) is a property of AVAssetWriter, not of which
`AVMediaType` is attached to it. Worth watching on a real take with camera
+ mic recording, killed mid-way: do `camera.mp4` and `mic.m4a` ALSO survive
to a playable prefix, the same as `display.mp4`?

## What is deliberately not here

- **No incremental sidecar writing.** The ticket's acceptance criterion is
  satisfied by the "clearly marked missing" branch, not the "recoverable"
  one — `anchors.json`/`events.json` are still written once, atomically, at
  a clean stop (`writeSidecars()`, unchanged). A crash always produces
  EITHER both sidecars and a complete video, OR neither sidecar and a
  partial (now playable) video — never a stale sidecar paired with a
  shorter video, so there is no mismatch to detect, only a marked absence.
  Making sidecars themselves recoverable mid-crash would be a materially
  larger change and is not what this ticket's own text asks for.
- **No change to `movieTimeScale`, the codec settings, or anything else
  `setupWriter()` already had.** `movieFragmentInterval` is the one new
  property, matching the ticket's own "if it uses AVAssetWriter, that means
  setting movieFragmentInterval" framing.
