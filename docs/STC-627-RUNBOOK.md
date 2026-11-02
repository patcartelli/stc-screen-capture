# STC-627 runbook: the color picker

Run from branch `accounts/stc-627-color-picker` (not on `master` yet) until it merges. Then `master`.

```bash
git fetch origin && git checkout accounts/stc-627-color-picker
helper/build.sh && npm run app:start
```

All of this is **host**: it needs a real display and the system loupe.

## What was built, and the two decisions

- **Route: `NSColorSampler` in the helper** (`helper/src/ColorPick.swift`, command `pick-color`), not Chromium's `EyeDropper`. It is the system loupe, needs no Screen Recording grant, and shows real pixels over any app. `EyeDropper` needs a focused renderer and a user activation, which a global hotkey does not have.
- **Space: sRGB, always** (`app/src/color-pick.ts`). Digital Color Meter's sRGB reading is the acceptance, and a hex pastes as sRGB everywhere. A P3 pixel outside sRGB is clamped, and only then does the toast say so.

The action is **Pick Color**, unbound by default (Settings > Shortcuts > Tools), and is in the menu bar.

## 1. Bind it and pick (host)

Settings > Shortcuts > Tools > Pick Color: record a key (not `⇧⌘5`). Press it from another app.

| check | expected |
|---|---|
| the loupe appears under the pointer | the system loupe, showing the real screen |
| click a pixel | toast with a swatch of that color and `#rrggbb`; the clipboard holds the same string |
| Esc | loupe closes, no toast, the clipboard is unchanged |
| press the key twice quickly | one loupe, not two |
| menu bar > Pick Color | same as the key |
| press during a recording | the loupe works and the take is unaffected (it can appear in the take) |

Try it over a window, the wallpaper and a playing video.

## 2. Against Digital Color Meter (host)

Set Digital Color Meter to "Display in sRGB" (Color > Display in sRGB, hex). Pick the same pixel in both, on a flat color. They must agree within rounding (1 level).

## 3. Displays (host)

Do section 2 on the **built-in P3 display** and on an **external sRGB display**. On P3, pick a saturated red or green from a P3-only image (for example a P3 test swatch): if the toast says "clamped to the nearest sRGB value", the hex is the nearest sRGB color, which is the intended behaviour. A plain UI color must never say clamped.

## 4. Things only the Mac can settle

- Whether the loupe appears at all from a background helper with no window (`NSColorSampler` is normally called from an app that can be active). If it does not, the toast says "Couldn't pick a color" with the reason. Report what it says.
- Whether the toast's swatch is visible against a dark and a light desktop (it has a hairline inset border).
- Whether `prefers-reduced-motion` leaves the toast fading rather than sliding (it reuses the existing message toast).
