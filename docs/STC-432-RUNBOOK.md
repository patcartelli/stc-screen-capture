# STC-432 — main window chrome: what to run on the Mac

Written on a Linux session with no macOS, no Xcode, no `swiftc` — so this is
typechecked (`npm run typecheck`) and bundled (`node app/build.mjs`) clean,
but **never actually watched**. The pixel numbers below are a reasoned guess,
not a measurement, and are the item most likely to need adjusting on real
hardware.

## What changed

- `app/src/main.ts`'s `createWindow()` now sets `trafficLightPosition: { x:
  TRAFFIC_LIGHT_X_PX, y: TRAFFIC_LIGHT_Y_PX }` (20, 24) instead of leaving it
  at the OS default, so the inset lights land at a position this file
  actually controls rather than one that happens to have collided with
  `#title-row`.
- `app/renderer/index.html`: `#title-row` gets `-webkit-app-region: drag`
  (the window's only drag surface — nothing else in the page declares one)
  and `padding-left: var(--traffic-light-offset)` (62px — the lights' 52px
  cluster width plus a 10px gap) so the "Capture" heading and the model-code
  plate start clear of the lights instead of underneath them.
- Nothing else moved: `pill-window.ts`'s `collapsePill`/`restorePill` still
  only toggle `setWindowButtonVisibility`, never reposition the lights, so
  they should come back exactly where this ticket puts them.

## Where the numbers came from

`TRAFFIC_LIGHT_X_PX` (20) matches `body`'s own `padding: 20px` — the
cluster's left edge sits flush with where every other row's content starts.
`TRAFFIC_LIGHT_Y_PX` (24) centres the lights' ~12px dot height inside
`#title-row`'s own ~20px height (`h1`'s 15px/1.3 line-height), offset by that
same 20px top padding: `20 + round((20 − 12) / 2) = 24`. The CSS offset (62px)
is the standard macOS three-dot cluster (12px dots, 8px apart = 52px) plus a
10px gap, matching the gap already used elsewhere in this row's flex layout.

These are the two things a Mac can actually confirm or correct — not the
approach (align + offset, both named rather than magic numbers), which the
ticket already settled.

## §1 — the lights and the heading

1. `npm run app:start`.
2. **Expect**: "Capture" and the model-code plate start well clear of the
   traffic lights, at the window's default 520px width — no overlap, no
   visible gap so large it reads as accidental.
3. Shrink the window to its minimum width. **Expect**: still no overlap —
   if the heading or plate ever wrap or get clipped before they'd overlap
   the lights, that's a different (pre-existing) layout question, not this
   ticket's.
4. Toggle dark mode (System Settings, or however this machine switches it).
   **Expect**: same layout in both — the lights' position and the heading's
   offset are appearance-independent, only colours should change.

## §2 — the drag region

1. Click and drag anywhere on the `#title-row` band (to the right of the
   lights, on either the "Capture" text or empty space in the row).
   **Expect**: the window moves with the cursor, the same as any normal
   title bar.
2. Double-click the same band. **Expect**: the window zooms (or does
   whatever this Mac's "double-click a window's title bar" System Settings
   preference says — that's inherited from the OS for free once the region
   is a real drag region, not built here).
3. Click and drag on `#record-row` (the Record/Shot/Settings row) or
   anywhere else in the body. **Expect**: nothing drags — only `#title-row`
   is a drag region.

## §3 — the pill still hides and restores the lights correctly

Unchanged mechanically by this ticket, but worth reconfirming since the
lights now sit at an explicit position rather than a default one:

1. Start a recording and let it collapse to the pill.
   **Expect**: the traffic lights disappear along with the rest of the
   window's chrome (as they did before this ticket).
2. Stop the recording and let it restore.
   **Expect**: the lights reappear in the same spot verified in §1 — not
   shifted, not needing a hover or a resize to redraw correctly.
