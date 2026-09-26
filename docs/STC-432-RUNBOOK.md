# STC-432 — main window chrome: what to run on the Mac

## Hardware pass 1 (2026-09-25, Patrick)

§1 (lights/heading) and §3 (pill hide/restore) confirmed as built — no
collisions at either width, lights return correctly after a pill
collapse/restore. Two real findings from §2, both fixed below:

1. No visible gap between the lights and "Capture" — the original 10px
   read as none at all once actually seen. Widened to 16px
   (`--traffic-light-offset` 62px → 68px).
2. The `#title-row` band dragged correctly, but the strip of window ABOVE
   it — `body`'s own 20px top padding, which carried no
   `-webkit-app-region` at all — did not. Double-click-to-zoom on the row
   itself worked correctly.

Fix: that 20px moved OFF `body` and onto `#title-row` as its own
`padding-top`, so `#title-row`'s box (and its drag region) now starts at
the window's actual y=0 instead of 20px below it. Visual position is
unchanged — the row is exactly as tall and exactly as far from the
lights as before, it just now draws from y=0 rather than being pushed
down by a separate, non-draggable body padding. Still typechecked and
bundled only (no Xcode/swiftc in this session either) — **not yet
watched**; that's this pass.

## What changed (both passes)

- `app/src/main.ts`'s `createWindow()` sets `trafficLightPosition: { x:
  TRAFFIC_LIGHT_X_PX, y: TRAFFIC_LIGHT_Y_PX }` (20, 24) instead of leaving it
  at the OS default, so the inset lights land at a position this file
  actually controls rather than one that happens to have collided with
  `#title-row`. Unchanged by the follow-up fix.
- `app/renderer/index.html`: `body`'s top padding moved onto `#title-row`
  as its own `padding-top: 20px`, alongside `-webkit-app-region: drag`
  (the window's only drag surface — nothing else in the page declares one)
  and `padding-left: var(--traffic-light-offset)` (68px — the lights' 52px
  cluster width plus a 16px gap) so the "Capture" heading and the
  model-code plate start clear of the lights instead of underneath them.
- Nothing else moved: `pill-window.ts`'s `collapsePill`/`restorePill` still
  only toggle `setWindowButtonVisibility`, never reposition the lights, so
  they should come back exactly where this ticket puts them.

## Where the numbers came from

`TRAFFIC_LIGHT_X_PX` (20) matches `body`'s own left `padding: 20px` — the
cluster's left edge sits flush with where every other row's content starts.
`TRAFFIC_LIGHT_Y_PX` (24) centres the lights' ~12px dot height inside
`#title-row`'s own ~20px height (`h1`'s 15px/1.3 line-height), offset by that
same 20px top padding — now `#title-row`'s own, not `body`'s, but the same
20px so the sum is unchanged: `20 + round((20 − 12) / 2) = 24`. The CSS
offset (68px) is the standard macOS three-dot cluster (12px dots, 8px apart
= 52px) plus a 16px gap — widened on the first hardware pass from an
initial 10px, matching the gap already used elsewhere in this row's flex
layout (`body`'s own `gap: 16px`).

These are the two things a Mac can actually confirm or correct — not the
approach (align + offset, both named rather than magic numbers), which the
ticket already settled.

## §1 — the lights and the heading

1. `npm run app:start`.
2. **Expect**: "Capture" and the model-code plate start clear of the
   traffic lights with a visible gap, at the window's default 520px width —
   no overlap, and the gap should now read as deliberate rather than as
   none at all (the first hardware pass's finding).
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
   title bar. (Confirmed on the first hardware pass.)
2. Click and drag the strip of window ABOVE `#title-row` — the ~20px above
   "Capture" and to the right of the lights, before any row content starts.
   **Expect (new in this pass)**: the window now moves from here too. This
   is the strip that did NOT drag on the first hardware pass; the fix above
   is specifically for this check.
3. Double-click the `#title-row` band. **Expect**: the window zooms (or does
   whatever this Mac's "double-click a window's title bar" System Settings
   preference says — that's inherited from the OS for free once the region
   is a real drag region, not built here). (Confirmed on the first hardware
   pass.)
4. Click and drag on `#record-row` (the Record/Shot/Settings row) or
   anywhere else in the body below the title strip. **Expect**: nothing
   drags — only the top strip (title row + the padding above it) is a drag
   region.

## §3 — the pill still hides and restores the lights correctly

Confirmed on the first hardware pass; unchanged by the follow-up fix
(`#title-row` is hidden entirely under `body.pill-collapsed`, so its new
`padding-top` plays no part while collapsed). Worth a quick recheck since
the row's own box changed shape:

1. Start a recording and let it collapse to the pill.
   **Expect**: the traffic lights disappear along with the rest of the
   window's chrome (as they did before this ticket).
2. Stop the recording and let it restore.
   **Expect**: the lights reappear in the same spot verified in §1 — not
   shifted, not needing a hover or a resize to redraw correctly.
