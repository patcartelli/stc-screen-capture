# STC-415 runbook — hotkey modifiers pick the post-capture outcome

Run from the branch `claude/elegant-ritchie-bh9k2e` until it merges (not on `master` yet).
Nothing here has run on a Mac: this session had no Swift toolchain and no display, so the
unit tests (`hotkeys`, `settings`, `tray-menu`) and the typecheck ran, and the e2e files were
only edited. CI is the first run of those.

## What changed

1. **Defaults moved off the hyperkey** to CleanShot's row: Area `⇧⌘4`, Window `⇧⌘2`,
   Full Display `⇧⌘3`, Record `⇧⌘6`, Self-Timer `⇧⌘7`. `⇧⌘5` is left free.
2. **`⌘⇧3/4/5/6` and their `⌃` forms are no longer on the reserved list** (`SYSTEM_CLAIMED`),
   because they are now defaults. `globalShortcut.register` is the authority: if macOS still
   owns one it reports "Something else on this Mac already holds this shortcut".
3. **Outcome variants, derived not stored.** For each shot (not Record), adding **⌃** copies
   straight to the clipboard (no panel) and adding **⌥** promotes the shot and opens the still
   editor (no panel). `⌃⇧⌘4` is also macOS's own "screenshot to clipboard" chord. The base
   binding keeps doing what the panel preference says, and "Skip it" is unchanged.
4. **Migration.** A `settings.json` whose bindings are each an old hyperkey default or a new
   default, with at least one old, is treated as untouched and takes the new defaults whole (this
   includes a file that predates Record, and a mix the new build wrote after filling in missing
   keys). Any set with a binding that is neither, or an unbound action, keeps everything it has,
   and its hyperkey bindings have no variants (a base that already holds ⌃ or ⌥ has nothing to add).

## What only a Mac can settle

0. Turn off macOS's own screenshot shortcuts (System Settings → Keyboard → Keyboard Shortcuts
   → Screenshots) so `⇧⌘3/4` are free, as they are with CleanShot. Quit CleanShot or move its
   bindings first, or it holds the same keys.
1. **Fresh install:** delete `settings.json`, launch. Settings → Shot shortcuts shows
   `⇧⌘2`, `⇧⌘3`, `⇧⌘4`, `⇧⌘6`, `⇧⌘7`, all "Active".
2. **Existing install** with the old hyperkey set: launch. It shows the new set.
   Then change ONE binding, relaunch, and confirm the others did not move.
3. **`⇧⌘4`** — overlay, drag, release: the usual panel (or silent copy if "Skip it" is on).
4. **`⌃⇧⌘4`** — same overlay, and on release the shot goes straight to the clipboard with
   no panel, even with "Skip it" OFF. Paste it somewhere. With "Skip it" ON it behaves the same.
5. **`⌥⇧⌘4`** — on release the still editor opens on the shot, no panel. The shot is in the
   library (Show in Finder from the editor, or open the library).
6. **`⌃⇧⌘3` and `⌥⇧⌘3`** (full display, no overlay) do the same two things. `⌃⇧⌘7` and `⌥⇧⌘7`
   run the countdown first.
7. **Does macOS take any of the variants?** `⌃⇧⌘3` and `⌃⇧⌘4` are macOS's clipboard
   screenshots; with the system shortcuts off they should reach this app. If one does not,
   the log has `[shortcuts] … is unavailable`.
8. **The editor outcome with a bad folder:** point the save folder somewhere unwritable and press
   `⌥⇧⌘4`. The shot must still come up in the panel (the log says it could not open the editor)
   rather than vanish.
9. **Rebinding Area** to something else moves its two variants with it, and the old ones stop
   firing.
10. **Record** (`⇧⌘6`) still starts a take, and the same key still stops it.

## Not done here

CleanShot's other menu items were filed as backlog tickets, not built: STC-569 All-In-One,
STC-570 Capture Previous Area, STC-571 Scrolling Capture, STC-572 Capture Text (OCR),
STC-573 Capture History, STC-574 Show Desktop Icons, STC-575 Open an existing image.
"Pin to the Screen" was not filed.
