# STC-381 — the scope indicator's confirmation flash: what to run on the Mac

Written on a Linux session with no display server other than a bare Xvfb (no
window manager). `app/test/scope-indicator.e2e.test.ts` drives the real
`flashScopeIndicator` wiring against `_fake-helper.mjs`'s stand-in window
list, and proves the MECHANISM — a second `BrowserWindow` appears the instant
a window or area is picked, disappears on its own after `FLASH_HOLD_MS`, and
is cancelled early by a scope change, a Clear, or Record. It cannot show what
the outline actually LOOKS like, whether the hold duration feels right, or
whether it reads as helpful now that it is a flash rather than a persistent
overlay. That is this file's job.

## The design changed once already, from real-hardware feedback

The FIRST cut showed the outline on every main-window focus, for as long as
Scope stayed Window/Area — the ticket's own "Decided approach". Run on real
hardware (2026-09-15) it read as naggy rather than helpful: reassuring the
first time, background noise on every subsequent focus. This is the answer —
a brief confirmation flash right after picking, gone on its own — and the
`docs/STC-381-RUNBOOK.md` you are reading now is checking THAT design, not
the persistent one this file used to describe.

## What changed

- `app/src/scope-indicator.ts` (pure, unchanged from the first cut) decides
  WHAT to outline — `resolveIndicatorTarget(scope, displays, liveWindow)`.
- `app/src/scope-indicator-window.ts` (mechanics, rewritten) has exactly one
  entry point that ever shows anything: `flashScopeIndicator`, called once
  from `pickCaptureTarget` right after a fresh pick resolves. It shows the
  outline for `FLASH_HOLD_MS` (2000, untuned — see §1) then hides itself with
  no further input. There is no focus/blur wiring to the main window at all
  now. `hideScopeIndicator` cancels an in-progress flash early — called from
  `recorder:setSettings` on any scope-affecting write (a kind change, a
  Clear) and as the very first line inside `recorder:start`.
- `app/renderer/scope-indicator.html` is unchanged: a 3px solid border in the
  app's existing `--accent` token (`#3b6fe0` light / `#7aa2ff` dark), no
  script, no preload.

## §1 — does the flash appear, on the right display, at the right spot, for the right length of time

1. Launch the app normally (`npm run app:start`).
2. Scope → Window, pick a window on your SECONDARY display if you have one
   (or the only display if not).
3. **Expect**: the moment the pick resolves (the overlay closes), a thin blue
   (or light-blue in dark mode) outline appears around exactly that window,
   on the display it is actually on — then fades from view on its own a
   couple of seconds later with no click, no refocus, nothing.
4. Repeat for Scope → Area with a drawn region.
5. **Expect**: Scope → Screen never shows an outline at all — nothing to
   confirm, since the whole display is already unambiguous.
6. Judge `FLASH_HOLD_MS` (currently 2000): does it disappear before you've
   had a chance to actually look, or does it linger annoyingly? This is the
   one number in this ticket most likely to need retuning from a real look —
   change the constant in `scope-indicator-window.ts` if so, and say what you
   changed it to and why.

## §2 — cancelled early, correctly

1. Pick a window or area, and WHILE the flash is still showing (within the
   couple of seconds from §1): change Scope to the other of Window/Area, or
   to Screen, or click Clear. **Expect**: the outline disappears at once,
   well before its own timer would have ended it.
2. Pick a window or area and press Record immediately, before the flash would
   have finished on its own. **Expect**: the outline is gone before (or
   indistinguishably close to) the recording actually starting, and never
   visible in the resulting export — this is the one property that actually
   matters here; everything else in this file is affordance.

## §3 — tracks the window that was actually picked

1. Scope → Window, pick a window whose title bar and edges you can clearly
   see against the desktop.
2. **Expect**: the flash's rectangle matches that window's real bounds
   exactly (not a stale/cached size, not another window). Since the flash is
   fired immediately after the pick now, there should be no visible lag or
   mismatch to catch — if there is, that is a real bug, not a design
   question.

## §4 — is a flash the right call at all

The original ticket's open question — "does an outline appearing on every
focus read as helpful or naggy" — is now answered (naggy; that is WHY this
became a flash). The live question this design raises instead: does a couple
of seconds right after picking give enough time to actually register what
was chosen, especially on a large or 4K display where the outline might sit
far from where you were looking? If not, say so and what would help instead
(longer hold, a distinct look, a reachable way to re-trigger it) — but do not
casually make it persistent again without re-reading why the first version
was dropped.
