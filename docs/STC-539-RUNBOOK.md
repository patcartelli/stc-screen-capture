# STC-539 runbook — camera.mp4 was 0 bytes after a helper crash

**Branch:** `accounts/stc-539-camera-fragments`. **Not on `master` yet**, so run it from the branch:

```
git fetch origin
git checkout accounts/stc-539-camera-fragments
npm ci
helper/build.sh
tools/test-host/build.sh
```

## Where it stands (2026-10-15)

**The helper did not reproduce it.** Every camera take SIGKILLed through `tools/test-host` left a demuxable `camera.mp4` that ended within a fragment of the kill. The built-in FaceTime HD Camera (the same uid `settings.json` picks) was used every time:

| run | helper | killed at | camera frames at kill | camera.mp4 |
| -- | -- | -- | -- | -- |
| grant test (camera only) | this branch | 12 s | 309 | 10.5 MB, last frame 0.4 s before the kill |
| camera + system audio | this branch | 30 s | — | 27.7 MB |
| camera + system audio | this branch | 62 s | 1812 | 59.6 MB |
| camera + system audio | `3df0518` (STC-530's merge, the 2026-10-14 code) | 30 s | — | 27.5 MB |

A synthetic writer with the camera's exact settings (1280×720, 30 fps, keyframe interval 60, 2 s fragments, real-time pacing, a first frame 1.4 s late) also flushes. **So the writer configuration is not the cause.**

That leaves two explanations for the 2026-10-14 take, and the take itself cannot tell them apart. `anchors.partial.json` is rewritten at the camera's FIRST frame and never again. So "the partial claimed a camera" only proves one frame landed:

1. **The camera stopped delivering** after its first frame or two, too soon for a 2 s fragment. That is not a writer bug. It is also a warning gap: `camera-no-frames` (STC-286) only fires when the camera delivered ZERO frames.
2. **The writer accepted frames and flushed nothing, only under the real app.** The app's take differs from the test-host's: fd3, an explicit `displayId`/`cameraDeviceUid`, `keys`, and 4K whole-screen.

The trashed take (`~/Library/Mobile Documents/.Trash/2026-10-14_12-40-15`) fits both. Its `camera.mp4` was last modified at 12:40 (creation) while `display.mp4` was last written at 12:41.

## §1 result (2026-10-15, real app, this branch)

**Not reproduced through the app either.** Whole screen at 4K, FaceTime HD Camera, Elgato Wave:3 mic, system audio, started from the hotkey, `pkill -9 stc-helper` at ~60 s (take `2026-10-15_16-42-30`):

- the `[camera]` count climbed steadily the whole take, 1749 frames at 60.0 s
- `camera.mp4` was 59.5 MB, its last frame at 59.64 s against a recovered stop of 60.25 s
- recovery (`recorder-quit`) kept the camera, `present: true`, so the PiP survived

Two clean-stop takes the same afternoon (34 s, 69 s) were fine too. Whatever emptied the 2026-10-14 camera.mp4 is intermittent, or depended on something not repeated here. The most likely candidate is explanation 1: a camera that stalled after its first frame, which nothing warns about. The `[camera]` log line in `npm run app:start`'s terminal now makes a recurrence diagnosable on the spot.

## What this branch adds to tell them apart

- **The stats heartbeat carries `cameraFrames`** (`CaptureSession.stats()`): frames that actually landed in camera.mp4. It appears once the camera is stored.
- **The main window's diagnostics table shows it** ("camera frames"). Turn it on in the profile sheet: **Show diagnostics**.
- **`tools/test-host --kill-after-ms <n>`** SIGKILLs the helper mid-take instead of stopping it. It records the last heartbeat before the kill as `lastStats`.
- **`helper/test/crash-camera.grant.test.ts`** pins the ticket's "done when" on the helper. It refuses (it does not pass) when the camera delivered under 60 frames by the kill, because a starved camera says nothing about the writer.

## §0 The grant test (your terminal)

```
npm run test:capture -- helper/test/crash-camera.grant.test.ts
```

It passed here on 2026-10-15. If it fails on your machine, that is the repro: note the message and stop there.

## §1 The real-app repro: the one run that decides it

```
npm run app:start
```

1. Profile sheet → **Show diagnostics** on.
2. Record **whole screen, camera on**, the same as 2026-10-14 (system audio on, Keys on).
3. Watch **camera frames** in the diagnostics table for ~60 s. Note whether it keeps climbing (~30/s) or stalls at a small number.
4. Note the number, then in a terminal:
   ```
   pkill -9 stc-helper
   ```
5. Check the file before doing anything else in the panel:
   ```
   ls -la ~/Library/Application\ Support/Capture/temp-takes/*/camera.mp4
   ```

**Read it like this:**

| camera frames | camera.mp4 | means |
| -- | -- | -- |
| climbed the whole take | > 0, PiP survives | not reproduced. Repeat 2–3 times; it may be intermittent |
| climbed the whole take | **0 bytes** | **the writer bug, under the app only.** Tell me the count; the fix is in the app's start path |
| stalled at a few frames | 0 bytes | **the camera stopped**, not the writer. This ticket becomes "warn when the camera stalls after its first frame" |
| shows "—" throughout | — | the camera never opened, so this run says nothing |
