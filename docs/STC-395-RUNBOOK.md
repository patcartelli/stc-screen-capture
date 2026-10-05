# STC-395 — Copy action for recordings via clonefile

**Run this from `accounts/stc-395-copy-recording`:**

```
git fetch origin accounts/stc-395-copy-recording
git checkout accounts/stc-395-copy-recording
npm ci
npm run app:start
```

**STC-395 is the Copy action for recordings.** STC-487 added the panel with Save/Edit/Trash; Copy was deferred to here. Unlike shots (which copy image data to clipboard), recordings use APFS clonefile (`cp -c`) to create a copy-on-write clone in temp storage, then put the clone's file URL on the clipboard. The clone survives deletion of the original take, so the paste still works after Trash.

## 1. Copy button is visible on recording panels

Record 5-10 s, Stop. The panel shows **Copy** as the first button (before Save/Edit/Trash).

- Click somewhere else to close the panel and re-open the library: the recording is not saved yet.
- Click Copy on the panel: status bar shows "Copying…" then "Copied to clipboard", then the panel stays open.
- Paste somewhere (Finder, a text editor, Chrome): a file URL appears, pointing to a temp file like `/var/tmp/stc-recordings/<dirname>-<timestamp>.mp4`.

**Judgement call:** does "Copied to clipboard" read as success, or does it need more feedback?

## 2. The clone is a real file, not a symlink

Paste the file URL from (§1) into Finder and press Return, or open it in VLC:

- The file plays and has audio (if the recording had audio).
- The file's size is small initially (copy-on-write: no data has been written yet).
- Play the file, then check its size again in Finder — it should be larger (APFS has written the diverged blocks).

**Verification:** clonefile is working if the file plays correctly and grows when read.

## 3. Copy multiple times, get multiple clones

1. Record, Stop, Copy, Paste → URL 1
2. Copy again from the panel, Paste → URL 2 (different timestamp)
3. Both URLs should work and point to different files in `/var/tmp/stc-recordings/`

**Verification:** each Copy produces a distinct clone with a unique timestamp.

## 4. The clone survives Trash of the original take

1. Record, Stop, Copy, Paste → URL (note it)
2. Trash the panel (click Trash, undo toast appears)
3. Let the undo toast expire, or click Trash in the library to confirm
4. Open Finder, paste the URL from step 1
5. The cloned file still exists and plays

**Verification:** clonefile survives deletion because it's a separate file, not a reference to the original.

## 5. Copy does not promote the take

1. Record, Stop, Copy (panel stays open, recording not in library yet)
2. Open the library in another window: the recording is **not** listed
3. Close the app (Quit Anyway if prompted)
4. Relaunch: the library **still does not** contain this recording (it's still in temp)
5. Click Review in the recovery prompt to bring the panel back, then Save to move it to the library

**Verification:** Copy is the only action that doesn't promote. The take stays in temp until Save or Edit.

## 6. Edit and Save still promote (STC-487 behavior verified)

1. Record, Stop, click Edit: editor opens and the recording **is promoted** to the library
2. Quit the editor (close the window), check the library: the recording is there
3. Record, Stop, click Save: the panel closes and the recording **is promoted** to the library

**Verification:** Copy's non-promotion is intentional; Edit and Save are unchanged.

## 7. Copy appears in the right-click menu (if implemented)

1. Record, Stop, right-click the panel: a context menu appears with Copy, Save, Edit, Trash
2. Click Copy: same behavior as the button

**Note:** STC-395 PR only adds the button action. Menu wiring (STC-296's right-click menu) is a separate concern and may not be included in this PR.

## 8. Cleanup timing (simplified for v1)

**This is a known simplification.** The 24h cleanup is scheduled via `setTimeout` and will only run if the app stays open for 24 hours. In production, cleanup tasks would be persisted to disk and checked at app startup. For v1 testing, this is acceptable: the temp files are in `/var/tmp`, which is cleaned by the OS eventually.

To verify cleanup is scheduled (no user-facing test):
- Check app logs or add a breakpoint in `main.ts`'s `panel:copyRecording` handler at the setTimeout line
- Verify the cleanup function has `clipboard.readText()` to check if the file is still the current clipboard item before deleting

**Judgement call:** is the non-persistent cleanup acceptable for v1, or does it need to be addressed before shipping?

## Failure scenarios (what should NOT happen)

- [ ] Copy button does not appear → check `panel-actions.ts` `actionsFor()` function
- [ ] Clicking Copy crashes → check `main.ts` error handling, verify `cp -c` works on this Mac
- [ ] Pasted URL is not a file URL → check `clipboard.write()` call in `main.ts`
- [ ] Clone is a copy, not copy-on-write → verify `cp -c` uses clonefile (check with `xattr -l` or file size during playback)
- [ ] Clone is deleted immediately → check 24h timeout, or verify cleanup logic doesn't run early
- [ ] Take is promoted to library after Copy → check `promotes("copy")` in `panel-actions.ts` returns false

