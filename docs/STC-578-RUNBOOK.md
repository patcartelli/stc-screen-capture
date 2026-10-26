# Camera starts 1.1–1.6 s after the screen — runbook

Ticket: STC-578 (filed after PR #369 merged; none existed when the work was done).
Found running STC-532's failure-states runbook on hardware, 2026-10-23.

**On `master` since PR #369:**

```
git checkout master && git pull
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

## Measured on Patrick's Mac, 2026-10-26 (FaceTime HD Camera, anchors in ms)

Control, `STC_CAMERA_WARM=off`, camera idle beforehand (`warm: false`):

| take | camera first frame | display first frame | camera lag |
|---|---|---|---|
| 11-24-02 (mic) | 1712 | 148 | +1564 |
| 11-26-38 | 1604 | 152 | +1452 |
| 11-29-04 (mic) | 1608 | 148 | +1459 |

Warm-up on (`warm: true`):

| take | camera first frame | display first frame | camera minus display |
|---|---|---|---|
| 11-38-13 | 274 | 281 | -7 |
| 11-47-06 (mic + system) | 166 | 191 | -25 |
| earlier session, six takes (terminal lines not kept) | 94-137 | 149-155 | -17 to -56 |

**The control reproduced the 1.5 s lag. The open phases are NOT where it comes from:** in the control takes `discoverMs` was 0, `configureMs` 14-54, `startRunningMs` 14-38 and the whole `start()` 71-116 ms, and the first heartbeat still read `0 frames at 0.5s`. `startRunning()` returns almost at once; the camera then takes ~1.4 s to deliver its first frame. The warm-up works because it starts the session earlier so that wait has already passed by t0, not because it makes an open faster. (The PR description and the first draft of this runbook said the open itself was the 1-2 s; that was wrong.)

With the warm-up the camera now leads or matches the screen by 7-56 ms. It cannot be later than the screen's first frame by construction: it is adopted when the display stream is up. Within 33 ms in 3 of the 8 warm takes; the other 5 have the camera ahead by 38-56 ms (1-2 frames).

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

## Export: the PiP no longer draws over black (TRANSFORM_VERSION 17)

With the warm-up the camera can start 7-56 ms before the screen's first frame. The export starts at t = 0 and paints black while there is no screen frame, so up to three output frames showed the face bubble over black. `render()` now returns no PiP while the screen has no frame (`frameIndex === null`); a take whose screen starts first renders exactly what version 16 did. Pinned by `render.test.ts` ("no PiP while the screen has no frame yet"). To check by eye on a warm take: export it, step through the first 5 frames; the bubble should appear with the first screen frame, never before it.

## Export: it starts at the screen's first frame, not at t = 0

**The "black start" of `camera.mp4` is a QuickTime artifact only** (VLC does not show it; no capture-side sink was needed, and #379, which built one, was closed). What was real: every export began at t = 0, and the screen's first frame lands 0.15-0.28 s later, so the first 9-17 output frames were black with the cursor overlay drawn on them (seen in QuickTime and VLC, 2026-10-26). `exportWindow(project, durationNs, firstFrameNs)` now never starts before `firstShowableFrame` (the first 60 fps frame at or after `session.frames[0]`); the audio is clipped to the same start by the existing window logic. A screen that starts at 0 is unchanged, so `TRANSFORM_VERSION` stays 17 (the pixels of any given frame are the same; the file just begins later). The editor's export-length estimate passes `player.firstRenderableNs`. Pinned by `trim.test.ts` ("an export does not open on black"). To check by eye: export a fresh take; frame 0 must be the desktop, in QuickTime and VLC.
