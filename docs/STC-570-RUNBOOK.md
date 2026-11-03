# STC-570 runbook — Shot Previous Area

Run from `accounts/stc-570-capture-previous-area` until it merges. Needs a Mac; a second display makes §3 and §4 possible.

What CI settles: the remember/validate rule (`app/test/previous-area.test.ts`), the settings round trip, the shortcut's binding, collision and ⇧ variant (`app/test/hotkeys.test.ts`), and that the helper's `devices` reply carries a `uuid` string per display (`helper/test/ipc.test.ts`). What it cannot settle is below.

Rebuild the helper first (`helper/build.sh`): the display `uuid` is new, and an old binary makes every retake fall back to the overlay.

## 0. Bind it

Settings > Shortcuts > **Shot Previous Area** ships unbound. Bind it (for example ⌥⌘6). Binding it to a key another action holds must say the key is taken.

## 1. After a Shot Area

1. Shot Area (⌥⌘1), drag a rectangle, finish. The panel appears.
2. Press the new shortcut. **Expected:** the same rectangle is shot at once, no overlay, no drag. Compare the two shots' pixel sizes.
3. Hold ⇧ with it. **Expected:** the clipboard outcome, as for Shot Area.

## 2. After a region recording

1. Record (⌥⌘4), drag a different rectangle, record a few seconds, stop.
2. Press the new shortcut. **Expected:** a shot of the recording's rectangle as a still, no drag.
3. A window shot or a window recording in between must NOT change what the shortcut retakes.

## 3. Relaunch

Quit and relaunch Capture, then press the shortcut. **Expected:** the same rectangle. `settings.json` holds `previousAreas` keyed by the display's UUID.

## 4. A changed layout falls back to the overlay

Each of these should open the normal selection overlay, never a clipped or off-screen shot:

- Unplug the display the rectangle was picked on (second-display Macs).
- Change the picked display's resolution in System Settings > Displays so its point size changes. This is the case the stored display size exists for: the rectangle may still fit, and would frame something else.
- Press the shortcut with nothing remembered yet (delete `previousAreas` from `settings.json`).

Replug the display: the rectangle should come back (the UUID outlives the numeric id).

## 5. Shared overlay

This change does not edit the overlay, but the fallback opens it. Check a fallback overlay still ends in a normal Shot Area, and that Shot Area, Record and Shot Window still work as before.

## Not settled here

- Latency: a retake asks the helper for `devices` (cameras and mics included) to get display UUIDs. It is one round trip; if a retake feels slower than Shot Full Display, a display-only verb is the follow-up.
- The tray's "Shot Previous Area" item shows whether or not the shortcut is bound, like Pick Color.
