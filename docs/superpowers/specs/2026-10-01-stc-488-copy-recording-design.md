# STC-488 — copy a recording from the panel (design)

**Ticket:** STC-488, split out of STC-395 on 2026-10-01. Blocks STC-395 (GIF/Video).
**Builds on:** STC-487 (#262), which put recordings on the floating panel.
**Decided with Patrick, 2026-10-01:**
- STC-395 is split: video Copy here, GIF there.
- Copy renders **when pressed**, not in the background, and the result is kept for a second Copy.

## 1. The problem

A recording's panel has Save, Edit and Trash, and no Copy (`panel-actions.ts`'s
`actionsFor`). STC-392 makes "Copy, then Trash" the way you copy-and-done, so a
recording needs a Copy whose paste still works after the Trash.

STC-392's carried-over design said to copy the take as an APFS clone. That
can't work: a fresh take's only video is `display.mp4`, which has no cursor and
no zoom. The pointer exists only in a render. So Copy has to **render**, and a
rendered file is already independent of the take. `clonefile` has nothing to
do. What carries over from STC-392 unchanged: copies live in temp storage, and
they're purged after 24 h unless one is still on the clipboard (one pasteboard
check at purge time, no polling).

## 2. What a Copy produces

- **The MP4 the editor's Export makes for an untouched take:** the full
  duration, cursor and auto-zoom under `DEFAULT_ZOOM`, the default output size,
  and the default audio mix (`exportAudioPlan` with default levels; narration
  cleanup off). A panel only ever shows an unedited take, because Edit closes
  the panel, so there are no edits to apply. The project is the same default
  document the editor loads for a take with no `project.json`. It is built by
  the same function, not by a second one written here.
- **Where it goes:** `copiesRoot(env)`, which is
  `~/Library/Application Support/<PRODUCT_NAME>/copies/`, overridable with
  `STC_COPIES_DIR` the way `STC_TEMP_TAKES_DIR` overrides `tempTakesRoot`.
  It's a sibling of the temp-takes root and **never inside a take**, so Save
  (which moves the take) and Trash (which deletes it) can't touch a copy.
- **File name:** `<take leaf name>.mp4`, e.g. `2026-10-01 18.04.12.mp4`. That
  is what the person sees in Finder or Slack when they paste. There is no
  ` (2)` collision suffix: the leaf is unique within the temp root by
  construction, and a copy exists only for a take in that root (plan
  deviation 2). Main writes the finished bytes to `<name>.mp4.partial` and
  renames only on success, so a file without the suffix is always a complete
  MP4 (deviation 5).

## 3. Where the render runs

- **A hidden render window, one per copy job** (`app/src/copy-render-window.ts`
  + `app/renderer/copy-render.html` + `app/src/copy-render.ts`), not inside the
  panel. The panel stays small and responsive, and the render is unaffected by
  the panel restacking, being hidden for a capture (STC-487), or being re-laid
  out.
- **One export path, not two.** The editor's "load a session over IPC" code
  (`editor.ts`'s `ipcSource` and the `loadSession` call around it) and its
  "export to bytes" call are lifted into one shared renderer module,
  `app/src/session-io.ts`, which `editor.ts` and `copy-render.ts` both import.
  `exportSession` itself is unchanged. The non-negotiable is that sinks may not
  fork the transform, and a second hand-built copy of this loading code would
  be the start of a fork.
- **Access:** when main creates the render window, it records that window's
  `webContents` against the take directory in the same `openTakes` map
  `editor:open` uses. So the existing guarded `preview:read`/`preview:size`/
  `preview:chunk` handlers serve it unchanged, and the render window can never
  name a path. The render window's preload exposes only those three channels
  plus `copy:progress`, `copy:done` and `copy:failed`. The finished bytes go
  through a new `copy:write` handler. It accepts bytes only from a sender
  registered as a copy job, and writes only to that job's `.partial` path,
  which main chose. The renderer supplies no file name.
- **Progress and cancel:** `exportSession`'s existing `onProgress(done, total)`
  and `signal` options. Progress is throttled to at most 10 updates a second
  and forwarded by main to the panel that owns the job. Cancel
  destroys the render window rather than aborting a signal: `exportSession`
  returns its bytes only when it finishes, so destroying the window cancels at
  once and leaves nothing to clean up in the renderer, and no signal crosses
  IPC (deviation 1).
- **Capture identity (STC-413):** main resolves the take's capture id with the
  same `ensureCaptureId` the editor's `captureId` channel uses, and the render
  window passes it as `captureId`, so a pasted copy can be traced back to its
  take like any other export. If it can't be resolved, the copy proceeds
  without one, matching the editor's behaviour.
  `hash` is off: it's for the gates only and costs a pixel read-back per frame.

## 4. The panel during a Copy

- **Copy is available for a recording.** `actionsFor` adds `"copy"` for
  `kind: "recording"`. The module-doc paragraph explaining why a recording had
  no Copy is replaced with one explaining why it renders. `closesPanel("copy")`
  stays false and `promotes("copy")` stays false. The button, ⌘C and the
  right-click menu all use `actionsFor`, so all three get it.
- **While rendering:** the card shows "Rendering… 42%" and a progress bar.
  Save and Edit are disabled, using the same `busy`/`setActionsEnabled(false)`
  pattern a still's export already uses, so the take can't be moved into the
  library while the render is reading it. Copy is disabled too, so a second
  press can't start a second job.
- **Trash stays enabled and cancels the render.** Main destroys the render
  window, deletes the `.partial`, and then runs the normal fresh-take Trash with its undo
  toast. A panel that waits must always have a way out. Escape and the
  panel's own dismiss also cancel.
- **On success:** main calls the helper's `copy-file` with the finished path.
  The card shows "Copied, paste anywhere", every button is enabled again, and
  the panel stays open.
- **A second Copy:** if this take's finished copy still exists in
  `copiesRoot`, Copy skips the render and goes straight to `copy-file`. A
  copy the purge deleted is simply rendered again.
- **On failure** (a decode error, an encode error, a helper refusal): the card
  shows a one-line reason, every button is enabled again, the `.partial` is
  deleted, and the take is untouched. Nothing retries on its own.
- **Quit during a render:** the job is cancelled and its `.partial` deleted,
  as part of `runQuitTeardown`. The existing unsaved-takes warning already
  counts the take, because its panel is open.
- **The render window dies** (`render-process-gone`): it's treated as a
  failure, with the `.partial` deleted and the panel told.

## 5. The clipboard and the purge

- **`copy-file`, a new helper command:** `{ path }` → `NSPasteboard.general`
  `clearContents()` then `writeObjects([NSURL(fileURLWithPath:)])`, replying
  with `{ changeCount }`. AppKit's own file-reference path is what Finder,
  Slack, Mail and Messages read. Electron's raw clipboard formats are not a
  reliable equivalent. Its pure half (request parsing: a non-empty absolute
  path to an existing regular file, else a refusal with a reason) sits beside
  the still path's decisions and is unit-tested without a pasteboard, like
  `StillEncodeDecisions.swift`.
- **`pasteboard-files`, a second command:** returns the file URLs currently on
  the general pasteboard, read-only. The purge is its only caller.
- **The purge** has its own hourly timer (`COPY_PURGE_INTERVAL_MS`), first
  run 60 s after launch (`COPY_PURGE_FIRST_DELAY_MS`). The existing
  `TEMP_PURGE_INTERVAL_MS` is 12 h, which would let a "24 h" copy live 36 h,
  and the delay keeps the helper request out of startup (deviation 4). It lists
  `copiesRoot`, asks the helper `pasteboard-files` once, and deletes every
  entry older than `COPY_MAX_AGE_MS` (24 h, by mtime) that isn't on the
  clipboard. Leftover `.partial` files older than one hour are deleted too:
  they can only be what a crash left behind. These are regenerable renders,
  not anyone's work, so they're removed with `rm`, not sent to the Trash.
  If the helper can't be asked (not running, or a timeout), the purge
  **skips this round** rather than deleting a file that might be on the
  clipboard.
- **`app/src/recording-copy.ts`** (pure, Electron-free, node-only) owns
  `copiesRoot`, `copyFileName(takeDir, existing)`, `COPY_MAX_AGE_MS`,
  `copyFor(takeDir, entries)` (the cache lookup) and
  `purgeDecision(entries, now, onClipboard)`. Main does the I/O, the same
  split `temp-takes.ts` and `sweepOrphanedBundles` already follow.

## 6. Testing

**Unit (CI):**
- `recording-copy.test.ts`:
  - file naming and the collision suffix;
  - the cache hit and miss;
  - `purgeDecision`: old deleted, young kept, the clipboard file kept however
    old, a stale `.partial` deleted, a fresh `.partial` kept, and no deletion
    at all when `onClipboard` is unknown.
- `panel-actions.test.ts`: a recording's actions are Copy, Save, Edit, Trash;
  Copy neither closes nor promotes. The existing "a recording has no Copy"
  assertion is replaced, not deleted silently.
- `thumbnail-menu.test.ts`: the recording menu now offers Copy.
- `helper/test/copy-file/`: the request decisions, without a pasteboard.

**Pasteboard round trip (`helper/test/copy-file.grant.test.ts`):** `copy-file`
on a real file, then `pasteboard-files` returns that URL. It is a grant-suite
test, not CI: `NSPasteboard.general` needs a real logged-in session, which
this repo already decided keeps such tests out of `npm test`
(`still-clipboard.grant.test.ts`'s header). The pure request decisions still
run on CI (deviation 3).

**E2E against the fake helper (`app/test/recording-copy.e2e.test.ts`):** real
WebCodecs H.264 already runs on the `macos-15` runner (`export.e2e.test.ts`,
`mic-level.e2e.test.ts`). Takes are started with `startRecordFlow`, and
windows are counted with `_windows.ts`.
1. Stop → Copy → progress appears → the fake helper receives `copy-file` with
   an MP4 path in `copiesRoot` that exists and contains `avc1` → the card says
   Copied → the panel is still open.
2. Copy, then Trash: the copy file still exists after the take is gone.
3. Trash during a render: the render window is gone, there's no `.partial`,
   and `copy-file` was never sent.
4. A second Copy sends `copy-file` again without rendering again (no new
   render window).
5. Save and Edit are disabled during a render and enabled afterwards.

**Hardware (`docs/STC-488-RUNBOOK.md`):** paste into Finder, Slack, Mail and
Messages; Copy → Trash → paste; render time for a real 1-minute 4K take; and
whether "Rendering…" on a small panel reads as progress or as a stall.

## 7. Out of scope

- The GIF/Video toggle, GIF encoding, GIF settings and the size warning: STC-395.
- Copying a recording from the library or the editor. The editor already has
  Export and Share.
- Rendering in the background before Copy is pressed (rejected, §1).
- Clipboard promises or lazy pasteboard data (rejected: a paste before the
  render finishes would block or fail in the app being pasted into).

## 8. What the build decided

The plan's five deviations (cancel by destroying the window, no ` (2)` suffix,
the pasteboard test in the grant suite, the purge's own timer, main writing
the file) are folded into §2, §3, §5 and §6 above. The build made six more
decisions:

- **Cancel waits.** Trash, dismiss and quit wait for any in-flight write and
  the cleanup before returning. Quit's wait is bounded by
  `COPY_CANCEL_AT_QUIT_MS` (5 s, `main.ts`), so a stuck cancel cannot hold the
  app open.
- **Load and process failures are failures.** A failed page load, a failed
  preload or a crashed render process settles the job as a failure, never as
  a hang.
- **A gone panel gets no pasteboard write.** `panel:copyRecording` re-checks
  that the panel still exists after the render, before `copy-file`.
- **Copy honours `busy`.** The renderer's `copyRecording` returns early when
  the panel is busy, so Cmd-C during an in-flight Save, Edit or Trash starts
  nothing.
- **A reused copy keeps its mtime.** The 24 h clock runs from the render, not
  from the last Copy.
- **STC-232's tripwire.** The `parseProject` check in
  `transform/test/trim.test.ts` accepts `loadTake` (`session-io.ts`) as an
  approved route, since it is the one shared loader.
