# STC-560 runbook — library and Settings window sizes

Run from branch `accounts/stc-560-window-sizes` until it merges, then `master`:

```
git fetch origin && git checkout accounts/stc-560-window-sizes
npm run app:start
```

## What changed

Decided by Patrick (2026-10-19). The logic lives in `app/src/window-size.ts`.

| window | opens at | smallest |
|---|---|---|
| Library | 960 × 720 (four grid columns), or where it last was | 480 × 420 (two columns) |
| Settings alone (menu bar → Settings, no library open) | 560 × 720, one column | 420 × 400 |
| Settings over the library | the slide-over is 440 wide, was 360 | — |

- Every size is clamped to the work area of the display under the pointer and centred there.
- The library writes its place to `settings.json` (`libraryWindow`) when it closes. A Settings-only window never writes it.
- A remembered place is used only while its title bar is on a connected display. It is pulled fully inside that display. Otherwise the default is used.
- When a Settings-only window is asked to show the library (Dock icon, tray Library), it takes the library's place and size.

## What only a Mac can settle

1. **First launch.** To start clean, delete `libraryWindow` from `~/Library/Application Support/<app>/settings.json`. Open the library: it should be 960 × 720, centred, with four columns and no horizontal scroll. Check in light and in dark.
2. **Remembered.** Move and resize the library, close it (⌘W), and open it from the menu bar. It should come back where it was. Quit and relaunch: same. Do it again with the window full screen when you close it: it should come back at its size from before full screen.
3. **Settings alone.** With no library open, choose menu bar → Settings. It should be a 560-wide single column, not stretched. Drag it wider: the rows stop at a readable width. Check that the traffic lights, the header drag and the X (STC-552) behave as before.
4. **Settings becomes the library.** With the Settings-only window open, click the Dock icon. The window should grow to the library's size and show the grid. Then close it, reopen the library, and confirm the size was remembered as the library's and not as Settings'.
5. **Over the library.** Open Settings from the library's Profile button. The 440 sheet should hold Preferences' rows without cramped wrapping. Close it with the X and with ⌘W.
6. **Small display / unplugged display.** Put the library on an external display, close it, and unplug the display. It should reopen at the default on the built-in one. On a small display (or a scaled "larger text" mode), nothing should open past the edge of the work area.

Not decided here, and left alone: the grid's own design (STC-429).
