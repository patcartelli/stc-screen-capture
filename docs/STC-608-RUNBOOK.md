# STC-608 runbook — one set of looks for stills and video

**Branch:** `accounts/stc-608-unify-backgrounds`. Not on `master` yet; run it from there until it merges.

```
git fetch origin
git checkout accounts/stc-608-unify-backgrounds && git pull
npm ci
helper/build.sh
npm run app:start
```

## What changed

- One catalogue, `transform/src/looks.ts`, owns the fill of Clean, Dark, Solid, Aurora and Ember. The
  still looks and the video framing presets both read it.
- A recording can wear **Aurora** and **Ember** (three-stop gradients). `project-21` lets
  `framing.background` be a linear fill of 2 to 8 stops; `versionFor` writes v21 only when a document
  needs it (more than two stops). Everything else stays at its older version.
- The video editor's **Frame tab** picks from the still editor's swatch grid (None, Clean, Dark, Solid,
  Aurora, Ember, Custom), one component for both editors (`app/src/look-grid.ts`).
- Picking a look writes the colours it draws into the project, so retuning a look later does not move a
  recording already framed with it.
- **The per-style tint is gone.** Clean, Dark and Solid are fixed swatches; your own colours are
  Custom's job (one colour = solid, two = linear).
- `gradientLine` exists once; the compositor and the still renderer both use it.

## §1 Sign-off: every look, a still and a recording, side by side

You need a **light** window and a **dark** window on screen. For each look below, with each window:

1. **Still.** Take a window shot (the Window shot look in Settings > Capture can be anything; set the
   look in the still editor's grid). Export PNG.
2. **Recording.** Record the same window for a few seconds, open it in the editor, Frame tab, pick the
   same look. Export the MP4, then grab a frame (editor frame-grab, or open the MP4 and screenshot).
3. Put the two images next to each other. **The background must look the same** (same colours, same
   direction). Padding and corner geometry may differ: a still grows its canvas, video insets the
   picture (design, "Geometry is not unified").

Looks: Clean, Dark, Solid, Aurora, Ember, **Custom with one colour**, **Custom with two colours**
(pick the same colours in both editors).

- [ ] Clean — light window, dark window
- [ ] Dark — light window, dark window (Dark's shadow is deeper in both)
- [ ] Solid — light window, dark window
- [ ] Aurora — light window, dark window
- [ ] Ember — light window, dark window
- [ ] Custom, one colour
- [ ] Custom, two colours
- [ ] Preview and export of a recording agree (scrub to a frame, compare with the exported frame)

## §2 Recordings framed before this change

Recordings made on `master` must open and draw as they did.

- [ ] A take framed **Clean**, one **Dark**, one **Solid** (no tint): each opens with that swatch
  selected and exports the background it always did.
- [ ] A take framed Solid with a **tint**, and one Clean or Dark with an **explicit two-stop
  background** (set on `master`): each draws exactly as before and the grid shows **Custom** selected.
- [ ] An unframed take: **None** selected, no framing in the export.
- [ ] Dark with the **shadow switched off** still shows Dark selected. Switch the shadow on, pick
  another look, then Dark: the shadow comes back deeper.
- [ ] Open an Aurora recording, choose Custom, and edit one colour: the stored `preset` is not
  quietly changed (a Dark recording stays Dark's shadow).

## §3 Keyboard, both grids

On the Frame tab and in the still editor's background picker:

- [ ] One Tab stop: the selected swatch (the first if none).
- [ ] Arrow keys, Home and End move the focus without picking; Enter or Space picks.
- [ ] The `--focus` ring shows on the focused swatch in light and dark; a pick does not lose the
  keyboard focus.
- [ ] Custom's colour field keeps what you are typing while the preview redraws.
- [ ] Reduce Motion on: nothing animates on a pick.

## §4 What only a Mac can settle

- How the grid reads in the **376 px Frame pane**: two rows of four, chip size, whether Custom's row
  fits without crowding Padding, Corners and Shadow below it.
- Whether Aurora and Ember look right behind a recording's picture at 1080p and at Embed size.
- Retuning: values in `looks.ts` are provisional. If a look is wrong, change it there once and run
  `npm run gate:still`.

## §5 Already run (agent's shell, 2026-11-03)

`vitest --project unit`, `npm run typecheck` (three passes), `npm run gate:still`, `npm run gate:identity`
all pass; `transform/test/shot-v1-frozen.test.ts` unchanged. The e2e suite runs on CI only. **None of
this has been watched in the running editor.**
