# STC-471 runbook — region and window takes place the cursor through their scope

Run from branch `accounts/stc-471-region-and-window-takes-place-the-cursor-as-if-the-whole`
(not on `master` until merged).

What changed: `spaces.ts`'s `scopedDisplay` narrows the display to the take's
`anchors.scope` (origin and point size); `geometryAt` returns it as `shown`;
`render()`, `zoom-change.ts`'s cursor fallback and `effectivePointWidth` read it.
`TRANSFORM_VERSION` is 10. A take with no scope renders exactly what version 9 did.

CI covers the arithmetic (`transform/test/scope.test.ts`) and the no-scope goldens.
Only a Mac can settle the rest.

## 1. Watch the failure first (optional, on master)
Record a short Area take with the cursor over a known target, export it on
`master`, and note where the cursor lands. The ticket's misplacement is inferred
from the code and has never been watched.

## 2. Area take
Record an Area take (Record, pick Area, drag a marquee, click a few known targets,
drag once). Export it from this branch. The cursor must sit on each target for the
whole take, including near the region's edges.

## 3. Window take
Same with a Window take. Click the window's corners and title bar.

## 4. Regression
Record a full-screen take (bar's expand control). The cursor must be exactly where it was.

## 5. Judgement calls nothing here can settle
- A window that MOVES mid-take is out of scope (the bounds are fixed at start);
  if the cursor drifts after a move, file a bounds-timeline ticket.
- A region take across a real display mode change (STC-235 §3): the cursor should
  stay on target because the region is in display points on each geometry entry.
  Not exercised on hardware.
