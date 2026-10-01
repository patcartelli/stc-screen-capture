# STC-487 — recordings get the panel (design)

**Ticket:** STC-487, STC-392 Phase B. Blocks STC-395 (GIF/Video, Copy on a recording).
**Supersedes:** Tasks 8–11 of `docs/superpowers/plans/2026-09-16-stc-392-floating-panel.md`.
That plan's intent stands. Its file paths, line numbers and three of its
mechanisms no longer match master (§6 lists each one).
**Decided with Patrick, 2026-09-30:** recordings always get the panel, `thumbnail.skip` or not.

## 1. The problem

STC-392 says every shot and every recording gets the floating panel, and that
the panel is where a take's fate is decided. #188 built it for stills only. On
master today:

- every `presentThumbnail` call passes `take: { kind: "shot", ... }`;
- a clean stop promotes the recording straight into the library
  (`HelperSupervisor.promote`, `supervisor.ts`), so nobody decides anything;
- crash recovery promotes a recovered recording outright (`main.ts`, the
  `t.kind === "recording"` branch: "No STC-392 panel exists yet for a recording");
- starting a recording CLOSES every open panel (`closeThumbnail()` in
  `recordFlowBody`), leaving those takes in temp storage until the next
  launch's recovery prompt.

## 2. What changes, in one sentence each

1. A stop never promotes. The take stays in temp storage until Save or Edit.
2. Both kinds of stop report through ONE new supervisor event, and `main.ts` presents the panel from it.
3. The panel renders a recording: a card with duration and scope, no picture, the same action row.
4. Starting a recording HIDES open panels, and the take ending shows them again.
5. Crash recovery and Trash-undo present a recording's panel the same way they present a still's.

## 3. Design

### 3.1 One event for "a take ended cleanly"

`stopRecording()` (a user's Stop) and `endRecording()` (the helper stopped on
its own: display change, window resize or close) are two separate paths today,
and only the second emits `recording-ended`. The old plan's "present from
`recording-ended`" would have missed every ordinary Stop.

- `HelperSupervisor` emits **`take-ended`** `{ dir: string, reason: string }`
  from both paths, after state is idle. `reason` is `"stopped"` for
  `stopRecording`, and the helper's own reason for `endRecording`.
- `promote()`, its `promoteTake` import, the `getSaveFolder` option (its only
  reader is `promote`; `main.ts:327` stops passing it) and the
  `recording-promote-failed` event are deleted.
  So is `main.ts`'s listener that turns that event into a
  `recording-not-promoted` warning. A warning about something that no longer
  happens is worse than none.
- `recording-ended` keeps its meaning: "the helper stopped without being
  asked". The tray, the pill and the main window still reconcile from it. Its
  `dir` is now the temp directory. Every consumer was checked (review,
  2026-10-01): the pill, the tray and the main window's `reconcile*` read
  state only and are unaffected. **`renderer.ts`'s `helper:recording-ended`
  handler is the one that assumed a library path** — see §3.6.
- Stale text goes with it: the "Already promoted out of temp storage" comment
  above `main.ts`'s `recording-ended` listener, `temp-takes.ts`'s reference to
  `recording-promote-failed`, and `_fake-helper.mjs`'s note about
  `HelperSupervisor.promote`.
- **`shutdown()` does not lead to a panel.** It calls `stopRecording()`, so
  `take-ended` still fires, and `main.ts`'s listener returns early while
  quitting (the existing `quitting` flag). The take stays in temp storage and
  STC-393's recovery prompt offers it on the next launch, the same backstop
  Quit Anyway already relies on.

### 3.2 Presenting a recording

`main.ts` has one function, `presentRecordingPanel(dir, origin)`, called from
`take-ended`, from crash recovery and from Trash-undo. Three callers, one
builder: a second copy is the defect this repo keeps finding.

It reads the take's `anchors.json` once and passes `presentThumbnail`:

- `take: { kind: "recording", origin }`,
- `recording: { durationMs, scope }`, where:
  - `durationMs` comes from `library.ts`'s existing derivation (`anchors.stop.t`
    in ns → ms). It's moved into an exported helper rather than recomputed;
  - `scope` is a label: no `scope` block, or `kind: "display"` → `"Screen"`;
    `"region"` → `"Area"`; `"window"` → `window.app`, or `"Window"` when absent.
    The vocabulary matches the record flow's Screen/Window/Area. It's a pure
    function next to the duration helper, unit-tested on all four cases,
  - `corner`, `dist`, `rendererDir` as for a still.
- **Never `silent`.** `thumbnail.skip` means "go straight to the clipboard", and
  a recording has no Copy until STC-395. A silent recording would have no
  outcome at all: not saved, not copied, found only by recovery or the 7-day
  purge.

An `anchors.json` that's missing or unreadable degrades the META LINE (empty),
never the panel. A take that can't describe itself still needs Save and Trash.
If `presentThumbnail` throws, the error is logged and the take stays in temp
storage where recovery will find it. A panel failure must never cost the take
(the STC-296 rule).

### 3.3 `PresentOptions` and the renderer

- `PresentOptions.shot` becomes optional. A new `recording?: { durationMs: number; scope: string }`
  is added. The doc comment states that exactly one of them is present, and
  that `take.kind` says which. Both go through the load query as JSON, the
  way `shot` and `take` already do.
- `thumbnail-renderer.ts` is shot-only from top to bottom today, bar one thing:
  it already unhides `#takecard` and hides `#thumbwrap` for `kind: "recording"`
  (Phase A groundwork), so that part is done. `parseShot(null)`
  throws, and `painted` fires only after the PNG frame has been fetched and
  drawn. So a recording panel would never be shown. Changes:
  - `parseShot` runs only for `take.kind === "shot"`;
  - a recording fills `#takemeta` with `${fmtDuration(durationMs)} · ${scope}`,
    reusing `library-items.ts`'s `fmtDuration` (a module-private `const` today: it
    gets `export`ed, not copied);
  - the paint path branches: a shot keeps fetch → draw → paint; a recording
    goes straight to the same `requestAnimationFrame` block that arms
    `SETTLE_KEYS_MS` and emits `painted`. That block is factored into one
    function both branches call, so the 300 ms input guard can't be lost
    for recordings;
  - every shot-only entry point (`draw`, the export, `refreshDragFile`, the
    redact listeners, the mode picker, drag-out, swipe-to-discard if it reads
    the frame) gets `if (take.kind !== "shot") return;` at its top. A guard
    at the entry can be grepped; a listener that was never attached can't.
- The right-click menu drops **Save As…** for a recording (`thumbnail-menu.ts`):
  it writes the decorated picture and a recording has none, so the row would
  be dead. `thumbnail-menu.test.ts` pinned the old row, and is updated.
- The action row is already right: `actionsFor({ kind: "recording", origin: "fresh" })`
  is Save, Edit, Trash, and `panel:edit` already promotes and opens `editor.ts`.

### 3.4 Panels while a recording runs

STC-392 focus rule 2: open panels move out of the way of a new take and must not
appear in its frame. `start` has no window-exclusion list, so hiding them is
the whole mechanism.

- `recordFlowBody` replaces `closeThumbnail()` with `await hideThumbnailForCapture()`,
  after the countdown (a cancelled countdown still costs nothing) and before
  the helper is told to `start`.
- Every exit after the hide that does not produce a recording (`start-failed`,
  a thrown helper error, a refused start) calls `showThumbnailsAfterCapture()`.
  Exits BEFORE the hide (`no-capture-target`, `capture-in-flight`, the
  countdown being cancelled) must not.
- `take-ended`'s listener calls `showThumbnailsAfterCapture()` BEFORE
  presenting the new panel. `presentThumbnail` unshifts, so the recording's
  panel lands at the corner with the older stack behind it, and its own
  focus-on-paint takes over from `afterCapture`'s focus on `panels[0]`. That
  outcome is correct, and a comment says why.
- `recording-lost` (the helper died) also shows the hidden panels again, with
  no new panel, because there is no take to decide on.

### 3.5 Recovery and undo

- **Crash recovery:** the `t.kind === "recording"` branch stops promoting and
  calls `markOfferedForRecovery`, then `presentRecordingPanel(t.dir, "fresh")`,
  the same sequence the still branch uses. The "open the library" fallback
  goes away with it.
- **Trash-undo:** `panel:undoTrash` re-presents from `shot.json` with
  `kind: "shot"` hardcoded. It switches to branching on what is in the
  directory (`anchors.json` → `presentRecordingPanel`, `shot.json` → the
  existing still path), because `takeFor(dir)` is already gone once a panel
  is closed. Without this, undoing a recording's Trash throws inside the
  catch and the take is silently left in temp storage.
- The quit warning needs no change: `unsavedTakeDirs()` counts every
  fresh-origin panel, so it counts recordings as soon as they have one.

### 3.6 The helper-stop alert

`renderer.ts`'s `helper:recording-ended` handler tells the user "What was
captured up to that point was saved.", refreshes the library grid and reveals
`i.dir` in Finder. All three are wrong once a stop doesn't promote: nothing is
saved yet, the grid has nothing new, and `dir` is a temp path. Decided with
Patrick, 2026-10-01: **reword, don't drop.**

- The handler keeps `applyRecordingState(false)` and the alert. The alert's
  first line is unchanged (`ENDED_BY_HELPER[reason]` already says why it
  stopped); the second line becomes
  `"What was captured up to that point is waiting in the panel at the corner of the screen. Save it to keep it."`
- `refreshTakes()` and `recorder.reveal(i.dir)` are removed.
- Main presents the panel from `take-ended` independently of this window, so
  the alert and the panel are two views of one event and neither waits on the
  other. If the panel failed to present, the take is still in temp storage and
  recovery offers it next launch (§3.2); the alert's claim is then optimistic
  by one launch, which is the accepted cost of the STC-296 rule.

## 4. Testing

**Unit (CI):**
- `supervisor.test.ts`: a clean `stopRecording()` leaves the take in temp
  storage and the library empty; it emits `take-ended` with the temp `dir`.
  The helper ending a take on its own emits BOTH `take-ended` and
  `recording-ended`. Uses the file's existing fake-helper harness.
- Existing tests that pin the old behaviour are rewritten, not just added to:
  `supervisor.test.ts:133` and `:189` ("…promotes too, and reports the NEW
  dir"); and `warnings.e2e.test.ts:247` and `pill.e2e.test.ts:129-135` are
  checked for an assumption that a stop lands in the library.
- The scope label's four cases and the duration helper, next to where they live.
- `panel-actions.test.ts`: unchanged, and it already pins a recording's action set.

**E2E (`app/test/recording-panel.e2e.test.ts`, new, against `_fake-helper.mjs`):**
takes are started through `_record-flow.ts`'s `startRecordFlow`, and windows
are counted through `_windows.ts`, never `app.windows()` (STC-416).
1. A clean stop puts up a panel showing `#takecard` (not `#thumbwrap`), with no
   `#copy` and with `#edit`. The take is in temp storage and the library is empty.
2. Save on that panel promotes it, and the panel closes.
3. A still panel on screen is hidden while recording (main-process visibility
   via `_windows.ts`) and visible again after the stop, behind the new
   recording panel.
4. Trash, then undo, on a recording puts its panel back.
5. `thumbnail.skip` on: a recording still gets a visible panel.

E2E timeouts are declared above the sum of their internal waits (the `bc9faaf` rule).
Before calling any failure flake, count orphaned Electron processes and check load.

**Hardware (runbook, `docs/STC-487-RUNBOOK.md`):** the recording card's look
at the corner; whether duration · scope is enough to tell two takes apart, or
whether the poster follow-up (D2) needs filing now; and that a hidden panel is
really absent from a real take's first frames, since a fake helper can't
show what ScreenCaptureKit captured.

## 5. Out of scope

- Copy on a recording, GIF/Video, the APFS clone: STC-395.
- A poster frame for a recording (STC-392 plan D2).
- Any change to `panel-actions.ts`'s table.

## 6. What changed from the 2026-09-16 plan

| Plan said | Now | Why |
|---|---|---|
| Present from `recording-ended`, "the single funnel" | New `take-ended` from both stop paths | A user's Stop never emits `recording-ended` (`supervisor.ts`) |
| `scopeLabel(settings.scope)` in `scope-indicator.ts` | Label from the take's own `anchors.json` | STC-388 removed `Settings.scope` and that module; scope is decided per take |
| Write a `formatDuration` | Export `library-items.ts`'s `fmtDuration` and `library.ts`'s duration derivation | They exist; a third formatter is the drift defect |
| `recorder:start` calls `closeThumbnail()` → hide | `recordFlowBody` calls `closeThumbnail()` → hide | STC-388 moved the start path |
| Not mentioned | Crash recovery and Trash-undo present a recording's panel | Both hardcode the pre-panel behaviour |
| Not mentioned | Renderer paint path branches; recordings skip the frame fetch | Otherwise `painted` never fires for a recording |
| `win.click("#record")`, `launched.windows()` | `startRecordFlow`, `_windows.ts` | STC-388 and STC-416 test rules |
| Not mentioned | `renderer.ts`'s `helper:recording-ended` alert says "saved", refreshes the grid and reveals `dir` | Found in review 2026-10-01; reworded, §3.6 |
| Runbook `STC-392-RUNBOOK.md` | `STC-487-RUNBOOK.md` | STC-392's runbook already exists and is about Phase A |
