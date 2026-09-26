# STC-465 review — Step 3: Gaps

Worktree `stc-465-review-run`, commit `a998725`. No code was changed. Builds
on step-0/1/2; not repeated here. `supervisor.ts`'s header was read in full —
helper-crash legibility (`recording-lost`, `gave-up`, the stderr carry-through)
is the thing this file explicitly already does, and none of that is repeated
as a finding below. The question this pass asked at every stop was "what
happens when this specific thing does NOT go as planned, and is that answer
written down anywhere or only implied."

---

## 1. Main's own faults

**Confirmed by grep, across the whole repo:** zero `process.on("unhandledRejection", ...)`
and zero `process.on("uncaughtException", ...)` anywhere in `app/`, `transform/`,
or `scripts/`. There is no process-level backstop at all. Node's default
action for an unhandled rejection (since Node 15, and Electron's main process
is a Node process) is to crash — silently, with no dialog, no crash report,
and (per §5 below) no log file a user could later find.

**This is not a hypothetical failure mode; the codebase has already found and
fixed this exact shape twice, ad hoc, without ever generalizing the fix.**
- `captureStill` (`main.ts:1183-1186`) carries an explicit doc comment —
  "Never throws, whatever the door. A hotkey has no caller to reject to: an
  exception here would be an unhandled rejection in the main process and a
  capture that silently did nothing" — and is wrapped in a single top-level
  `try { … } catch (e) { return { ok:false, … } }` (`:1199`, `:1275-1278`)
  that makes the invariant true regardless of what fails inside it.
- `main.ts:1761-1770` (the `take:delete`/`trashWithConfirmation` handler)
  documents the bug landing for real: "`dialog.showMessageBox` and
  `shell.trashItem` were previously UNCAUGHT here, so a rejection … escaped
  as an unhandled promise rejection in the renderer's `perform()`" (STC-392
  review, finding I2), and was fixed by wrapping the whole handler.

**The same discipline was never applied to Record, which is the app's other
primary action and is invoked exactly the same fire-and-forget way:**
- `main.ts:591-592` (tray callback): `void onRecordHotkey(); return;` /
  `void runRecordFlow("menu-bar");` — no `.catch`.
- `main.ts:1409` (global shortcut callback): `if (plan.action === "record")
  return void onRecordHotkey();` — no `.catch`.
- `onRecordHotkey` (`main.ts:1430-1443`) itself has no top-level try/catch —
  it only checks `r.ok` on `runRecordFlow`'s RESOLVED value (`:1441-1442`),
  which does nothing if the promise rejects instead of resolving.
- `runRecordFlow`/`recordFlowBody` (`main.ts:919-1101`) has no equivalent
  "never throws" catch-all the way `captureStill` does. Individual known-
  fallible calls inside it are wrapped (`sup.devices()` at `:1025` has
  `.catch(() => null)`, `sup!.startRecording()` at `:1092-1100` has its own
  try/catch), but `openOverlay(...)` (`:973`, unwrapped), `runCountdown(...)`
  (`:1065`, unwrapped) and `closeThumbnail()` (`:1080`, wrapped, fine) are not
  uniformly covered — a throw from window construction inside either of the
  first two (both real `BrowserWindow` calls, not pure functions) propagates
  all the way to whichever `void` call site invoked it, with no `.catch`
  anywhere between it and the process.
- `recoverUnsavedTakes` (`main.ts:397-458`), invoked fire-and-forget at
  startup (`main.ts:602`, `void recoverUnsavedTakes();`), has good per-step
  try/catch around the purge, the listing, and each recovery branch — but
  the `dialog.showMessageBox` call itself (`:408-415`) is not wrapped, and a
  rejection there (Electron's dialog API can reject, not just resolve) has
  nothing catching it before the `void` call site.

**Area:** main-process fault handling.
**What's missing:** a `process.on("unhandledRejection", …)` /
`process.on("uncaughtException", …)` pair that at minimum logs (see §5) and
does not let the process die silently, plus auditing the four fire-and-forget
call sites above to either wrap the callee (matching `captureStill`'s own
pattern) or `.catch()` at the call site.
**One-sentence fix:** add the two process-level handlers near the top of
`main.ts`, and give `runRecordFlow`/`onRecordHotkey`/`recoverUnsavedTakes` the
same top-level catch-all `captureStill` already has.
**Class: CI-CHECKABLE.** A test can stub `dialog.showMessageBox` (or
`BrowserWindow`'s constructor, for the overlay/countdown case) to reject once,
drive Record through the tray or the hotkey, and assert the Electron process
is still alive and answering IPC afterward rather than having exited. The
absence of the two `process.on` calls is itself a one-line grep.

**IPC handlers that throw, separately checked:** every real request/response
channel in this app is `ipcMain.handle` (step-0's table), and Electron
serializes a thrown `Error` and rejects the renderer's `invoke()` promise with
it — confirmed this is what several handlers rely on deliberately (e.g.
`export:write`'s `throw new Error(...)` calls at `main.ts:1878-1889`, caught
by `editor.ts`'s `runExport` catch block at `:2038-2043` and shown via
`alertUser`). No handler in this app answers a request through a manual
`ipcMain.on` reply channel that could hang instead of rejecting. **No finding
here** — this is the one half of the brief's question that is already sound.

---

## 2. Quitting mid-operation

**Checked and found solid, briefly, so the gaps below read as gaps rather
than as an unexamined area:** `runQuitTeardown` (`main.ts:651-694`) cancels
any live countdown, hides the toast, drains `pendingTrash` with a bounded
commit per entry (`TRASH_COMMIT_AT_QUIT_MS`, STC-427), closes the thumbnail
stack without exporting or deleting anything, closes the overlay, and only
then shuts the helper down — each stage timed and the whole chain printed
(`:691`). `before-quit` (`:696-778`) counts unsaved panel takes and offers
Save All / Quit Anyway / Cancel. A live recording when the last window closes
is stopped and promoted, not abandoned (`window-all-closed`, `:605-618`,
`sup.stopRecording()` promotes internally per `supervisor.ts:123-135`). This
machinery is real and was read in full, not assumed from the header.

**Gap: quitting during an editor export is invisible to all of the above, and
silently discards the work with no warning.** `runExport` (`editor.ts:1994-2046`)
runs `exportSession(...)` — a CPU-bound, potentially multi-minute encode
(CORRECTNESS-TRAPS documents this repo's own export timings) — entirely in
the editor renderer, and only calls `editor.writeExport` (`export:write`)
once, after the whole encoded buffer exists in memory (`:2020-2021`). Nothing
in `main.ts`'s `unsavedTakeDirs()` (which only counts thumbnail-panel takes,
per `thumbnail-window.ts`) or in `before-quit`'s dialog knows an export is
running in the editor window. Pressing Cmd-Q (or closing the editor window)
mid-encode: no warning is shown, `quitDecision` sees zero unhandled takes and
quits immediately, the editor window is torn down, and the user has no
indication anything was lost — contrast with the careful, specific "1 take
isn't saved" wording the same file uses for panel takes three functions away.
The take itself is unaffected (nothing is written until the encode finishes),
so nothing is corrupted; the gap is entirely in warning-and-legibility.
**Area:** quit sequencing / editor export.
**What's missing:** the editor's in-flight export state is not visible to
`before-quit`.
**One-sentence fix:** have the editor set a shared "export in progress" flag
(an IPC push, mirroring how `openTakes` is already tracked) that
`before-quit`'s `unhandled` count folds in, or have the editor's own
`beforeunload` (`editor.ts:2209`) prompt when `exportAbort` is set.
**Class: CI-CHECKABLE.** An e2e test can start an export against the fake
helper, trigger `app.quit()` mid-encode, and assert either a warning fired or
that no export silently vanished with the user none the wiser.

**Gap, lower severity: quitting mid-`duplicateTake` can leave a partial bundle
directly in the visible library root, with no recovery path.**
`duplicateTake` (`takes.ts:228-247`) copies a take's files one at a time into
a freshly claimed directory under `rawRoot` — the user's own, visible library
folder, not the temp root STC-393's crash recovery watches. A quit mid-loop
(the `for (const entry of await readdir(dir))` copy loop, `:237-241`) is not
tracked by `runQuitTeardown` or `before-quit` at all — `duplicating`
(`takes.ts:205`) exists only to prevent a name collision between two racing
duplicates, not to report an in-flight one at quit. The result is a partially-
copied bundle sitting in `raw/`, which neither STC-393's recovery (temp-root
only) nor `sweepOrphanedBundles` (`temp-takes.ts:287-351`, which only flags a
bundle with NO matching finished file — a partial copy with SOME files present
and a plausible `capture.json` does not match that predicate) will ever flag
for cleanup or explanation.
**Area:** quit sequencing / duplicate.
**One-sentence fix:** track in-flight `duplicateTake` calls the same way
`pendingTrash` is drained at quit — either wait for them in
`runQuitTeardown`, or delete the partial destination in a `catch` when a
quit is detected mid-copy.
**Class: CI-CHECKABLE** (kill the app mid-`duplicateTake` in a test and assert
the destination directory is either complete or absent, never partial).

---

## 3. Missing or corrupt state

**Checked and found solid:** `readSettings`/`writeSettings` (`settings.ts:358-386`,
`:396-436`) never throw — a missing file, a parse failure, or a non-object
document all fall through to `{ ...DEFAULT_SETTINGS }`, and every field is
individually type-checked before being trusted (`settings.ts:355-356`'s own
header: "one bad field cannot smuggle itself in as a preference"). A
`saveFolder` that has become unreachable (an unmounted volume) is handled at
the one place it matters — `HelperSupervisor.promote` (`supervisor.ts:136-144`)
catches a failed `promoteTake` and emits `recording-promote-failed`, which
`main.ts:312-315` turns into a user-visible `helper:warning`
("Recording saved but could not be moved into the library"), leaving the take
recoverable in temp storage rather than losing it. Both of these were read in
full, not inferred from a header.

**Gap: a temp take that is neither a still nor a recording is silently
dropped by crash recovery's "Review" path, after being counted in its own
dialog.** `TempTakeInfo.kind` (`temp-takes.ts:353-358`) is `"unknown"` when a
directory in temp storage has neither `shot.json` nor `anchors.json` — the
shape a crash between `mkdir`-ing the temp leaf and the helper's first
sidecar write leaves behind (killed the instant after Record is pressed, a
power loss, `kill -9` before the helper answers `start`). `recoverUnsavedTakes`
(`main.ts:397-458`) computes `orphaned = await listTempTakes(...)` and shows
the user a dialog reading "N unsaved takes recovered" (`:413`) where N
includes every "unknown"-kind entry. If the user picks "Review", the per-kind
loop (`:429-456`) handles `"still"` and `"recording"` and falls to
`else { console.error("[recovery] unrecognised temp take, leaving it in
place:", t.dir); }` for `"unknown"` — nothing is shown, nothing is presented,
and the console line goes nowhere the user can see (§5). The dialog said N;
the user sees fewer than N with no explanation, and the directory sits in
temp storage until the 7-day age purge quietly removes it. Only "Discard all"
(`:417-420`) actually clears it, since that branch `rm`s every entry in
`orphaned` unconditionally before the per-kind loop runs at all.
`app/test/crash-recovery.e2e.test.ts` exists and drives this dialog for real,
but nothing in it (grepped for `"unknown"`/`kind`) seeds a directory with
neither sidecar.
**Area:** crash recovery / temp-take classification.
**What's missing:** an "unknown"-kind temp take has no recovery UI, and the
dialog's count does not match what "Review" actually shows.
**One-sentence fix:** either present an "unknown" temp take as a generic
recoverable item (promote it outright, the way a recording is, since there is
nothing to lose by keeping a file that already exists) or exclude "unknown"
entries from the dialog's own count so the number shown is the number
delivered.
**Class: CI-CHECKABLE.** Extend `crash-recovery.e2e.test.ts` with a temp
directory containing neither `shot.json` nor `anchors.json` and assert the
dialog's count matches what "Review" actually surfaces.

---

## 4. The world changing under the app

**Checked and found solid:** the overlay tracks live display changes while it
is open (`screen.on("display-added"/"display-removed"/"display-metrics-changed")`,
`overlay-session.ts:351-353`, torn down at `:650-652`). A display picked by
the overlay is re-validated against the helper's own enumeration immediately
before the countdown (STC-433, `main.ts:1015-1058`) rather than trusted from
the overlay's now-stale answer.

**Gap (narrow, and already degrades safely — flagged for completeness rather
than as urgent): that display re-check runs once, before the countdown
starts, and is not repeated after it.** A display unplugged during the 3-10 s
countdown window itself (after `recordFlowBody`'s STC-433 check passed, before
`sup!.startRecording(dir, startParams)` at `main.ts:1092`) falls through to
the helper's own `display-not-found` refusal at `start`, which IS caught
(`:1095-1100`) and returned as a legible `{ok:false, code, detail}` rather
than hanging or crashing. So the failure mode is graceful, just not
pre-empted the same way the pre-countdown case is — the user watches a full
countdown finish for a start that was already going to be refused.
**Class: NEEDS-A-MAC** to see how that refusal actually reads after a real
countdown (does the countdown's own success animation contradict the refusal
that follows it) — the code path itself is not a blind spot, only untested on
hardware.

**Gap (uncertain, out at the edge of this review's scope, flagged rather than
asserted): disk filling during a recording has no ENOSPC-specific handling
anywhere.** Grepped `ENOSPC`/"No space"/"disk full"/"out of space" across
`helper/src/*.swift`, `app/src/*.ts` and `transform/src/*.ts`: zero matches.
A recording that fills the disk mid-take would presumably surface through
whatever generic path `AVAssetWriter`'s own failure takes (`didStopWithError`
→ some `stop.reason` string → `recording-lost`/`recording-ended` → the
already-solid supervisor legibility this review is told not to re-litigate),
so this may already be covered by the generic crash/stop-reason machinery
rather than being a true blind spot — but nothing names it specifically, and
nothing in this repo's test suite exercises it. **Disk filling during an
EXPORT, by contrast, is already handled**: `writeFile` failing inside
`export:write` (`main.ts:1878-1913`) rejects the `ipcMain.handle` promise,
and `editor.ts`'s `runExport` catch block (`:2038-2043`) reports it to the
user via `alertUser` rather than losing it silently.
**Class: NEEDS-A-MAC** (a real full disk, or `STC_CAPTURE_FAULT`-style fault
injection at the Swift layer, is the only way to know which `stop.reason`
this actually produces and whether it reads as a disk problem or a generic
one).

**Not investigated to a conclusion, flagged as a genuine unknown rather than
a finding:** whether a live TCC revoke (Screen Recording, Input Monitoring,
Mic, or Camera pulled from System Settings while a take is already running)
produces an app-visible signal distinct from "never started" or "device
unplugged." The app-side event surface (`sup.on("helper:camera-started"/
"helper:mic-started"/"helper:warning", ...)`, `main.ts:295-325`) forwards
whatever the helper sends, but this pass did not trace the Swift capture
classes far enough to say whether a mid-take revocation is even distinguishable
helper-side from a stall — and the task brief scopes helper crash/fault
legibility as already covered ground. **NEEDS-A-MAC**, named here only so it
is not silently dropped from consideration.

---

## 5. Logging

**Confirmed by grep:** no `electron-log`, no hand-rolled log-file writer, no
`app.getPath("logs")` reference, anywhere in `app/src` or `package.json`. All
diagnostics in this app — and there are many, cited throughout this review —
are `console.log`/`console.error` calls: `[quit] teardown …` (`main.ts:691`,
the one line that would explain a slow or hung quit — see CORRECTNESS-TRAPS'
own STC-427 entry on exactly this), `[recovery] …` (`:441`, `:452`, `:455`),
`[orphan-sweep] …` (`:562`, `:566`), `[temp-takes] …` (`:399`, `:403`),
`[record] stop failed` (`:1432`), and more.

In a launched app (opened from Finder/Spotlight/Dock, not from a Terminal),
Electron's `console.*` output does not go anywhere a typical user can find —
at best it reaches the system's unified log
(`log show --predicate 'process == "Electron"'` or Console.app), which is not
something anyone would think to check, let alone attach to a bug report,
before the failure has already happened and the relevant lines have scrolled
out of the live buffer. `showDiagnostics` (STC-412's settings field) only
gates a live in-app debug table showing CURRENT state — it has no history and
nothing to show once the relevant window or panel has already closed, which
is exactly when a "why did that just happen" question gets asked.

**Area:** diagnosability of a launched (non-Terminal) app.
**What's missing:** any persistent, user-attachable record of what the main
process actually did, across a session.
**One-sentence fix:** write `console.log`/`console.error` (or a thin wrapper
around them) to a rotating file under `app.getPath("logs")`, and add a
"Reveal Log File" item somewhere reachable (the tray menu, or beside the
existing diagnostics toggle) — mirroring the pattern this app already uses
for `recorder:reveal`/`share:reveal`.
**Class: CI-CHECKABLE** once added — a test can trigger any of the above
console-only paths and assert a matching line landed in the log file at
`app.getPath("logs")`. The absence itself needed no test to confirm, only the
grep above.

---

## Disagreements with settled decisions

None. Nothing in this pass contradicts a settled decision; every gap above is
an absence next to code that is otherwise careful (`captureStill`'s own
"never throws" invariant, `promoteTake`'s graceful degradation, the STC-433
pre-countdown display check), not a disagreement with how any of that careful
code was built.
