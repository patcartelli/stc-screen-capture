# STC-531 — Source-lost copy and the pill's stopped state: plan

Prepared 2026-10-14 while STC-530 (#324) was still in CI. **Do not start building until
#324 merges**: this ticket fills in `app/src/stop-copy.ts`, which only exists on that
branch. Branch `accounts/stc-531-source-lost-copy`, cut from master `d5854a3`; once #324
squash-merges, rebase it onto master (a plain `git rebase origin/master`; nothing here
touches #324's files yet).

Sources: the ticket, Patrick's 2026-10-13 comment on it (put the rows in
`stop-copy.ts`'s `panelReason`, don't add a second path), and the STC-505 spec's copy
table (`docs/superpowers/specs/2026-10-12-stc-505-failure-states-design.md`).

`npm run ticket -- STC-531` → nothing found (exit 0), 2026-10-14.

## What the code does today (mapped 2026-10-14)

- **Helper reasons.** `stop.reason` (anchors-10) already carries `window-closed`,
  `window-resized`, `display-reconfigured`, `region-out-of-bounds`, `stream-stopped`,
  `disk-full`, each with a `-timeout` variant. `t` is session-relative **ns**.
- **"Display lost" has no reason of its own.** Since STC-235 a mode change refits, so
  `display-reconfigured` is reached only when the captured display is missing
  (`DisplayChangeDecisions.swift:21`). `region-out-of-bounds` is the spec's "Display
  changed" row.
- **"Access revoked" has no reason at all.** A revoked grant mid-take would reach
  `SCStreamDelegate.didStopWithError` → `stream-stopped` (`Capture.swift:1901`,
  `main.swift:249`), with the SCK error only in the warning's `detail`, *if* macOS lets
  the stream end rather than quitting the app. That is the ticket's settle-first item.
- **Toast.** `renderer.ts:704` `ENDED_BY_HELPER` lacks `window-closed`/`window-resized`/
  `disk-full`, so they fall through to "Recording stopped by the recorder (…)".
- **Event order.** `HelperSupervisor.endRecording` (`supervisor.ts:193`) sets
  `state = "idle"`, then emits `take-ended` (→ `onTakeEnded` → panel, immediately), then
  `recording-ended` (→ pill reconcile → restore, immediately; → renderer toast).
- **Pill.** `pill-window.ts`'s `attachPillToSupervisor` restores as soon as
  `decidePillAction("collapsed", "idle")` says `"restore"`. There is no stopped state.
- **Panel.** On #324: `presentRecordingPanel` reads `anchors.json`, sets
  `recording.reason = panelReason(anchors.stop)` → `#takereason`. No panel action buttons
  exist for a reason. The thumbnail bridge (`thumbnail-preload.ts`) has no reclaim or
  settings channel.

## Answers (Patrick, 2026-10-14)

- **2: stop path.** Turning Screen Recording off mid-take ends the take, and it reaches
  the panel. So access revoked gets its own helper reason (plus the schema bump) and the
  Open System Settings action. Still needed: the SCK error code `didStopWithError`
  reports, so the helper can tell a revoked grant from any other dead stream. Read it
  from the `stream-stopped` warning's `detail` on a take recorded with this branch's
  build. The only take in temp storage from 2026-10-14 stopped with `user` (anchors-6),
  so it isn't that test.
- **3: yes.** The panel waits out the 2 s pill label, but only when the helper stopped
  the take itself.
- **1: drop the toast.** When the helper stops a take with a panel, there is no toast: the
  pill and the panel carry the cause. `ENDED_BY_HELPER` is deleted and `stop-copy.ts` is
  the only copy table. A toast appears only if `presentRecordingPanel` fails, so a lost
  panel is never silent. Build step 4 is this.

## Decisions needed from Patrick before building

1. **The recording-ended toast.** Spec decision 3 says toasts are only for events with no
   take to attach to; with pill + panel carrying the cause, the toast is a third copy of
   the same message. The ticket still asks for `ENDED_BY_HELPER` entries.
   Recommendation: **drop the toast for any stop that produces a panel**, and make
   `ENDED_BY_HELPER` go away in favour of `stop-copy.ts` (one table). Keep the toast only
   if `presentRecordingPanel` fails.
2. **Access revoked.** Depends on the Mac finding (below). If the stream ends: add a helper
   reason `screen-recording-revoked` classified from the SCK error code in
   `didStopWithError` → anchors-11/12 schema bump (minimum-version rule). If macOS quits
   the app: state 1 collapses into STC-530's crash path and this ticket drops the row and
   the Open System Settings action. Recommendation: settle first, scope after.
3. **2 s dwell vs. the panel.** The spec says pill label ~2 s, *then* the panel. Delaying
   the panel 2 s means delaying `onTakeEnded` for helper-initiated reasons only.
   Recommendation: yes, delay it, and only when the reason is one with a pill label.

## Build (after #324 merges)

### 1. `stop-copy.ts` — one table for every surface
- Add `pillLabel(reason)`: Window closed / Window resized / Display lost /
  Display changed / Disk full / Access revoked. ≤14 chars, test enforces it.
- Extend `panelReason(stop)` with the spec's rows, formatting `stop.t` (ns) as `m:ss`
  through the existing `formatElapsedTimer` rules (move or reuse; `pill.ts` is node-free).
  `Stopped at 1:30. The window you were recording was closed.` etc. Disk full adds
  `Everything up to then is saved.` per the spec (the ticket's template appends it to
  every row; the spec's table does not — use the spec, note the difference in the PR).
- `-timeout` variants map to the same copy as their base reason (strip the suffix once,
  in one helper).
- Add `panelAction(stop)`: `"reclaim-space"` for disk-full, `"open-screen-recording-settings"`
  for access revoked, else undefined.
- `app/test/stop-copy.test.ts` already walks every schema reason; add: no stop reason
  reachable from the helper falls through to `undefined` panel text except `user`/`quit`/
  `stdin-closed`/`signal-*` (the acceptance criterion as a test).

### 2. Pill stopped state (`pill.ts` pure, `pill-window.ts` mechanism)
- `pill.ts`: `PILL_STOPPED_DWELL_MS = 2000`; `decidePillAction` gains a third input —
  a pending stopped label — returning `"show-stopped"` instead of `"restore"` when the
  take ended by itself with a labelled reason. Restore happens when the dwell elapses.
- `pill-window.ts`: on `recording-ended` with a labelled reason, send
  `pill:stopped { label }` to the renderer, start the dwell timer, restore on expiry.
  Guard against fighting STC-375: a new `start` during the dwell cancels it (the
  heartbeat says `recording` again → stay collapsed, clear the label); a window close
  during the dwell clears the timer (and the restore goes through
  `setBoundsUnlessClosing`, STC-496).
- `renderer.ts` + `index.html`: `#pill` shows the label in place of the timer, stop
  button disabled, dark theme unchanged.

### 3. Panel delay + action
- `onTakeEnded(dir, reason)`: if `pillLabel(reason)` exists, wait
  `PILL_STOPPED_DWELL_MS` before `presentRecordingPanel` (re-check `quitting` and
  `sup.state` after the wait, as #324 does after recovery).
- Panel action button under `#takereason`, driven by `panelAction`. New thumbnail bridge
  call `panel:stopAction(id)`; main maps `reclaim-space` → the existing
  `recorder:reclaimSpace` flow (extract its body into a function both call), and
  `open-screen-recording-settings` → `TOAST_ACTION_URLS` (already has the URL; the ticket's
  "add to TOAST_ACTION_URLS" only applies if a new id is invented — reuse the existing one).
  Main validates the id; the renderer only names it (toast-message.ts's rule).

### 4. Toast
- Per decision 1.

## Tests

- Unit: `stop-copy.test.ts` (labels ≤14, every reason covered, m:ss formatting at
  0, 59.999 s, 1:00, 1 h), `pill.test.ts` (dwell decisions incl. restart during dwell).
- E2E (mechanism only — no window manager on CI; CI via draft PR, never locally):
  `_fake-helper.mjs` emits `stopped` with `window-closed`; assert `pill:stopped` label in
  `#pill`, panel appears after the dwell with the reason line, no generic text anywhere.
  Same for `disk-full` with the Reclaim space button present.
- Grant/Mac: `STC_CAPTURE_FAULT=window-closed`/`window-resized`/`display-gone`/
  `disk-full` on the real binary end to end.

## Settle first, on a Mac (Patrick)

Start a take in the packaged app, then turn Screen Recording off for Capture in System
Settings. Record which happens:

- **A.** the take stops and a panel appears (stop path) — note the `stream-stopped`
  warning's `detail` from the app log; its SCK error code is what the helper will classify, or
- **B.** macOS offers "Quit & Reopen" / kills the app (crash path).

A VM can run this too (`tools/vm/fresh.sh --granted`, the toggle is a TCC click).

## Out of scope
- Library notes (STC-529), live mic meter (STC-528), the runbook pass (STC-532).
