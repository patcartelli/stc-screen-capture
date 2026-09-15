# STC-381 — the persistent scope indicator: what to run on the Mac

Written on a Linux session with no display server other than a bare Xvfb (no
window manager). `app/test/scope-indicator.e2e.test.ts` drives the real
`attachScopeIndicator` wiring against `_fake-helper.mjs`'s stand-in window
list, and proves the MECHANISM — a second `BrowserWindow` appears on focus
only when Scope is Window/Area with a resolved target, disappears on blur,
on a scope or Clear change even while still focused, and within one IPC
round trip of Record. It cannot show what the outline actually LOOKS like,
whether it reads as intrusive, or whether a live window really tracks under
real window-manager focus semantics. That is this file's job.

## What changed

- `app/src/scope-indicator.ts` (pure) decides WHAT to outline —
  `resolveIndicatorTarget(scope, displays, liveWindow)` — given the current
  scope, the live display list, and (for a window scope) a FRESH lookup of
  that window's current bounds.
- `app/src/scope-indicator-window.ts` (mechanics) creates one non-interactive,
  click-through `BrowserWindow` sized and positioned exactly to the target
  rect, wired to the main window's `focus`/`blur`, and to two explicit
  triggers from `main.ts`: `scopeIndicatorScopeChanged()` (called after any
  settings write that could change scope — a kind change, a pick, a Clear)
  and `hideScopeIndicatorForRecording()` (the very first line inside
  `recorder:start`, before the helper is ever touched).
- `app/renderer/scope-indicator.html` is the whole view: a 3px solid border
  in the app's existing `--accent` token (`#3b6fe0` light / `#7aa2ff` dark),
  no script, no preload.

## §1 — does the outline appear, on the right display, at the right spot

1. Launch the app normally (`npm run app:start`).
2. Scope → Window, pick a window on your SECONDARY display if you have one
   (or the only display if not).
3. Switch to another app, wait a couple of seconds, switch back.
4. **Expect**: the moment the main window's window regains focus, a thin
   blue (or light-blue in dark mode) outline appears around exactly that
   window, on the display it is actually on.
5. Repeat for Scope → Area with a drawn region. Repeat for Scope → Screen and
   confirm NO outline ever appears (nothing to confirm — the whole display is
   already unambiguous).

## §2 — does it track a REAL move/resize, not a stale snapshot

1. Scope → Window, pick a window.
2. With the main window focused (outline showing), drag or resize the
   PICKED window (not the recorder's own window).
3. Click away and back to the recorder to force a fresh focus.
4. **Expect**: the outline redraws at the window's new position/size, not
   where it was when picked. If the window was closed instead, **expect**:
   no outline at all (refuse to draw a stale rect) — check the debug console
   for anything unexpected, but this should be silent from the user's POV.

## §3 — does it correctly disappear

1. With the outline showing (Window or Area scope, focused): switch to
   another app. **Expect**: outline gone immediately.
2. With the outline showing: change Scope to Screen, or to the other of
   Window/Area, or click Clear. **Expect**: outline gone at once, with NO
   need to blur/refocus first.
3. With the outline showing: press Record. **Expect**: outline gone before
   (or indistinguishably close to) the recording actually starting, and
   never visible in the resulting export — this is the one property that
   actually matters; everything else here is affordance.
4. During a live recording, click the collapsed pill to bring the window
   forward (if that gesture exists on this build). **Expect**: no outline
   appears even though the window is now focused — `reconcile` refuses to
   draw while `sup.state` is `"recording"`.

## §4 — the ticket's own open question

> Whether an outline appearing every time the app regains focus reads as
> helpful or naggy — a Mac call, not a geometry one.

Use the app for a normal session with Window or Area scope set (pick once,
then just work — switch apps, come back, check the debug table, switch away
again, several times over a few minutes) and note a gut reaction: does the
outline read as reassuring ("yes, that's still what I'm about to record") or
as a flicker you start tuning out? There is no acceptance criterion attached
to this — it is a design question for whoever reads this runbook to decide,
and the write-up should say which way it landed and why, so the decision is
made once rather than re-litigated the next time someone notices the
outline.
