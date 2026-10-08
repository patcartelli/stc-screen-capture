# STC-502 runbook — launch to the menu bar

Run from `accounts/stc-502-launch-to-the-menu-bar-no-library-window-by-default-library` until it merges, then from `master`.

```
git fetch origin && git checkout accounts/stc-502-launch-to-the-menu-bar-no-library-window-by-default-library
npm run app:start
```

The tests prove the rule (`icon-placement.test.ts`) and, on CI's macOS, the launch, the Dock click and the three settings (`launch-no-window.e2e.test.ts`). What only a Mac with eyes can settle:

## 1. Cold launch

- [ ] Quit Capture, launch it. **No window opens.** The menu-bar item and the Dock icon (Capture's own icon, STC-503) are both there.
- [ ] Click the Dock icon. The library opens, once. Click it again: it raises the same window.
- [ ] Menu bar → Open Library does the same. Close the library with the red light: the app keeps running, menu bar and Dock unchanged.

## 2. Show icon in (Settings sheet, Preferences, bottom)

- [ ] **Menu bar and Dock** (default): open and close the library and an editor several times. The Dock icon never moves.
- [ ] **Dock only:** the menu-bar item disappears the moment you pick it, no relaunch. Dock icon stays. A hotkey shot still works. Pick Menu bar and Dock again and the item returns.
- [ ] **Menu bar only:** with a window open the Dock icon is there and the window is in Cmd-Tab. Close the last window (library, editor and still editor all count) and the Dock icon leaves. A shot's overlay and floating panel do not make it flash.
- [ ] The choice survives a quit and relaunch.

## 3. Judgement calls

- Does the Dock icon leaving in Menu bar only feel like a bug when you close a window and the app seems to vanish? That is the decided behaviour; flag it if it reads badly.
- Dock only has no menu-bar recording indicator, only the pill. Is that enough?

## Not in this ticket

Record and Shot buttons are still in the library window; launch at login is not offered. Empty/loading library states are STC-521.
