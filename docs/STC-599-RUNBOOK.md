# STC-599 runbook: the still editor's background picker

Run from branch `accounts/stc-599-screenshot-backgrounds-expose-the-existing-modes-with-video`
(not on `master` yet).

```
git fetch origin && git checkout accounts/stc-599-screenshot-backgrounds-expose-the-existing-modes-with-video
npm ci && npm run app:start
```

## What was built

- `transform/src/backgrounds.ts`: the picker's looks and what each means in `shot.json`.
  Clean, Dark and Solid read from `FRAMING_PRESETS`; Aurora and Ember are defined there once.
- `still:writeShot` (main.ts) takes an optional `look` (`mode`, `background`, `shadow`); a `null`
  deletes the key. The merged document still goes through `parseShot`.
- The still editor (`still-editor.html`, `still-editor-renderer.ts`) has a radio-group swatch grid
  above the toolbar for window shots with alpha. Display-crop shots do not get it.
- No `shot.json` field is new and no version changes.

Checked on CI-class machines: typecheck (all three passes), the whole unit project,
`transform/test/backgrounds.test.ts` (look values, round trip, Clean-after-Dark clears the fill,
custom validation). **Not run: the e2e suite, and nothing has been looked at in the running app.**

## What only a Mac can settle

Take a real window shot of a light window and of a dark window, open each from the library, and:

1. Each of the eight swatches draws, the preview changes at once, and reopening the shot shows the
   same swatch selected (Window only and Window + shadow included).
2. **Banding.** Export each look as PNG and JPEG and look at Aurora, Ember and Dark at 100%. Dark
   gradients band first. If one bands, dither the fill as a follow-up (the ticket says so).
3. **Provisional values.** Aurora (`#050a12` to `#0d4a52` to `#5b3fd1`, 135) and Ember
   (`#12061a` to `#7a1f5c` to `#ff7a3d`, 160) are judged here, on both window kinds. This is the
   ticket's one open question.
4. Clean, Dark and Solid against the same preset in the video Frame control: fill and shadow
   should agree. The still's margin is roomier by decision, and its corners are the window's own.
5. Custom: starts from `#3b4252`; one valid colour is a solid, two is a 135 degree pair; a bad value
   (`red`, `#abc`) shows its reason in the hint line and writes nothing (check `shot.json` does not change).
6. Keyboard: Tab lands on the grid once; arrows, Home and End move the focus; Enter or Space picks;
   the focus ring is visible; a screen reader announces the selection.
7. A write main refuses puts the previous swatch back and shows the reason. (Easiest way to see it:
   make `shot.json` unwritable while the editor is open.)
8. Library: after a pick, the shot's grid tile shows the new background (the cached thumbnail is
   dropped by `still:writeShot`). Its badge still reads "Window + background" for Clean, Dark, Solid,
   Aurora, Ember and Custom, because `MODE_LABELS` names modes, not looks.

## Left alone on purpose

- `PRESET_PADDING_PCT`, `PRESET_SHADOW`, `shot-v1-frozen` and its fixtures: untouched.
- The post-capture thumbnail card, background images, area-capture backgrounds, a capture-time
  default, the shared still/video model (STC-608).
