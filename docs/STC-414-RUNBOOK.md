# STC-414 — mic/camera device pickers: what to run on the Mac

Written on a Linux session with no Xcode/swiftc at all (CLAUDE.md's own
Toolchain note). `helper/src/CameraCapture.swift`, `CaptureDecisions.swift`
and `Capture.swift` were only **typechecked by eye against the existing
`MicCapture.swift` pattern they mirror — none of it has run.** `npm run
typecheck` and the TS unit suite (`app/test/device-picker.test.ts`,
`app/test/settings.test.ts`) are green here; `app/test/camera-toggle.e2e.test.ts`,
`app/test/mic-picker.e2e.test.ts` and `app/test/settings-sheet.e2e.test.ts`
pass under Xvfb against the fake helper. `helper/test/decisions/main.swift`
(the `parseStartRequest`/`cameraDeviceUid` cases) needs `swiftc` to run at
all and has not been run anywhere this session had access to.

Run this from `accounts/stc-414-audio-meter-and-camera-preview-become-input-selectors`.

## Scope note — read before judging anything below

The ticket's own text describes the audio meter growing live levels and a
camera PiP preview becoming clickable. Neither exists in this codebase:

- There is no audio capture anywhere in the helper. The pill's meter is
  deliberately a static hatched placeholder (STC-375) — building live levels
  needs a real audio-capture path in the Swift helper first, which is out of
  scope here.
- There is no camera preview UI at all — camera was a plain on/off checkbox.
  Building a live PiP preview (an `AVCaptureSession` preview piped into
  Electron) is a separate, larger effort.
- The pill itself only renders while `SupervisorState === "recording"` — the
  opposite of when this ticket wants a picker clickable, and exactly the
  state it wants read-only. So the pickers were built onto the
  always-visible `#devicestate` row (`#camera-state`/`#mic-state`) instead of
  the pill, which is what the ticket's own "the controls that already show
  their feedback" phrase names once you look at what's actually always on
  screen before a take.

All three notes are in this ticket's Linear comment too. If any of these
scope calls is wrong, that is the thing to correct first — the rest of this
runbook assumes them.

## §0 — build it at all

1. `git fetch origin accounts/stc-414-audio-meter-and-camera-preview-become-input-selectors`
   `git checkout accounts/stc-414-audio-meter-and-camera-preview-become-input-selectors`
2. `helper/build.sh` — **this is the first real compile of the Swift changes.**
   Expect it to fail here before anywhere else; the mirror to `MicCapture.swift`
   was done by hand, one type at a time (`AVCaptureDevice?` optional binding,
   the `if let deviceUid { … } else { … }` device fork, the new
   `CameraError.deviceNotFound` case). If it does not build, that is this
   runbook's most important finding — fix it before anything below.
3. `npm run typecheck && npm test` — should still be green; `npm run
   test:capture` needs the Screen Recording grant.

## §1 — mic and camera pickers, pre-record

1. `npm run app:start`.
2. At rest (not recording), the `#devicestate` row reads "camera: off" /
   "mic: off". Click the camera row.
   **Expect**: a small popover appears anchored under it — Off, Automatic,
   then every connected camera by name — with the current choice checked.
   It must not resize or move the main window.
3. Pick "Automatic". **Expect**: the row now reads "camera: automatic", the
   popover closes.
4. Click the camera row again and pick a named device (plug in an external
   camera, or an iPhone via Continuity Camera, if you have one — otherwise
   the built-in is the only real entry). **Expect**: the row reflects that
   device's name at rest.
5. Same for mic: click the mic row, pick a real input. **Expect**: "Off" is
   still there and still means no mic — STC-233's rule is unchanged, only
   Automatic is new (and camera-only).
6. Quit and relaunch. **Expect**: both choices survive (sticky, same as
   before).
7. Click a trigger, then click the OTHER trigger without picking anything.
   **Expect**: the first popover closes and the second opens — never both at
   once (`decidePopoverToggle` in `device-picker.ts`).
8. Open a popover, then click elsewhere on the window. **Expect**: it closes.
   Open one and press Escape. **Expect**: it closes (shares the profile
   sheet's own Escape handler).

## §2 — the picked camera is actually THE camera, not a label

This is the part with no automated coverage at all on this machine — the
`cameraDeviceUid` plumbing through `CameraCapture.swift` is unverified Swift.

1. With two cameras available (built-in + one external/Continuity), pick the
   EXTERNAL one explicitly (not Automatic).
2. Record a few seconds with Camera on.
3. **Expect**: the PiP in the resulting take is the external camera's actual
   feed, not the built-in's — the concrete claim `CameraCapture.start`'s new
   `if let deviceUid` branch makes (`discovery.devices.first(where: {
   $0.uniqueID == deviceUid })`, no ranking).
4. Repeat with Automatic selected and only the built-in connected.
   **Expect**: unchanged from before this ticket — `pickCamera`'s own
   transportType ranking picks it, exactly as it always has.
5. Pick a real device, then physically disconnect it (unplug the external
   camera, or leave Continuity Camera's phone out of range) before
   recording. **Expect**: the take fails to open a camera and the toast
   reads "The chosen camera is no longer available…" (`CAMERA_FAULTS`'s new
   `camera-not-found` entry) — the camera's own version of the existing
   mic-not-found behaviour, not a silent fallback to some other device.

## §3 — read-only during a take

1. Start recording with a camera and mic chosen.
2. **Expect**: both `#devicestate` triggers are disabled (`opacity: .4`,
   unclickable) for the whole take — matching the pre-existing checkbox/select
   behaviour, just on the new controls.
3. Stop the take. **Expect**: both re-enable.

## §4 — popover visuals only a Mac can judge

- Does the popover read as a small, deliberate control, or as a stray box —
  spacing, the checkmark, hover state?
- Does it ever clip off the window's edge? The row sits near the top of the
  window; a popover with several devices could in principle run past the
  bottom in a very short window. Nothing here clamps its position to the
  viewport — if it clips, that is a real gap to fix, not a design call.
- Light and dark mode both (the popover reads `--surface`/`--border-strong`/
  `--accent` from `tokens.css`'s existing tokens — nothing new was added).
