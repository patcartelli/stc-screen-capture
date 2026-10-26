# STC-505 runbook — the failure states, run end to end on the Mac (STC-532)

**Branch:** `claude/exciting-hamilton-lg7sdu` (draft PR). **Not on `master` yet**, so run it from the branch:

```
git fetch origin
git checkout claude/exciting-hamilton-lg7sdu
npm ci
helper/build.sh
npm run app:start
```

Use the **packaged** app (`npm run app:package`) for §1 and §2. `npm run app:start` runs as Electron or the terminal app, not as Capture, so switching Capture's entry off in System Settings does nothing to it (STC-531).

Written 2026-10-23 from `docs/superpowers/specs/2026-10-12-stc-505-failure-states-design.md` ("Reaching each state on the Mac"), after all six follow-ups merged. The session that wrote it was Linux with no Mac, so the author ran none of it.

**Run on hardware by Patrick, 2026-10-23, on an M-series Mac with an HP Z27 as the second display.** The results below are what he reported; where a check was not reported it says so, and a row from an earlier ticket's runbook is not counted as done here. Still open: the narration take for the 10 s threshold (§7), the launch-recovery extra (§6), whether the pill window jumps on restore (§8), and the pill's label and placement on a lost display (§5). See "Findings" for what the run turned up.

## What this runbook is for

Each failure state was built and watched on its own ticket. This pass is the one the ticket asks for: **the whole chain per state, in order: the pill, then the panel, then the library tile, then the take itself.** It is the first time anyone looks at all four together. The spec's rule is that a failure never discards a take, so the last check matters as much as the first.

The rule for every row: the take **plays to the failure point** in the editor, and **exports**.

## The states

| # | State | Reach it with | Pill (2 s) | Panel line | Library tile |
|---|---|---|---|---|---|
| 1 | Screen Recording denied, before a take | Remove Capture from Screen Recording, relaunch, press Record | n/a (no take) | n/a. The grants panel (STC-476) covers the main window | n/a |
| 2 | Screen Recording revoked, mid-take | Switch Capture off in System Settings during a take | **no label: not a stop** | none | none |
| 3 | Disk full | `hdiutil` volume + `STC_TEMP_TAKES_DIR`, or `STC_CAPTURE_FAULT=disk-full` | Disk full | `Stopped at m:ss. Your disk is full. Everything up to then is saved.` + **Reclaim space** | `Stopped early: disk full at m:ss` |
| 4a | Window closed | Record a window, close it. Fault: `STC_CAPTURE_FAULT=window-closed` | Window closed | `…The window you were recording was closed.…` | `Stopped early: window closed at m:ss` |
| 4b | Window resized | Record a window, resize it. Fault: `=window-resized` | Window resized | `…The window you were recording was resized.…` | `Stopped early: window resized at m:ss` |
| 5 | Display unplugged | Record a second display, unplug it. Fault: `=display-gone` | Display lost | `…The display you were recording was disconnected.…` | `Stopped early: display disconnected at m:ss` |
| 6 | Helper `kill -9` | `pkill -9 stc-helper` mid-take | n/a (the helper is dead; there is no pill label) | `Capture's recorder quit unexpectedly…`, no "not saved" toast | `Recovered after the recorder quit. No cursor data.` |
| 7 | Silent mic | Mic input volume to zero, or fault `=mic-silent` | amber dot + flat bar after 10 s, tooltip "No mic signal for 10 s" (take keeps recording) | none | `No mic signal from m:ss to m:ss` |

Wording is `app/src/stop-copy.ts` and `app/src/pill.ts`. If what you see differs from this table, `stop-copy.ts` is the truth and this table is stale: say so in the results.

Other stops the helper can make, not in the spec's seven, with the same chain: `region-out-of-bounds` (pill "Area lost"), `stream-stopped` ("Source lost") and `error` ("Write failed"). They have no reproduction here. If one turns up during the pass, record it.

## How to read the chain

For every row 3 to 7, do these in order and write down what you saw:

1. **The pill.** Label, how long it stayed, whether the label fit (an ellipsis means it did not), whether the window jumped when it restored.
2. **The panel.** It appears *after* the pill label, not with it. Reason line present, Copy/Save/Edit all visible on the 250 px card, no toast anywhere.
3. **The library tile.** Save the take, open the library, read the note on the tile.
4. **The take.** Open it in the editor. It plays from the start to the failure point and the cursor is there (except row 6, which has no cursor data). Export it.
5. **`anchors.json`.** `stop.reason` is what the table says, and `files` lists every file that exists on disk.

## §1 Permission denied, before a take

Packaged app. Remove Capture from System Settings → Privacy & Security → Screen Recording. Relaunch, then press Record by every door: the button, the hotkey, a still.

Expect the grants panel (`#permissionsheet`) over the main window, no close button, and **no overlay opened** behind it. A grant made while the app runs reads "Relaunch Capture", never "Granted".

This was settled by STC-476/STC-518 in a VM (`docs/STC-476-RUNBOOK.md`). Here the question is only whether it still holds on the real Mac with the failure states around it. It needs no new work.

| Result | Notes |
|---|---|
| ✅ pass | Reported as a pass, packaged app. No detail beyond that. |

## §2 Screen Recording revoked, mid-take

**This is the spec's open item, and it is already settled; do not redo it as a discovery.** Measured on the packaged app 2026-10-14 (`docs/STC-531-RUNBOOK.md`): macOS keeps delivering frames to a running stream (57 fps, no gap) and only offers **Quit & Reopen / Later**. It is not a stop, and a `screen-recording-revoked` reason was built and removed.

Check it once more on this build, because it is the one state the spec expected to be a stop:

1. Start a take of 15+ s. Switch Capture off in Screen Recording.
2. Expect the take **keeps recording** and macOS shows its Quit & Reopen sheet. No pill label, no panel, no toast.
3. Press **Later**, then Stop. The take saves normally.
4. Repeat, pressing **Quit & Reopen**. The take should be among the unsaved takes on relaunch, playable to the quit. Report if it is missing.

Judgement call: whether *doing nothing* is the right behaviour, given the take is intact but the user has just withdrawn consent. That is a product call. Record what you think.

| Result | Notes |
|---|---|
| ✅ keeps recording | Reported as a pass. The judgement call (is doing nothing right?) was not recorded. |
| ✅ Quit & Reopen recovers the take | Reported as a pass with §2 as a whole; not itemised. |

## §3 Disk full

Two routes. Run the volume route once (it is the real thing) and the fault route for repeats.

**Volume route.** Follow `docs/STC-527-RUNBOOK.md` §2 *exactly*, including its three traps (`hdiutil create`, not `diskutil image create`; check `df` shows about 244Mi on a different device; `STC_TEMP_TAKES_DIR` only counts at launch):

```
STC_TEMP_TAKES_DIR=/tmp/stc-small npm run app:start
```

Record the whole screen with a video playing. Then run the `dd` variant (fill the volume from outside, a few seconds into a fresh take) to prove the 8 MiB sidecar reserve holds.

**Fault route.** `STC_CAPTURE_FAULT=disk-full npm run app:start`, then record. Use `=disk-write-failed` for the writer path.

Chain: pill **Disk full**, then the panel with the line and **Reclaim space**, then the tile `Stopped early: disk full at m:ss`. Open the take: it plays to the stop. `anchors.json` is v10 with `"reason": "disk-full"`.

**Judgement call: does Reclaim space work from the panel?** Click it. It must run the same sweep as the profile sheet's button: a native sheet listing what would move to the Trash (confirm or cancel), or "nothing to reclaim" as a toast. Two things to check that a unit test cannot:
- the sheet appears in front of the panel and is not hidden behind it, and the panel is still there after you cancel;
- on a volume with no orphaned bundles it says so, rather than a one-button dialog.

STC-531 §4 confirmed this on 2026-10-14 for a 256 MB volume. Do it again on the current build.

| Result | Notes |
|---|---|
| ✅ fault route (`STC_CAPTURE_FAULT=disk-full`) | Pill "Disk full", then the panel line with Reclaim space, no toast. |
| ✅ volume route: stopped by itself | 256 MB volume, free space fell 65Mi to 57Mi at the stop. `anchors.json` v10, `stop.reason` `disk-full` at 39.47 s, no `.sidecar-reserve`, all five tracks present and ending within 0.3 s of the stop. Take had camera, mic and system audio on. Playback and export of this take **not checked**: it was discarded. |
| ✅ `dd` variant: `anchors.json` still present | Stopped at 5.92 s, `anchors.json` v15, `disk-full`. The camera ended `writer-failed` (its writer hit the full disk 0.2 s before the display watch): designed (STC-562), not a bug. Pill and panel said Disk full. The take played; a 6.9 MB rendered copy was made. Whether the pill flashed "Camera lost" first was **not reported**. |
| ✅ Reclaim space from the panel | Works; ran the same sweep as the profile sheet. |
| ✅ tile note | `Stopped early: disk full`-shaped note on the tile (exact text not pasted). |

## §4 Window closed / resized

Overlay → Window, pick a window, record 10+ s, then close it. Repeat, resizing it instead. A *move* must **not** stop the take (STC-370's assumption, and Patrick's ruling that a resize ending the take is fine and must not be warned about).

Fault routes for repeats: `STC_CAPTURE_FAULT=window-closed` / `=window-resized`.

Chain per the table. Both are CONFIRMED on hardware (2026-10-14), including the close path that first stopped as `stream-stopped`. The new thing here is the **tile**, which was not looked at in the real grid when STC-529 landed.

| Result | Notes |
|---|---|
| ✅ closed | Reported as a pass. |
| ✅ resized | Reported as a pass. |
| ☐ move does not stop it | Not reported. |

## §5 Display unplugged

Needs a second display. Record it by id (overlay), unplug it mid-take. Also unplug a display that is **not** being recorded: the take must continue (STC-247/STC-235).

Fault route: `STC_CAPTURE_FAULT=display-gone`.

Expect **Display lost**, then the panel, then the tile `Stopped early: display disconnected at m:ss`. The pill is on the recorded display's work area, so check where it goes when that display disappears: it must not be stranded on a screen that no longer exists.

| Result | Notes |
|---|---|
| ⚠️ recorded display | Ran twice: the laptop screen closed (stopped at 0:12) and the HP Z27 unplugged (stopped at 0:06). Both stopped the take and put up a panel, and both takes play. **The wording is the generic `stream-stopped` row, not `display-reconfigured`:** the panel said "The screen capture stopped unexpectedly." and the tile said "Stopped early: capture source lost at m:ss", where the table above expects "Display lost" / "The display you were recording was disconnected." See Findings. Pill label **not seen** (the recorded display was gone). |
| ✅ other display (continues) | Recording continued through full playback. The mic on the same USB hub dropped with the unplug and was handled as a track loss ("The mic disconnected at 0:05…"), not a stop. |
| ☐ pill placement on loss | Not verified: Patrick noticed the panels but could not say where the pill went. |

## §6 Helper `kill -9`

```
npm run app:start        # or the packaged app
# start a take, 10+ s of visible motion (an on-screen clock helps)
pkill -9 stc-helper
```

Expect the panel at the corner with `Capture's recorder quit unexpectedly…`, **no "not saved" toast**. Edit plays the take to within ~2 s of the kill (record the gap). Tile note: `Recovered after the recorder quit. No cursor data.`

Then, because the chain is the point:
- with a mic and camera on (STC-530 §2);
- quit with Cmd-Q before saving, relaunch, and confirm the take is offered (STC-530 §3);
- start a new take within 2 s of the kill. The recovered panel must **not** appear while the new one records.

Full detail is in `docs/STC-530-RUNBOOK.md`. Run it here only to see it next to the others.

| Result | Notes |
|---|---|
| ✅ panel, no toast | Panel appeared at the corner with no "not saved" toast. |
| ✅ plays to within ~2 s of the kill (gap: ~0 s) | Reported as "almost instantaneous" from the kill to the end of the video. Mic and camera present; the camera's first frame came about 1.1 s into the take (see Findings). |
| ✅ tile | Reads "Recovered after the recorder quit. No cursor data." |
| ✅ deferred panel (new take within 2 s of a kill) | The recovered panel stayed hidden while the new take recorded. |
| ☐ launch recovery (kill, Cmd-Q, relaunch) | Not run, or not reported. |

## §7 Silent mic

Two routes: the fault (`STC_CAPTURE_FAULT=mic-silent`) and a real one (System Settings → Sound → Input, volume to zero).

Record 30 s with the mic selected and silent. About 10 s in, the bar flattens and the amber dot appears; the tooltip reads "No mic signal for 10 s". The take is **not** interrupted: this state warns and never offers to stop. Stop it. `anchors.json` is v13 with `mic.silentSpans`. The tile reads `No mic signal from 0:00 to 0:30`-shaped text. The take plays and exports with a silent narration track.

**Judgement call: the 10 s threshold on a real narration take.** This is `docs/STC-528-RUNBOOK.md` §3, and it is the one item that cannot be settled without a person:

1. Record a real narration, 3–5 min, with natural pauses (thinking, a breath, reading the screen).
2. `mic.silentSpans` should be **absent**, or hold only pauses you really took past 10 s. A span over a breath means the duration is too short.
3. Record 30 s in your quietest room, mic live, nobody talking. If that makes a span, the room is under -60 dBFS on this mic. Decide whether "no voice" reading as "no signal" is right, or whether the floor should drop to -70.
4. Muted input must still make a span.

The change, if any, is one constant: `MicSignal.silenceFloorDbfs` or `silentSpanMinNs` in `helper/src/MicSignalDecisions.swift`.

| Result | Notes |
|---|---|
| ✅ fault route: meter, dot | Amber dot appeared and the timer kept running (warn only, not interrupted). Tooltip text not reported. |
| ✅ fault route: tile note | "No mic signal from 0:00 to 0:34". |
| ✅ real muted mic | Elgato Wave:3 muted, ~16 s take: one `silentSpans` entry from 0.51 s to 15.97 s, covering the whole mic recording. The tile text and whether the dot showed on this take were not reported. |
| ✅ quiet room, mic live (30 s) | No `silentSpans`: the room's noise sits above -60 dBFS, so "nobody talking" does not read as "no signal". |
| ☐ narration take: spans (list) | **Not run / to redo.** Patrick did not remember the take's length or pauses. A blank result on a short take does not settle the 10 s threshold. |
| ☐ verdict on 10 s / -60 dBFS | Open until the narration take is done. |

## §8 The ~2 s pill dwell

Judge it across §3 to §5 rather than on its own. `PILL_STOPPED_DWELL_MS` is 2000 (`app/src/pill.ts`). For each stop:

- is 2 s long enough to *read* the label before the panel arrives?
- does the pill's collapse/restore (STC-375, now its own window per STC-550) fight the dwell? Does the window jump on restore?
- does starting a new take during the dwell end it cleanly (it should)?

If it reads too fast or too slow, the change is the one constant. The panel waits the same time (`onTakeEnded`), so they move together.

| Result | Notes |
|---|---|
| ✅ readable | "Yes" for the labels seen (disk full, window closed/resized). Display loss could not be judged: the pill was not visible. |
| ☐ no jump on restore | Not answered clearly. |
| ✅ verdict on 2 s | Long enough. |

## Findings

1. **A lost display is named "capture source lost", not "display disconnected" (§5).** Both the laptop-screen close and the HP Z27 unplug stopped as `stream-stopped`, so the pill label would be "Source lost" and the panel and tile say "stopped unexpectedly" / "capture source lost". The `display-reconfigured` row ("Display lost", "The display you were recording was disconnected.") never fired. Likely cause, read from the code and not confirmed against the running helper: ScreenCaptureKit stops the stream before the display watcher decides, and `decideStreamDeath` (`helper/src/CaptureDecisions.swift`) only asks whether a *window* is gone, so a dead display stream falls through to `stream-stopped`. It is the same race STC-531 fixed for a closed window. No data is lost: the takes are saved and play. Wanted: a display take whose stream dies should check whether its display is still present and say `display-reconfigured`. Needs its own ticket; not fixed here.
2. **The camera's first frame comes 1.1 to 1.6 s after the screen's.** Measured from `anchors.json`: display first frame about 0.25 to 0.29 s, mic about 0.5 s, camera 1.56 s and 1.61 s (and about 1.1 s in a recovered take). Patrick's expectation is that the camera and screen start together. Queued as a separate task, "Start the camera with the screen capture".
3. **A fill from outside ends the camera first (§3).** On the `dd` run the camera ended `writer-failed` about 0.2 s before the display's `disk-full` stop. Designed (STC-562), listed so nobody reads it as a fault.

## Still to do

- §7: the narration take (3 to 5 min, natural pauses) for the 10 s and -60 dBFS threshold.
- §6: launch recovery (kill, Cmd-Q, relaunch).
- §5: the pill's label and placement on a lost display (record the laptop display, unplug an external).
- §4: a window move must not stop the take.
- §3: playback and export of a volume-route take.

## What is deliberately not here

- **A user-asked Stop** gets no label and no line.
- **Mic and camera loss, camera stall, system audio loss** (STC-237, STC-553, STC-542) are the same shape as these states but are not in the STC-505 spec. Their runbooks cover them. If you have the mic or camera at hand, one unplug while you are here costs a minute: pill "Mic lost" or "Camera lost" over the timer, the take keeps recording.
- **`npm run test:soak`** (STC-238) holds every capture fault to one bar in a real take. It runs the faults; this runbook looks at the words and the screen. They do not replace each other.

## When it is done

Fill the result tables above, commit the file with the results, and note on STC-532 which judgement calls are decided. Anything that needs a code change (a threshold, a dwell, a label that did not fit) is its own ticket.
