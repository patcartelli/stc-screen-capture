# STC-553 runbook: a camera that stalls after its first frame

**Branch:** `accounts/stc-553-camera-stall`, cut from `master` at 47faa36 (it includes STC-562,
#352). **Not on `master` until its PR merges**, so run it from the branch:

```
git fetch origin
git checkout accounts/stc-553-camera-stall
npm ci
helper/build.sh
npm run app:start
```

## What changed

- **Detection** (`helper/src/CameraStallDecisions.swift`, pure). A camera that has delivered
  frames and then has no frame ARRIVE for **3 s** (N, from the 2026-10-16 Mac check) while the
  take is recording and not paused is stalled. Arrival is stamped at the top of
  `captureOutput`, before the pause gate, the ordering guard and the writer. Checked every
  250 ms on the camera's own queue. A pause closes an open stall at the pause's start. After
  a resume, N runs from the resume.
- **Said once per stall:** a reliable `camera-stalled` warning (`tNs` = where it froze), then
  re-armed by the next frame. Nothing is torn down, so a camera that recovers keeps
  contributing.
- **The pill** shows **Camera stalled** for 2 s over the timer (the STC-237 notice). The
  button stays Stop and there is no toast. The camera's device row is NOT marked failed.
- **anchors-16:** `camera.stalledSpans: [{startNs, endNs}]`. Each span runs from the last
  frame before the stall to the first frame after it, or to the pause that cut it short, or
  to `stop.t` for a camera that never came back. It is written to `anchors.partial.json` the
  moment a stall begins (open, no `endNs`) and again when it ends, so a SIGKILL mid-stall
  still records it. Recovery closes an open span at the stop.
- **The panel** adds "The camera stalled from 1:10 to 1:25, so the picture-in-picture is
  hidden there."
- **The library** adds the note "Camera stalled from 1:10 to 1:25". It lists the first two
  spans, then "and N more".
- **The export** (STC-557, folded in) no longer holds the last camera frame frozen across a
  stall. The PiP is hidden across each `stalledSpans` span, and across any camera frame-grid
  gap over 3 s of recording time, which covers takes recorded before this. Paused time never
  counts, and the PiP is never hidden inside a pause (`transform/src/camera-gaps.ts`,
  `TRANSFORM_VERSION` 16).

## §1: the injected stall, from your terminal (grant test)

```
helper/build.sh
npm run test:capture -- helper/test/camera-stall.grant.test.ts helper/test/camera-gap.grant.test.ts
```

Needs Screen Recording, Input Monitoring and Camera granted to the terminal, and a camera.
`camera-stall.grant.test.ts` must show all of the following:

1. `STC_CAPTURE_FAULT=camera-stall` (no frames 3-7 s after the first, a 4 s stall, under the
   5 s the Mac check could not see): `camera-stalled` within about 3.9 s of the stall, printed
   as `[camera-stall] said N ms after the stall began`. One warning only. The open span is in
   `anchors.partial.json`, the take still recording, and one closed span in `anchors.json` at
   v16. render() has no PiP mid-stall and the PiP back after.
2. `=camera-stall-end`: one span that ends at `stop.t`.
3. **CONTROL, no fault:** no warning, no `stalledSpans`, not v16.
4. **CONTROL, a 5 s pause:** no warning, no span.

`camera-gap.grant.test.ts` (STC-562) now also expects its 5 s gap on record as a stall. Its
unheld control is v16, not 15.

The fault soak (`npm run test:soak`, STC-238) has `camera-stall` as a row.

## §2: by eye (a real stall)

Nothing here can order a real camera to stall. If you can make one happen (for example a USB
camera pulled halfway, or a Continuity camera walked out of range and back), record through it
and check:

1. The pill reads **Camera stalled** for about 2 s, with no toast, within about 3 s of the
   picture freezing.
2. The panel's line ends with "The camera stalled from m:ss to m:ss, so the picture-in-picture
   is hidden there."
3. The library tile has the "Camera stalled from …" note.
4. In the export the PiP disappears for that stretch and comes back. It must not show a frozen
   face.

## §3: what a pause must not do (by eye)

Record with the camera on, pause for 10 s, resume, stop. The pill must never say **Camera
stalled**. In the export the PiP behaves exactly as before this change through the pause.
