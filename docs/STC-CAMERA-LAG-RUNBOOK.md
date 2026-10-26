# Camera starts 1.1–1.6 s after the screen — runbook

No Linear ticket yet (searched 2026-10-23: STC-286/539/553/562 are camera tickets, none is this). Rename this file to `STC-NNN-RUNBOOK.md` when one exists.
Found running STC-532's failure-states runbook on hardware, 2026-10-23.

**Not on `master` yet. Run it from `claude/eager-einstein-n9sgd3`:**

```
git fetch origin claude/eager-einstein-n9sgd3
git checkout claude/eager-einstein-n9sgd3
helper/build.sh && npm run app:start
```

**Written on Linux with no `swiftc`: none of the Swift here has been compiled or run.** The TypeScript typechecks; the helper, the decisions harness (`helper/test/decisions.test.ts`) and `helper/test/ipc.test.ts` have not run. Build first and expect to fix compile errors.

## What was found (from the code and the older measurements; nothing re-measured)

Take anchors, 2026-10-23: display `firstFrameNs` ~0.25–0.29 s, mic ~0.50 s, system ~0.41–0.43 s, camera 1.56 s and 1.61 s.

The camera lag is the **cold open**, and it sits on the take's timeline because the camera is opened only after the display stream is up:

1. `CaptureSession.begin` starts the SCStream, and only in its completion handler calls `startCameraAsync()`.
2. `CameraCapture.start()` then does device discovery, builds an `AVCaptureSession`, sets up the writer and calls `startRunning()`; the first frame follows.
3. Earlier numbers agree: phase 0 +1.04 s, HANDOFF-2026-08-27 "cold Facecam 2.2 s to open", STC-286 control run first frame at 1.76 s.

Not the cause: `captureOutput`'s `rel >= 0` drop only discards frames stamped before t0, which a not-yet-open camera has none of; the pause gate and ordering guard act on frames after the first.

## What changed

- **Timings** (`camera-started.timings`, plus a `[camera] first frame` line on the helper's stderr): `discoverMs`, `configureMs`, `startRunningMs`, `writerMs`, `startMs`, `warm`, and once the first frame lands `firstFrameArrivalNs` (wall time since t0 when it arrived), `firstFramePtsNs` (what anchors.json records) and `displayFirstFrameNs`.
- **Warm-up**: when the countdown starts and the camera is on, main sends `camera-warm`. The helper opens the camera and runs the session (`CameraWarm.swift`). The take adopts it (`CameraCapture.start(warm:)`) if it is the device the take would have picked (`decideWarmAdoption`). Cancelling the countdown sends `camera-release`. A start that fails, a take with the camera off, and a hold timer (countdown + 15 s, capped at 90 s) all release it too, so the LED is never left on.
- No countdown (`countdownMs: 0`) = no warm-up = today's behaviour (the PiP appears late; the export hides it until the first frame, `camera-gaps.ts`, unchanged).

## Run 1 — measure the old behaviour first (the numbers are the point)

Warm-up off for a control: start the app with `STC_CAMERA_WARM=off npm run app:start`. The terminal prints `[camera] started: {... "warm": false ...}` for every take (`true` when the warm-up was used). Then record 5 s takes and read `anchors.json` and the helper stderr:

| # | camera | mic | system audio | write down |
|---|---|---|---|---|
| 1 | FaceTime, automatic | off | off | `timings`, `camera.firstFramePtsNs`, `capture.firstFrameNs` |
| 2 | FaceTime, automatic | Wave:3 | on | same |
| 3 | FaceTime, **named** (picker) | Wave:3 | on | same |
| 4 | Elgato Facecam (if present) | — | — | same |

Which phase dominates? `startRunningMs` is expected to be most of it. `firstFrameArrivalNs − firstFramePtsNs` is the device pipeline latency (phase 0: ~90 ms on a USB cam). **If `startRunningMs` is small and the lag is still ~1.2 s, the lag is not the open, and the pre-warm will not fix it: stop and report.**

## Run 2 — with the warm-up (the acceptance)

Countdown on (the default 3 s). Repeat the four takes.

**Must show:**
- `timings.warm: true` and `startRunningMs` ~0 (the session was already running).
- `camera.firstFramePtsNs` close to t0, not 1.2 s after it. **The gap to `capture.firstFrameNs` can now go negative:** a warm camera's first frame lands a frame or two after t0, while the display's first frame is ~0.25 s after t0 (the SCStream's own start). So "within 33 ms of the display" may read as the camera leading by ~0.2 s. Report the three numbers (t0-relative camera, display, gap) rather than forcing the match; the export hides the PiP before the camera's first frame and shows it from there, so a camera that leads the screen is harmless to it, but say if it looks wrong.
- A stale warm-up releases itself: send `camera-warm` by hand (e.g. through `tools/test-host`, or a throwaway client), wait past its hold, and the `camera warm-up unclaimed` stderr line appears and the LED goes off; then record: `warm: false`, cold open as before.
- Cancel the countdown (Esc): the camera LED goes off within a second.
- A named camera whose uid differs from what the warm-up opened (change the picker between two takes' countdowns is not possible mid-flight, so test it by sending `camera-warm` for the automatic camera and then `start` with a different `cameraDeviceUid`): `warm: false`, the named device recorded, the warm one stopped.
- The LED is on during the countdown (3 s) and not before. **Decide whether that is acceptable.** It is the cost of the fix, and the one thing no test can judge.

**Also check:** the pill and the library do not show the camera as active before Record; Stop → the camera light goes off as before; a second take straight after works (the warm slot is empty again, so it warms cold-then-warm again at its own countdown).

## Open

- Run 1 decides whether the premise holds. Nothing is concluded until it is read.
- Whether the display's own 0.25 s start should be chased once the camera matches it is not part of this change.
- Warming at the overlay instead of the countdown would give more lead time and light the LED while still choosing; it was not chosen (Patrick, 2026-10-23).
