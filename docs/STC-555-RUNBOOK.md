# STC-555 runbook: closing a recorded window says "Window closed"

Branch: `accounts/stc-555-window-close-not-resize` until it merges, then `master`.

```
git fetch origin
git checkout accounts/stc-555-window-close-not-resize
helper/build.sh
npm run app:start
```

## What changed

Closing a window animates it: it shrinks toward its centre before it is gone.
The window watcher polls once a second, and on 2026-10-16 a poll landed inside
that animation on a closing Finder window, read a smaller window, and stopped
the take as `window-resized`. The pill and the panel said "Window resized".

Now a size change is only a suspicion. The watcher looks again 0.5 s later
(`WINDOW_RESIZE_RECHECK_SECONDS`, `decideWindowPoll` in
`helper/src/CaptureDecisions.swift`):

| at the re-check | result |
|---|---|
| window gone | stops as `window-closed` |
| window there, another size | stops as `window-resized` (AVAssetWriter cannot change size mid-file) |
| window back at its start size | keeps recording |

## 1. Close a window

1. Open a Finder window. Record it (Window scope).
2. After a few seconds, close it with the red button.
3. **Expect:** the pill says **Window closed**, then the panel says
   "The window you were recording was closed."
4. Check the take's `anchors.json`: `stop.reason` is `window-closed`.

Do it 3 times. The bug depended on where the 1 Hz poll fell, so one pass
proves little. Also try ⌘W.

## 2. Resize a window

1. Record a Finder window again.
2. Drag its corner to resize it, and let go at a clearly different size.
3. **Expect:** the pill says **Window resized**, within about 1.5 s of the
   resize. `stop.reason` is `window-resized`.

## 3. (Optional) resize and put it back

Drag the corner out and back to roughly where it started, within a second.
The take may keep recording; that is intended if the window ends at its start
size (within half a point). Report what happened either way.

If §1 still says "Window resized", copy `anchors.json` and the terminal's
`window: size changed to …` line. That line means the re-check fired.
