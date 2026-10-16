# STC-550 runbook — the pill's own window

**Branch:** `accounts/stc-550-pill-own-window` until it merges, then `master`.

```bash
git fetch origin && git checkout accounts/stc-550-pill-own-window
```

```bash
helper/build.sh && npm run app:start
```

The helper changed too (`start` takes `excludeWindowIds`), so rebuild it.
`app:start` does not do that for you.

## What changed

The pill is no longer the library window collapsed to 26px. It is its own
window, one per take:

1. Made before `start` at opacity 0 and click-through, top-centre of the
   recorded display. Its window id goes to the helper as `excludeWindowIds`.
2. Made visible once the helper has confirmed the take (not on the click).
3. Destroyed when the take is over. The next take's pill opens top-centre again.

The library is `hide()`n for the take if it was on screen, and shown again
(without focus) afterwards. A minimized library is not touched. No library is
ever made for a take.

**Stop is now the square button only.** The whole pill is a drag handle, and a
drag region takes no clicks, so clicking the timer no longer stops the take.

## Results

- **2026-10-15, Patrick's Mac, this branch:** a full-screen take did NOT have
  the pill in the recording, and the pill opened top-centre. So ScreenCaptureKit
  does list a window shown at opacity 0 as on screen, and the exclusion holds.
  The first attempt that day ran `master` by mistake (pill in the take, not
  centred). Check the prompt says this branch before judging a result.
- **Same day, full pass:** §1 (`screencapture` shows the pill; an Area take
  over the top-centre exports without it), §2, §3, §6 and §8 PASSED. §7: Stop
  works and a new take opens top-centre.
- **Three found and fixed the same day (re-check these):**
  - §9: closing a recorded window went straight to the panel, with no
    "Window closed" on the pill. The supervisor emits `take-ended` before
    `recording-ended`, and the pill was put away on the first. Pinned by
    `app/test/pill-dwell.test.ts`.
  - §4: after ⌘H, the library came back when Record was chosen from the menu
    bar (the overlay activates the app, which unhides it) and again after the
    take. The library's state is now read when the Record flow starts.
  - §7: the drag moved the pill once and never again (the native
    `-webkit-app-region: drag`). Replaced with the page's own pointer events,
    which also ease the motion as asked (direct under Reduce Motion).
- **After CI (also re-check):** the pill is now `focusable: false`. On CI a
  take started from the menu bar with no window open gave the pill key
  status, so it held the keyboard. Check on hardware that Stop still works on
  the first click and that the drag still moves it, in §5 and §7.
- **2026-10-16 re-check, this branch:** §4 PASSED (⌘H, then record: the
  library stays hidden). §7 PASSED (drags repeatedly, eased). §9's dwell
  PASSED: closing a recorded window showed the stop label on the pill before
  the panel. The label read "Window resized", not "Window closed": the
  helper's 1 Hz window watcher caught Finder's close animation mid-shrink
  (the take's window track shows the origin moving +3/+3 pt at 14.22 s, the
  stop 90 ms later). That's the helper's reason, from STC-370's watcher, not
  this ticket's pill; it's a separate fix.
- Not yet run: §5.

## §1 The one open question: is the pill out of the video? (requirement 9)

The helper can only exclude a window that ScreenCaptureKit lists as on screen.
The pill is on screen at opacity 0 when `start` is sent. Nobody has seen yet
whether SCK lists a window at alpha 0. If it doesn't, the pill is silently NOT
excluded, and the helper logs:

```
start: excluding 0 of 1 requested windows; the rest are not on screen
```

1. Record a full-screen take for ~10 s. Move the pointer over the pill, so it
   is obviously "there", and stop.
2. Open the take in the editor and export it. **The pill must not be in any
   frame.**
3. Repeat with an **Area** take whose region covers the top-centre of the
   screen. Same result expected.
4. In the terminal running the app, look for the `excluding N of M` line. It
   should not appear. If it does, §1 failed for the reason above; report it
   with the line.

**And it must still be visible to everyone else** (STC-404's behaviour,
requirement 7). During a take, run:

```bash
/usr/sbin/screencapture -x /tmp/pill-check.png && open /tmp/pill-check.png
```

The pill must be in that screenshot. A Zoom or Meet share to yourself is the
stronger check if you have one handy.

## §2 Library open (acceptance 1)

1. Open the library and move it somewhere distinctive. Resize it.
2. Record. The library disappears with no minimize animation. The pill appears
   **top-centre, just under the menu bar, on the recorded display**.
3. Stop. The panel goes up in front. The library comes back **at the same
   place and size**, behind the panel, and the panel has the keyboard
   (Escape works on it).

## §3 Library minimized (acceptance 2, the STC-538 repro)

1. Open the library, minimize it to the Dock.
2. Record. The pill appears top-centre. The library stays in the Dock.
3. Stop. The library is still minimized.

## §4 App hidden with ⌘H (acceptance 3)

1. Open the library, press ⌘H.
2. Record from the menu bar or the hotkey. **The pill appears.**
3. Stop. The library stays hidden (it wasn't on screen when the take started).

Known edge, not fixed here: unhiding the app so the pill can show also unhides
any other window that was hidden with it, an open editor for example. Note it
if you see it.

## §5 No window (acceptance 4, the STC-524 repro)

1. Quit, relaunch (menu bar only, no library), record from the hotkey.
2. Pill appears. Stop. **No library appears.**

## §6 Two displays (acceptance 5)

1. With a second display, record it (Screen on the secondary, or an Area or a
   window on it).
2. The pill is top-centre **of the secondary**.

## §7 Drag (acceptances 6, 7)

1. During a take, drag the pill by its timer or dot to another spot. Then drag
   it again, and a third time: the first version only moved once.
2. It follows the pointer with a short settle, not a jump. With System
   Settings → Accessibility → Display → Reduce motion on, it tracks the
   pointer directly. Clicking Stop still ends the take, on the first click,
   **without bringing Capture to the front** (the app you were recording keeps
   focus).
3. Start another take. The pill is back at top-centre.

## §8 Dock icon (acceptance 8)

1. Settings → Show icon in: **Menu bar only**. Close the library. Record.
   **No Dock icon appears** at any point in the take.
2. Settings → **Dock** (or both). Record and stop. The Dock icon may go during
   the take: Electron hides it so a window can float over fullscreen apps, and
   the overlay and countdown already did this before STC-550. **It must come
   back after the take.** Before this ticket nothing brought it back.

## §9 Things that carried over and need a glance

- Timer, mic meter (live / hatched / no-signal dot), "Mic lost" notice, a
  helper-decided stop's label ("Window closed") showing for ~2 s before the
  panel: all as before, in the new window.
- Pill legibility over a light and a dark background (the ring).
- A Space switch mid-take, and a fullscreen app: the pill stays.
