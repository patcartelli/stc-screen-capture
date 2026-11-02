# STC-621 runbook — the playhead stays reachable when the timeline is zoomed

Run from `accounts/stc-621-playhead-reachable-when-zoomed` until it merges (not on
`master` yet). `npm run app:start`, open a take of a minute or more, press `+` four
times so about a fifth of it shows.

**Read this first:** testing this PR found that the timeline's CSS transform had been wrong since STC-373 (see `spanTransform` in `timeline-zoom.ts`), which made the ruler, bookmarks, blocks and the playhead drift from the lanes whenever the view did not start at 0. Items 1-3 below are only meaningful with that fixed; start by wheel-panning a zoomed view and checking the ruler ticks, the zoom blocks and the Clip bars all move together.

What CI covers: the pure decisions (`app/test/timeline-zoom.test.ts`: `revealSpan`,
`centreSpan`, `followSpan`, `playheadSide`, `playheadKeyIntent`) and the wired
behaviour on the 5 s fixture (`app/test/playhead-reach.e2e.test.ts`: a key jump,
the marker, G, the button, a page flip, a hand pan ending the following). What only
a Mac can settle:

1. **Reveal on explicit moves.** `End`, then `Home`, then `Shift+→` held down, then
   `↑`/`↓` between bookmarks: the playhead is always in view afterwards, the zoom
   never changes, and a step that stays in view does not move the view. Check the
   5 % margin reads as "just inside", not as "stuck to the edge" (dial:
   `REVEAL_MARGIN_FRACTION` in `timeline-zoom.ts`).
2. **The marker.** Pan the ruler (or scroll) until the playhead is off screen. A chip
   with an arrow and a timecode sits at that edge, top of the overlay strip. Click it:
   the view re-centres on the playhead at the same zoom. It must not collide with the
   Export range chip or the Zoom block chip at the same edge (it is 14 px tall at the
   very top of the 36 px strip; the others are centred). Tab to it: the focus ring is
   the same one as the zoom buttons'.
3. **Follow during playback.** Press Space: when the playhead reaches the right edge
   the view flips a page and lands it ~10 % in from the left. Check the flip is a cut,
   not a slide, and that it does not stutter the preview. Reverse shuttle (`J`) flips
   the other way and lands near the right. Pan or zoom by hand mid-play: following
   stops (the marker appears if the playhead runs off); pause and Play again: it
   follows again. Dial: `FOLLOW_LANDING_FRACTION`.
4. **G and the button.** `G` and the target button beside Fit both re-centre at the
   same zoom. `G` does nothing while a text field has the keyboard; `⌘G` is untouched.
5. **The zoom buttons still fit.** The cell is 64 px; `−`, `+`, `Fit` and the new
   button were tightened (13 px min width, Fit 2 px padding) to share it. Look at it:
   all four are legible, none clipped, and hit targets still feel usable. If not, the
   alternative is widening `--label-col`, which moves every lane.
6. **Reduced motion.** Nothing here animates (a span change is a jump), so there is
   nothing to switch off; confirm nothing slides with Reduce Motion on or off.

Deliberately not built: the overview-strip mark (STC-605 took the strip out; the
ruler is the pan handle and carries no playhead), and re-engaging the following when
the marker or `G` is used mid-play (the ticket says it resumes at the next Play).
