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
