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
- The warning the helper sends just before such a stop (`window-resized-during-recording`, `window-closed-during-recording`, `stream-stopped`, `disk-full`, `writer-failed`) is no longer a toast either: `STOP_ANNOUNCING_WARNINGS`, found on hardware 2026-10-14 when a resized window still got "The recorder reported a problem: window-resized-during-recording".
- One panel action: **Reclaim space** for a full disk. It runs the same sweep as the profile sheet's button.
- Labels:

| Reason | Pill | Panel cause |
|---|---|---|
| `window-closed` | Window closed | The window you were recording was closed. |
| `window-resized` | Window resized | The window you were recording was resized. |
| `display-reconfigured` | Display lost | The display you were recording was disconnected. |
| `region-out-of-bounds` | Area lost | The display settings changed and the area you were recording no longer fits. |
| `disk-full` | Disk full | Your disk is full. + **Reclaim space** |
| `stream-stopped` | Source lost | The screen capture stopped unexpectedly. |
| `error` | Write failed | The recording could not be written to disk. |

Three of these depart from the spec:
- **"Area lost":** the spec's "Display changed" is 15 characters, over its own 14-character limit.
- **The last two rows:** the spec does not name these stops. Without the toast they would say nothing.
- **"Everything up to then is saved."** appears on every row. That follows the spec's wording rule, not its table, which has it only on disk full.

## Settled: Screen Recording turned off mid-take is not a stop

Measured on 2026-10-14 with the **packaged** app, switching off Capture's own entry in System Settings mid-take:
- macOS kept delivering frames: 57 fps, no gap, until the user pressed Stop.
- It only offered **Quit & Reopen / Later**. Quit ends the take through the ordinary quit path, and the take waits in unsaved takes for the next launch.

So the spec's state 1 has no pill label or panel line. A `screen-recording-revoked` stop reason was built and then removed.

**Trap:** `npm run app:start` runs as Electron or the terminal app, not as Capture. Switching off Capture's entry does nothing to it, so test anything involving permissions on the packaged app (`npm run app:package`).

## §1 The pill label, by eye

Work through §2 to §4 and look at the pill during the 2 s.

- **Does the label fit?** CONFIRMED for "Window resized" on hardware 2026-10-14. The window keeps the width it collapsed to, sized for the timer, so the label is in the system font. The longest label is "Window resized". An ellipsis means it does not fit: report it.
- **Is 2 s long enough to read?**
- **Does the window jump when it restores?**

## §2 Window closed / resized

Record a window (overlay → Window), then close it. Do it again and resize the window instead. Expect **Window closed** / **Window resized** on the pill, then the panel line, with no action button.

## §3 Display lost

Record a second display, then unplug it. Expect **Display lost**, then `...The display you were recording was disconnected...`.

## §4 Disk full

Use STC-527's runbook §2 setup (a small `hdiutil` volume as `STC_TEMP_TAKES_DIR`; check `df` first). Expect:
- **Disk full** on the pill;
- the panel line, and a **Reclaim space** button;
- clicking the button gives the same result as the profile sheet's Reclaim space (a list to confirm, or "nothing to reclaim").

## What is deliberately not here

- Library notes for these stops: that is STC-529.
- A Stop the user asked for: it gets no label and no line, unchanged.
