# STC-433 — display/mic fallback: what to run on the Mac

Rewritten 2026-09-25. The original version of this runbook (and of the
feature) predates two events that changed the actual behavior underneath it:

1. **PR #221's merge** ported STC-433 onto STC-388's Record-flow rewrite,
   which landed on `master` in between. Scope (display/window/region) is no
   longer a sticky setting read from disk — it's picked fresh from a live
   overlay every time `runRecordFlow`/`recordFlowBody` run. That removed the
   "Choose a Different…" dialog option entirely (there's no sticky picker
   control left to focus — pressing Record again already shows a live
   device list) and split the display fallback in two: **Use Automatic**
   only when the pick was a full display, a plain refusal for a cropped
   region (its `region` coordinates belong to the display that's gone).
2. **A second bug found on hardware** while testing this ticket
   (2026-09-25): disconnecting the mic **mid-recording** (not before
   Record was pressed) was ending the whole take, video included.
   Investigation found no code ever wired a mic-disconnect notification to
   anything — `Watchers.onDeviceChange` fired but nothing was assigned to
   it. Fixed in `CaptureSession.handleMicDisconnected`
   (`helper/src/Capture.swift`) and wired from `main.swift`'s `boot()`: it
   tears down ONLY the mic subsystem and leaves video running, unlike a
   display change mid-take (a full, intentional stop — `AVAssetWriter`
   cannot resize mid-file). **This fix is unverified — root cause was
   inferred from static reading, not a crash log, since this session has no
   Mac.** If the take still ends after this lands, the next step is a real
   crash log from Console.app or the Xcode debugger, not another
   speculative patch.

Still typechecked/bundled only (no Xcode/swiftc in this session) — **none
of what follows has been watched.**

## What changed (current behavior)

### Before Record starts (the original ticket)

`recordFlowBody` (`app/src/main.ts`) checks the overlay's own fresh
display/mic pick against `sup.devices()`'s current enumeration, right
before the countdown:

- **Missing display, full-display pick**: a dialog — **Use Automatic**
  (drops the specific display, records on whichever the helper lists
  first) / **Cancel**.
- **Missing display, cropped-region pick**: a dialog with **OK** only —
  a plain refusal. Press Record again to re-pick from the live list.
- **Missing mic**: a dialog — **Turn Mic Off** (the same state picking
  "Off" reaches — never an automatic pick of another mic, the standing
  STC-233 decision) / **Cancel**.
- A CoreAudio enumeration reported as `stalled` skips the mic check
  entirely (unknown is not the same as gone) — the existing
  `mic-not-found` live warning stays the backstop for that case.

### During an active recording (found 2026-09-25, this pass)

- **Display disconnects mid-take**: unchanged, pre-existing, intentional —
  the recording stops cleanly (`display-reconfigured`, already covered by
  `docs/STC-247-RUNBOOK.md` and settled architecture: AVAssetWriter cannot
  change output dimensions mid-file). Not this ticket's bug.
- **Mic disconnects mid-take**: previously ended the WHOLE recording with
  no dedicated reaction. Now: the recording continues on video, the mic
  track is finalised at the point of disconnect (`mic.m4a` covers up to
  that moment, `present: true` if any audio was captured before it), and
  the app shows a `mic-disconnected` warning (distinct from the ambiguous,
  camera-labeled `device-disconnected` toast this used to show instead).

## §1 — the display fallback (pre-start)

1. `npm run app:start`. Press Record — the overlay opens.
2. Pick a specific display (not a region crop), then disconnect that
   display before the countdown finishes (or before pressing Record on a
   multi-display Mac — the overlay only ever lists what's live, so this is
   a narrow timing window rather than a sticky, easy-to-hit state; a
   one-display Mac has no way to trigger this by hand at all).
3. **Expect**: a dialog naming the display as no longer connected, **Use
   Automatic** as the default button.
4. Click it. **Expect**: the countdown starts immediately, the take
   records on whichever display is available.
5. Repeat, picking a cropped region instead of a full display, and
   disconnect that display in the same window. **Expect**: a dialog with
   only an OK button — no automatic fallback offered — and no recording
   starts. Press Record again and confirm the overlay now shows the
   remaining display(s) only.
6. Cancel (or Escape) on the full-display case. **Expect**: back to idle,
   nothing recorded, no error toast.

## §2 — the mic fallback (pre-start)

Same shape, with a microphone (unplug a USB/Bluetooth mic between picking
it in the overlay's bar and the countdown finishing):

1. **Expect**: a dialog with **Turn Mic Off** as the default button —
   never an automatic pick of another mic.
2. Click it. **Expect**: recording starts with no audio; the device
   popover (`#mic-picker`) now reads "off" once reopened.
3. Cancel. **Expect**: back to idle.

## §3 — a CoreAudio stall still doesn't force the mic off (pre-start)

Hardest to trigger by hand; if `docs/STC-233-RUNBOOK.md` already has a
reliable way to make `devices()` report `stalled: true`, use that. Pick a
mic in the overlay while stalled, then let it proceed to Record.
**Expect**: no dialog for the mic (a stall means "unknown," not "gone") —
recording proceeds with the mic as configured.

## §4 — mic disconnect DURING an active recording (new, 2026-09-25)

The check this pass exists for:

1. Start a recording with a mic selected. Let it run long enough to be
   unambiguously past the countdown and actually capturing (a few seconds
   of real audio).
2. Physically disconnect that mic (unplug the USB/Bluetooth device).
3. **Expect**: the recording keeps running — the pill/window still shows
   `recording`, the display capture is unaffected, and a `mic-disconnected`
   warning appears (not the old, mislabeled "A capture device was
   disconnected" camera toast — that specific toast should no longer show
   for a mic uid). **This is the behavior that was broken before this fix;
   if the whole take still ends here, the fix did not work and needs a
   crash log, not another guess.**
4. Stop the recording normally. **Expect**: `mic.m4a` exists and is
   non-empty, `anchors.json`'s `mic` block has `present: true` with
   `lastFramePtsNs` at roughly the moment of disconnect (well before
   `stop.t`), and `display.mp4` covers the FULL take duration, not just
   the portion before the mic dropped.
5. For contrast, repeat with a DISPLAY disconnect mid-take instead (or
   just recall `docs/STC-247-RUNBOOK.md`'s own trial) — confirm that one
   still stops the whole recording. The two should now behave differently
   on purpose: audio loss is a track ending early, video loss is the take
   ending.

`STC_CAPTURE_FAULT=mic-disconnected` reproduces step 2-3 deterministically
(the mic reports itself gone 0.5s after opening, same idiom
`STC_CAPTURE_FAULT=stream-died` already uses for the display side) if a
real unplug is inconvenient to arrange — set it as an environment variable
on the helper process before `start`ing a recording with a mic. No grant
test yet exercises this via the fault (see the Next section) — it has to be
run by hand for now.

## Next

- No automated test exists for §4 yet. A grant test mirroring
  `helper/test/stream-died.grant.test.ts`'s shape would need
  `tools/test-host` to forward `STC_CAPTURE_FAULT` into the helper
  subprocess it spawns (it doesn't today — `Process()` there inherits the
  test-host app's own environment, not whatever a Node test sets via
  `execFileSync`'s `env` option, since `open -W` doesn't propagate that).
  Skipped in this pass rather than half-built.
- The camera has the identical latent gap (`Watchers.onDeviceChange` fires
  for a camera disconnect too, and nothing tears down just the camera
  subsystem either) — not fixed here, since nobody has reported it and this
  pass was scoped to the mic report. Worth its own ticket if it turns out
  to matter.
