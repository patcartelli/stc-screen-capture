# STC-393 — unsaved takes, on a Mac

Written and VERIFIED in a real macOS sandbox (arm64, swiftc 6.4, a real Electron
under Playwright — not the usual Linux-authored situation this repo's other
runbooks describe) — so most of this has already run, including the full
`npm test` suite (unit + e2e, 118 files) and a dedicated
`app/test/crash-recovery.e2e.test.ts` exercising every branch of
`recoverUnsavedTakes` against a stand-in helper. What is left is the two things
no stand-in can produce: a REAL crash and the native dialog's actual look.

```
npm test                                          # everything not needing a grant
npx vitest run --project e2e app/test/crash-recovery.e2e.test.ts
```

## §1 — a real crash mid-recording

1. Start a recording from the app (`npm run app:start`).
2. While it is running, force-kill the HELPER process directly
   (`kill -9 $(pgrep stc-helper)`) — not the app. This reproduces
   `recording-lost` (the helper died, the take is gone) rather than a clean
   stop, which is the one path `promoteTake` deliberately never runs.
3. Confirm: the take directory sits under
   `~/Library/Application Support/stc-screen-recorder/temp-takes/`, NOT in
   `~/Desktop/stc`. `display.mp4` will have no `moov` atom (expected — this is
   exactly the STC-394 gap the ticket's own "Related" line names).
4. Quit the app (⌘Q) and relaunch it. **Expected:** a dialog reading "1 unsaved
   take recovered" with Review / Discard all. Discard all should remove the
   temp directory. Review should promote it to `~/Desktop/stc` and bring the
   library to the front — check the take actually appears in the grid (it may
   not preview correctly, since the mp4 is genuinely broken; that is expected
   and is what STC-394 exists to fix, not this ticket).

## §2 — a real crash mid-still (panel open, app force-quit)

1. Take a screenshot (⌃⌥⇧⌘1 or the Capture Still button) and leave the
   floating panel open — do not click anything.
2. Force-quit the app from Activity Monitor (not ⌘Q, which drains the panel
   cleanly via `closeThumbnail()` — the point is to skip that).
3. Relaunch. **Expected:** the same recovery dialog, "1 unsaved take
   recovered". Review should reopen the panel exactly as it looked before the
   crash — same picture, same redactions if any were drawn — with the normal
   Save/Copy/Discard/timeout behaviour working from there.

## §3 — the dialog itself

Nothing here can render a native macOS alert — `dialog.showMessageBox` was
stubbed for every automated test. Look at whether "N unsaved takes recovered"
reads as expected with N > 1 (several stale panels from one bad session), and
whether Review bringing back multiple panels at once (stacked, newest at the
corner — §1's scenario doesn't exercise this; run §2 twice before relaunching)
feels like a flood or a reasonable recovery.

## §4 — the 7-day purge, for real

Not practically testable by waiting — `purgeStaleTempTakes` reads the
directory's OWN timestamp name, not mtime, so the fastest real check is: seed
a fake old directory by hand (`mkdir` one named `2020-01-01_00-00-00` under
the temp root) and relaunch. It should vanish silently, with no dialog (this
IS covered by `crash-recovery.e2e.test.ts`'s "purged silently" case, so this
step is optional — mentioned for completeness, not because it is unverified).

## What is deliberately not here

- **Nothing about STC-392's panel model.** Save/Copy/Trash as three distinct
  actions with the panel staying open on Copy don't exist yet — this ticket's
  promote logic is built against TODAY's panel (settle = save or copy, both
  keep the file; only an explicit discard does not). When STC-392 lands, its
  "Copy stays open, does not save" model will need this file's promotion
  hooks revisited — see `app/src/main.ts`'s `still:export` handler comment.
- **Nothing about the editor's own Save.** There is no explicit take-level
  Save action in the editor today (`editor.ts` only has "Save frame", an
  unrelated per-frame PNG export) — every take the editor can open is already
  in the library by construction (`editor:open` only reads library paths), so
  the "or on the editor's Save" clause in the ticket's requirement 1 is moot
  under the current UI and needs no code here. Revisit if the editor becomes
  reachable from an unsaved (temp) take.
