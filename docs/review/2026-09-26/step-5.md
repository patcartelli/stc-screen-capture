# STC-465 review — Step 5: Support triggers

Worktree `stc-465-review-run`, commit `a998725`. No code was changed. Builds on
step-3 (read first) and does not repeat it: step-3 §1 (no process-level
rejection handler, `onRecordHotkey` has no catch-all) and §5 (every diagnostic
is `console.*`, which a Finder-launched app sends nowhere a user can find) are
assumed below. Starting evidence: `docs/PRE-DEMO-CHECKLIST.md` (STC-406), the
TCC/signing entries in `docs/CORRECTNESS-TRAPS.md` (lines 108-117, 177-194,
791-800, 1265-1297), and `docs/STC-315-RUNBOOK.md`.

Headers read for every module cited: `main.ts` (58-63), `renderer.ts` (1),
`supervisor.ts` (4-11), `temp-takes.ts` (10-44), `toast.ts` (3-40),
`library.ts`, `library-view.ts`, `settings.ts`, `overlay-session.ts` (14-37),
`helper/src/Capture.swift` (9-18), `CaptureDecisions.swift`,
`CaptureGeometry.swift`, `WriterGate.swift`, `Still.swift`.

---

## Before the walk: there is no install

The persona is "a Mac user installing this app for the first time". There is
nothing to install. `package.json` has no electron-builder or forge; the app
runs as `electron .`; and the helper is found by a path relative to the
repo checkout, `join(here, "..", "..", "helper", "build", "stc-helper")`
(`app/src/main.ts:74-75`). That path cannot resolve inside any bundle. The
STC-397 row in `docs/TICKET-LOG.md` already says the same thing
("there is no packaging step in this repo"). So today "installing" means
`git clone`, `npm ci`, `helper/build.sh`, `npm run app:start`. Every prompt
names **Electron**, not Capture, and every grant is keyed to npm's Electron
binary (CORRECTNESS-TRAPS 798-800: ad-hoc signed, `TeamIdentifier=not set`).

The three triggers below are the ones a real user would hit **in either
world**: today's `electron .` or a first STC-401 bundle. Where the fix is
packaging, the text says so. Where STC-401 alone would NOT fix it, that is
called out, because packaging is the easy thing to wait for.

---

## 1. "It asked for permission twice, recorded nothing both times, and from the menu bar it did literally nothing"

The first Record. Every new user hits it.

### What triggers it

A fresh machine and the first Record, from any of the three doors: the
window's button, the menu-bar item, or ⌃⌥⇧⌘4. A take needs **two** grants,
Screen Recording and then Input Monitoring (STC-315 refuses a take with no
event tap; Accessibility is never involved). They are discovered **one failed
take at a time**, and each failure comes only after the full scope overlay,
the options bar and a 3 s countdown. A still (the first-still step of the
walk) needs only Screen Recording. So a user who granted that for a shot is
surprised again by the first Record.

### What the user sees

Window door, first press:
1. Record → the overlay covers every display. Behind it, the first
   `SCShareableContent` call (`sup.listWindows()`, `main.ts:952`) has just
   raised macOS's own Screen Recording prompt, naming "Electron". Whether that
   prompt sits above or below a screen-saver-level overlay has not been
   observed.
2. The user drags a region, confirms, and watches a 3 s countdown.
3. A toast: *"Screen Recording permission is required. Grant it in System
   Settings › Privacy & Security › Screen & System Audio Recording, then try
   again."* (`renderer.ts:526-528`). It says "try again", but macOS's own
   prompt offers **Quit & Reopen**. Whether this app sees a fresh Screen
   Recording grant without a relaunch has not been observed.

Second press, after granting: the overlay, options and countdown all run
again. Then `event-tap-unavailable`, the 572-character toast
(`renderer.ts:566-574`) that ends *"…tick the recorder under … Input
Monitoring. Then quit and reopen the recorder and press Record."* The pane
has no entry named "the recorder". It has **Electron**.

Third press, after a second quit and reopen: it records.

**Menu-bar and hotkey doors: nothing at all.** The same overlay and
countdown, then no toast, no pill, no take:
- menu-bar Record: `void runRecordFlow("menu-bar")`. The result is
  discarded (`main.ts:592`).
- hotkey Record: `console.error(\`[record] ${r.code}\`, …)` and nothing else
  (`main.ts:1441-1442`). Per step-3 §5, that line goes nowhere a launched
  app's user can see.
- menu-bar still: `void captureStill(action, "menu-bar")`. The result is
  discarded (`main.ts:595`). This is **not** `captureAndAnnounce`.
- hotkey still: `captureAndAnnounce` → `send("still:captured", r)`
  (`main.ts:1378-1381`). `send` is a no-op unless the main window exists
  (`main.ts:201-203`). The app is menu-bar-first (STC-292): ⌘W removes the
  window and the Dock icon, which is exactly the state a hotkey user lives
  in. The comment at `main.ts:1374-1376` says a closed window "misses
  nothing, because the shot is already on disk". That is true of a success
  and false of a refusal, where nothing is on disk.

A silent failure behind a 3-second countdown the user just sat through is the
most 1-star-shaped thing in the app.

### Cause in the code

- `main.ts:952-957` (Record) and `main.ts:1298-1305` (shot). The
  `windows` verb has already answered `no-displays` (`Still.swift:361-363`).
  The app swallows that with a comment stating it knows why ("Without a
  Screen Recording grant the helper cannot enumerate anything"), then opens
  the overlay and counts down toward a start that must refuse
  (`main.ts:1092-1100`). This is the same "don't count down to a refusal"
  reasoning STC-433 applies to a vanished display (`main.ts:1015-1018`), not
  applied to the commonest refusal of all.
- `main.ts:592`, `:595`, `:1380`, `:1441-1442`: refusals from three of the
  four non-window paths reach no surface. `START_FAULTS` lives in the
  renderer (`renderer.ts:521`), so main has no copy of the sentences to show
  even if it wanted to.
- Nothing checks either grant before a capture. There is zero
  `systemPreferences`, `CGPreflight*` or `x-apple.systempreferences` use
  anywhere in `app/src` or `helper/src` (grep).
- `renderer.ts:573`: "tick the recorder" names an entry that does not exist
  under `electron .`.

### What would prevent it

- **Code:** a helper `permissions` verb returning
  `CGPreflightScreenCaptureAccess()` and `CGPreflightListenEventAccess()`.
  Both are in the 13.3 SDK. The helper is Electron's child, so it answers
  for Electron's identity (the `main.ts` header). Call it at launch and at
  the top of `runRecordFlow`/`captureStill`, before the overlay. When both
  are missing, request both **together**
  (`CGRequestScreenCaptureAccess`/`CGRequestListenEventAccess`) so one
  relaunch covers both, and do not open the overlay.
  **CI-CHECKABLE** (the fake helper answers `permissions: {screen:false}` →
  assert no overlay window and one toast; `_windows.ts` owns the count).
  Whether the request APIs raise the same prompts as the implicit path is
  **NEEDS-A-MAC**.
- **Code:** at minimum, treat a `no-displays` reply from `listWindows()`
  at `main.ts:952` as the refusal and return it before `openOverlay`.
  **CI-CHECKABLE.**
- **Code:** show refusals from main for the hotkey and menu-bar doors.
  `showMessageToast` is already imported into main (`main.ts:57`); move
  `START_FAULTS` and `reportStill`'s wording into a node-free module both
  processes import. **CI-CHECKABLE:** drive the tray item and the hotkey
  path against a fake helper that refuses `start` with
  `event-tap-unavailable`, with the main window closed, and assert a
  message toast appears.
- **Copy:** the first refusal should say a second permission comes next.
  Name **Electron** as the entry to tick until STC-401 ships. Add an "Open
  Privacy settings" action (`shell.openExternal` to the pane's URL) instead
  of a path to navigate by hand. **CI-CHECKABLE** (string and action
  presence).
- **NEEDS-A-MAC:** is respawning only the helper (the supervisor can
  already do this) enough for a new grant to take effect, or must Electron
  itself relaunch? STC-315 runbook §4 left this open. If the helper is
  enough, "quit and reopen" becomes a "Try again" button, and the gauntlet
  loses both relaunches.
- **Packaging (STC-401):** a real bundle name in both prompts and both
  panes. This fixes the naming only. It does not fix the ordering, the
  silence or the two relaunches.

---

## 2. "Worked last week. Now it says to grant Screen Recording, and it's already ticked"

Quitting and reopening a week later, after an Electron update.

### What triggers it

Any change to the Electron binary: the next exact-pin bump in `package.json`
(`electron: 43.4.1`), a `node_modules` reinstall, or a fresh clone. The dev
`Electron.app` is ad-hoc signed (CORRECTNESS-TRAPS 798-800), so TCC keys its
grants to that binary's code hash. A new binary is a new identity, and it
inherits neither grant. `docs/PRE-DEMO-CHECKLIST.md` exists for exactly this
("can silently revoke both grants, with no error until the next capture
attempt fails").

A related, unverified trigger: recent macOS releases periodically re-ask
apps that capture the screen without the system content picker to confirm
access. This app cannot use the picker (13.3 SDK, a settled toolchain
constraint). Whether macOS 27 still re-prompts, and how often, is
**NEEDS-A-MAC**. If it does, the prompt lands on the same `listWindows()`
call at `main.ts:952` as in trigger 1.

### What the user sees

- System Settings still shows **Electron, ticked**, in both panes. That is
  the stale entry for the old binary, and it looks identical to a working
  one.
- Record (window door) → overlay → countdown → *"Screen Recording
  permission is required. Grant it in System Settings › … then try again."*
  (`renderer.ts:526-528`). The user opens the pane, finds it already
  granted, and has no next step. Pressing Record again repeats the same
  thing.
- If only Input Monitoring went stale, the 572-character toast again tells
  them to "tick the recorder", which is already ticked.
- From the hotkey or menu bar: nothing (trigger 1).

This is the classic "the app is broken, the permission is right there"
review. The correct fix (select Electron, press **–**, re-add, relaunch) is
written down nowhere a user would look. It is only in the pre-demo checklist,
which is for the developer.

### Cause in the code

- Packaging: there is no stable designated requirement for TCC to key to
  (`main.ts:74-75`; TICKET-LOG STC-397 row; CORRECTNESS-TRAPS 798-800). This
  is the root cause and belongs to STC-401.
- Copy: `renderer.ts:526-528` and `:566-574` both assume the entry is
  **missing**. Neither covers "present but stale", which after the first
  week is the likelier of the two.
- Code: the app keeps no record of which binary last recorded successfully,
  so it cannot tell "never granted" from "granted to a previous version".
  `settings.ts` has no such field, and `Settings` is the natural home.

### What would prevent it

- **Packaging (STC-401):** Developer ID signing with a stable identifier and
  team, so TCC's requirement survives an Electron update. Notarisation too,
  or a downloaded bundle hits Gatekeeper first. Recent macOS releases make
  the unnotarised path an explicit trip to Privacy & Security → "Open
  Anyway". This is the only real fix, and it makes this trigger rare rather
  than routine. **NEEDS-A-MAC** (a grant must be watched surviving an update
  of the signed bundle; CORRECTNESS-TRAPS 108-110: confirm the CDHash
  actually changed first, or the test is vacuous).
- **Code:** persist `process.versions.electron` (or the executable's
  CDHash) in settings on every successful `start`. When `no-displays` or
  `event-tap-unavailable` arrives and the stored identity differs from the
  running one, show the stale-grant wording instead of the missing-grant
  wording. The decision is pure. **CI-CHECKABLE** (a unit test on the
  decision, and an e2e with a seeded settings file plus a refusing fake
  helper).
- **Copy:** both refusal strings get one more sentence: *"If Electron is
  already ticked, select it, press –, add it back, then quit and reopen.
  This happens after an update."* **CI-CHECKABLE** (the string; toast sizing
  is already measured by `warnings.e2e.test.ts` per `toast.ts:30-35`, and
  the longer event-tap string must be re-measured there, not assumed to
  fit).

---

## 3. "Recorded 25 minutes, pressed Stop, and the library says it's not a recording"

The first long take on a nearly full Mac. A screen recorder is the app most
likely to fill a disk.

### What triggers it

The disk fills during a take. Two details make this likelier than it looks:
- Takes are written to **temp storage on the boot volume**, not the save
  folder: `~/Library/Application Support/Capture/temp-takes`
  (`temp-takes.ts:45-47`). They are moved only at Stop. That location is
  STC-393's settled choice and is not re-proposed here. The consequence is
  that a user who pointed `saveFolder` at an external drive **because the
  internal one is small** still records onto the internal one.
- 4K H.264 plus an optional camera, mic and system-audio track grows by
  hundreds of MB a minute (CORRECTNESS-TRAPS 138: a 458 MB take). The
  promotion itself can also fail with ENOSPC when the destination is a
  different volume and `moveDir` falls back to `cp` (`temp-takes.ts:114-121`).

### What the user sees

**Nothing, until afterwards.** Every layer turns the failure into silence:
- Mid-take: `AVAssetWriter` fails, and every later append returns `false`.
  `WriterGate.append` maps that to `.dropped` (`WriterGate.swift:44`), the
  same outcome as a harmless frame during teardown. The count lands in
  `framesDropped` (`Capture.swift:868`). It is visible only in the
  diagnostics table (`index.html:428`), which is off by default
  (`settings.ts:230`, `showDiagnostics: false`). The pill's timer keeps
  counting and nothing warns.
- Stop: `writer.finishWriting { group.leave() }` never checks
  `writer.status`/`writer.error` (`Capture.swift:1392`). The sidecars are
  written with `try? d.write(...)` (`Capture.swift:1448`), so an ENOSPC on
  `anchors.json` or `events.json` is discarded without a word. Only a JSON
  *encode* failure is reported (`:1445-1446`).
- The app ignores the stop reply too. `recorder:stop` returns
  `{ ok: true, info: r }` (`main.ts:1480-1481`), and the renderer never
  reads `info` (`renderer.ts:597-599`). `stopWarning` is set
  (`Capture.swift:1302`) and grep shows zero readers in `app/src`.
- The library then shows the take, promoted anyway, as a grey line:
  *"2026-… — no anchors.json — not a recording"* (`library.ts:742`,
  `library-view.ts:372-374`). Or, if the sidecars made it and the video did
  not, it shows a tile whose editor/export fails later on a truncated file.

The first message the user gets names an internal file. By then the take is
gone.

### Cause in the code

`WriterGate.swift:44`, `Capture.swift:1392`, `Capture.swift:1448`,
`main.ts:1480-1481`, and no free-space check before `start` (zero
`statfs`/`availableCapacity`/`ENOSPC` matches in `helper/src`, `app/src` and
`transform/src`; step-3 §4 found the same absence and left it open).

### What would prevent it

- **Code (helper):** when `adaptor.append` returns false and
  `writer.status == .failed`, stop treating it as a drop. Emit
  `warning{code:"writer-failed", detail: writer.error}` and end the take
  through the same path `stream-stopped` uses (STC-306,
  `Capture.swift:873-884`), so what was written before the failure is kept
  and named. Check `writer.status` after `finishWriting` and put the result
  in the stop reply. Make `write(_:to:)` report a failed write the way it
  already reports a failed encode. **NEEDS-A-MAC** for the real thing (a
  small `hdiutil` disk image as the temp root via `STC_TEMP_TAKES_DIR`,
  under a grant). The reporting paths could follow the repo's
  `STC_CAPTURE_FAULT` pattern with a `writer-failed` injector, which still
  needs a grant test (`*.grant.test.ts`), so also **NEEDS-A-MAC**.
- **Code (app):** before `start`, `fs.statfs` the temp root's volume. Refuse
  or warn below a floor derived from the capture size, and name which disk
  (the boot disk, even with an external save folder). Read `info` in
  `recorder:stop` and surface `stopWarning`, `dropped > 0` and any
  writer-failure field. **CI-CHECKABLE** (a fake helper whose stop reply
  carries them; the free-space decision is a pure function of
  `(bytesFree, captureW, captureH)`).
- **Copy:** `renderer.ts`'s `RECORDING_FAULTS` gains a `writer-failed`
  entry that says the disk is full and what was kept.
  **CI-CHECKABLE.**

---

## Runners-up

Each would be in a top three on another day. Short form: trigger → what is
seen → cause → fix and class.

**R1. A stranded take is deleted permanently at seven days, with no prompt,
if the app is left running.** This fits "a week later" exactly. A recording
whose promotion failed (an unmounted save folder or ENOSPC; `supervisor.ts:140-142`
→ `main.ts:312-315`) is told to the user as *"Recording saved but could not
be moved into the library"*. The comment above it (`main.ts:305-311`) says
crash recovery "will pick it up on next launch". But the recovery prompt runs
**only at launch** (`main.ts:602`), while `purgeStaleTempTakes` runs on a
12-hour **timer** (`main.ts:461`, `:547-548`). It uses `rm`, not the Trash
(`temp-takes.ts:200-201`), and ages a take from its own start stamp, not from
when it was stranded (`temp-takes.ts:171-175`). The purge's own premise,
"nothing legitimate stays in temp for anywhere near 7 days"
(`temp-takes.ts:183-186`), is false for this path. A menu-bar-first app is
exactly the kind that stays running for a week. The recovery code even says
"(rather than let it expire silently in 7 days)" (`main.ts:445-447`).
**Fix, code:** the timer path must not delete a `recording`-kind temp take
without the prompt (surface it, or promote it), and the launch purge should
Trash rather than `rm`. **CI-CHECKABLE:** seed an 8-day-old
`anchors.json`-bearing temp take and advance the purge. Assert it is
offered, not gone.

**R2. The helper cannot start at all → "The recorder keeps failing to start.
Restart the app."** (`renderer.ts:733`, `:1240-1243`). This is what a
bundle with a missing or unfound helper (`main.ts:74-75`), or a helper
blocked by Gatekeeper, would show. Restarting fixes neither. The supervisor
already carries the helper's last words, e.g. `spawn ENOENT`, in `gave-up`'s
`stderr` (`supervisor.ts:256-259`), but the renderer ignores the payload.
The `status()` path used when the window opens after the fact carries no
stderr at all. **Fix:** copy and code (show `stderr`; add it to `status()`),
plus packaging (STC-401 resolves the helper from `process.resourcesPath`).
**CI-CHECKABLE:** `STC_HELPER_BIN=/nonexistent`, assert the toast names the
cause. Gatekeeper's actual behaviour on a quarantined helper is
**NEEDS-A-MAC**.

**R3. A second instance → `-3805`, shown raw.** There is no
`requestSingleInstanceLock` anywhere (grep). Under `electron .`, the only way
to run today, a second `npm run app:start` while the menu-bar-only first
instance is still alive (CORRECTNESS-TRAPS 182-190 records how invisible
that instance is) gives a second tray icon and a second helper. The second
one's Record fails through `stream-failed`, which has no `START_FAULTS`
entry, so the user reads *"Could not start: stream-failed / SCStream failed
to start: Error Domain=… Code=-3805 …"* (`renderer.ts:589`). CORRECTNESS-TRAPS
177-181: "It reads like a permission or entitlement problem and is not one".
LaunchServices mostly prevents this once the app is a bundle; the lock
costs three lines either way. **Fix, code:** a single-instance lock whose
`second-instance` handler calls `openLibrary()`, plus a `START_FAULTS` entry
for `stream-failed` that names "another copy of the app, or another
recorder, is holding the display". **CI-CHECKABLE** (launch twice, assert
the second exits).

**R4. The helper dies mid-take.** The message is *"The recorder quit while
recording — that take was not saved.\n<dir>"* (`renderer.ts:669-672`). The
`<dir>` is a temp path under Application Support that the user cannot act
on. The helper's last stderr line, carried at `supervisor.ts:240-242`
(e.g. `[helper] FATAL signal SIGSEGV`), is dropped by the renderer. The
display track is 2 s-fragmented (`CaptureDecisions.swift`, STC-394), so
the pixels mostly survive. But `anchors.json`/`events.json` are written only
at stop (`Capture.swift:1403-1441`), so the leftover directory is kind
`unknown`, which step-3 §3 found recovery silently skips, and R1's purge
deletes it later. **Fix:** copy (drop the path; say whether anything is
recoverable) and code (include `stderr`). **CI-CHECKABLE**
(`killForTest()` exists, `supervisor.ts:194`).

**R5. A refusal the user cannot act on.** Every start refusal outside the
two grant codes and `capture-in-flight` falls through to *"Could not start:
<code>\n<detail>"* (`renderer.ts:589`): `start-timeout` ("capture did not
start within 15s and reported no error"), `writer-failed`,
`frame-status-mismatch`, `window-not-found`, `crop-outside-display`
(`Capture.swift:1471-1507`). None of them tells a user what to do. The two
recoverable ones are `window-not-found` ("that window closed — press Record
and pick again") and `crop-outside-display`. The rest should say "quit and
reopen; if it happens again, it is a bug". **Copy.** **CI-CHECKABLE** (a
test that every code in the Swift `code` switch has a `START_FAULTS` entry,
reading the literals out of `Capture.swift` the way `stop-reasons.test.ts`
already reads `stop.reason` literals, per CORRECTNESS-TRAPS 256-260).

**R6. A second display.** Two unverified assumptions stack up.
(a) Electron's `Display.id` equals the `CGDirectDisplayID` the helper
matches (`main.ts:1312-1315`; STC-290 runbook §3, "the one thing I could not
verify at all"). If it does not, every Record on display 2 hits STC-433's
*"The selected display is no longer connected"* for a connected display
(`main.ts:1035-1036`). A region take is then refused outright. A full-display
take offers **Use Automatic**, which drops `displayId`, and the helper
records whichever display `SCShareableContent` lists first, "NOT promised to
put the main display first" (`CaptureDecisions.swift:316-322`). That is a
take of possibly the wrong screen, after a dialog that said the right one
was gone.
(b) STC-382 records that nobody has run the display-selection paths on two
displays. **NEEDS-A-MAC** (STC-247 runbook, `multi-display.grant.test.ts`).

**R7. A display above 3840×2160.** The capture is silently downscaled,
aspect-preserved (`CaptureGeometry.swift:19-33`). The cap is settled
(CLAUDE.md) and correct. The only support trigger is "my recording is softer
than my 5K/6K screen", with nothing in the app saying the take was captured
at, for example, 64% of native (6016 → 3840). **Copy:** show capture size
against display size in the editor's export dialog, beside the STC-318
legibility sentence. Low. **NEEDS-A-MAC** to judge whether anyone notices.

**R8. The first export of a long 4K take blanks the editor.** Preview holds
the whole video in renderer memory, and about 15 minutes of 4K is the
practical ceiling (CORRECTNESS-TRAPS 138-140). There is no
`render-process-gone` or `unresponsive` handler anywhere in `app/src`
(grep), so an out-of-memory editor goes white with no message, and an
in-flight export vanishes (step-3 §2's quit case, reached by a different
route). **Fix, code:** handle `render-process-gone` on the editor window
with a dialog that names the take's length as the likely cause and offers
to reopen. **CI-CHECKABLE**
(`webContents.forcefullyCrashRenderer()` in an e2e). The real ceiling is
**NEEDS-A-MAC**.

---

## Summary

| # | trigger | seen | root | fix type | class |
|---|---|---|---|---|---|
| 1 | first Record: two grants, found one failed take at a time | overlay + countdown, then a toast; **nothing** from the menu bar or hotkey | `main.ts:952-957`, `:592`, `:595`, `:1380`, `:1441-1442`; no preflight | code + copy (+ STC-401 for naming only) | CI-CHECKABLE; the relaunch question is NEEDS-A-MAC |
| 2 | Electron update → grant silently stale | "grant it", and it is already ticked | ad-hoc identity; `renderer.ts:526-528`, `:566-574` assume "missing" | packaging (STC-401) + copy + code | NEEDS-A-MAC for survival; the copy and decision are CI-CHECKABLE |
| 3 | disk fills mid-take | nothing until the library says "no anchors.json — not a recording" | `WriterGate.swift:44`, `Capture.swift:1392`, `:1448`, `main.ts:1480-1481`; no free-space check | code + copy | helper half NEEDS-A-MAC; app half CI-CHECKABLE |

---

## Disagreements with settled decisions

- `toast.ts:66-72` records that the message toast is NOT excluded from
  capture and caps it at 20 s, so a mid-take `camera-no-frames` warning is
  recorded into the take. Excluding the toast window the way the overlay
  and countdown already are seems cheaper than timing it out.
