# STC-381 — the scope indicator's confirmation flash: what to run on the Mac

Written on a Linux session with no display server other than a bare Xvfb (no
window manager). `app/test/scope-indicator.e2e.test.ts` drives the real
`flashScopeIndicator` wiring against `_fake-helper.mjs`'s stand-in window
list, and proves the MECHANISM — a second `BrowserWindow` appears the instant
a window or area is picked, exists no longer than `FLASH_HOLD_MS +
FLASH_FADE_MS`, and is cancelled well before that by a scope change, a Clear,
or Record. It cannot show what the outline actually LOOKS like, whether the
fade reads as smooth, or whether the timing feels right. That is this file's
job.

## This design has moved three times already, each time from real-hardware feedback

1. **The FIRST cut** showed the outline on every main-window focus, for as
   long as Scope stayed Window/Area — the ticket's own "Decided approach".
   Run on real hardware, it read as naggy: reassuring once, background noise
   on every later focus.
2. **The SECOND cut** replaced that with a flash held for 2000ms right after
   picking. Still read as lingering.
3. **The THIRD cut** shortened the hold to 450ms with a hard cut at the end.
   Read as buggy — an outline present one frame and gone the next looks like
   a rendering glitch, not an intentional dismissal.
4. **What ships now**: hold briefly (`FLASH_HOLD_MS`, 200ms), then FADE to
   transparent (`FLASH_FADE_MS`, 250ms) via `BrowserWindow.setOpacity()`
   stepped from the main process — no renderer script, `scope-indicator.html`
   is still static. Total time on screen: 450ms, same order of magnitude as
   cut 3, but ending smoothly instead of cutting.

Each of these was a live product call made watching the app run, not a
request written down in advance — which is also why this file keeps getting
rewritten rather than just amended. If you find yourself wanting to change
this again, that is expected; say what you changed and why, the same way the
last three changes are recorded here.

## What changed

- `app/src/scope-indicator.ts` (pure, unchanged since the first cut) decides
  WHAT to outline — `resolveIndicatorTarget(scope, displays, liveWindow)`.
- `app/src/scope-indicator-window.ts` (mechanics) has exactly one entry point
  that ever shows anything: `flashScopeIndicator`, called once from
  `pickCaptureTarget` right after a fresh pick resolves. It shows the outline
  at full opacity for `FLASH_HOLD_MS`, then fades it to 0 over
  `FLASH_FADE_MS` in ~16ms steps, then destroys the window. There is no
  focus/blur wiring to the main window at all. `hideScopeIndicator` cancels
  an in-progress flash (hold OR fade) immediately — called from
  `recorder:setSettings` on any scope-affecting write (a kind change, a
  Clear) and as the very first line inside `recorder:start`.
- `app/renderer/scope-indicator.html` is unchanged: a 3px solid border in the
  app's existing `--accent` token (`#3b6fe0` light / `#7aa2ff` dark), no
  script, no preload.

## §1 — does the flash appear, hold, and FADE — not cut

1. Launch the app normally (`npm run app:start`).
2. Scope → Window, pick a window on your SECONDARY display if you have one
   (or the only display if not).
3. **Expect**: the moment the pick resolves (the overlay closes), a thin blue
   (or light-blue in dark mode) outline appears around exactly that window,
   on the display it is actually on — holds for a beat, then visibly FADES
   out rather than vanishing between two frames.
4. Repeat for Scope → Area with a drawn region.
5. **Expect**: Scope → Screen never shows an outline at all — nothing to
   confirm, since the whole display is already unambiguous.
6. Judge the two constants in `scope-indicator-window.ts`:
   - `FLASH_HOLD_MS` (200): long enough to register before it starts fading?
   - `FLASH_FADE_MS` (250): does the fade itself look smooth (macOS's own
     `setOpacity` may or may not interpolate at the OS level — this steps it
     manually from JS, so stutter here is informative, not a given)?
   Change either if wrong, and say what you changed it to and why — this is
   the third round of exactly that.

## §2 — cancelled early, correctly, whether mid-hold or mid-fade

1. Pick a window or area, and WHILE the outline is still visible (holding OR
   already fading): change Scope to the other of Window/Area, or to Screen,
   or click Clear. **Expect**: the outline disappears at once — no partial
   fade left hanging, no jump to a new position.
2. Pick a window or area and press Record immediately. **Expect**: the
   outline is gone before (or indistinguishably close to) the recording
   actually starting, and never visible in the resulting export — this is
   the one property that actually matters here; everything else in this file
   is affordance.

## §3 — tracks the window that was actually picked

1. Scope → Window, pick a window whose title bar and edges you can clearly
   see against the desktop.
2. **Expect**: the flash's rectangle matches that window's real bounds
   exactly (not a stale/cached size, not another window). Since the flash is
   fired immediately after the pick, there should be no visible lag or
   mismatch to catch — if there is, that is a real bug, not a design
   question.
