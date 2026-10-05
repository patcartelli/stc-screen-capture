# STC-395 — Copy for recordings: Test Checklist

## Automated Tests (CI/Local)

```bash
# Run all tests (must pass before merge)
npm test

# Run just the panel tests (includes recording panel)
npm test -- app/test/recording-panel.e2e.test.ts

# Run typecheck (required)
npm run typecheck
```

**Expected:** All tests pass. The e2e test verifies:
- Recording panel appears after helper stops cleanly
- Panel has Copy button in the actions list
- Copy action is callable (does not crash)
- Recording is not promoted after Copy (vs. Save/Edit which do promote)

## Manual Runbook (Mac Only)

**Start the app:**
```bash
git fetch origin accounts/stc-395-copy-recording
git checkout accounts/stc-395-copy-recording
npm ci
npm run app:start
```

**Then follow `docs/STC-395-RUNBOOK.md` sections 1-8**, testing on real Mac hardware:

### Quick smoke test (5 min)
1. **Record 10s, Stop** → Panel appears with Copy button
2. **Click Copy** → "Copied to clipboard" message shows
3. **Paste in Finder** → File URL appears, file plays in VLC or QuickTime
4. **Trash the panel** → Recording not in library, but pasted clone still plays

### Full test (15 min)
- Test all 8 sections in the runbook
- Verify Copy does not promote (stays in temp until Save/Edit)
- Verify multiple Copies create separate clones with different timestamps
- Verify clone survives Trash of original take

## Code Review Points

Before merging, check:

**thumbnail-preload.ts:**
- [ ] `copyRecording` method exposed in `window.thumb` interface
- [ ] Invokes `ipcRenderer.invoke("panel:copyRecording", dir)`
- [ ] Returns promise with `{ ok: boolean; detail?: string }`

**main.ts:**
- [ ] `panel:copyRecording` handler validates directory with `insideCaptureRoot`
- [ ] Uses `cp -c` (clonefile) via `execSync`, not regular `copyFileSync`
- [ ] Error handling catches both invalid dirs and clonefile failures
- [ ] File URL written to clipboard with `clipboard.write()`
- [ ] 24h cleanup scheduled (with note that it's simplified for v1)
- [ ] Returns `{ ok: true }` or `{ ok: false, detail: "..." }`

**thumbnail-renderer.ts:**
- [ ] Copy action branches on `take.kind`
- [ ] Shots: continue calling `runExport("copy")`
- [ ] Recordings: call `window.thumb.copyRecording(dir)`
- [ ] Status messages: "Copying…" → "Copied to clipboard" or error message
- [ ] Panel stays open after Copy (does not close)

**panel-actions.ts:**
- [ ] `actionsFor()` returns Copy for both shots and recordings
- [ ] `closesPanel("copy")` returns false (panel stays open)
- [ ] `promotes("copy")` returns false (does not move to library)
- [ ] Documentation explains clonefile mechanism for recordings

**TypeScript:**
- [ ] `Window.thumb.copyRecording` type signature matches implementation
- [ ] No type errors in `npm run typecheck`

## Browser Compatibility

**Not tested in this PR.** The clonefile (`cp -c`) approach is **macOS only**. On other platforms:
- Linux: `cp --reflink=auto` (some filesystems support copy-on-write)
- Windows: Not applicable (no APFS)

This PR is macOS-only. If porting to other platforms becomes a goal, that's a separate ticket.

## Cleanup Task (Post-Ship)

**Known limitation:** The 24h cleanup is simplified (setTimeout, not persisted). If this becomes a problem:
- File STC-XXX to persist cleanup tasks to a `.cleanup` file in the app's data directory
- Check tasks at app startup and apply pending cleanups
- At cleanup time, read clipboard to avoid deleting the current item

Current implementation is acceptable for v1 because:
- `/var/tmp/stc-recordings/` is a well-known temp location
- macOS clears `/var/tmp/` periodically anyway
- User can manually delete clones if needed

## Verification Checklist

Run through this before calling STC-395 done:

- [ ] `npm test` passes (all tests green)
- [ ] `npm run typecheck` passes (no type errors)
- [ ] `npm run app:start` builds and launches without errors
- [ ] Recorded 3+ takes with different scopes (Screen, Window, Area)
- [ ] Copy button visible on all recording panels
- [ ] Pasted file URL points to existing file in `/var/tmp/stc-recordings/`
- [ ] Pasted file plays correctly in VLC or QuickTime
- [ ] Copy does NOT promote take to library
- [ ] Save/Edit still promote (STC-487 behavior unchanged)
- [ ] Clone survives Trash of original take
- [ ] Multiple Copies create separate clones (different timestamps)
- [ ] No crashes during Copy operation
- [ ] "Copied to clipboard" message is visible and clears appropriately

## Known Limitations & Open Items

1. **24h cleanup is simplified** — see "Cleanup Task" above. Acceptable for v1.
2. **Right-click menu** — may not include Copy yet. Check with STC-296 for full menu integration.
3. **No progress indicator** — clonefile is fast, but if needed: file transfer, add `setStatus("Copied to clipboard")` with a brief delay visible to user.
4. **No verification of clipboard success** — assumes `clipboard.write()` succeeds. In practice, this is reliable on macOS.

## Questions for Patrick

- Is the 24h simplified cleanup acceptable for v1, or should it be persisted?
- Should Copy appear in the right-click context menu (STC-296 follow-up)?
- Is "Copied to clipboard" clear enough, or should it show the file path?

