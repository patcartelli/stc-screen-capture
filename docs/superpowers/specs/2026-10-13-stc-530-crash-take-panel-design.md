# STC-530 — a take the recorder quit on reaches the panel

Date: 2026-10-13. Ticket: STC-530. Parent spec:
`docs/superpowers/specs/2026-10-12-stc-505-failure-states-design.md` (the "Recorder quit"
row of its copy table, and its disk-full open item).

## Problem

When the helper dies mid-take, `recording-lost` reaches the renderer as a toast ("The recorder
quit while recording — that take was not saved.", `app/src/renderer.ts:727`) and no panel.
Since STC-394 the fragmented `display.mp4` plays up to ~2 s before the crash, but nothing
describes it: `anchors.json` and `events.json` are written only at stop
(`Capture.swift` `writeSidecars`), and the `started` reply and start parameters main holds are
discarded. Launch-time recovery (STC-393) classifies the same folder as `unknown` and reveals
it in Finder — no panel, and nothing in the app can open it (`main.ts` `recoverUnsavedTakes`;
the comment there says reconstruction was "deliberately not attempted").

STC-527's disk-full stop can leave the same shape: if the `anchors.json` write fails, the
helper is still alive and the take reaches the panel, but Edit, Copy and the library all
refuse it, and the disk-full reason is lost.

## Decisions (Patrick, 2026-10-13)

1. **A recovered take is a full take with no cursor data.** It opens in the editor, exports,
   copies, and sits in the library like any other. Only the reason line and the library note
   differ. Not a watch-only video.
2. **The helper writes a provisional `anchors.partial.json`** while recording. Only the helper
   knows the timebase, display geometry, colour space and each track's first PTS exactly.
   Rejected: main writing a `start.json` (no timebase or colour space, audio and camera lost),
   and reconstructing from `display.mp4` alone (geometry guessed, every other track lost).
3. **Build the reason/note seam generically, populated for `recorder-quit` only.** STC-529
   (library notes) and STC-531 (panel reason line, actions, pill) extend it rather than
   replace it. Their copy and actions stay in those tickets.
4. **A helper death before the first frame is not a take.** There is nothing to show: the
   folder is removed and a toast stays, "The recorder quit before anything was recorded." —
   the parent spec's rule that toasts are for events with no take to attach to.

## Design

### 1. Helper: `anchors.partial.json`

**Content.** Exactly what `anchorsDocument` (`helper/src/AnchorsDoc.swift`) would emit at
that moment, minus the `stop` block, from the same function — `anchorsDocument` gains a
partial mode (no `stopReason`/`stopTNs`) so the two documents cannot drift. Version follows
the same minimum-version rules from the blocks present.

**When it is written.** Only when something it describes changes, never on a timer:

- the first display frame (the first write — before it the take has no geometry entry 0 and
  no `firstFrameNs`);
- the first sample of the camera, the mic, and system audio;
- each pause and each resume;
- each display refit (STC-235) and each window-track entry (STC-482).

Each write is to a temporary name, then renamed over `anchors.partial.json`, so a crash
mid-write leaves the previous complete version or nothing — never a torn file. Typically 2–5
writes per take. Writes happen off the capture callbacks (the decision is made there, the
write is dispatched), the same rule `IO.stat` follows: the partial file must never
back-pressure the capture graph.

**What it cannot know.** Each present track's `lastFramePtsNs`, and the stop time. Both are
stale by construction; the app recovers them from the media (§2).

**At a clean stop** `writeSidecars` writes `events.json` and `anchors.json` as today, then
deletes `anchors.partial.json` — only if `anchors.json` was written. If that write fails
(STC-527's disk-full case) the partial stays, which is what the app needs.

**Fault.** `STC_CAPTURE_FAULT=anchors-write-failed` fails only the `anchors.json` write, so
the disk-full-without-anchors path is reachable on CI.

### 2. Schema: anchors-11

anchors-10 plus one `stop.reason` value, `recorder-quit`. Written only by the app when it
finalises a partial after a crash. Minimum-version rule: only that reason forces 11; every
other take keeps the version its blocks earned. `transform/src/session.ts` accepts 1–11. The
partial file is never loaded as a take and has no schema of its own beyond "an anchors
document without `stop`"; recovery validates its output, not its input's shape.

### 3. App: one finaliser for both paths

**`transform/src/recover-anchors.ts` (pure).** `recoverAnchors(partial, media, reason)`:

- `media` carries the last sample PTS of `display.mp4` and of each present camera/mic/system
  file, read from the files themselves.
- Returns the partial plus `stop: { t, reason }` (`t` = the display's last frame PTS,
  session-relative) and each present track's `lastFramePtsNs` corrected.
- Version: `recorder-quit` forces 11; any other reason (e.g. `disk-full`) keeps the version
  its blocks earned.
- **Refuses rather than guesses:** no display frames; a track marked present whose file is
  missing or has no samples; a partial that is not an object or lacks a required block.
  Refusal means "not recoverable", never a defaulted field.

**`recoverTake(dir, reason)` (main, I/O).** Reads `anchors.partial.json`, reads each media
file's last sample PTS (the fragmented demux already handles a file truncated mid-write,
STC-394), calls `recoverAnchors`, checks the result with `loadSession`'s own checks, writes
`anchors.json`, deletes the partial. Returns recovered / not recoverable. A missing
`events.json` already loads as no events (`app/src/session-io.ts`), so the cursor overlay is
simply empty and nothing downstream changes.

*To settle in the plan:* whether `demux.ts`/`mp4-boxes.ts` import cleanly under
`tsconfig.node.json`. If not, the last-PTS read becomes a small node-side reader over
`mp4-boxes.ts`'s box walk.

**Live crash.** Main's `recording-lost` handler (the payload already carries `dir`) calls
`recoverTake(dir, "recorder-quit")`:

- recovered → `presentRecordingPanel(dir, "fresh")`, the same as a clean stop. No toast. From
  here it is an ordinary unsaved take: Save, Edit, Trash, the 7-day purge, and the launch
  prompt if ignored.
- not recoverable → the folder is removed and the renderer shows "The recorder quit before
  anything was recorded."

Main tells the renderer which outcome happened; `renderer.ts`'s "not saved" toast is replaced.

**Disk full without `anchors.json`.** In `onTakeEnded`, before `presentRecordingPanel`: if
`anchors.json` is missing and `anchors.partial.json` exists, `recoverTake(dir, <the stopped
reason>)`. The disk-full reason survives — the parent spec expected it to be lost.

**Launch-time recovery.** `listTempTakes` (`app/src/temp-takes.ts`) gains kind `partial`:
`anchors.partial.json` present, `anchors.json` absent. Review runs
`recoverTake(dir, "recorder-quit")` then the existing recording branch
(`markOfferedForRecovery` + panel). A partial that is not recoverable falls back to today's
`unknown` handling. An `unknown` take with no partial (anything recorded before this change)
is unchanged: revealed in Finder. The prompt's text counts `partial` takes as recordings.

**Trash-undo** is unchanged: after recovery `anchors.json` exists.

### 4. The reason/note seam

**`app/src/stop-copy.ts` (pure, node-free).**

- `panelReason(stop)` → "Capture's recorder quit unexpectedly. This is what was saved before
  it stopped. Cursor and event data are missing." for `recorder-quit`; `undefined` otherwise.
- `libraryNote(stop)` → "Recovered after the recorder quit. No cursor data." for
  `recorder-quit`; `undefined` otherwise.

**Panel.** `PresentOptions.recording` gains optional `reason`; `presentRecordingPanel` fills
it from `panelReason(anchors.stop)`; it travels as a query parameter and renders as a
`#takereason` line under `#takemeta`. No actions (STC-531 owns those).

**Library.** `TakeInfo` gains optional `stop` (read in `library.ts`); `recordingItem` appends
`libraryNote(stop)` to `notes`. No view branches on kind (`library-seam.test.ts`).

## Testing

**Pure, every push.**

- Swift: `anchorsDocument` partial mode — no `stop`, otherwise byte-identical to the stop-time
  document for the same inputs; the write-trigger decision as a pure value (precedent:
  `SettleDebounce`, `helper/test/display-change/`).
- `transform/test/recover-anchors.test.ts`: corrected `lastFramePtsNs`, the `stop` block, v11
  only for `recorder-quit`, `disk-full` kept at its own version, each refusal; every output
  validated against `schema/anchors-11.schema.json` and accepted by `loadSession`.
- `app/test/stop-copy.test.ts`: the two strings, and `undefined` for every other reason in
  the schema's enum.
- `app/test/temp-takes.test.ts`: kind `partial`; `unknown` unchanged without a partial.

**Real helper.**

- `helper/test/crash-partial.grant.test.ts` (grant; Patrick's terminal): start, wait ~3 s,
  SIGKILL; the partial exists, `recoverTake` finalises it, `loadSession` accepts it, recovered
  `stop.t` within ~2.5 s of the kill. Added to `vitest.screencapturekit-files.ts`.
- `helper/test/disk-full.test.ts` (CI, `hdiutil`): with `STC_CAPTURE_FAULT=anchors-write-failed`
  the partial survives the stop and recovery keeps `disk-full`.

**E2E (CI via draft PR, never locally).**

- `app/test/_fake-helper.mjs` gains `STC_FAKE_DIE_MS`: writes a partial plus a small real
  fixture `display.mp4`, then exits as if killed. A test asserts a panel with the reason line
  and no "not saved" toast; a second asserts the before-first-frame toast when no partial is
  written.
- `app/test/crash-recovery.e2e.test.ts`: the `unknown` → Finder test stays (no partial); a new
  test asserts Review puts a `partial` take up as a panel.

## Docs

- `docs/STC-530-RUNBOOK.md`: `kill -9` the helper mid-take → panel, plays to near the kill
  point, no "not saved" toast, Edit and export work; quit with the panel ignored, relaunch →
  prompt → panel.
- A `CLAUDE.md` table row and a `docs/TICKET-LOG.md` row.
- Comments on STC-529 and STC-531 pointing at `stop-copy.ts`.

## Out of scope

- Panel actions, pill stopped state, other stop reasons' copy: STC-531.
- Library notes for other stop reasons and silent spans: STC-529.
- Recovering the cursor. Events are written only at stop; streaming `events.json` is a
  separate decision with its own cost on the capture path.
- Takes recorded before this change: no partial, so still revealed in Finder.
