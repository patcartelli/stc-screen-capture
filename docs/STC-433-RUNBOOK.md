# STC-433 — display/mic fallback: what to run on the Mac

Written on a Linux session with no macOS, no Xcode, no `swiftc` — typechecked
and bundled clean, but the actual dialog has never been shown on screen, and
none of the existing e2e picker tests exercise this path (checked by hand:
neither `display-picker.e2e.test.ts` nor `mic-picker.e2e.test.ts` presses
Record with a selection that's missing from the fake device list).

## What changed

`recorder:start` (`app/src/main.ts`) now checks the stored `displayId` and
`micDeviceUid` against `sup.devices()`'s own current enumeration, before the
countdown runs:

- **Missing display** (previously: `start` refused outright with a raw
  `display-not-found` string) — a native dialog: **Use Automatic** (falls
  back to the existing, safe "whichever the helper lists first" mode) /
  **Choose a Different Display…** (opens the profile sheet and focuses the
  display picker) / **Cancel**.
- **Missing mic** (previously: `start` proceeded anyway with no audio and
  said so only afterwards, via `mic-not-found` in `MIC_FAULTS`) — a native
  dialog: **Turn Mic Off** (the same state picking "Off" reaches) / **Choose
  a Different Microphone…** / **Cancel**. Never an automatic pick — the
  existing STC-233 decision against silently grabbing a mic stands.

A CoreAudio enumeration reported as `stalled` skips the mic check entirely
(unknown is not the same as gone) — the existing `mic-not-found` live warning
stays the backstop for that case.

## §1 — the display fallback

1. `npm run app:start`, pick a specific (non-Automatic) display in Settings.
2. Disconnect that display (or, on a one-display Mac, there's no way to
   trigger this by hand — skip to §3's fake-helper alternative instead).
3. Press Record. **Expect**: a native dialog naming the display as no longer
   connected, with "Use Automatic" as the highlighted default button.
4. Click **Use Automatic**. **Expect**: the countdown starts immediately
   (no second click needed), the take records on whichever display is
   available, and the Settings picker now reads "Automatic" once reopened.
5. Repeat, this time clicking **Choose a Different Display…**. **Expect**:
   the profile sheet opens with the display `<select>` focused, and nothing
   recorded.
6. Repeat, clicking **Cancel** (or pressing Escape). **Expect**: back to
   idle, nothing recorded, no error toast.

## §2 — the mic fallback

Same shape as §1, but with a microphone (unplug a USB/Bluetooth mic that was
selected, or use a mic that was removed since it was last picked):

1. Press Record with a since-disconnected mic selected.
   **Expect**: a native dialog with **Turn Mic Off** as the default button
   — never an automatic pick of another mic.
2. **Turn Mic Off** → recording starts with no audio, Settings now shows
   "Off".
3. **Choose a Different Microphone…** → profile sheet opens, mic `<select>`
   focused, nothing recorded.
4. **Cancel** → back to idle.

## §3 — a CoreAudio stall still doesn't force the mic off

Hardest to trigger by hand; if `docs/STC-233-RUNBOOK.md` already has a
reliable way to make `devices()` report `stalled: true`, use that. Press
Record with a mic selected while stalled. **Expect**: no dialog for the mic
(a stall means "unknown," not "gone") — recording proceeds with the mic as
configured, same as before this ticket.
