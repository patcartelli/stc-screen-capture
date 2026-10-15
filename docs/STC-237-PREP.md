# STC-237 prep: device-loss recovery, after STC-531

Written 2026-10-14, while STC-531 is in progress (local branch `accounts/stc-531-source-lost-copy`,
not pushed). `npm run ticket -- STC-237` found nothing. STC-237 is still Backlog and unclaimed.

STC-237 was filed on 2026-08-25, before cameras and mics existed. Most of its scope has
shipped under other tickets since then. This doc lists what has shipped, what is left, and
what STC-531 has to land before the rest can start.

## The ticket's scope, line by line

| STC-237 asks for | Status | Where |
|---|---|---|
| Display: tell "reconfigured" (continue) from "disconnected" (stop with the right `stop.reason`) | **Done** | STC-235: a mode change refits the stream (`decideDisplayChange`); a lost display stops with `display-reconfigured`, and an area that no longer fits stops with `region-out-of-bounds` |
| Camera lost mid-take: track ends at the loss, export shows no bubble from then on, no crash | **Done in code, never tested with a real unplug** | STC-433: `handleCameraDisconnected` (`Capture.swift:1218`) tears down only the camera. `anchors.camera.lastFramePtsNs` is the end, and `render.ts:141` drops the PiP after `lastFramePtsNs + frameIntervalNs` |
| Mic lost: track ends, export is silent from then on | **Done in code, never tested with a real unplug** | STC-433: `handleMicDisconnected` (`Capture.swift:1171`). `audio-mix.ts` reads 0 past the end of a track |
| Show the user what happened | **Partly done.** Toasts appear mid-take, and nothing after | `renderer.ts` `CAMERA_FAULTS`/`MIC_FAULTS` `*-disconnected`. These are toasts DURING a take, which STC-505's rule now rules out |
| Metadata says which track ended and when | **Half done.** "When" is there, "why" is not | `lastFramePtsNs` exists. Nothing tells a lost track apart from one that ran to the end |
| All three cases produce a valid, exportable take | **Not proven at export level** | `device-disconnect.grant.test.ts` drives the helper fault. No test exports a take with a truncated track |

The display row is closed, and STC-531 finishes its copy. **What STC-237 has left is the mic
and camera.**

## What is left

1. **Record the reason a track ended (helper + schema, anchors-12).** Add an optional
   `endedBy` to `mic` and `camera`: `"disconnected"`, plus `"format-mismatch"` for the mic
   (STC-485 already ends the mic track for this). Write it only when the track ended before
   the take did. Follow the minimum-version rule, so a take with no lost track stays at v11.
   `lastFramePtsNs` already gives the time. `loadSession` refuses an `endedBy` on a track
   that has `present: false`.
2. **Move the live notice off the toast and onto the pill.** STC-505's rule is that a state
   during a take goes on the pill, then the panel, and toasts are only for when no take
   exists. `mic-disconnected` and `camera-disconnected` (and `mic-format-mismatch`) are
   currently toasts. The pill needs a TRANSIENT label for a take that is still running, for
   example "Mic lost" or "Camera lost". This is not STC-531's stopped state, but it can
   reuse STC-531's label slot and dwell.
3. **Add a panel line after the take.** `stop-copy.ts` (STC-531) owns the stop line. A
   track that ended early is a second sentence, for example "Mic disconnected at 1:10. The
   rest of the take has no mic audio." It is built from `endedBy` and `lastFramePtsNs` in
   the same module, not in a second one.
4. **Add a library note.** This is STC-529's `libraryNote`. Add the track-ended row there
   if STC-529 has landed. If not, leave the row for STC-529 to pick up.
5. **Prove the export works.** Add a unit or slow test that exports a fixture with a camera
   and a mic that each end at around 50%. Check four things: the output has the full
   duration, the audio length matches the video, the PiP is absent after the cut, and
   nothing throws. `fixtures/pip` with a cut-down `anchors.json` should be enough.
6. **Hardware.** STC-433 runbook §4 and §5 (a real cable pull, with both an explicit and an
   automatic camera pick) have never been run. Run them before claiming acceptance, along
   with a short STC-237 runbook for the new pill label and panel line.

## What STC-531 must land first

- `app/src/stop-copy.ts`: `panelReason`, `pillLabel`, `libraryNote` and `formatTakeTime`.
  STC-237 adds rows to these and does not fork them.
- The pill's stopped-state mechanism in `pill.ts` (the label, `PILL_STOPPED_DWELL_MS`, not
  fighting collapse/restore). STC-237's transient label should be the same state machine
  with a "continuing" variant, not a second one.
- The removal of toasts for helper stops (Patrick, 2026-10-14). STC-237 applies the same
  ruling to track loss.
- Its `TOAST_ACTION_URLS` and panel-action wiring. STC-237 probably needs no action, since
  there is nothing to fix after a cable pull.

After STC-531 merges, rebase this plan onto its final API before writing code. The branch
had one commit when this was written, and its names may change.

## Decided (Patrick, 2026-10-14)

- **`endedBy` is a field in anchors (anchors-12)**, not worked out from `lastFramePtsNs`.
- **STC-237 is narrowed** to mic and camera loss. The Linear ticket was rewritten and is
  now blocked by STC-531.
- **A real unplug is deferred.** STC-433 §4 and §5 wait until Patrick has time. The
  simulated faults are the evidence until then.
- This doc gets committed with STC-237's branch.
- **The pill says it:** "Mic lost" / "Camera lost" for about 2 s, then back to the timer.
- **The mid-take toasts are removed entirely**, with no fallback for a collapsed pill.
- **System audio is a separate ticket: STC-542.**

The questions below are kept for the record. All four are answered above.

## Still open

1. **Pill label for a take that keeps going:** "Mic lost" / "Camera lost" for ~2 s, then
   back to the timer? Or does it stay as a marker until the take ends?
3. **Should the toasts go entirely** (consistent with STC-531's ruling), or stay as a
   backup when the pill is collapsed?
4. **System audio:** its `SCStream` can also die mid-take (an output device change?).
   Should it be in scope here, or a separate ticket? STC-237 never named it, because it did
   not exist then.

## Suggested ticket edit

Narrow STC-237 to "mic/camera loss mid-take: record why, say it on the pill and panel,
prove the export". Point the display half at STC-235 and STC-531.

## Update 2026-10-15: STC-531 merged (#325), and STC-541 (#326)

- **Schema:** STC-531 took anchors-11 (`screen-recording-revoked`). STC-237's `endedBy` is
  now **anchors-12**, and a take with no lost track stays at v11 or below.
- **Toasts:** STC-531 added `STOP_ANNOUNCING_WARNINGS` in `stop-copy.ts`, which lists the
  warnings the renderer must not toast. STC-237's removal of `mic-disconnected`,
  `camera-disconnected` and `mic-format-mismatch` should be a sibling set there (the take
  continues, so these are not stops), not a second filter in `renderer.ts`.
- **Pill:** STC-531's dwell runs only AFTER a take ends: `decidePillAction(..., dwelling)`
  holds a collapsed pill while `!recording`, and `shouldDwell` keys on a stop label.
  A "Mic lost" label on a pill that is still RECORDING is a new case. It is a label swap
  inside the collapsed pill for `PILL_STOPPED_DWELL_MS`, with no collapse/restore at all,
  so it should not go through `shouldDwell`. Reuse the constant and the label slot.
- **Panel actions:** `StopActionId` is now only `reclaim-space`, because the access-revoked
  action was dropped. STC-237 still needs no action.
- **STC-541 interacts with `endedBy`:** `loadSession` now demotes a camera whose
  `camera.mp4` has no video track to `present: false` at load time. A camera unplugged
  before its first frame could therefore have `endedBy` in the raw anchors and
  `present: false` after loading. Rule: the helper writes `endedBy` only when it writes
  `present: true`. The schema refuses `endedBy` on `present: false`. When the loader
  demotes a track, it DROPS `endedBy` rather than refusing the take, because STC-541's
  whole point is that such a take loads.
