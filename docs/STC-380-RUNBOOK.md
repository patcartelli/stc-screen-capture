# STC-380 — the window picker's visibility flag, on a Mac

Written on Linux, with no `swiftc`, so the Swift half (`isFullyVisible` and
its wiring into the `windows` verb) has never actually run — it is reasoned
about and unit-tested by hand-computed fixtures
(`helper/test/still/main.swift`), the same position most Swift tickets in
this file start from. The TS half (the picker's refusal to select a
not-fully-visible window, and its dashed-highlight treatment) DID run here —
`app/test/selection.test.ts` (pure) and `app/test/still-overlay.e2e.test.ts`
(a real, driven overlay window under `xvfb-run`, using a stand-in helper
window flagged `fullyVisible: false`) both pass. What is unverified is
whether the Swift geometry (`StillDecisions.swift`'s `subtractRect` /
`remainingFraction` / `isFullyVisible`) agrees with a REAL desktop's windows.

```
npm run app:start
```

## §1 — the case the ticket was filed for

Open two windows so one mostly covers the other, leaving a small sliver of
the back one visible (a few percent of its area, not a clean edge). Open the
scope picker or still-capture window mode and hover that sliver.

* The mostly-hidden window should still highlight — DASHED, not the normal
  solid blue fill — with a caption ending "not fully visible, choose another
  window" rather than a size readout.
* Clicking it (or pressing Return while it is hovered) must do nothing: no
  capture-still request, no recording start, the overlay stays open.
* The window it is hidden under should highlight normally (solid, selectable)
  wherever it is actually on top.

## §2 — a window mostly off every display

Drag a window so most of it hangs off the edge of every connected display
(easy with two displays: drag toward where a THIRD, disconnected display
would be, or far past a single display's edge). Hover the small on-screen
remainder.

* Same dashed/disabled treatment as §1, for the same reason: selecting it
  would capture bounds ScreenCaptureKit cannot render as what the user sees.

## §3 — the epsilon (`VISIBILITY_EPSILON`, 2% of a window's own area)

Hover a window that is essentially fully visible but for an ordinary sliver
another window's title bar or drop shadow happens to clip — the everyday
case, not the deliberately-broken one above.

* This should NOT trip the dashed treatment. If ordinary, unremarkable
  windows are being flagged not-fully-visible, `VISIBILITY_EPSILON`
  (`StillDecisions.swift`) is too tight and needs loosening; if the two cases
  above (§1, §2) are NOT being caught, it is too loose.

## What to write down

Whether `isFullyVisible`'s two independent checks (off-display, occluded) are
each individually reachable on real geometry — a window can be off-display
without being occluded and vice versa, and the fixture math in
`helper/test/still/main.swift` cannot substitute for a real
`SCShareableContent` window list, which may have front-to-back ordering
surprises this file only assumed from `selection.ts`'s existing comment. If
`VISIBILITY_EPSILON` needs to move, it is the one dial — no second copy of it
exists.
