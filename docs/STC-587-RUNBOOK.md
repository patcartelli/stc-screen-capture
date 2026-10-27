# STC-587 — Settings focus and reduced motion: what only a Mac can settle

The Settings half of STC-587, on STC-506's rules. The audit row is the last
section of `docs/STC-506-AUDIT.md`. The Library half waits for STC-584.

Run it from `claude/brave-brown-z2zjmb` until the PR merges, then from `master`:

```
git fetch origin claude/brave-brown-z2zjmb && git checkout claude/brave-brown-z2zjmb
npm ci && npm run app:start
```

Linux has checked that every control a Tab reaches wears the `--focus` ring,
the keyboard paths below work, a switch's transition changes under reduced
motion, and axe is at zero. It cannot show how any of it looks.

## §1 — keyboard only

Open Settings and put the mouse away.

1. Tab moves sidebar → pane → back to the sidebar. Each control shows the
   blue ring, clear of the group's rounded edge.
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

System Settings › Accessibility › Display › Reduce motion, on.

1. Toggle a Settings switch: the knob is at its new end at once, and the
   track's colour fades in (about a tenth of a second). It should read as a
   fade, not a jump and not a slide.
2. The same in the record bar's mic menu (Include System Audio), which
   shares the switch.
3. Turn Reduce motion off: both slide again.

## §4 — what changed visually

- Hover and press states, which Settings had none of: a faint lift on hover,
  more on press. Judge whether they are too strong for the frames.
- Section headings and notes are slightly brighter (`.48` white instead of
  Figma's `.45`), the smallest change that clears AA contrast.
