# STC-456 — Record options bar + device dropdowns, rebuilt to Capture SK 016

**Not on `master` yet.** Run this from
`accounts/stc-456-device-picker-popover-unstyled-needs-a-design-pass`:

```
git fetch origin accounts/stc-456-device-picker-popover-unstyled-needs-a-design-pass
git checkout accounts/stc-456-device-picker-popover-unstyled-needs-a-design-pass
npm run app:start
```

## What shipped

The overlay's options bar is a two-row 340×108 dark pane (`#0f0f0f`, radius
16) plus a separate 340×36 "Capture Video" button 8px below it
(`app/src/record-options.ts`'s `PANE_WIDTH`/`PANE_HEIGHT`/`CAPTURE_GAP`/
`CAPTURE_HEIGHT`). Row 1 is the size field (editable W/H, JetBrains Mono) and
Expand/Crop; row 2 is Settings, Mic, Camera, Keys, Clicks — Keys and Clicks
are disabled slots for STC-419/STC-420. Icons are Material Symbols Outlined,
weight 300, vendored from `@material-symbols/svg-300@0.47.5` by
`scripts/vendor-icons.mjs` into `app/src/icons.ts` (generated;
`app/src/icons.LICENSE.txt` carries the Apache-2.0 notice).

The mic and camera menus are one shared component now: `app/src/
device-picker.ts`'s `micMenuRows`/`cameraMenuRows`/`applyMenuPick` decide the
rows and the state change; `app/src/device-menu-dom.ts`'s `buildMenuRow`
draws them (used by both `overlay.ts`'s `renderMenu` and `renderer.ts`'s main
window popover); `app/renderer/device-menu.css` is the one shared dropdown
stylesheet. The overlay's menus drop BELOW their trigger and sit OVER the
capture button on purpose (Patrick's ruling), flipping ABOVE whenever the
trigger's bottom edge, plus the gap, plus THAT menu's own height
(`menuHeight(rowCount)`, `record-options.ts`) would cross the display's
bottom margin — not only when the bar itself sits at the bottom of the
display; an ordinary `below`-placed bar with a long enough menu (the camera
list, say) crosses the same line and flips for the same reason. The main
window's popover keeps its old position, under its trigger, and now also
offers "Include System Audio" (STC-459 folded into this ticket). The mic
trigger is never disabled, even with zero mics — its menu's two device-less
rows (Include System Audio, Mute External) need none.

A typed size (`parseDimension`/`resizeToPixels`) resizes the marquee around
its centre; `barPress` (`record-options.ts`) decides pointerdown ordering: a
focused, typed size commits BEFORE any other press acts, and with a menu
open, a press on any control other than the mic/camera triggers only closes
the menu. Return in the size field commits the size; Return in the options
phase re-confirms the selection and does **not** start the take — the ↵ glyph
on the Capture Video button is decorative, and the legend says "Click Capture
Video" rather than promising Return starts it.

None of this has been exercised with real mouse/keyboard input — the e2e
suite drives the overlay with `STC_OVERLAY_SYNTHETIC_INPUT=1`, which bypasses
`overlay.ts`'s real listeners entirely. Checks 11–19 below exist because of
that gap.

## Checks

1. **The bar against Frame 9, side by side.** Pane 340×108, radius 16,
   `#0f0f0f`, JetBrains Mono for the size digits, Geist for everything else
   on the pane and the Capture Video label. Screenshot in both OS
   appearances (System Settings → Appearance) — the pane must be dark in
   **both**, since it forces dark regardless of the OS theme (unlike the
   main window's popover, check 9).
2. **Icons.** Material Symbols Outlined, weight 300. Check each glyph reads
   clearly at 20px against the dark pane: size caret, expand, crop,
   settings, mic/mic-off, camera/camera-off, keys, clicks, record.
3. **Size field.** Click W, type `1280`, Tab, type `720`, Return. The
   marquee resizes around its centre and no take starts. Type letters into
   either field: nothing appears (non-digits are stripped). Escape mid-edit:
   the old value returns and the overlay stays open.
4. **Crop.** Returns to drawing (the marquee disappears, back to a fresh
   drag). A new drag brings the bar back.
5. **Settings.** The overlay closes and the main window opens with the
   settings sheet already open. A camera or mic pick (or a system-audio
   toggle) made on the bar just before pressing Settings shows up in the
   main window too — `#camera-state`/`#mic-state` and the popover's own
   checked row, not just `settings.json` (STC-456 fix round, Finding 2:
   `writeBarOptions` used to write the file but never tell an already-open
   main window, so its labels stayed stale until something else refreshed
   them).
6. **Mic menu.** Drops below its trigger and over Capture Video; flips above
   the trigger whenever the trigger's bottom + gap + the menu's own height
   would cross the display's bottom margin — NOT only when the bar sits at
   the bottom of the display: a bar in its ordinary `below` placement can
   also cross that line if the menu itself is long enough (drag a marquee
   near the bottom edge, or Expand on a bar-at-bottom layout, to force it
   either way). Toggling "Include System Audio" keeps the menu open. Record
   → `system.m4a` exists in the take's folder. With no mic connected, the
   trigger is still clickable and the menu still opens — it offers only
   Include System Audio and Mute External.
7. **Camera menu.** The "Automatic" row sits between "No Camera" and the
   named devices (it was left out of Frame 9 by accident — Patrick confirmed
   it stays). Pick a named camera, Record → that camera is the one in the
   take.
8. **Keys / Clicks.** Visibly disabled (32% opacity, no hover state).
   Tooltips name STC-419 and STC-420 respectively.
9. **Main window popover.** Same rows, same shared markup/CSS as the
   overlay's menus, but follows the OS light/dark appearance (it uses
   `tokens.css`'s theme variables, not the overlay's forced dark). The
   popover still opens under its trigger, not over a capture button — there
   isn't one in the main window.
10. **Padding presses.** A press inside the pane's own 16px padding — not on
    any control — does not start a new marquee and does not close an open
    overlay session.

### Checks only real mouse/keyboard input can settle

The e2e suite runs synthetic input (`STC_OVERLAY_SYNTHETIC_INPUT=1`) and
never drives these paths for real. All of them were sanity-checked once with
a scratch Playwright-CDP script during Task 6 (not committed — see the task
report) but need a proper hand pass:

11. **Type a width, then click Capture Video immediately.** The take is
    recorded at the TYPED size, not the drag's original size — open the
    exported file and check its dimensions.
12. **Type W, Tab to H, move the mouse around, then leave the pair.** W
    keeps what was typed — it must not get overwritten by a broadcast while
    H still has focus.
13. **With a menu open, click Capture Video's exposed edge beside the
    menu** (the part of the button not covered by the dropdown). The menu
    closes and no take starts.
14. **Click into the size field.** Its text is selected (Chromium can undo
    a programmatic `select()` on the same mouseup that focused the field —
    this is a known risk, not confirmed either way).
15. **Menu rows keep their hover highlight** while the pointer rests on
    them. Rows are rebuilt on every broadcast (including plain pointermove),
    so a naive rebuild could drop `:hover` state between frames.
16. **Clear W, then click Expand.** The field should show a valid value
    again. Known minor, deferred: it may only refresh on the next mouse
    move rather than immediately.
17. **Whether the NSPanel overlay actually gives the size `<input>`
    keyboard focus** when it's clicked — nothing here proves the overlay
    window itself accepts text-field focus correctly.
18. **Settings from the tray or a hotkey with the main window CLOSED**
    still opens the settings sheet (not just when a window is already open).
19. **A mic/system-audio choice made on the bar survives pressing
    Settings**, and does **not** survive a plain Escape — these are two
    different, deliberately asymmetric outcomes (see `writeBarOptions` in
    `app/src/main.ts`); confirm both directions by hand, not just one.

### Judge against Frame 9

- The menu's top edge overlaps the pane's bottom 12px of padding (measured:
  `menuAnchor` puts a menu at trigger-bottom + 4, and the pane's own padding
  is 16). This matches the "below its trigger, over the capture button"
  ruling, but confirm it reads as intended rather than as a bug.
- The `#size` chip (marquee-relative, predates this ticket) can overlap the
  pane on a narrow selection.
- `#legend` can sit behind the bar when the bar is `inside` at the display's
  bottom edge.

### Grant-requiring runs

Any check above that needs a real recording (6, 7, 11) needs a Screen
Recording grant. Hand these to Patrick to run from **his own terminal**, not
an agent shell — `npm run test:capture` and any real take reliably skip
(`-3801`) or silently fail to start when launched from an agent's shell on
this Mac (see `reference_grant_tests_need_user_terminal` in memory).
