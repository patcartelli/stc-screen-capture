# STC-581 — the Settings window: what only a Mac can settle

Settings is its own 760 × 560 window with a five-pane sidebar and STC-586's
CSS glass title bar, built to Capture SK 016's Settings frames and its "Row
pattern spec". It replaces the library's slide-over sheet. What each control
writes is unchanged: the same handlers and the same `settings.json` fields.

Run it from `claude/brave-brown-z2zjmb` until the PR merges, then from `master`:

```
git fetch origin claude/brave-brown-z2zjmb && git checkout claude/brave-brown-z2zjmb
npm ci && npm run app:start
```

Linux (Xvfb) has already checked that the window opens, all five panes
render and the controls write their fields (the e2e suite, plus screenshots
against the Figma frames). Linux can't show any of what follows.

## §1 — the window

1. Open Settings from each of the three doors: the library's Settings button,
   the menu bar's Settings…, and the record bar's Settings control. Each one
   opens the same window. Opening it a second time brings it forward. None of
   them opens the library.
2. The traffic lights sit where the frames draw them (20 px in, 22 px down),
   vertically centred on the sidebar's first row and clear of "Capture".
3. Dragging works from the title bar and from the sidebar's empty space. A
   sidebar item clicks rather than dragging.
4. ⌘W closes the window. The window is a fixed size: no resizing, no zoom
   button.
5. It is dark whatever the system appearance. Check with the Mac in Light mode.

## §2 — the glass title bar (STC-586)

1. On Camera or Shortcuts, scroll so content passes under the title. It blurs
   behind the 64 px bar and fades out toward the bar's bottom edge. Compare
   with the Figma frame "Settings / Shortcuts (scrolled)".
2. Turn on System Settings › Accessibility › Display › Reduce transparency
   with the window open. The bar becomes solid with a hairline under it,
   without reopening the window. Turn it off again and the blur comes back.

## §3 — each pane against its frame

Put the window next to each frame and look at row heights, the 16 px group
radius, the hairlines, heading spacing, the JetBrains Mono values and the
switch blue.

- **Dropdowns** (Show icon in, Panel corner, GIF frame rate and max width):
  each opens the record bar's own menu, below the trigger or above it near
  the window's bottom, with a check on the current value. Open one with a
  click or the down arrow, move with the arrows, pick with Return, close with
  Escape or a click outside. Compare the menu with the record bar's mic menu.
- **Camera:** dragging Corners and Size moves the preview live. Each switch
  changes the preview, and so does dragging the PiP on the preview (it snaps
  to the edges). Close and reopen Settings: everything you set is still set.
- **Shortcuts:** click a keycap, press a chord, and it binds. Clear empties
  it. Restore defaults puts every key back. A key another app already owns
  shows its reason in amber under the label.
- **Output:** both Change… buttons open the folder picker as a sheet on the
  Settings window, including with the library closed. Clean up… shows its
  sheet on the Settings window.
- **Advanced:** Show diagnostics shows and hides the table in the library
  window, live.

## §4 — Settings and a take

Open Settings, then start a recording from the menu bar. The Settings window
closes before the take starts, so it is not in the recording. Every change
was already saved.

## Known differences from the frames

- Shortcut labels use the app's own names ("Shot Area"); the frames write
  "Shot area".
- Keys are shown in macOS order (⌥⌘1); the frames write ⌘⌥1.
- "Show icon in" grows to fit "Menu bar and Dock". The frame's 168 px fits
  only "Menu bar only".
- The Clean up helper is not the ticket's wording. STC-435's sweep
  (`temp-takes.ts`'s `findOrphanedBundles`) offers a working folder only when
  it has a `capture.json` whose finished file is gone from the save folder. A
  library Delete removes both halves, and a take that never finished has no
  `capture.json` and is never offered. So "left behind by failed or
  interrupted recordings" was not true. The copy now says "whose finished
  capture is gone from this folder, such as one you deleted in Finder".
