# STC-374 — instrument, main-window strip: what to run on the Mac

Written on a Linux session with no display server other than Xvfb, so
everything below is REASONED about and driven through Playwright's
`_electron`, never LOOKED at. The wiring (scope switching, picking a window
or an area, `recorder:start`'s payload, persistence across a restart) is
exercised end to end in `app/test/scope-picker.e2e.test.ts` and passes; what
that file cannot see is what any of it looks or feels like.

## What changed

- The main window sheds everything but capture and the take grid at rest:
  Record, Shot, Camera, a new **Profile** button, the Scope picker
  (Screen/Window/Area), the scope's "source" control, live telemetry, and
  the take grid. Still-capture preferences and the shortcuts editor moved
  behind the Profile button, into a slide-over panel (`#profilesheet`) that
  slides in from the right edge over the take grid — a panel inside this
  window, not a fourth window.
- The Scope picker is wired to STC-370's `region`/`windowId`, not just drawn:
  choosing Window or Area shows a "Choose window…" / "Choose area…" button
  that opens the same selection overlay `capture-still` already uses
  (STC-290), and confirming a pick stores it as a sticky preference
  (`settings.ts`'s new `scope` block) the same way a chosen display already
  was. Record is disabled until a region/window scope actually has a target.
- "Profile" is the sheet's toggle only in this pass — there is no saved/
  switchable-profiles feature yet. See CLAUDE.md's STC-374 entry for why.

## 0. Build and the no-hardware checks

```
git pull && helper/build.sh
npm run typecheck && npm test
```

`npm test` covers `settings.test.ts`'s round-trip/validation of the new
`scope` block and the E2E wiring in `scope-picker.e2e.test.ts` (synthetic
overlay input, the real IPC, the real `settings.json`). Nothing here needs a
grant.

## 1. Look at the stripped window

Launch the app normally (`npm run app:start`). At rest, the window should
show exactly: Record, Shot, the Camera checkbox, a Profile button,
the state readout, the Scope picker and its source control, the telemetry
table, and the take grid. Nothing else.

- Does the row read as one coherent instrument, or as controls added in
  passes (which they were)?
- Is "Profile" legible as a settings entry point, or does it read like it
  should do something else (start a recording profile, switch a mode)?

## 2. The profile sheet

Click Profile. It should slide in from the right, over the take grid,
holding "Still capture" (destination, panel corner, timeout, settle action,
skip) and "Capture shortcuts" underneath.

- Does the slide read as a panel (dismissible, part of this window) or does
  it feel modal (like it should have a scrim, or block the rest of the
  window)? The ticket left this open and a slide-over was chosen without a
  design doc to check it against — this is the first real look at whether
  that reads right.
- Close it with the × button, then reopen it, then close it with Escape.
  Does Escape feel right, or does it fight with anything else that uses
  Escape (the shortcuts editor's own "stop listening" behaviour, if a
  shortcut row happens to be focused)?
- Everything inside still needs to work exactly as it did in the main flow:
  changing the still destination, the thumbnail corner/timeout/settle/skip,
  rebinding a shortcut, restoring defaults, the shutter-sound checkbox.

## 3. The scope picker and source control

- Screen (the default): the source control is the existing display picker.
  Confirm it still behaves exactly as STC-247 left it — automatic vs. a
  named display, a stale choice shown as "not connected".
- Window: switch Scope to Window. Record should grey out and the source
  control should read "No window chosen" with a "Choose window…" button.
  Click it — the same crosshair/window-highlight overlay `capture-still`
  opens should appear. Pick a real window. The overlay should close, the
  source control should show that window's app and title, and Record
  should become available again.
- Area: switch Scope to Area, click "Choose area…", drag a marquee, confirm
  it. The source control should show the picked size (e.g. "640 × 400").
- Press Record with a Window or Area scope picked. Confirm the recording
  really is scoped to that window/area — not the whole display — by
  watching it happen and then opening the export.
- **RUN 2026-09-14: confirmed working**, and found the one real gap in this
  section — there was no way back to "nothing chosen" without reopening the
  picker. Fixed the same day: a **Clear** button next to each source control
  (`#clearwindow`/`#clearregion`) forgets the pick without touching Scope.
  Re-picking (clicking "Choose window…"/"Choose area…" again) still works as
  the way to change your mind to a DIFFERENT target; Clear is for "nothing"
  rather than "something else".
- Cancel a pick (Escape inside the overlay) with nothing previously chosen,
  and confirm Record stays correctly disabled and the source control still
  reads "No … chosen" — nothing should silently fall back to Screen.

## 4. A real window mid-recording

STC-370's own runbook already covers a window resizing, closing, or moving
during a take captured by `windowId` — read that first
(`docs/STC-370-RUNBOOK.md` §3). What is new here is only the PICKING: does
choosing a window through this app's own button feel like the same gesture
still capture already has, or does anything about doing it for a recording
(rather than a one-shot still) feel like it needs different wording or a
different affordance (e.g. "this window will be recorded until you stop",
since a recording is open-ended in a way a still is not)?

**RUN 2026-09-14: confirmed through this app's own picker, not just STC-370's
hand-crafted IPC.** A resize stops the recording; a plain move does not
interrupt it — exactly the behaviour STC-370's own hardware run already
established for `windowId` scope, now verified end to end starting from the
"Choose window…" button rather than a raw `start` command. All four sections
of this runbook are RUN.
