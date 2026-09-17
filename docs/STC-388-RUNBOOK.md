# STC-388 — the Record flow, on a Mac

Written during the whole-branch review (2026-09-17), on the same box the
branch itself was built on — this machine has `swiftc` and a real display, so
everything mechanical already ran here (`npm run typecheck`, the full E2E
suite for `app/test/record-flow.e2e.test.ts` and friends). What is left is
what only a person looking at a real screen can settle: how the bar READS,
whether the four-step flow feels like one gesture, and the one item (§3/§4)
that needs a SECOND display, which this machine does not have and neither
does CI — so §3 and §4 are the two items most likely to still be open after
everything else here is checked off.

```
node app/build.mjs && npm run app:start
```

Drive the flow from the main window's **Record** button, the menu-bar
**Record** item, or ⌃⌥⇧⌘4 — all three reach `runRecordFlow` (main.ts).

## §1. The options bar's legibility near each screen edge, and `inside` placement

`record-options.ts`'s `barLayout` picks `below`, else `above`, else `inside`
(anchored to the marquee's own bottom-inner edge) — the view
(`overlay.ts`/`overlay.css`) never sees which one it got beyond a class name.
Drag a marquee, press Enter, and look at the bar in each of these positions:

1. **A small selection near the TOP edge of the screen.** The bar should sit
   BELOW the marquee. Check it is not so close to the marquee that it reads as
   part of the same shape, and not so close to the screen edge that its own
   padding (`BAR_MARGIN`, 8pt) looks tight.
2. **A small selection near the BOTTOM edge**, close enough that `below`
   cannot fit. The bar should sit ABOVE instead. Confirm the switch is not
   jarring as you drag the bottom edge of the marquee past the threshold —
   does the bar visibly "jump" in a way that reads as a glitch, or as the
   layout simply following the selection?
3. **A marquee covering (or nearly covering) the WHOLE display** — drag corner
   to corner, or press `expand`. Neither `below` nor `above` has room, so the
   bar falls back to `inside`, anchored near the marquee's own bottom edge.
   This is the one placement `BarLayout`'s own doc calls out as "the fallback,
   not a preference" — look at whether it reads as intentional or as the bar
   having nowhere better to go. Does it obscure anything the user was likely
   trying to capture (a dock, a menu bar, a status area at the bottom of the
   screen)?
4. **Left and right edges** — drag near each side. `barLayout` clamps `x`
   into `[BAR_MARGIN, display.width - BAR_MARGIN - barWidth()]`; confirm the
   bar never visually touches or crosses a side edge, at both the smallest and
   largest marquee sizes you can make.

## §2. `expand` pressed while a WINDOW is picked

Mechanism-tested (`app/test/overlay-options.test.ts`) and now driven through
the real app too (`record-flow.e2e.test.ts`'s "expand" describe block, task
9's `expandAfterWindow`), so this section is about how it LOOKS and READS,
not whether it works.

1. Press Record. Press **Space** to enter window mode. Hover a real window and
   click to pick it — the bar appears, anchored to that window's own bounds.
2. Press the bar's **expand** control.
3. The marquee should visibly grow from the window's bounds to the WHOLE
   display it sits on, and the bar's `#ctl-size` readout should update to the
   display's own dimensions. `#ctl-expand` should read as on.
4. Does the transition read as "this window's capture became a full-display
   one", or does it read as a discontinuity — the window highlight vanishing
   and an unrelated full-screen marquee appearing in its place? There is no
   "expand this window" meaning being preserved (a window and its display are
   never the same rect — see `onControl`'s own comment), so some visual jump
   is expected; the question is whether it reads as a DELIBERATE mode change
   or as a bug.
5. Press Record. Confirm (via the take that results, or the debug table) that
   it recorded the WHOLE DISPLAY, not the window.

## §3. Multi-display: a take records the display the drag landed on

**No test anywhere in this suite covers this** — a single-display machine
cannot distinguish "recorded the display I dragged on" from "recorded the
only display there is", and this sandbox and CI are both single-display. This
needs a second display, physically connected.

1. Connect a second display. Open the app; confirm two displays are visible to
   the OS (`System Settings › Displays`, or the debug table's source list).
2. Press Record. Drag a marquee entirely on the SECOND display, press Enter,
   press the bar's Record control.
3. **The resulting take must show the second display's content** — not the
   main display's, not a mix. Watch the recorded file, not just the request
   that reached the helper: `anchors.json`'s `display` field is the mechanical
   check, but only playback confirms the pixels agree with it.
4. Repeat starting the drag on the main display and dragging the pointer ACROSS
   the bezel onto the second display before releasing — `overlay-session.ts`'s
   own header says this is meant to work (drag crosses a bezel, the marquee
   does not stop at it). Confirm the recorded display is whichever one the
   FINAL rect's dominant area lands on (`dominantDisplay`), not the one the
   drag started on.

## §4. Finding 5's per-display bar behaviour, on two displays

This is the review's own finding: before the fix, `OverlaySession.push()`
built a bar layout for EVERY overlay window (one per display) unconditionally,
and `barLayout`/`micMenuLayout` CLAMP their result into whichever display's
bounds they are handed — so a selection made entirely on display 1 also drew
a fully visible, fully clickable copy of the bar on display 2. The fix
(`barBelongsOn`, `overlay-session.ts`) is unit-tested with two SYNTHETIC
displays (`app/test/overlay-options.test.ts`), which is the only way it could
be tested from here — this section is the real-hardware confirmation that
never ran.

1. With a second display connected, drag a marquee entirely on display 1,
   press Enter.
2. **Look at display 2.** There must be NO bar, no size readout, no controls —
   nothing drawn there at all. Before the fix this would have shown a full,
   live copy of the bar.
3. If anything IS visible on display 2, try clicking where its Record control
   would be. Before the fix this was fully live — a genuinely reachable way to
   start a take from a bar that visually belongs to the other display's
   selection. Confirm nothing happens there now.
4. Repeat with the marquee on display 2 and check display 1 the same way, and
   again with a WINDOW pick on each display (the anchor is the picked
   window's own bounds, from `pending`, not `state.rect` — same rule, worth
   checking it holds for both anchor kinds).
5. Drag a marquee that STRADDLES both displays, weighted mostly toward one
   side (`dominantDisplay`'s own tie-break). Confirm the bar appears on the
   display holding the larger share of the rect, and nowhere else.

## §5. Does the four-step flow feel like ONE gesture, and does the legend mislead?

The flow is: pick scope (drag or window-click) → adjust in the options phase
→ countdown → recording starts. Four steps, three of which happen in the same
overlay window with no visible seam between "selecting" and "reviewing".

1. Run the flow start to finish, at a normal pace — drag, Enter, maybe adjust
   the marquee, press Record, watch the countdown, watch the take start.
   **Does it feel like four separate decisions, or like one continuous
   motion?** This is a taste question with no test behind it; say what,
   specifically, felt like a seam if anything did (the bar's appearance? the
   countdown replacing the bar? something else?).

2. **The legend is the concrete thing to check, and it is very likely
   wrong.** `overlay.ts`'s `renderLegend` is called on every render regardless
   of `phase` or `purpose` — it always says `↵ capture · Esc cancel` (region
   mode) or `Click capture window · Space region · Esc cancel` (window mode),
   text that was written for the STILLS flow, where Enter/Return genuinely
   captures immediately. In a RECORD flow's options phase, Enter does not
   capture anything — it only re-confirms whatever the current marquee is
   (Finding 1's own subject), and the actual commit is the bar's own Record
   control, a mouse target the legend never mentions. Confirm this readout
   yourself: press Enter after the bar is up and check what happens (nothing
   starts; the pending selection updates) against what the legend claims
   ("↵ capture"). If it reads as actively misleading during a Record flow —
   promising a capture that Enter does not do — that is a real finding for a
   follow-up ticket, not a mechanism to fix here; note whether it is
   confusing in practice or merely inconsistent on paper.

## §6. The custom-drawn mic menu, while the overlay holds key focus

The mic menu (`record-options.ts`'s `micMenuLayout`) is drawn INSIDE the
transparent overlay window, not as a native popup — deliberately, per its own
comment, because a native menu would take key focus off the overlay the way
5850e4f already cost the countdown once.

1. Press Record, confirm a selection, and press the bar's **mic** control (it
   is enabled only if at least one mic is available — check `Settings ›
   Profile` or plug in a mic if the list is empty).
2. The menu should open drawn over the overlay, listing "Off" plus each real
   mic, with the currently-selected one marked.
3. **While the menu is open, does the rest of the overlay still respond?**
   Specifically: can you still adjust the marquee (drag a handle) with the
   menu open, or does the mic menu capture all pointer input the way a native
   menu would? Try pressing Escape with the mic menu open — does it close the
   MENU, or cancel the WHOLE overlay? Either could be the intended behaviour;
   what matters is which one it actually is, since nothing here specifies it.
4. Click a mic entry. The menu should close and the bar's mic control should
   reflect the new choice. Click OUTSIDE the menu (elsewhere on the overlay,
   not on a control) — does it close the menu without changing the
   selection, the way a normal dropdown would?
5. With the menu open, move the mouse to a SECOND display (if connected) and
   click there. Confirm nothing unexpected happens — the menu is drawn in one
   overlay window's local space, and a click routed to a different window's
   handler is worth checking explicitly given Finding 5 above.

## What is deliberately not here

- **The overlay's appearance outside the options bar** — the marquee, the
  handles, the crosshair in window mode — is STC-290/STC-342's own runbook
  territory, unchanged by this ticket except where the bar interacts with it.
- **The countdown panel itself** (focus, centring, reduced motion) is
  STC-391's runbook. This flow reaches the same countdown; nothing about it
  is retested here.
- **Camera/mic device behaviour** (a real camera opening, a real mic
  recording audio) is STC-287/STC-233's territory. §6 above is about the
  MENU's own interaction, not whether the chosen mic actually records.
