# STC-505 — Failure states: design

Design only. No code ships with this ticket. The helper and pill work it implies is
listed under [Follow-ups](#follow-ups) and filed as separate tickets.

## Scope

Four failure states named on 2026-09-12: Screen Recording permission denied, disk
full mid-take, source lost mid-take, no audio signal. For each: **where** it appears,
**when**, **what the take becomes**, and **the one action** offered.

Out of scope: pre-take low-disk warnings, mic/camera permission denial (STC-520),
anything already designed by STC-476 (the pre-take permissions panel), STC-235
(display hot-swap that succeeds) and STC-394 (fragmented writes).

## What exists today

Mapped read-only on 2026-10-12.

| State | Today |
|---|---|
| Permission denied | STC-476 panel blocks Record until Screen Recording and Input Monitoring are granted. `no-displays` start error maps to a toast (`refusals.ts`). A grant revoked **mid-take** is not handled. |
| Disk full | **Nothing.** A failed write is counted as a dropped frame (`WriterGate.append` returns `.dropped`) and the take keeps "recording". No `ENOSPC` or free-space check, no disk stop reason. |
| Source lost | Window closed/resized and display-gone already stop the helper cleanly, and the take reaches the corner panel (STC-487). Copy is the gap: `window-closed` and `window-resized` are missing from `ENDED_BY_HELPER`, so the toast reads "Recording stopped by the recorder (window-closed)". A helper crash shows a toast and **no panel**. |
| No audio | The pill meter is a static hatched placeholder (`LevelMeterMode = "hatched"`). The helper does no level or silence detection. |

Native `dialog.showMessageBox` sites (all `app/src/main.ts`): crash-recovery on launch,
quit with unsaved takes, reclaim space, device-not-found before a take, library delete.
**None is a mid-take failure.**

## Decisions

Settled with Patrick, 2026-10-12.

1. **A failure never discards a take.** Whatever was written is kept and goes to the
   same corner panel as any stopped take.
2. **Stop vs warning.** Disk full, source lost and permission revoked *stop* the take.
   No audio only *warns*; it never interrupts and never offers to stop. A silent mic is
   often legitimate (a pause, a screen-only walkthrough with the mic left selected),
   and a prompt mid-demo is the worst moment to ask.
3. **Where.** Mid-take, the state is drawn on the pill in its dark theme. After the
   take, the corner panel carries the reason and a library note carries it
   permanently. Toasts stay only for events with no take to attach to.
4. **Library mark is a note, not a badge.** It uses the `notes: string[]` slot that
   "Camera: recorded no frames" already uses. No new badge, no red tile treatment.

## Per state

### 1. Screen Recording permission denied

- **Before a take:** unchanged. The STC-476 panel is the prevention; this ticket adds
  it to the runbook only.
- **Revoked mid-take:** macOS ends the stream, so it is handled as a lost source.
  The take is kept up to that point.
- **Action:** Open System Settings.

### 2. Disk full

- **When:** during a take.
- **Pill:** switches to a stopped state, "Disk full".
- **Fate:** stopped cleanly, kept up to the failure. STC-394's fragments (2 s) make the
  file playable.
- **Panel:** the reason line, and one action: **Reclaim space**, which opens the
  existing STC-435 sheet.
- **Risk to design for:** a full disk may also fail the sidecars (`anchors.json`,
  `events.json`). The take must still reach the panel; see Follow-ups.

### 3. Source lost

- **Window closed or resized, display unplugged:** the helper already stops cleanly.
  The pill shows the cause for about 2 s, then the panel appears.
- **Helper crash:** build a panel from the fragmented `display.mp4` and say the cursor
  and event data are missing, instead of today's toast with no panel.
- **Action:** none beyond the panel's own Save and Edit.

### 4. No audio signal

- **Pill:** the hatched meter becomes live. After about 10 s of silence the meter
  flattens and a small marker appears. No toast, no sound, no interruption.
- **Fate:** the take is unaffected.
- **Action:** none.
- **Library note:** the silent span(s), recorded in the take's sidecar.

## Copy

Run through ux-copy. Pill labels are 14 characters or fewer. Times are the take clock
(`m:ss`). One term per thing: "take" for the recording, "Reclaim space" for the
existing STC-435 control.

| State | Pill | Panel reason | Action | Library note |
|---|---|---|---|---|
| Disk full | Disk full | Stopped at 4:12. Your disk is full. Everything up to then is saved. | Reclaim space | Stopped early: disk full at 4:12 |
| Window closed | Window closed | Stopped at 1:30. The window you were recording was closed. | none | Stopped early: window closed at 1:30 |
| Window resized | Window resized | Stopped at 1:30. The window you were recording was resized. | none | Stopped early: window resized at 1:30 |
| Display lost | Display lost | Stopped at 1:30. The display you were recording was disconnected. | none | Stopped early: display disconnected at 1:30 |
| Display changed (exists) | Display changed | Stopped at 1:30. The display settings changed. | none | Stopped early: display changed at 1:30 |
| Screen Recording off | Access revoked | Stopped at 2:05. Screen Recording was turned off for Capture. | Open System Settings | Stopped early: Screen Recording turned off at 2:05 |
| Recorder quit | n/a, the pill is gone | Capture's recorder quit unexpectedly. This is what was saved before it stopped. Cursor and event data are missing. | none | Recovered after the recorder quit. No cursor data. |
| No mic signal | marker, tooltip "No mic signal for 10 s" | n/a, no stop | none | No mic signal from 1:10 to 4:30 |

Rules behind the wording:
- **What happened, then the consequence, then the action.** The first sentence is the
  time and the fact. The second says whether the take is safe.
- **"Everything up to then is saved"** is stated wherever the take is kept, because the
  fear after a failure is losing the take. The crash row says "what was saved" because
  there the claim is weaker.
- **Not blame-shifting.** "Your disk is full" names the cause; it doesn't say "error".
- **Library note format** is `Stopped early: <cause> at <time>`, so a scan down the
  grid reads the same way every time. Several silent spans list the first two, then
  "and N more".
- **Localization:** avoid idiom; times and `m:ss` are numerals; the pill labels expand
  roughly 30% in German, so 14 characters is the English ceiling, not the target.

## Data the design needs

None of this exists. It is why the build is split into follow-ups.

- A **`disk-full` stop reason** in `anchors.json` `stop.reason` (schema bump, minimum
  version rule), plus write-failure detection in the writers. `anchors.json` must still
  be written, or the panel falls back to the crash path.
- **Silent spans** for the mic: a new field or warning carrying `startNs`/`endNs`.
- The library reads `stop.reason` and the silent spans into `notes` (today `TakeInfo`
  does not read `stop.reason`).
- A **live level signal** from the helper to the pill (today only a static glyph).
- `ENDED_BY_HELPER` entries for `window-closed`, `window-resized`, and the new reasons.

## Native dialogs that stay native

All are modal decisions made before a take or at app lifecycle boundaries, never while
recording, so the pill/panel/toast treatment doesn't apply:

| Site | Why it stays native |
|---|---|
| Unsaved takes recovered at launch | Blocks until the user chooses Review or Discard all; no take is running |
| Quit with unsaved takes | Quit confirmation; the app is closing |
| Reclaim space | Destructive batch action; confirms before moving to Trash |
| Device not found (before a take) | Fires before a take can start, from a Record click; a choice is required to proceed |
| Library delete | Destructive confirm |

## Reaching each state on the Mac (runbook)

Written for the implementation tickets. States that need a fault injector say so; the
injectors are proposed here and are part of those tickets.

| State | How to reach it |
|---|---|
| Permission denied, before a take | Remove Capture from Screen Recording in System Settings, relaunch, press Record. The STC-476 panel appears. |
| Permission revoked, mid-take | Start a take, turn Screen Recording off for Capture in System Settings. **Unverified:** macOS may offer to quit and reopen the app, which would end the take through the crash path, not the stop path. Settle this first. |
| Disk full | Create a small volume (`hdiutil create -size 64m -fs APFS -volname Small small.dmg`), attach it, point the take temp root at it, record until it fills. Proposed fault: `STC_CAPTURE_FAULT=disk-full`. |
| Window closed / resized | Record a window, close or resize it. Existing fault: `STC_CAPTURE_FAULT=window-closed` / `window-resized`. |
| Display lost | Record a second display, unplug it. Existing fault: `STC_CAPTURE_FAULT=display-gone`. |
| Helper crash | Start a take, `kill -9` the helper. |
| No mic signal | Select a mic and set its input volume to zero, or mute the input. Proposed fault: `STC_CAPTURE_FAULT=mic-silent`. |

For each: watch the pill, then the panel, then the library tile, and check the take
plays to the failure point.

## Open items

- **Permission revoke mid-take** (above): behavior is unverified on macOS 27. If the
  OS terminates the app, state 1 collapses into the crash path.
- **10 s silence threshold** is a guess. It should be tuned on a real narration take
  with natural pauses, so the marker doesn't fire on a breath.
- **The 2 s pill dwell** before the panel appears needs to be looked at on a Mac. It
  must not fight the pill's collapse/restore (STC-375).
- **Sidecars on a full disk:** if `anchors.json` can't be written, the take takes the
  crash-recovery path and the "disk full" reason is lost. Reserve space for the
  sidecars up front, or write the reason first.

## Follow-ups

To be filed in Linear after this spec is approved, checking `list_issues` for
duplicates first:

1. Disk-write failure detection and a `disk-full` stop reason (helper, schema bump).
2. Live mic level from the helper and a live pill meter, with the silence marker.
3. Library `notes` from `stop.reason` and silent spans.
4. Crash-recovery panel from a fragmented `display.mp4` with no sidecars.
5. `ENDED_BY_HELPER` entries and the pill's stopped-state labels.
6. Runbook execution on the Mac, with the fault injectors in the table above.
