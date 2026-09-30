# STC-482 runbook — a window that moves mid-take keeps the cursor on target

Stacked on PR 253 (STC-471). Run from branch
`accounts/stc-482-a-window-that-moves-mid-take-misplaces-the-cursor-record-a`
(not on `master` until 253 and this merge). Rebuild the helper first: `helper/build.sh`.

What changed: for a window-scope take the helper samples the window's origin at
30 Hz and writes `scope.window.track` (anchors v8) only if the window moved.
`session.ts`'s loader takes that displacement out of the cursor events before
the spring sees them (`transform/src/window-track.ts`). `TRANSFORM_VERSION` is 11.

CI covers the arithmetic, the loader's refusals, the anchors-8 schema and the
document writer. Only a Mac settles the rest.

## 1. The failing take, re-exported
Take `2026-09-30_10-24-01` was recorded before the track existed, so it cannot be
fixed retroactively: its anchors have no `track`. Record a new one.

## 2. Window take with a title-bar drag (the acceptance)
Record a Window take. Click a couple of targets inside the window, then drag the
window by its title bar across the screen twice, click again, stop. Export.
- The cursor must stay on the title bar it is holding for the whole drag, not trail
  behind it or lead it.
- Clicks after the move must land on the same content as before it.
- Open `anchors.json`: `version` 8, `scope.window.track` with entry 0 at `t: 0`
  equal to `bounds`, and entries every ~33 ms while the window moved.

## 3. Regression
- A Window take where you do NOT move the window: `anchors.json` stays version 3,
  no `track`, and the export is unchanged.
- An Area take and a full-screen take are unchanged.

## 4. Judgement calls only eyes can settle
- **Sampler vs. events clock.** Both use `Clock.nowNs() - t0Ns`, but the window
  server reports a frame slightly after it happens. If the pointer runs ahead of or
  behind the bar by a few points during a fast drag, that is a constant lag between
  the two clocks and the fix is a fixed offset, not more samples.
- **A window moved with the mouse standing still** (an app repositioning itself) is
  not corrected until the next mouse event. A drag always produces events, so this
  should not show up in a real take.
- **Window resize still ends the take** (STC-382). A move never changes the size.
- **Display changes mid-take** convert the window origin with the take's START
  display origin. Untested with a moving window across a real mode change.

## What the fault injector covers
`STC_CAPTURE_FAULT=window-moved` (`helper/test/region-window-scope.grant.test.ts`,
needs a grant, `npm run test:capture`) scripts one +120/+60 move 0.5 s in and checks
the v8 document. It replaces the sampler, so it proves the sidecar, not the sampling.
