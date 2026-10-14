# STC-531 runbook — the pill and the panel say why the helper stopped a take

**Branch:** `accounts/stc-531-source-lost-copy`. **Not on `master` yet**, so run it from the branch:

```
git fetch origin
git checkout accounts/stc-531-source-lost-copy
npm ci
helper/build.sh
npm run app:start
```

## What changed

- **No toast** when the helper stops a take by itself (Patrick, 2026-10-14). Instead:
  - the pill shows the cause for 2 s (`PILL_STOPPED_DWELL_MS`) in place of the timer, and is disabled meanwhile;
  - then the window restores and the take's panel goes up with `Stopped at m:ss. <cause>. Everything up to then is saved.`
- Every word comes from `app/src/stop-copy.ts`. `ENDED_BY_HELPER` is gone.
- Two panel actions:
  - **Reclaim space** for a full disk. It runs the same sweep as the profile sheet's button.
  - **Open System Settings** when Screen Recording was turned off. It opens the Screen Recording pane.
- **A new stop reason, `screen-recording-revoked` (anchors-12).** `decideStreamStop` (`helper/src/StreamStopDecisions.swift`) decides it when the display stream dies. Either signal is enough:
  - `CGPreflightScreenCaptureAccess()` reads false at that moment;
  - the error is ScreenCaptureKit's `userDeclined` (-3801).

  Any other death is still `stream-stopped`.
- Labels:

| Reason | Pill | Panel cause |
|---|---|---|
| `window-closed` | Window closed | The window you were recording was closed. |
| `window-resized` | Window resized | The window you were recording was resized. |
| `display-reconfigured` | Display lost | The display you were recording was disconnected. |
| `region-out-of-bounds` | Area lost | The display settings changed and the area you were recording no longer fits. |
| `disk-full` | Disk full | Your disk is full. + **Reclaim space** |
| `screen-recording-revoked` | Access revoked | Screen Recording was turned off for Capture. + **Open System Settings** |
| `stream-stopped` | Source lost | The screen capture stopped unexpectedly. |
| `error` | Write failed | The recording could not be written to disk. |

Three of these depart from the spec:
- **"Area lost":** the spec's "Display changed" is 15 characters, over its own 14-character limit.
- **The last two rows:** the spec does not name these stops. Without the toast they would say nothing.
- **"Everything up to then is saved."** appears on every row. That follows the spec's wording rule, not its table, which has it only on disk full.

## §0 Grant test (Patrick's terminal)

```
npm run test:capture -- helper/test/stream-died.grant.test.ts
```

All three tests pass. The new test drives `STC_CAPTURE_FAULT=screen-recording-revoked`: the same injected death, with the grant probe reading false. The existing `stream-died` test is its control: the same death with the real probe must stay `stream-stopped`.

## §1 Screen Recording turned off mid-take (the acceptance for state 1)

1. Use the packaged app, or `app:start` from a terminal so the helper's stderr is visible.
2. Start a Screen take.
3. A few seconds in, turn Screen Recording off for Capture in System Settings.

**Expect:**
- the pill reads **Access revoked** for about 2 s, with no toast;
- then the panel reads `Stopped at m:ss. Screen Recording was turned off for Capture. Everything up to then is saved.`;
- **Open System Settings** opens the Screen Recording pane.

**Report the helper's log line** `stream: died (<domain> <code>), Screen Recording granted: <bool> -> ...`. It says which signal classified the stop. If the panel says "The screen capture stopped unexpectedly" instead, neither signal fired; that log line is what to send back.

Turn Screen Recording back on and relaunch afterwards. A grant made while the app is running only takes effect after a relaunch.

## §2 The pill label, by eye

Work through §3 to §5 and look at the pill during the 2 s.

- **Does the label fit?** The window keeps the width it collapsed to, sized for the timer, so the label is in the system font. The longest labels are "Window resized" and "Access revoked". An ellipsis means it does not fit: report it.
- **Is 2 s long enough to read?**
- **Does the window jump when it restores?**

## §3 Window closed / resized

Record a window (overlay → Window), then close it. Do it again and resize the window instead. Expect **Window closed** / **Window resized** on the pill, then the panel line, with no action button.

## §4 Display lost

Record a second display, then unplug it. Expect **Display lost**, then `...The display you were recording was disconnected...`.

## §5 Disk full

Use STC-527's runbook §2 setup (a small `hdiutil` volume as `STC_TEMP_TAKES_DIR`; check `df` first). Expect:
- **Disk full** on the pill;
- the panel line, and a **Reclaim space** button;
- clicking the button gives the same result as the profile sheet's Reclaim space (a list to confirm, or "nothing to reclaim").

## What is deliberately not here

- Library notes for these stops: that is STC-529.
- A Stop the user asked for: it gets no label and no line, unchanged.
