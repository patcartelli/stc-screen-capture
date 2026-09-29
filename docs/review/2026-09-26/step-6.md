# STC-465 review — Step 6: Risk register

Worktree `stc-465-review-run`, commit `a998725`. No code was changed. This
file draws on `step-0.md` through `step-5.md` for 2026-09-26. Line numbers
are the ones those steps cite. I re-read these against the code before
grading: the four High rows, STC-468's call sites, `recorder:stop`, the
temp purge, and `recoverUnsavedTakes`.

**How rows were graded.** Every row is graded against THIS step's rubric,
not the grade the originating step gave it. Four rows therefore moved. The
rubric's High is narrow: data loss, a take lost silently, or a renderer
escaping its confinement.
- Step 2 rated D1 High. It is Medium here: the saved file is wrong, but the
  source `frame.png` is untouched and nothing is lost.
- Step 4 rated STC-468 and D3 "High impact". Both are Medium here.
- Step 2 rated D4, D5 and D6 Medium. They are Low here: nothing fails,
  and they are hardening or maintainability issues.
- Step 5's "silent Record from the menu bar / hotkey" is High. Once the
  main window is closed, which is the normal state for a menu-bar-first app
  (STC-292), a user who sat through the countdown has no signal that
  nothing started. They go on to perform the demo into nothing. That is a
  take lost silently, just from the user's side of the glass.

**Ticket column.** This session has no Linear access. The only keys cited
are the three calibration tickets from `docs/ELECTRON-REVIEW-KIT.md`.
Everywhere else the column says "none found (no Linear access this pass)".
Where the repo's own docs name a related ticket (STC-401 packaging, STC-388,
STC-290/247 runbooks), that is noted in the action column as context. It is
not a claim that the ticket covers the row. **Search Linear by title and key
terms before filing any row** (kit §How to run it, and the STC-417/STC-403
collision).

**Class.** CI means a test in this repo could pin it on Linux/Xvfb. MAC means
only real hardware, a real TCC grant or an eye can settle it. "CI + MAC" rows
have a checkable half and a half that is not.

---

## Register

Sorted by severity (H, M, L), then effort (S < 1 h, M ≈ 1 day, L > 1 day).

| # | area | finding | sev | effort | CI or MAC | existing ticket | recommended action |
|---|---|---|---|---|---|---|---|
| 1 | Crash recovery | A temp take with neither `shot.json` nor `anchors.json` (kind `"unknown"`, `temp-takes.ts:353-358`) is counted in the recovery dialog (`main.ts:413`). "Review" then skips it with only `console.error` (`main.ts:455`), and the 7-day purge later deletes it. This is exactly what a helper death or `kill -9` mid-take leaves behind. Sidecars are written only at stop (`Capture.swift:1403-1441`, step-5 R4), while the 2 s-fragmented `display.mp4` mostly survives. So recoverable pixels are dropped without a word. `crash-recovery.e2e.test.ts` never seeds this kind (step-3 §3). | H | S | CI | none found (no Linear access this pass) | Crash recovery: surface unknown-kind temp takes on Review instead of silently leaving them for the purge (and make the dialog's count match what Review shows) |
| 2 | Temp storage / purge | `purgeStaleTempTakes` permanently deletes (`rm`) any temp take aged ≥ 7 days, measured from the take's own start stamp (`temp-takes.ts:171-175`, `:183-201`). The header's premise that "nothing legitimate stays in temp for anywhere near 7 days" is false for a recording whose promotion failed. `main.ts:305-315` tells the user it will be recovered on next launch. Two paths delete it anyway. At launch, the purge runs BEFORE `listTempTakes` (`main.ts:398` → `:402`), so a relaunch after day 7 deletes it before the prompt. And the 12-hour timer (`main.ts:547-548`) deletes it from a long-running menu-bar session with no prompt at all (step-5 R1). | H | S | CI | none found (no Linear access this pass) | Temp purge: never delete a recording or still temp take that has not been offered for recovery |
| 3 | Record flow, refusals | Refusals from three of the four non-window doors reach no surface:<br>• menu-bar Record discards the result: `void runRecordFlow("menu-bar")` (`main.ts:592`)<br>• menu-bar still is `void captureStill(...)` (`main.ts:595`)<br>• hotkey Record only calls `console.error` (`main.ts:1441-1442`)<br>• hotkey still sends `still:captured`, a no-op without the main window (`main.ts:201-203`, `:1378-1381`)<br>`START_FAULTS` lives only in the renderer (`renderer.ts:521`), so main has no sentence to show. After the full overlay and countdown, the user gets nothing (step-5 #1). | H | M | CI | none found (no Linear access this pass) | Show Record and still refusals from the menu-bar and hotkey doors, with or without the main window (move `START_FAULTS` to a node-free shared module; toast from main) |
| 4 | Disk full, app half | Nothing checks free space before `start`: there is no `statfs`/`availableCapacity`/`ENOSPC` anywhere. Temp takes live on the boot volume even when `saveFolder` is external (`temp-takes.ts:45-47`). `recorder:stop` returns `{ ok, info }` (`main.ts:1480-1481`) and the renderer never reads `info` (`renderer.ts:597-599`). The helper's `stopWarning` (`Capture.swift:1302`) has zero readers in `app/src`. A full disk surfaces only afterwards, as "no anchors.json — not a recording" (`library.ts:742`) (step-5 #3). | H | M | CI | none found (no Linear access this pass) | Check free space on the temp-takes volume before Record, and surface the stop reply's warnings and dropped-frame count |
| 5 | Disk full, helper half | An `AVAssetWriter` failure is indistinguishable from a harmless drop: `adaptor.append` returning false maps to `.dropped` (`WriterGate.swift:44`). `finishWriting` never checks `writer.status`/`error` (`Capture.swift:1392`). Sidecar writes are `try? d.write(...)` (`Capture.swift:1448`), so ENOSPC on `anchors.json` is discarded; only an encode failure is reported. Note: Swift internals are outside this kit's scope. This row is here because #4 alone cannot tell the user what was kept. | H | M | MAC | none found (no Linear access this pass) | Helper: treat an AVAssetWriter failure as `writer-failed` (end the take, report it), and report sidecar write errors the way encode errors already are |
| 6 | Main-process faults | There is no `process.on("unhandledRejection")` or `process.on("uncaughtException")` anywhere in `app/`, `transform/` or `scripts/` (grep, step-3 §1). Fire-and-forget callers have nothing between them and the process: `main.ts:591-592`, `:1409`, `:602`. **Unverified:** steps 3 and 4 say this "crashes silently" on Node's default. Electron's main process may instead warn (rejections) or show its own error box (exceptions). The test in step-4 #1 settles which. Either way, nothing is logged anywhere retrievable (#20). Medium, not High: a main-process death closes the helper's stdin, which ends a live take as `stdin-closed` (`Protocol.swift:153`) and leaves it to recovery. | M | S | CI | **STC-468** | Add process-level unhandledRejection/uncaughtException handlers in main (step-4 #1 has the change and the test) |
| 7 | Main-process faults | Record has no "never throws" catch-all of the kind `captureStill` has (`main.ts:1183-1186`, `:1199`). `onRecordHotkey` (`main.ts:1430-1443`) checks only a resolved `r.ok`. Inside `runRecordFlow`, `openOverlay` (`:973`) and `runCountdown` (`:1065`) build real `BrowserWindow`s unwrapped. `recoverUnsavedTakes`'s `dialog.showMessageBox` (`:408-415`) is unwrapped too (step-3 §1). | M | S | CI | STC-468 (adjacent: scope it in, or file separately) | Give runRecordFlow, onRecordHotkey and recoverUnsavedTakes the same top-level catch-all captureStill has |
| 8 | Navigation / new windows | There is zero `will-navigate`, `setWindowOpenHandler`, `web-contents-created` or `setPermissionRequestHandler` in `app/src` (grep; re-checked for this step). No renderer handles `dragover`/`drop`. A preload reruns on whatever document its `WebContents` navigates to, so a dropped file or link would inherit the window's whole bridge (step-1 §3). Effort is S, not step 4's estimate: one `app.on("web-contents-created")` in `main.ts` covers all seven windows. Whether a drop actually navigates is the MAC half. | M | S | CI + MAC | **STC-466** | Refuse navigation, window.open and permission requests for every WebContents from one web-contents-created handler in main |
| 9 | Export write guard | `export:write` refuses `TAKE_FILES` and `"take.json"` only (`main.ts:1888`). It misses STC-413's `CAPTURE_DOC_FILE = "capture.json"` (`transform/src/capture-doc.ts:18`) and `THUMBNAIL_FILE` (`library-items.ts:253`). A `.json` name is written straight into the bundle (`main.ts:1892-1895`). So `writeExport("capture.json", …)` from a buggy or compromised editor replaces the bundle id that `export:write`, `share:publish` and the orphan sweep all rely on (step-2 D3, step-4 #2). | M | S | CI | none found (no Linear access this pass) | export:write: refuse capture.json and thumb.png, from one exported "files a bundle owns" set |
| 10 | Documents from the renderer | `preview:writeProject` (`main.ts:1840-1860`) `JSON.parse`s the renderer's bytes and checks only `isProjectVersion` (`project-version.ts:32`). It then writes the ORIGINAL bytes verbatim, with no `parseProject`/`projectForWrite`. `still:writeShot` (`main.ts:2427-2454`) parses before writing; this handler does not (step-1 §2). | M | S | CI | none found (no Linear access this pass) | preview:writeProject: parse and re-serialise through projectForWrite in main, refusing what parseProject refuses |
| 11 | Record flow, permissions | Without a Screen Recording grant, `listWindows()` answers `no-displays` (`Still.swift:361-363`). The app swallows that, with a comment stating why (`main.ts:952-957`, `:1298-1305`), then opens the overlay and counts down toward a `start` that must refuse (`main.ts:1092-1100`). This is STC-433's "don't count down to a refusal" (`main.ts:1015-1018`) left unapplied to the commonest refusal (step-5 #1). | M | S | CI | none found (no Linear access this pass) | Treat no-displays from the pre-overlay window listing as the refusal, before opening the overlay or countdown |
| 12 | Permission copy | Both grant refusals assume the entry is MISSING (`renderer.ts:526-528`, `:566-574`). The Input Monitoring one says to "tick the recorder" (`renderer.ts:573`), but the pane lists **Electron**. After an Electron update the entry is present but stale (ad-hoc signing, CORRECTNESS-TRAPS 798-800), and neither message covers that. There is no "Open Privacy settings" action (steps 5 #1 and #2). | M | S | CI | none found (no Linear access this pass) | Permission refusal copy: name the real entry, cover "already ticked" (remove and re-add), add an Open Privacy Settings action. Re-measure toast size in warnings.e2e |
| 13 | Settings drift | The Settings sheet's "Source" control (`index.html:451`, `renderer.ts:163-212`) writes `displayId`, and nothing in main reads it. Record takes the display from the overlay (`main.ts:1007`), and a still from the pointer (`main.ts:1338`). `display-picker.e2e.test.ts:89-106` says so outright. `settings.ts:36-44` and `renderer.ts:153-162` still describe the old behaviour. A user can pick a display and get another (step-2 D2). | M | S | CI | none found (no Linear access this pass). The test calls it "unscoped follow-up work for STC-388" | Remove the dead display Source control and Settings.displayId, or wire it into runRecordFlow (product decision for Patrick) |
| 14 | Second instance | There is no `requestSingleInstanceLock`. A second `electron .` while the invisible menu-bar-only first instance is alive (CORRECTNESS-TRAPS 182-190) yields a second tray icon and a second helper. Its Record fails `stream-failed` with no `START_FAULTS` entry, so the raw "Could not start: stream-failed / … Code=-3805" appears (`renderer.ts:589`). That error "reads like a permission or entitlement problem and is not one" (step-5 R3). | M | S | CI | none found (no Linear access this pass) | Add a single-instance lock whose second-instance handler opens the library, plus a stream-failed message |
| 15 | Helper cannot start | "The recorder keeps failing to start. Restart the app." (`renderer.ts:733`, `:1240-1243`) is shown for a missing or blocked helper, and a restart fixes neither. The supervisor already carries the helper's stderr in `gave-up` (`supervisor.ts:256-259`), and the renderer ignores it. The `status()` path carries no stderr at all (step-5 R2). | M | S | CI | none found (no Linear access this pass) | Show the helper's last stderr line when it gives up, and include it in status() |
| 16 | Second display | It is unverified that Electron's `Display.id` equals the helper's `CGDirectDisplayID` (`main.ts:1312-1315`; STC-290 runbook §3). If it does not, a take on display 2 hits STC-433's "no longer connected" for a connected display (`main.ts:1035-1036`). "Use Automatic" then records whichever display `SCShareableContent` lists first (`CaptureDecisions.swift:316-322`). STC-382 records that nobody has run this on two displays (step-5 R6). | M | S | MAC | none found (no Linear access this pass). Related runbooks: STC-247, STC-290 | Run the two-display paths on hardware (STC-247 runbook, multi-display.grant.test.ts) and record whether Display.id matches CGDirectDisplayID |
| 17 | Still export drift | The still editor's copy of "composite, then export" has drifted from the panel's (step-2 D1). It renders from the unscaled `layout` (`still-editor-renderer.ts:95-99`) but sends the composite's size and pixels (`:255-256`). So a stored `1x` scale on a retina capture saves 2x, while the panel saves 1x. Its context has no `colorSpace` (`:99`), so it reads sRGB values. The request still declares `shot.display.colorSpace` (`:257`), and main maps that to `display-p3` (`main.ts:2021`): a P3 profile embedded over sRGB numbers, oversaturated on every P3 panel. The panel does both right (`thumbnail-renderer.ts:192-200`). | M | M | CI + MAC | none found (no Linear access this pass) | One shared still composite-and-request helper used by the panel, the still editor and the library thumbnail |
| 18 | Quit during export | `runExport` (`editor.ts:1994-2046`) encodes entirely in the editor renderer and writes once at the end (`:2020-2021`). `before-quit`'s unsaved count (`main.ts:696-778`, via `unsavedTakeDirs()`) knows nothing of it. Cmd-Q or closing the editor mid-encode discards minutes of work with no warning. The take itself is unaffected (step-3 §2). | M | M | CI | none found (no Linear access this pass) | Warn before quitting or closing the editor while an export is in progress |
| 19 | Editor renderer crash | There is no `render-process-gone` or `unresponsive` handler in `app/src` (grep). Preview holds the whole video in renderer memory, and ~15 min of 4K is the practical ceiling (CORRECTNESS-TRAPS 138-140). An OOM editor goes white with no message, and an in-flight export vanishes (step-5 R8). | M | M | CI | none found (no Linear access this pass) | Handle render-process-gone on the editor window with a dialog that names the likely cause and offers to reopen |
| 20 | Logging | Every main-process diagnostic is `console.*`. There is no `electron-log`, no log-file writer and no `app.getPath("logs")` (grep). A Finder-launched app's `[quit]`, `[recovery]`, `[record]` and `[orphan-sweep]` lines go nowhere a user can find or attach. `showDiagnostics` is live state only, with no history (step-3 §5). Every silent path above (#1, #3, #6) ends in this. | M | M | CI | none found (no Linear access this pass) | Write main-process logs to a rotating file under app.getPath("logs") and add a Reveal Log File menu item |
| 21 | Permissions preflight | Nothing checks either grant before a capture: zero `systemPreferences`, `CGPreflight*` or `x-apple.systempreferences` in `app/src` or `helper/src`. So the two grants a take needs are discovered one failed take at a time, each after the overlay and a countdown, with a relaunch after each (step-5 #1). | M | M | CI + MAC | none found (no Linear access this pass) | Add a helper permissions verb (CGPreflightScreenCaptureAccess / CGPreflightListenEventAccess) and check it before the overlay, requesting both grants together |
| 22 | Stale grants | The app keeps no record of which binary last recorded successfully, so it cannot tell "never granted" from "granted to a previous Electron". `settings.ts` has no such field (step-5 #2). | M | M | CI + MAC | none found (no Linear access this pass) | Persist the Electron version (or CDHash) on each successful start and show stale-grant wording when it changes |
| 23 | Quit during duplicate | `duplicateTake` copies file by file into a claimed directory under the visible `raw/` root (`takes.ts:228-247`). Nothing at quit tracks it; `duplicating` (`takes.ts:205`) only prevents name races. A partial bundle with a plausible `capture.json` escapes both STC-393's recovery (temp root only) and `sweepOrphanedBundles` (`temp-takes.ts:287-351`) (step-3 §2). | M | M | CI | none found (no Linear access this pass) | Make duplicateTake atomic: copy to a temp sibling and rename, or drain in-flight duplicates in runQuitTeardown |
| 24 | Packaging / TCC identity | There is no bundle. The helper is found by a repo-relative path (`main.ts:74-75`) that cannot resolve inside one. The dev Electron is ad-hoc signed, so every grant is keyed to a binary hash that an Electron bump or reinstall changes. This is the root cause of #12 and #22, and of every prompt naming "Electron" (step-5 #2, R2). | M | L | MAC | none found (no Linear access this pass). The kit names STC-401 as the open packaging ticket; confirm it covers this before filing | Package as a Developer ID–signed, notarised bundle with a stable identifier, resolving the helper from process.resourcesPath |
| 25 | CSP | `app/renderer/overlay.html` is the only one of the seven renderer pages with no `Content-Security-Policy` meta tag, and it loads `../dist/overlay.js` (`overlay.html:131`). The bridge behind it is the narrowest in the app (`send`/`onState`). No test checks any page's CSP (step-1 §4, step-4 #3). | L | S | CI | **STC-467** | Add the countdown/toast CSP to overlay.html, plus a test requiring a CSP meta tag on every app/renderer/*.html |
| 26 | Preload breadth | Three bridge members are uncalled by their own window (step-2 D4, which corrects step-1 §5):<br>• main-window `recorder.takes` (`preload.ts:13`, handler `main.ts:1580-1581`)<br>• main-window `recorder.exportStill` (`preload.ts:38-43`), a disk-writing, helper-calling channel<br>• `thumb.reveal` (`thumbnail-preload.ts:19`), which exists only to read `lastStillFile` (`main.ts:162`, `:2369-2374`) | L | S | CI | none found (no Linear access this pass) | Remove unused preload members (recorder.takes, recorder.exportStill, thumb.reveal) and their handlers, plus a seam test that every preload key has a caller |
| 27 | Confinement predicate | `insideTempTakesRoot` (`temp-takes.ts:93-98`) is `insideTakesRoot`'s body (`takes.ts:22-27`) with the root swapped. `takes.ts`'s header records the prefix-test bug being found "in five places"; a future fix (e.g. symlinks) would reach one root only (step-2 D10, step-4 #5). | L | S | CI | none found (no Linear access this pass) | Extract one insideRoot(root, dir) and reduce both confinement predicates to it |
| 28 | Dead code | Several exports have no importer (step-2 D21):<br>• `editorIsOpen`/`closeEditor` (`editor-window.ts:76,80`)<br>• `stillEditorIsOpen`/`closeStillEditor` (`still-editor-window.ts:63,67`)<br>• `thumbnailIsOpen`/`thumbnailCount` (`thumbnail-window.ts:429,432`)<br>• `displayContaining` (`selection.ts:395`)<br>The unused parameters are `still:writeShot`'s `mode` (`main.ts:2427`) and `export:write`'s `png` (`main.ts:1882`). `QuitChoice` (`quit-guard.ts:40`) is unused, and `main.ts:751-763` decodes the quit dialog by button INDEX, so reordering the labels would swap Save All and Quit Anyway. | L | S | CI | none found (no Linear access this pass) | Delete unused window-module exports and parameters; decode the quit dialog through QuitChoice, not button indices |
| 29 | Dead code | `PILL_THEME` (`pill.ts:157-163`) has no importer. The CSS values at `index.html:320,327,337,348` claim to match it, and nothing checks that (D12). The `renderer.ts:879-884` duration and size formatters are dead, and the size one disagrees with the live `fmtBytes`: 1.5 MB shows as "2 MB" (D16). | L | S | CI | none found (no Linear access this pass) | Delete PILL_THEME and renderer.ts's dead formatters (or pin PILL_THEME to the CSS with a test) |
| 30 | Duplicated constant | `editor.ts:188` `MIN_TICK_SPACING_PX = 6` redeclares `scrubber.ts:114` `MIN_TICK_PX`, with a second ladder search (`editor.ts:185,227` vs `scrubber.ts:389-401`). `editor.ts`'s header says it inherits `scrubber.ts` verbatim (D14). | L | S | CI | none found (no Linear access this pass) | editor.ts: import MIN_TICK_PX and tickStrideFrames from scrubber.ts |
| 31 | Duplicated constant | The 20 px corner margin is defined three times: `thumbnail-window.ts:74`, plus the defaults at `thumbnail.ts:327,508`. `toast-window.ts:85` relies on the default, so changing `CORNER_MARGIN` leaves the toast behind (D15). | L | S | CI | none found (no Linear access this pass) | Export one CORNER_MARGIN from thumbnail.ts and use it everywhere |
| 32 | Duplicated list | The anchors versions are listed in `library-items.ts:250` and chained again in `session.ts:138-141`. They are held together by a source-regex test (`take-list.test.ts:70-114`) behind a "cannot share a constant" claim, the same claim STC-318 disproved for project versions (D8). | L | S | CI | none found (no Linear access this pass) | Add transform/src/anchors-version.ts on project-version.ts's pattern and delete the source-regex test |
| 33 | Duplicated rules | `readSettings` (`settings.ts:367-385`) and `writeSettings` (`:408-430`) each spell every field's cleaning rule. They agree today; the type forces presence, not sameness (D17). | L | S | CI | none found (no Linear access this pass) | One cleanSettings() used by both readSettings and writeSettings |
| 34 | Duplicated validation | `PanelTake` is validated in two places with different strictness. `thumbnail-renderer.ts:114-123` checks `kind`/`origin` literals. `main.ts:2113` (`thumbnail:menu`) only defaults, so `{kind:"bogus"}` reaches `buildThumbMenu` (D18). | L | S | CI | none found (no Linear access this pass) | Add parsePanelTake() in panel-actions.ts and use it on both sides |
| 35 | CSS drift | `CARD_CHROME = {40, 100}` (`thumbnail-renderer.ts:143-159`) still counts a removed style row. Its horizontal parts now sum to 36 px (`thumbnail.html:21,56`), not 40, so a few pixels of letterbox appear (D19). | L | S | CI | none found (no Linear access this pass) | Measure #thumbwrap's content box instead of the CARD_CHROME constant |
| 36 | Coordinate spaces | `overlay.ts:77-80` hand-writes `spaces.ts`'s `toDisplayLocal`/`rectToDisplayLocal` (`spaces.ts:295-303`). `spaces-seam.test.ts` scans only `transform/src/`, so it cannot catch this (D20). | L | S | CI | none found (no Linear access this pass) | overlay.ts: use spaces.ts's display-local conversions and extend the seam grep to it |
| 37 | Duplicated literals | `<title>Capture</title>` in `index.html:6`/`editor.html:6` restates `PRODUCT_NAME` (`product.ts:30`), and it is the copy users see. Panel action names appear in both `thumbnail-menu.ts:68-73` and `thumbnail.html:132-135` (D22). | L | S | CI | none found (no Linear access this pass) | Pin HTML titles and panel button labels to their TS owners with a test |
| 38 | Docs drift | Thirteen CLAUDE.md rows no longer describe their files (step-2 §5 table):<br>• the editor's Zoom lane "read-only"<br>• "Geist Mono"<br>• "keeps only `--clip`/`--zoom`"<br>• the `thumbnail.ts`/`thumbnail-window.ts` timers and "drains oldest-first"<br>• "expanded mode picker, redact"<br>• "26 px stack step"<br>• the `pill.ts` "no audio capture"<br>• the `countdown.ts` "NO control"<br>• the countdown "bottom centre"<br>• `still-io.ts` "only thing that writes an image"<br>• the STC-374 sticky display<br>• `selection.ts` listed twice | L | S | CI | none found (no Linear access this pass) | Correct the drifted CLAUDE.md rows listed in step-2 §5 |
| 39 | Comment drift | Code comments that are now false (step-2 §5):<br>• `main.ts:1954` and `settings.ts:399` cite a destination STC-412 removed<br>• `still-editor-preload.ts:10`<br>• `still-editor-renderer.ts:8,60`<br>• `main.ts:931` ("Off … a shipped option" vs `countdown.ts:74-77`)<br>• `preload.ts:38-42`<br>• the doubled `/**` at `settings.ts:62-63` | L | S | CI | none found (no Linear access this pass) | Fix the stale code comments listed in step-2 §5 |
| 40 | Helper death copy | "The recorder quit while recording — that take was not saved.\n<dir>" (`renderer.ts:669-672`) shows a temp path the user cannot act on. It drops the helper's last stderr line (`supervisor.ts:240-242`), and it says "not saved" when #1's fix could recover the pixels (step-5 R4). | L | S | CI | none found (no Linear access this pass) | Rewrite the recording-lost message: drop the temp path, say what is recoverable, include the helper's last stderr line |
| 41 | Refusal copy | Every start refusal outside the two grant codes and `capture-in-flight` falls through to "Could not start: <code>\n<detail>" (`renderer.ts:589`). That covers `start-timeout`, `writer-failed`, `frame-status-mismatch`, `window-not-found` and `crop-outside-display` (`Capture.swift:1471-1507`) (step-5 R5). | L | S | CI | none found (no Linear access this pass) | Give every helper start refusal code a START_FAULTS entry, with a test reading the codes out of Capture.swift |
| 42 | Display unplugged mid-countdown | STC-433's display re-check runs once, before the countdown (`main.ts:1015-1058`). A display removed DURING it falls through to the helper's `display-not-found` at `start` (`main.ts:1092-1100`). That path is caught and legible, but only after a full countdown (step-3 §4). | L | S | MAC | none found (no Linear access this pass) | Re-validate the chosen display after the countdown, before start, and check on hardware how the refusal reads |
| 43 | TCC revoked mid-take | Open question, not a finding: it is not known whether revoking Screen Recording, Input Monitoring, Mic or Camera mid-take produces a signal distinguishable from a stall or an unplug. The app forwards whatever the helper sends (`main.ts:295-325`) (step-3 §4). | L | S | MAC | none found (no Linear access this pass) | Investigate on hardware what a mid-take TCC revoke produces, per grant |
| 44 | Capture ceiling copy | A display above 3840×2160 is silently downscaled (`CaptureGeometry.swift:19-33`; the cap itself is settled). Nothing tells the user the take was captured at, e.g., 64% of native (step-5 R7). | L | M | MAC | none found (no Linear access this pass) | Show capture size against display size in the export dialog, beside the legibility sentence |
| 45 | Restated types | `Settings` is restated in four renderers (`renderer.ts:11-45`, `editor.ts:11-24`, `thumbnail-renderer.ts:59`, `still-editor-renderer.ts:37`). `editor.ts:13` still has `still.destination`, which STC-412 removed (D5). | L | M | CI | none found (no Linear access this pass) | Split a pure settings-types.ts that the renderers import type-only |
| 46 | Restated types | IPC event and payload unions live in Electron-side modules, so renderers restate them or send untyped (D6):<br>• `ThumbEvent` is copied at `thumbnail-renderer.ts:85`<br>• `OverlayEvent` is sent as `unknown` (`overlay.ts:82`)<br>• `overlay:state` and `countdown:state` are sent as untyped literals (`overlay-session.ts:466-481`, `countdown-window.ts:230-233`)<br>This is the STC-343 defect, moved to the renderer side. | L | M | CI | none found (no Linear access this pass) | Move ThumbEvent, OverlayEvent, OverlayPayload and StatePayload into their pure decision modules and type both ends |
| 47 | Restated types | More wire shapes are restated (D7):<br>• `StillResult` is copied at `renderer.ts:51-55`, with `any`<br>• the helper `devices` reply has three narrowings (`renderer.ts:2-10`, `main.ts:1027-1028`, `:1137-1145`)<br>• two different `DisplayInfo`s share a name (`renderer.ts:2` vs `selection.ts:125`)<br>• the `still:export` request is written three times, with two `CompositedStill` builders (`main.ts:2016-2022`, `:2149-2152`) | L | M | CI | none found (no Linear access this pass) | Give StillResult, the helper devices reply and the still:export request one owner each, and rename the helper's DisplayInfo |
| 48 | Bundle filenames | `shot.json` is read and parsed in 7 places (`main.ts:432,1528,1554,1575,2352,2432`, `library.ts:795`). The bundle-kind rule is restated in `temp-takes.ts:382-383` against `library.ts:526,700`. `take.json` is spelled three times (D9). | L | M | CI | none found (no Linear access this pass) | Add bundle filename constants and bundleKind() beside THUMBNAIL_FILE, and one readShotAt() in main |
| 49 | Colour tokens | `editor.html:24-52` restates `tokens.css`'s whole dark block, which `tokens.css:7-9` forbids. `toast.html:109` and `countdown.html:39,57` hard-code the accent; `overlay.html:106,108` use uncommented system colours (D11). | L | M | CI | none found (no Linear access this pass) | Expose tokens.css's dark palette under an opt-in selector and have the dark-always windows use it |
| 50 | Panel window recipe | The panel `BrowserWindow` options are written four times: `overlay-session.ts:386-412`, `countdown-window.ts:153-182`, `thumbnail-window.ts:516-535` and `toast-window.ts:86-103`. `panel-focus.ts` owns only `type`, so any new hardening flag is four edits (D13). | L | M | CI | none found (no Linear access this pass) | Add panelWindowOptions() and raisePanel() to panel-focus.ts and build all four panels from them |

---

## Calibration

The kit (`docs/ELECTRON-REVIEW-KIT.md` §Calibration) says steps 1 and 3
should re-find all three pre-filed tickets on their own. **They did, all
three**:

- **STC-466 (navigation, window-open and permission guards): re-found by
  step 1, §3.** Its grep names all four APIs, including
  `setPermissionRequestHandler`, and reports zero matches across every
  window. It rates the absence Medium. The analysis dwells on
  `will-navigate` and calls the `setWindowOpenHandler` half "close to
  cosmetic" on Electron 43. It says nothing further about the permission
  handler beyond the grep. That is a thinner treatment than the ticket's
  title, but it is the same finding.
- **STC-467 (`overlay.html` has no CSP): re-found by step 1, §4.** The
  CSP table shows six pages with a policy and `overlay.html` with none. It
  rates it Low–Medium.
- **STC-468 (no `unhandledRejection`/`uncaughtException` handler in main):
  re-found by step 3, §1.** It confirms zero of either across `app/`,
  `transform/` and `scripts/`, and goes further than the ticket by tracing
  four fire-and-forget call sites (row 7).

Neither step 1 nor step 3 cited the ticket keys; they found the defects
independently. Step 4 did the matching. By the kit's own test, the prompts
are not too loose on these three.

Two qualifications, so the pass is not over-read:
- Step 1 was not error-free elsewhere. Its §5 said no preload carries an
  uncalled member, and step 2 (D4) found three, one of them a disk-writing
  channel on the main window (row 26).
- Steps 3 and 4 state that an unhandled rejection "crashes silently" on
  Node's default. That is not verified for Electron's main process
  (row 6), and the fix's test should establish it rather than assume it.

---

## Disagreements with settled decisions

Collected verbatim from every step file. Unranked. For Patrick to read, not
to act on. Steps 0 and 4 have no such section. Steps 1 and 3 recorded
"None".

**Step 1:**
> None. `lastStillFile`'s scope-widening refusal (`main.ts:152-161`),
> `export:write`'s identity-over-name destination resolution (STC-413), and
> the version-only gate on `preview:writeProject` (`project-version.ts`'s
> header) are all decisions this review either confirms hold in the code or,
> for the last one, treats as an adjacent gap rather than a rejection of the
> decision itself — the header settles *which version check*, not *whether
> the rest of the document needs validating*.

**Step 2:**
> - `pill.ts:127-137`'s hatched-only meter was settled on the premise that "no
>   audio capture exists anywhere in the helper". Mic (STC-233) and system audio
>   (STC-418) now exist, so the reason behind the decision no longer holds. It
>   may be worth asking again; it is not a finding here.

**Step 3:**
> None. Nothing in this pass contradicts a settled decision; every gap above is
> an absence next to code that is otherwise careful (`captureStill`'s own
> "never throws" invariant, `promoteTake`'s graceful degradation, the STC-433
> pre-countdown display check), not a disagreement with how any of that careful
> code was built.

**Step 5:**
> - `toast.ts:66-72` records that the message toast is NOT excluded from
>   capture and caps it at 20 s, so a mid-take `camera-no-frames` warning is
>   recorded into the take. Excluding the toast window the way the overlay
>   and countdown already are seems cheaper than timing it out.

**Two register rows touch a header-recorded decision.** Neither step filed
these under this heading, but Patrick should know:
- **Row 2 (temp purge).** `temp-takes.ts:183-190` settles two things:
  permanent deletion rather than the Trash, and "age alone is a safe
  filter". Step 5 R1 proposed switching to the Trash. The register row
  deliberately does not: it keeps `rm` and challenges only the "age alone"
  premise, which the promote-failed path falsifies.
- **Row 4 (free space).** It accepts STC-393's settled temp location on the
  boot volume, as step 5 did, and only asks the app to check that volume.

---

## Lead Engineer Summary

Here is what I would say at the start of the next sprint, in priority
order.

**First, stop losing takes quietly.** Three small, CI-testable fixes close
the paths where a recording exists on disk and the app throws it away or
never tells anyone:
- The 7-day temp purge deletes stranded recordings, even at launch before
  the recovery prompt (row 2).
- Crash recovery skips the "unknown" takes a helper crash leaves behind
  (row 1).
- Record refusals from the menu bar and the hotkey are silent, so a user
  can perform a whole demo into nothing (row 3).

**Second, a full disk.** It is the likeliest real-world way to lose a long
take, and today it announces itself as "no anchors.json — not a recording".
The app half is a day and testable here (row 4). The helper half needs a
Mac (row 5).

**Third, the cheap hardening, including all three calibration tickets.**
- STC-468 (row 6, plus the Record catch-all in row 7).
- STC-466, which is one `web-contents-created` handler, not seven edits
  (row 8).
- STC-467 (row 25).
- The `export:write` and `preview:writeProject` guards (rows 9 and 10).
Each is under an hour.

**Fourth, the first-run permission experience** (rows 11, 12, 21, 22).
Every new user hits it, and packaging (STC-401, row 24) fixes only the
name in the prompt, not the order, the silence or the two relaunches.

**Fifth, visibility for support.** Add a log file (row 20). It is the
thing that would have made every silent path above diagnosable after the
fact.

**The rest is drift,** rows 26–50. None is failing a user today, except
the still editor's P3/scale export (row 17). That one is the most visible
wrong output in the app, and it should ride along with the next still-path
ticket rather than wait.
