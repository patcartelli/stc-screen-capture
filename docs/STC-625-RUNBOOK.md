# STC-625 — window select by what's visible, on a Mac

Run from `accounts/stc-625-window-hit-test` until it merges, then `master`.
The helper must be REBUILT: `app:start` never rebuilds it, and an older
helper sends no `visible` field. Main then falls back to each window's whole
frame (the pre-STC-380 picker), so a run on a stale helper tests the wrong
thing.

```
git fetch origin && git checkout accounts/stc-625-window-hit-test
helper/build.sh
npm run app:start
```

What already ran: the Swift hit-test (`pickableWindows`/`windowAt`,
`helper/test/still/main.swift`, a hand-built stack of three overlapping
windows) and the overlay's reducer (`app/test/selection.test.ts`). The e2e
case (`still-overlay.e2e.test.ts`, a stand-in helper's corner window) runs on
CI. None of this has seen a real desktop.

## §1 — the ticket's acceptance: three overlapping windows

Open three windows (Finder, TextEdit, Terminal will do):

* **A** on top.
* **B** behind A, with only a small corner showing (a few dozen points).
* **C** entirely behind A.

Press the still hotkey (or Record), Space for window mode, and move the pointer.

* Over A: A tints. Over B's corner: B tints, **only the corner**, with no tint
  over A and no outline for B's covered part.
* Anywhere over where C sits: A tints. **C never tints.**
* Click B's corner. The shot must contain **all of B**, including the part A
  covers. Open it from the panel and check.
* The chip shows B's name and its WHOLE size (not the corner's), and sits at
  the corner rather than at B's covered top-left.

## §2 — edges

* A window dragged mostly off the display: hoverable on the part that shows,
  and the capture is the whole window.
* Bare desktop: nothing tints and a click does nothing.
* Esc cancels from a hover.
* Hover a window, let it close (a Terminal running `sleep 5; exit` works),
  then click where it was. The overlay still holds the list it opened with,
  so the click names the closed window and the helper refuses it. Expect the
  toast "That window closed" and no shot. Do the same from Record and expect
  "That window closed" with nothing recorded.
* Hover a window, let it MOVE (drag it with a second pointer, or let an app
  reposition it), then click its old place. The capture is that whole window
  wherever it now is: a shot is taken by window id, not by place.

## §3 — the one call made without you

Only **layer-0** windows (ordinary app windows) count as covering something.
The Dock, the menu bar, floating panels and Capture's own overlay and pill sit
on other layers, so they are never targets and never hide a window. That is
the occluder set STC-481 measured working. The cost: hover a window where
the **Dock** is over it, and that window tints under the Dock.
If that reads wrong, the fix is to let the Dock and menu bar occlude too
(`Still.swift`'s `windows` verb). Say so and it is a small change.

## §3a — the camera pointer

In window mode the pointer is a camera (`app/renderer/cursor-camera.svg`,
hotspot the lens centre); in area mode it stays the crosshair. Check that it
is sharp on a retina display rather than a blurry 1x bitmap, and that it
reads over a light and a dark window.

## §4 — does the tint read

The highlight is now an 18% accent fill with no border (an outline on each
piece of a region would draw seams inside one window). Judge whether a
selected window is obvious enough over a busy window and over a dark one. If
not, the dial is the 18% in `#highlight .tint` (`app/renderer/overlay.html`).
