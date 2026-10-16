# STC-562 runbook — a camera gap no longer costs the take its camera

**Branch:** `accounts/stc-562-camera-hold-frame` (not on `master` yet; run it from that
branch until it merges). STC-561 (#351), which it builds on, is on `master`.

```
git fetch origin
git checkout accounts/stc-562-camera-hold-frame
npm ci
helper/build.sh
```

## What was wrong

camera.mp4's writer input has the same 1 ns `mediaTimeScale` as display.mp4's, so it
has STC-561's limit: **no sample may be longer than 2^31 ns = 2.147 s.** A sample's
duration is the gap to the next frame, so the first camera frame after a longer gap
failed the camera writer (`-11800` over `-17771`).

Two things make that gap:

- **Any pause over 2.15 s with the camera on.** `PauseGate` drops camera frames while
  paused, so the first frame after resume is more than 2.15 s after the last written
  one. This is the ordinary trigger.
- **A camera that stalls and comes back** (STC-553).

**It was silent.** `CameraCapture` never read its writer's status. Every frame after the
failure was refused, nothing was said, the take carried on, and `anchors.camera` ended
at the gap. The PiP just disappeared after the pause.

## What changed

- **Camera hold frames.** `CameraCapture` runs STC-561's `decideHoldFrame`
  (`helper/src/HoldFrameDecisions.swift`) on a timer on its own sample queue. Once the
  newest camera frame in the file is 1.5 s old, it writes the same frame again at +1 s.
  This happens paused or not.
  - **Held frames do NOT move `anchors.camera.lastFramePtsNs`**, which is what ends the
    PiP (render.ts). So a camera that dies without a disconnect still ends the PiP at
    its last real frame, rather than freezing a face to the end.
  - The heartbeat gains `cameraFramesHeld`.
- **The pause check now comes before the camera's ordering guard.** The guard is "the
  newest PTS offered to the writer", and a hold must come after it. Paused frames used
  to advance it, and that left no hold ever safe during a pause. The pure test pins why.
- **A camera writer that fails anyway says so.** One reliable `camera-track-failed`
  warning (with `tNs` and the writer's error). The camera is torn down mid-take the
  STC-237 way. The take keeps recording, and `anchors.camera.endedBy` is
  `"writer-failed"`.
  - **anchors-15**, written only then. 12–14 had shipped with `disconnected` as the
    camera's only reason.
  - The pill shows **"Camera lost"** for 2 s. The panel adds "The camera could not be
    recorded at m:ss, so the rest of the take has no camera." No toast.
  - The warning is `camera-track-failed`, not `camera-writer-failed`. That name already
    meant a writer that never *started*, which has no track to lose.
- **What a failed camera writer leaves** (measured, `helper/test/camera-writer.test.ts`).
  The finished file is a demuxable prefix that loses only the fragment in flight: 61 of
  90 pre-gap frames come back. `loadSession` keeps the take and the camera.
  The helper's `lastFramePtsNs` is the last frame *appended*, and a failed writer keeps
  accepting a few frames after the sample that killed it. On hardware (2026-10-16) that
  was 8.0 s against a file ending ~2 s in. So for `writer-failed` only, `loadSession`
  ends the track at the file's last frame, and the PiP does not hold a frozen frame
  across the difference.
- **Faults.**
  - `STC_CAPTURE_FAULT=camera-gap` throws away every camera frame from 3 s to 8 s
    after the first, as a stalled camera sends none.
  - `camera-gap-unheld` is the same gap with no holds: the control, and the bug.
  - Three seconds in, not one: the control needs a finished 2 s fragment before the
    failure.
  - Named apart from STC-553's planned `camera-stall`, which is a different fault.
- **Tests.**
  - `helper/test/hold-frame.test.ts`: the pure rule, the camera's latency margin, and
    the pause ordering.
  - `helper/test/camera-writer.test.ts`: the writer in camera.mp4's shape, on CI.
  - `helper/test/camera-gap.grant.test.ts`: the grant test.
  - `transform/test/ended-by.test.ts`, `recover-anchors.test.ts`, `stop-copy.test.ts`,
    `helper/test/anchors.test.ts`: v15.
  - A `camera-gap` row in the fault soak.

## §1 The grant test (your terminal: Screen Recording, Input Monitoring and Camera)

```
npx vitest run --config vitest.grant.config.ts helper/test/camera-gap.grant.test.ts
```

All three must pass. If the camera does not open, they refuse (`SKIP-GRANT`); they do
not pass.

- **`camera-gap`**:
  - no `camera-track-failed` warning;
  - `cameraFramesHeld` is at least 3;
  - the take stops as `user` with the camera present and no `endedBy`;
  - no camera sample is longer than 1.6 s;
  - only held frames sit inside the gap.
- **`a 4 s pause with the camera on`** (no fault: the real trigger):
  - no failure;
  - held frames through the pause;
  - real camera frames after the resume.
- **CONTROL `camera-gap-unheld`**:
  - a `camera-track-failed` warning whose detail has `-11800` or `-17771`;
  - the take keeps recording, then stops as `user`;
  - `anchors.json` is v15 with `camera.endedBy: "writer-failed"`;
  - the take still loads, and its camera ends at the file's last frame, before the gap.
  - It prints `[camera-gap] unheld: N camera frames survive`. **Write N down.** If the
    control fails, the fault made no gap and the first test proves nothing.

## §2 The real thing, in the app (needs a person)

1. `npm run app:start`, camera on, and record the whole display.
2. After ~10 s, **pause for 10 s**, resume, record 10 s more, and stop.
3. Open the take in the editor.

**Pass:** the PiP is there after the resume (before this branch it vanished at the
resume). The panel shows no camera line. `anchors.json` has a camera with no `endedBy`.

**Then a stall, if you can make one.** Covering the lens does not stop frames, so it is
not a stall. Two candidates that might be: switch the Continuity camera's iPhone to
another app, or start a second app on the same camera mid-take. If one of them makes a
gap, the take must keep its camera through it.

## §3 What only a Mac can tell

- **Frame rate with a held buffer.** `CameraCapture` now keeps one camera pixel buffer
  out of AVCaptureVideoDataOutput's pool (the newest written one) for the hold to
  repeat. Compare `[camera] N frames at Xs` in `app:start`'s terminal with master on the
  same camera. They should be the same ~30 fps. If this branch delivers fewer, the pool
  is starving, and the hold should copy the buffer instead.
- **The failure line.** Nothing on real hardware is known to fail the camera writer now
  that holds exist. If you ever see "Camera lost" on the pill with the camera still
  plugged in, save the take and run:

  ```
  /usr/bin/log show --style compact --last 10m --predicate 'process == "stc-helper" AND eventMessage CONTAINS "FFR_"'
  ```
- **Crash recovery.** A take the helper dies in is rebuilt from the media
  (`recover-anchors.ts`), so held frames DO count there. A camera that died silently,
  followed by a helper crash, would show a frozen PiP up to the crash. That is narrow,
  and noted rather than fixed.
