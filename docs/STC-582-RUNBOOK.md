# STC-582 runbook — shortcut defaults that do not collide

Run from `claude/bold-johnson-ft7dut` (not on `master` yet). Nothing here has run on a Mac; the unit tests
(`hotkeys.test.ts`, `settings.test.ts`, `tray-menu.test.ts`) pass on Linux, the e2e edits are unrun.

What changed: defaults are ⌘⌥1 area, ⌘⌥2 window, ⌘⌥3 full display, ⌘⌥4 record, ⌘⌥5 self-timer. ⇧ adds the
clipboard outcome (⌘⌥⇧N). STC-415's ⌥ "to editor" variant is gone (STC-415 had shipped ⌃ clipboard / ⌥ editor,
both derived, never stored). The editor is reached from the panel and the menu bar's new **Open Latest in
Editor**. Superseded defaults are no longer rewritten silently at read: main asks once at launch.

## 1. Fresh install (the acceptance)
Delete `settings.json`, launch. Settings → Shortcuts must show the five keys above, every row "Active", each
shot row's Clipboard variant ⌘⌥⇧N "Active". With macOS's own screenshot keys ON and CleanShot running, press
each of the ten keys: all fire Capture, none fires a system or CleanShot action.

## 2. Migration
Seed `settings.json` with each of: the STC-415 row (⇧⌘4/2/3/8/7), the hyperkey row, a mix, and the STC-415 row
with one key changed. Launch each.
- Expect one dialog "New default shortcuts" listing only the keys still on an old default (before → after),
  buttons "Reset to new defaults" / "Keep mine". It never appears a second launch (`shortcutsOffered`), whatever
  was chosen. A fresh install, or a file already on the new defaults, never shows it.
- Reset moves only the listed keys, takes effect immediately (no relaunch), and leaves a changed or unbound key.
- Keep mine leaves everything and registers the old keys as stored.

## 3. Menu bar
**Open Latest in Editor** opens the newest library item in the still editor or the video editor by its kind;
with an empty library it opens the library. It shows no accelerator.

## 4. Decision for Patrick: in-app ⌘⌥N
Xcode, Safari and others use ⌘⌥+digit in-app; Capture's global registration overrides them while it runs. Check
the ones you use. Accepted by the ticket unless it bites.
