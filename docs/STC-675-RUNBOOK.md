# STC-675 runbook: the panel's window shot has its look's margin and shadow

Not on `master` yet. Run from branch `accounts/stc-675-panel-window-shot-look` until it merges, then `master`.

```bash
cd ~/dev/stc-screen-recorder && git fetch origin && git checkout --detach origin/accounts/stc-675-panel-window-shot-look && npm run app:start
```

No helper change: no need to rebuild it.

## What changed

The panel laid out `shot.json` as stored. A fresh window shot is stored with no `paddingPct` and no `shadow`, so the panel's picture, Copy, Save and drag-out had no margin and no shadow. The Library and the still editor filled them in. All of them now go through `planStill` (`transform/src/still-plan.ts`), which fills them. `shot.json` is not changed.

## Setup

Settings > Capture > Window shots. Panel on (not clipboard mode). Export scale Native.

## Checks (yes/no)

Desktop wallpaper (the default):

1. Shot a window. The panel's picture shows the wallpaper around the window, with a shadow under it.
2. Save from the panel. Open the PNG: it is bigger than the window, with the wallpaper as a margin and a shadow.
3. Open the same shot in the Library's editor (Redact) and Save there. Both PNGs are the same size (Finder > Get Info, or `sips -g pixelWidth -g pixelHeight <file>`).
4. Copy from the panel and paste into Preview (File > New from Clipboard). Same size as step 2.
5. Drag the panel's picture to the Desktop. Same size as step 2.

Capture background:

6. Pick a swatch in the still editor once, then set this look. Shot a window. The panel and its Save show that swatch as a margin, with a shadow.

Window with shadow:

7. Shot a window. The panel's Save is a PNG with a transparent margin and a shadow, and no background colour.

Just the window:

8. Shot a window. The panel's Save is exactly the window's size: no margin, no shadow. (Control: this look has neither.)

An old shot:

9. In the Library, open a window shot from before this change (for example one from 2026-11-03). It looks the same as before, in the tile and in the editor.

## If a check fails

Send the shot's folder (`shot.json`, the PNG) and say which step.
