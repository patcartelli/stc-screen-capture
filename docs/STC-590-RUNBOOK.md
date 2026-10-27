# Mic and system audio start after the screen — measure first (STC-590)

**Not on `master` until its PR merges: run it from `accounts/stc-590-audio-start-timings`.**

```
git fetch origin accounts/stc-590-audio-start-timings
git switch --detach origin/accounts/stc-590-audio-start-timings
helper/build.sh && npm run app:start
```

(`app:start` does not rebuild the helper; build it first.)

## Why

Measured 2026-10-26 (STC-578): screen first frame ~0.15 s, system audio ~0.27 s, mic ~0.36 s. `Capture.swift` opens the mic (`startMicAsync`) and system audio (`startSystemAudio`) only after the display stream is up, the shape the camera had. That is a **hypothesis**: the cost may be the open, or the first buffer's latency after an open that is quick (the camera's open took 14-63 ms and its first frame still took ~1.4 s). **Nothing is warmed in this change.**

## What this adds (logging only)

- `mic-started` carries `timings` (`discoverMs`, `configureMs`, `startRunningMs`, `firstArrivalRelMs`), printed as `[mic] started: {...}`.
- A reliable `audio-first-sample` event per track, printed once per take:
  `[mic] first sample at N ms, screen first frame at M ms, lag L ms, {...}` and the same for `[system]`. `startCaptureMs` is how long the system stream's start took. `firstArrivalRelMs` is when the first buffer ARRIVED (before any gate), relative to t0.

## Run (one take, mic AND system audio on, with a countdown)

Record 10 s. Send me the `[mic]` and `[system]` lines.

Reading them:

- `lag` is first sample minus screen first frame. Target is within ~33 ms.
- `startRunningMs` / `startCaptureMs` large: the open is the cost, so warming it ahead pays.
- Those small but `firstArrivalRelMs` large: the device is slow to deliver its first buffer after opening. Warming still helps, but only if it starts BEFORE t0, which is what the countdown gives.
- `firstArrivalRelMs` much smaller than `firstSampleMs`: samples are being dropped between arrival and the file (`rel < 0` drop, pause gate, ordering guard), and warming is not the fix.

## Then

Only after the numbers are read: pre-open both during the countdown the way `camera-warm` does, release on cancel / failed start / track off, and re-measure. Not built yet.

## Measured (2026-10-27, Patrick's Mac, started from the menu bar)

| | first sample | screen first frame | lag | open cost |
|---|---|---|---|---|
| mic | 432 ms | 271 ms | +161 ms | 176 ms (`discoverMs` 27 + `configureMs` 19 + `startRunningMs` 130) |
| system | 416 ms | 271 ms | +145 ms | 166 ms (`startCaptureMs`) |

First arrival minus open cost is ~250 ms for both, which is when the display stream came up. Both tracks deliver as soon as they finish opening, so the lag is the **open time**, not first-sample latency (the camera's cause was the opposite). Both opens began only after the display stream was up.

## The fix: start them beside the display stream, not after it

`Capture.begin` calls `startAudioTracks` right before `startStream`, so the opens overlap the display's ~250 ms start. Each takes ~170 ms, so both should now land slightly BEFORE the screen's first frame (~70-90 ms ahead). Patrick accepted "ahead" (2026-10-27): the export starts at the screen's first frame (STC-578) and clips the audio to the same start. No pre-Record indicators, unlike warming at the countdown (not built).

A start that fails after the audio opened (`startStream` error or throw) calls `abandonAudioTracks`, which marks the session stopping, so an open still in flight closes itself on arrival, and stops what is already open. Nothing else would: `stop()` is never run for a session that never started.

## Run on the Mac (from `accounts/stc-590-parallel-audio-start` until it merges)

```
git fetch origin accounts/stc-590-parallel-audio-start
git switch --detach origin/accounts/stc-590-parallel-audio-start
helper/build.sh && npm run app:start
```

1. **The acceptance.** One 10 s take, mic and system audio on. The `[mic]` and `[system]` lines should show `lag` about -70 to -90 ms (negative = ahead of the screen), not +145/+161.
2. **Two streams starting together** (system audio's SCStream and the display's). Nothing in this repo has ever overlapped them. Do three takes back to back with system audio on; every one must start, with both `[system]` and the display present. A start error or a take with no system audio is the finding.
3. **A failed start.** Record with a display that vanishes, or deny a grant, then check the mic's orange dot goes out at once and `Activity Monitor` shows no leftover helper streams.
4. **The export still opens on the desktop, with audio in sync** (clap or click against the picture).
