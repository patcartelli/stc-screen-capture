# STC-396 — Video framing presets (design)

Status: DRAFT for review, 2026-10-02. Branch `accounts/stc-396-video-framing-presets`.
Source: STC-396, from STC-382's session outcomes v2 (handoff §7a).

## Goal

A video take can export with static chrome around the moving picture: a
background, padding, rounded corners and a shadow, chosen from a few presets.
It carries over from the decorated stills (STC-291), adapted to the limits
video has and a still does not.

Not in this ticket (the ticket says so): annotation markers (need timing, belong
to the editor), tracked redaction (computer vision), and per-dial controls.

## Decisions settled in the brainstorm

1. **Inset inside a fixed output.** The export size is whatever was chosen
   (capture size, Embed 1x/2x); the recording is scaled into an inset rect
   inside it. Stills grow the canvas, but video cannot: H.264 and Chrome's
   decoder cap at 3840x2160, a 4K take is already at the cap, and
   `output-size.ts`'s even-dimension rule is untouched by this design.
2. **Four presets:** None (default; today's behaviour), Clean (light gradient,
   ~6% padding, rounded corners, soft shadow), Dark (dark gradient, shadow),
   Solid (user-chosen colour with padding, corners, shadow). Values are
   provisional and tuned by eye on a Mac, as the stills' were.
3. **The camera PiP stays anchored to the content rect**, so it sits on the
   recording as it does today. The keycast pill stays on the output canvas (a
   caption, not part of the picture). Auto-zoom crops *within* the inset
   picture; the chrome never moves.

## Approach: the inset lives in `render()`

`render()` returns a `framing` result alongside the existing `FrameState`
fields: the content rect in output pixels plus the chrome. `spaces.ts`'s
`displayToOutput` already carries an origin and per-axis scale, so the cursor,
click highlight, pointer size and zoom crop map into the inset rect through
the existing owner of every coordinate conversion (STC-314). The compositor
draws the result and decides nothing. One implementation, two sinks.

Rejected: a second pass that scales the finished canvas into a frame (resamples
the cursor artwork, costs a full-frame pass, and makes `render()` stop
describing what is on screen); baking the frame into the capture (the take is
immutable and framing is an edit).

## Data

`schema/project-15.schema.json` adds an optional `framing`:

```
framing?: {
  preset: "clean" | "dark" | "solid",
  color?: string,                 // solid only
  paddingPct?, radiusPct?, shadow?, background?   // overrides; explicit wins
}
```

- Absent means None. `projectForWrite` emits the MINIMUM version that can
  express the document (the rule `zoom` and `shotForWrite` follow), so an
  untouched project stays at its current version and no existing document
  changes.
- Explicit override values beat the preset, so `project.json` stays the
  artefact and a later editor has somewhere to write. v1's UI sets only the
  preset (and the solid colour).
- `PROJECT_VERSIONS` gains 15. A frozen v14 document must still load
  unchanged (test).

## Layout: `transform/src/framing.ts` (pure)

`framingLayout(framing, output, captureAspect)` returns, in output pixels:

- `content`: the capture fitted inside the output minus padding, aspect
  preserved, centred, whole-pixel. Padding is a fraction of the output's short
  edge (resolution-independent, as in stills). A capture whose aspect differs
  from the output's (region/window scope) fits by its own aspect; the rest is
  background.
- `radius`, `shadow` (offset, blur, spread, opacity) and `background`, all in
  output pixels.
- **Shadow reach is clamped to the padding.** The stills gate caught a shadow
  clipped by the canvas edge and reading as a hard grey band; this is a
  correctness bound, not taste.

Presets live here as named constants with the same "reasoned, not made"
header the stills' carry. Framing None returns `undefined`.

## Rendering

`compositor.ts`, when `fs.framing` is present:

1. Fill the background (gradient or solid).
2. Draw the shadow, cast from the rounded content rect.
3. Clip to the rounded rect and draw the zoom-cropped capture into `content`.
4. PiP, cursor and keycast as today (already positioned in output pixels by
   `render()`).

With framing absent the existing code path runs unchanged, so "framing None
changes no export pixel" holds **by construction**, the way the five-argument
`drawImage` makes "zoom off changes no pixels" true. `TRANSFORM_VERSION`
13 -> 14 with a `TRANSFORM_HISTORY` entry stating that framing-None output is
unchanged and a framed take differs.

The cursor is always inside the capture, hence inside `content`; it needs no
extra clip.

**Rasterizer risk.** Canvas shadows and gradients are the kind of drawing that
differs between GPU and swiftshader (the rasterization-backend trap in
`docs/CORRECTNESS-TRAPS.md`). Mitigation is to test it, not to assume: a framed
fixture goes into `gate:identity` (both sinks inside one browser) and
`export-identity.slow` (pinned to software). Cross-process pixel equality
stays out of scope, as it already is.

## Legibility

`legibility.ts`'s formula uses the content width instead of the output width
when framing is present (`textPt * contentWidth / display.pointWidth`), so an
inset recording is warned about correctly. With framing absent the number is
unchanged.

## Editor UI

One "Frame" control in the editor's export-dialog area: a preset picker
(None / Clean / Dark / Solid) and a colour input shown for Solid. It writes
`project.framing` through the path the zoom settings already use: a document
edit, not an app setting. Preview and export both go through `render()`, so
what is previewed is what exports; the legibility readout updates live. No
Figma-matched design in this ticket; it matches the existing dialog's controls
and the runbook says so.

## Testing and proof

- **Pure:** `framingLayout` over even and odd outputs, a wide/tall capture in a
  differently shaped output, region/window scope, shadow clamp, zero padding,
  aspect fit, preset resolution with overrides winning.
- **`render()`:** cursor lands at the right output pixel under a frame and
  under frame + zoom crop. Each test is mutation-checked against reverting the
  mapping (the STC-421 lesson: a first draft can pass against the bug).
- **Schema/loader:** project-15 validates; `projectForWrite` minimal-version
  behaviour; frozen v14 document loads unchanged.
- **Gates:** framed fixture in `gate:identity`; a pixel-property check (background
  outside the rect, no dark fringe at the corners, a shadow that reaches
  zero), in the style of `scripts/still-gate.mjs`: properties, not golden
  images.
- **Hardware/eyes (`docs/STC-396-RUNBOOK.md`):** how each preset looks, whether
  the shadow reads at 4K and at Embed size, whether the inset hurts legibility.
  Written and run on a Mac; a real export is looked at before the ticket is
  called done.

## Open (named, not decided)

- Preset values (padding, radius, gradient stops, shadow) are provisional.
- Whether an Embed-size export of a framed take wants a different default
  padding. Judged by eye in the runbook.
