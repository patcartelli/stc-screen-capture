# STC-587 — focus and reduced motion in Settings and the Library: what only a Mac can settle

STC-587 on STC-506's rules, in two halves: Settings (§1-§4, on `master`) and
the Library (§5-§7, after STC-584's rebuild). The audit rows are the last two
sections of `docs/STC-506-AUDIT.md`.

Both halves are on `master` (the Library half merged as #395, STC-593's GIF
check as #396). The STC-595 follow-ups from the first Mac pass (2026-10-28),
marked **STC-595** below, are on `claude/wonderful-babbage-fbqb2g` until
their PR merges, then on `master`:

```
git fetch origin claude/wonderful-babbage-fbqb2g && git checkout claude/wonderful-babbage-fbqb2g
npm ci && npm run app:start
```

Linux has checked that every control a Tab reaches wears the `--focus` ring,
the keyboard paths below work, a switch's transition changes under reduced
motion, and axe is at zero. It cannot show how any of it looks.

**Home and End on a MacBook are fn+← and fn+→.** Every "Home/End" below
means those.

## §1 — keyboard only

Open Settings and put the mouse away.

1. Tab moves sidebar → pane → back to the sidebar. Each control shows the
   blue ring, clear of the group's rounded edge.
1a. **STC-595:** the sidebar is ONE Tab stop, on the pane being shown. ↑/↓
   move through it and show each pane as they reach it; Home/End go to
   Capture and Advanced. It stops at the ends rather than wrapping.
2. On a segmented control (When a shot is taken, Countdown, Shape), Tab
   stops once. ←/→ move and choose; Home/End go to the ends.
3. On a dropdown, ↓ or Return opens it, ↑/↓ move, Return picks, Escape
   closes and puts the ring back on the trigger.
4. Shortcuts: Return on a keycap, press a chord, and the ring stays on that
   keycap. Return, then Escape, leaves it there too. Tab on from it reaches
   Clear.
5. Camera: Tab to the PiP on the preview. ←↑→↓ move it 1%, with Shift 10%.
   It snaps near the guides and never leaves the frame. Close and reopen
   Settings: it is where you left it.

## §2 — VoiceOver

With VoiceOver on (⌘F5), a keycap reads as its action and its key ("Shot
Area, ⌥⌘1, toggle button"), a segmented option as a radio button with its
state, and the PiP as "Camera position" with the hint under the preview.

## §3 — reduced motion

Reduce motion is in System Settings › Accessibility, under Motion on
recent macOS (Display on older releases). The quickest way is to type
"Reduce motion" into System Settings' search field. Turn it on.

1. Toggle a Settings switch and watch the white knob. With Reduce motion
   off it slides across (0.15 s); with it on it is at its new end at once
   and only the track's colour fades (about a tenth of a second). The
   difference is small: compare the two settings side by side.
2. The same in the record bar's mic menu (Include System Audio), which
   shares the switch.
3. Turn Reduce motion off: both slide again.

## §4 — what changed visually

- Hover and press states, which Settings had none of: a lift on hover, more
  on press. **STC-595** raised them to the Library's steps (8% white on
  hover, 16% on press; they were 6% and 11%, and on the first Mac pass they
  did not read at all). The current sidebar item does not change on hover.
  Judge whether they are now too strong.
- Section headings and notes are slightly brighter (`.48` white instead of
  Figma's `.45`), the smallest change that clears AA contrast.

## §5 — the Library, keyboard only

Open the Library with a few recordings and shots in it, and put the mouse away.

1. Tab from the window's start: Grid/List, the kind filter, Search, the
   gear, then each item's picture, Share and •••, in order. Every stop shows
   the blue ring. The ring on a picture sits clear of its rounded corners.
2. Grid/List and the kind filter each take ONE Tab stop. ←/→ move and
   choose; Home/End go to the ends. After a pick the ring stays on the chosen
   segment (it used to fall off when the bar redrew).
3. Return or Space on a picture opens it, as a click does.
3a. **STC-595:** the arrow keys move between items, from a picture, Share or
   •••, onto the same control of the next item. In the list ↑/↓; in the grid
   ←/→ for the previous and next, ↑/↓ for the item a row away (resize the
   window to two columns and check ↑/↓ follow it). Nothing moves at the
   first or last item. Tab still walks every control.
4. Return on ••• opens the menu on its first row. ↑/↓ move, Home/End go to
   the ends, and each row shows the ring drawn INSIDE the row. Escape or Tab
   closes it with the ring back on •••.
5. Rename from that menu: the name field shows the ring. Escape leaves the
   name alone and puts the ring back on •••. Rename again, type, Return: the
   new name shows and the ring is still on that item's •••. **STC-595:** the
   first Mac pass found Escape left the focus before Share (Tab went to
   Share, then •••). Linux never reproduced it; Escape and Return now find
   the item's ••• in the page as it is then. Check this one again, and say
   whether it is fixed.
6. Delete an item from its menu and confirm: the ring lands on the item that
   took its place (the next one, or the last if it was the last). **STC-595:**
   the first Mac pass found it on the title bar instead (fixed: picking a row
   now puts the focus on ••• before the action runs, so the confirm sheet
   returns to it). Cancel the sheet too: the ring stays on •••.

## §6 — the Library, VoiceOver

Grid/List reads as "View, radio group" and the filter as "Show, radio
group", each option as a radio button with its state. A picture reads as its
action and its name ("Open login bug, button").

## §7 — the Library, what changed visually

- Press states, which the Library had none of: Grid/List and the filter,
  Share, •••, the gear, menu rows, a tile's picture border and a row's
  background, the empty state's buttons. Judge whether they are too strong.
- The list's column headers, the item count and the grants panel's note are
  slightly brighter (`.48` white instead of the frames' `.45`), the smallest
  change that clears AA, as in Settings.
- Two things move in the Library: the loading spinner, and a saved GIF's
  thumbnail while the pointer is over its tile (STC-592). Under Reduce
  motion the spinner stops and the GIF keeps its first frame (STC-593). To
  check the GIF: save one from a recording's panel (Video/GIF switch, then
  Save), point at its tile with Reduce motion off (it plays) and on (it does
  not), and move away (it goes back to the first frame). It plays on pointer
  hover only, never on keyboard focus (Patrick, 2026-10-28).
