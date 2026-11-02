# STC-628 runbook — window shot looks, with the desktop wallpaper

**Branch:** `accounts/stc-628-window-shot-looks`. Not on `master` yet; run it from there until it merges.

```
git fetch origin
git checkout accounts/stc-628-window-shot-looks && git pull
npm ci
helper/build.sh
npm run app:start
```

## What changed

- A window shot has a **look**, set in **Settings > Capture > Window shot look** and applied the moment
  the shot is taken: **Just the window** (`window-only`), **Window with shadow** (`window-shadow`),
  **Capture background** (the last swatch picked in the still editor, `clean` if none; a Custom pick
  keeps its colours) and **Desktop wallpaper**. **The default is Desktop wallpaper**, existing users
  included.
- The wallpaper is drawn **cover-cropped** behind the window with the same margin (9% of the short
  edge), corner radius and shadow as the swatches, always **Clean's shadow**. Canvas is `natural`.
- `helper/src/Wallpaper.swift` reads it (`helper/src/WallpaperDecisions.swift` decides). Sources in
  order: the wallpaper window captured alone with ScreenCaptureKit (the frame currently showing, no
  icons, no windows), then `desktopImageURL` for a single static picture. The picture is written
  **beside the shot as `wallpaper.jpg`** (JPEG, quality 0.9, display colour space, never larger than
  the display), and `shot.json` names it in `decoration.background.file`. No version bump.
- **No cache.** Every window shot reads the wallpaper fresh. A cache was built and removed: with JPEG
  every read fits gate 3, and a cached read goes stale when the wallpaper changes.
- If the wallpaper cannot be read the shot uses **Clean** and the panel says "Couldn't read your
  wallpaper, so this shot uses Clean." The shot is still taken and saved.
- With **When a shot is taken = Copy to clipboard**, a fallback shot is still copied but the **panel is
  shown anyway** with that line. It reaches the library when you press Save, like any panel-mode shot.
- The still editor's background picker has a **Wallpaper** swatch. Picking it on a shot with no
  wallpaper file reads the wallpaper as it is now from the shot's own display, with the same fallback. A shot that already has `wallpaper.jpg` keeps its capture-time picture when Wallpaper is re-picked.
- `lastBackgroundLook` (the last swatch) is written by main only; `recorder:setSettings` strips it.
- Fault: `STC_CAPTURE_FAULT=wallpaper-unavailable` makes every read fail.

## §0 Measured already (the agent's shell, Patrick's Mac, 2026-11-02)

macOS 27, two displays (5120x2880 main, 3600x2338 side).

- The window list per display (`CGWindowListCopyWindowInfo` and `SCShareableContent`): "Wallpaper"
  (WindowManager, layer -2147483624), an off-screen "Fullscreen Backdrop" (WindowManager), "Display N
  Backstop" (Window Server) and Finder's icon windows. The rule takes the window titled "Wallpaper";
  the Backdrop is never it.
- The capture produced a Display P3 picture of the wallpaper with no icons and no windows (looked at).
- Gate 3 with the wallpaper on display 5 (5120x2880), every read fresh: **steady wall 152-175 ms
  against the 400 budget.** Before the switch to JPEG it was 462-713 ms (PNG encode alone is about
  300 ms for 8 MP; JPEG about 33 ms).
- Patrick's wallpaper there is a folder shuffle, so it is not a single static picture.
- **Not measured:** display 1, a dynamic or aerial wallpaper, a non-main Space, a one-display Mac.

## §1 Grant tests (your terminal; the agent's shell has no Input Monitoring)

Open one ordinary window on the display you want measured first.

```
npm run test:capture
STC_GATE3_DISPLAY=1 npm run test:capture
```

- `helper/test/wallpaper.grant.test.ts` must pass (the shot's wallpaper, the verb, the refusals).
- Gate 3 (`still-gates.grant.test.ts`), both variants (plain and with the wallpaper), must pass at
  `STILL_BUDGET_MS` 200 and `STILL_END_TO_END_MS` 400. Write down `steadyMedian` for each.
- The second command is **display 1's number, never measured**. `STC_GATE3_DISPLAY` filters the
  windows gate 3 shoots to that display. Put the window on display 1 first.
- Gate 6 (a still during a recording) needs Input Monitoring; failing with `event-tap-unavailable`
  without it is environmental.

## §2 Kinds of wallpaper

For each, set Window shot look to Desktop wallpaper, take a window shot, open it in the editor and
look at the background. Check the shot folder has `wallpaper.jpg` and `shot.json` names it.

1. **Static picture** (System Settings > Wallpaper, one image). The background is that picture,
   cover-cropped, no icons, no Dock, no other windows.
2. **Dynamic** (a time-of-day HEIC). The background is the variant showing now, not the first frame
   of the file.
3. **Aerial / Screen Saver video.** The background is the frame showing at that moment. Take two shots
   a minute apart; they may differ, and that is correct.
4. **A folder or shuffle** wallpaper (Patrick's): the shot shows the picture currently on screen.

If the wallpaper window cannot be found, the helper logs the below-normal window list; paste it into
the ticket. Also check a Mac with Stage Manager off, if you have one.

## §3 Two displays, different wallpapers

Give each display a different wallpaper. Put a window on display 2 and shoot it: the background is
display 2's wallpaper, at display 2's size. Repeat on display 1. Then shoot a window straddling both
and say which display's wallpaper it took.

## §4 A window on a non-main Space

Move a window to its own Space (or a full-screen app Space), switch to it, shoot it. Expected: the
wallpaper of the display it is on, as currently shown. In a full-screen Space the desktop is not
visible; if the result is black or the fallback fires, that is a finding, not a pass.

## §5 The fallback

```
STC_CAPTURE_FAULT=wallpaper-unavailable npm run app:start
```

1. **Panel mode.** Take a window shot. It uses Clean (no wallpaper file in its folder) and the panel
   shows "Couldn't read your wallpaper, so this shot uses Clean." in one visible line. The shot is
   saved and listed.
2. **Clipboard mode** (Settings > When a shot is taken > Copy to clipboard). Take a window shot. The
   image is on the pasteboard (paste it) **and** the panel opens with the line. It is not in the
   library until you press Save; press Save and confirm it appears. A normal shot in clipboard mode
   (fault off) stays silent with no panel.
3. **Editor.** With the fault still on, open any shot and pick Wallpaper in the background picker: it
   falls back to Clean with the same line, and nothing is left half-written in the shot folder.

Then relaunch without the fault: Wallpaper works again.

## §6 Settings

Settings > Capture > Window shot look: four choices, operable by keyboard, a visible focus ring, the
selected one announced by VoiceOver, light and dark. A fresh profile (delete `settings.json`) shows
Desktop wallpaper selected. Pick Capture background with no swatch ever picked: shots use Clean. Pick
a swatch (say Ember) in the still editor, then shoot with Capture background: it uses Ember, and
Custom keeps its colours.

## §7 Sign-off (the ticket stays open until you do this)

On a **real capture**, take a window shot in each of the four looks with a **light** window and again
with a **dark** window (eight shots). Export each (PNG at least; HEIC or JPEG for one) and compare it
with the editor's preview and the panel: they must show the same pixels.

Judge:
- **The margin.** Wallpaper and the swatches share one margin, 9% of the short edge. CleanShot's is
  about 13%. If 9% reads thin, say so here; the change is made for **both background looks together**.
- **The JPEG.** On a smooth-gradient wallpaper look for banding, blocking or ringing around the window
  and in the gradient, at 100%. If it shows, the ruling to store JPEG at 0.9 is revisited.
- The wallpaper shows nothing but the wallpaper (no icons, Dock or other windows) in any of the eight.
- The quick path: a default window shot is still one hotkey and no extra step.

Sign-off is Patrick's. Do not close STC-628 on merge alone.
