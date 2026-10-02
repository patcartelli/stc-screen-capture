# STC-485 — mic.m4a full of noise: what to run on the Mac

Branch: `accounts/stc-485-mic-noise` until it merges, then `master`.

## What changed, and what is still unknown

**Measured 2026-10-02, on the Wave:3 itself.** Its native format is 24-bit
integer PACKED, 3 bytes per frame (`flags 0xc`). When `MicCapture` left the
capture output to choose, that is what came through. Data that is really
4 bytes per frame (float32, or 24-in-32) but described as 3 is read as 4/3 as
many frames of misaligned bytes. That gives exactly the length ratio and the
white noise both bad takes showed.

**The trigger was not reproduced.** 16 opens of the Wave:3 on the old path,
alone and with a second client opening the device at the same moment, all came
out clean. So what makes the bytes and the label disagree is still unknown. Two
changes, either of which is enough by itself:

1. **The format is pinned.** `AVCaptureAudioDataOutput.audioSettings` asks for
   float32 interleaved at the device's own rate and channel count. The
   recording no longer takes whatever the driver exposes. This is a
   sample-format conversion only, never a resample.
2. **A guard** (`helper/src/MicFormatDecisions.swift`) checks every delivered
   buffer: its description against the pinned format, its byte count against
   its frame count, and over 2 s windows, how many frames arrived against how
   much time passed. The bad takes measured 1.33x on that last check. The
   first failure ends the mic track with one `mic-format-mismatch` warning
   (a toast and "failed — mic-format-mismatch" on the mic row). The take
   keeps recording. At most ~2 s of noise can reach the file before the
   guard trips. Before the guard, the whole take was noise and nothing was
   said.

Already verified from an agent shell, with the real `MicCapture` against the
Wave:3 and no ScreenCaptureKit:

- 20 of 20 three-second takes were clean. Each decoded to its recorded span
  plus one 512-frame buffer. Quietest 10% was −47 to −50 dBFS and the
  zero-crossing rate 0.05–0.09; the noise takes were −8 dBFS and 0.43.
- The injected fault produced exactly one warning, no `mic-no-frames` after
  it, and no mic track.

What that does NOT cover is the full app: system audio's own `SCStream`
starting next to the mic, the Record flow and the countdown, and whatever
state the device was in on 2026-09-30. That is what follows.

## §1 The grant test (your terminal)

```bash
helper/build.sh
```

```bash
npx vitest run --config vitest.grant.config.ts helper/test/mic-format.grant.test.ts
```

Two tests must pass. In the first, the injected fault gives exactly one
warning and the take is not stopped. The second is the CONTROL: a real 6 s
take raises no warning, and its `mic.m4a` decodes to within 0.97–1.05 of the
span `anchors.json` records.

## §2 Twenty takes in the app, Wave:3, system audio ON

This is the ticket's acceptance. Use `npm run app:start`. Turn on the Wave:3
mic and system audio. Mix the scopes (Area, Window, Screen) and include a
window drag or two, as on 2026-09-30. Speak in some takes and stay silent
in others.

Then check every take. One command, from the repo:

```bash
for d in ~/Desktop/test/raw/*/; do [ -f "$d/mic.m4a" ] && echo "$d $(afinfo "$d/mic.m4a" | grep 'estimated duration')"; done
```

Compare each duration with `mic.lastFramePtsNs − mic.firstFramePtsNs` in that
take's `anchors.json`. They should agree within a few hundredths of a second,
nowhere near 4/3.

The four possible outcomes:

- **No noise, no warning, in all 20.** This is the expected result, but it
  does not prove the cause is gone, because the old path was intermittent
  too. The guard is what still protects a future take.
- **A `mic-format-mismatch` toast.** The guard caught it. Keep that take
  folder and copy the toast's text, which names the format that arrived, the
  one expected, and what the device reports natively. That is the first real
  evidence of the trigger, so post it on STC-485.
- **A noise take with NO toast.** The guard missed it. Keep the folder and
  report the measured ratio. This is the one result that sends this back.
- **A clean take that still got a toast** (false positive). Keep the folder
  and report what the warning said.
