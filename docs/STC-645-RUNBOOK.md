# STC-645 runbook — shortcut defaults follow macOS

Run from `accounts/stc-645-shortcut-defaults-follow-the-macos` (not on `master` yet). Passed on the Mac 2026-11-12 (all checks). Unit tests pass;
the e2e edits run on CI only.

What changed: defaults are ⇧⌘4 area, ⇧⌘2 window, ⇧⌘3 full display, ⇧⌘5 record, ⇧⌘7 self-timer. ⌃ adds the
clipboard outcome (⌃⇧⌘N), as in macOS. STC-582's ⌘⌥1–5 row is offered the reset once, including to anyone who
already answered STC-582's dialog (`shortcutsOffered` is now a generation number; an old `true` reads as 1).

Build: `npm run app:start`. To seed a file, quit Capture, edit `settings.json` in the app's folder under
`~/Library/Application Support/` (`ls ~/Library/Application\ Support | grep -i -e capture -e stc` finds it),
relaunch.

## 1. Fresh install, macOS shortcuts OFF (the acceptance)
- [ ] The path is right: System Settings › Keyboard › Keyboard Shortcuts… › Screenshots. Turn all of them off. If the path differs on macOS 27, note the real one (the pane's note quotes it).
- [ ] Delete `settings.json`, launch. Shortcuts pane: five rows show ⇧⌘4, ⇧⌘2, ⇧⌘3, ⇧⌘5, ⇧⌘7, none warns.
- [ ] Each shot row's Clipboard line shows ⌃⇧⌘N and no warning.
- [ ] Press each of the nine keys (five bases, four ⌃ variants). Each fires Capture; the ⌃ ones copy with no panel.

## 2. macOS shortcuts still ON
- [ ] Turn the system ones back on, relaunch. The rows macOS holds say "Something else on this Mac already holds this shortcut." Nothing crashes.
- [ ] ⇧⌘2 and ⇧⌘7 still register (macOS has no screenshot action on them).

## 3. The reset dialog
Seed `"shortcuts"` with the ⌘⌥ row: `"region":"Alt+Command+1","window":"Alt+Command+2","display":"Alt+Command+3","record":"Alt+Command+4","self-timer":"Alt+Command+5"`.
- [ ] With `"shortcutsOffered": true` (you answered STC-582's dialog): the dialog still appears, once, and says the defaults "now follow macOS's own screenshot keys".
- [ ] "Keep mine": ⌘⌥ keys stay and work. Relaunch: no dialog.
- [ ] Seed again, "Reset to new defaults": keys move to ⇧⌘ at once. Relaunch: no dialog.
- [ ] Seed STC-415's row (⇧⌘4/2/3/8/7): the dialog lists Record only (⇧⌘8 → ⇧⌘5).

## 4. Shortcuts pane
- [ ] Both notes sit above the groups: the macOS-shortcuts line, then "Registered means…".
- [ ] Before the fix, reproduce on `master`: click a keycap ("Press keys…"), click empty space. It keeps waiting.
- [ ] On this branch: the same click ends the wait. Clicking a second keycap moves the wait there in one click. Switching pane ends it.
