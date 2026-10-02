# STC-461 — Customize the PiP webcam image

**Ticket:** STC-461. Follow-on to STC-232 (camera PiP), whose spec deferred
"any adjustable PiP geometry UI" to exactly this.
**Branch:** `accounts/stc-461-customize-pip-webcam-image`
**Related:** STC-497 (framing guides — filed during this design, out of scope here).

## Intent

Stated by Patrick, 2026-10-02:

- **Full creative control** over the PiP: shape, size, position, border, shadow,
  mirror, reframe.
- **Good-looking demos fast** — a few presets that are one click from finished.
- One layout for the **whole take**. Changing the PiP mid-take is not wanted.
- Chosen **before a take (Settings)** as the default for new takes, and **per take
  in the editor**.
- Position is **free drag with snapping**.

Success: a camera take can be given a circle / rounded / bordered / shadowed /
mirrored PiP anywhere in the frame, from the editor or as a sticky default; preview
and export agree byte for byte; every document written before this ticket renders
exactly as it did.

## Non-goals

- Mid-take PiP changes, keyframes, multiple cameras (a layer model — YAGNI).
- Framing guides (thirds, fifths…) — **STC-497**. This design only reserves the
  surface they draw on.
- A live camera feed in Settings (it would light the camera LED to adjust a
  preference), and reframe in Settings (unjudgeable without a picture).
- An undo stack. The editor has none today; a change is reverted by hand or by a preset.
- Tunable shadow parameters (blur, offset, opacity). One tuned shadow, on/off.
- The reactive/deforming PiP in the ticket's comment — a Labs study, not this.

## 1. Data model — `project-15`

`project-15.schema.json` is `project-14` plus an optional `pip.style`.

```ts
// transform/src/types.ts
export interface PipStyle {
  shape: "rect" | "square" | "circle";  // rect = the framing crop's own aspect
  cornerRadius: number;  // 0..0.5, fraction of the SHORT side; ignored for circle
  center: { x: number; y: number };     // UV over the OUTPUT
  width: number;         // UV, fraction of output width
  framing: Rect;         // UV over the CAMERA frame — which part of it shows
  mirror: boolean;
  border: { widthPt: number; color: string } | null;  // color "#rrggbb"
  shadow: boolean;
}
export interface Pip {
  enabled: boolean; corner: "bottom-right"; widthPct: number; marginPx: number;
  style?: PipStyle;
}
```

Rules:

- **Absent `style` = today's path, untouched.** `render()` keeps using
  `fixedCornerPipUv`. A document gains `style` only when a person edits the PiP
  (or a take inherits a non-default Settings style — §3). `projectForWrite` emits the
  MINIMUM version that can express a document, so an unedited take stays at
  whatever version (v3–v14) its other edits earned.
- **One size input.** `width` only. Height is derived: 1:1 for square and circle;
  the framing crop's aspect (in camera pixels) for rect. Two independent
  dimensions could disagree with the shape.
- **Framing agrees with the shape.** For square/circle, `framing` is 1:1 in camera
  pixels. Enforced at load and on every edit (§4), never silently corrected.
- **Border in points**, converted to output pixels by the same factor the cursor
  already uses, so it scales with the output.
- **Presets** are a pure constant list in `pip-style.ts`, never stored. Picking one
  writes a complete `PipStyle` into the document.
- The fixed-corner fields stay required and keep their meaning for documents
  without `style`; with `style` present they are carried but unused.

## 2. Render and compositor

### `transform/src/pip-style.ts` (new, pure, no DOM)

Owns every PiP decision:

- `pipRect(style, output, camera): Rect` — center + width → output pixels, height
  from shape/framing aspect, **clamped inside the output**, rounded to whole pixels
  (the rect places a decoded frame; a half-pixel offset resamples every edge —
  same reason `pipStateAt` rounds today).
- `snap(center, size, output, thresholdPx)` — the four corners and four edge
  centres at a fixed margin; threshold in SCREEN pixels, passed in by the caller.
- `clampFraming(framing, shape, camera)` — inside the camera frame, never smaller
  than the PiP's output size in camera pixels (no upscaling below 1:1), 1:1 for
  square/circle.
- `checkPipStyle(style, camera?)` — the refusals JSON Schema cannot express (§4).
- `defaultFraming(shape, camera)` — centred, largest crop that fits the shape.
- `PIP_PRESETS` — Classic, Circle, Rounded square, Large circle. Values are tuned by
  eye on hardware (runbook).
- `DEFAULT_PIP_STYLE` — today's corner geometry expressed as a style: rect, no
  border, no shadow, no mirror.

Coordinate conversions go through `spaces.ts`, per STC-314; the new rect is named
there next to `fixedCornerPipUv`, which remains the default for documents that
predate `style` — exactly what its own header anticipated.

### `render.ts`

`pipStateAt` gains one branch: `style` present → `pipRect`; absent →
`fixedCornerPipUv` as now. `PipState` gains resolved drawing parameters:

- `source`: the framing rect in camera pixels (`drawImage`'s source rect)
- `mirror`
- `radiusPx` (circle = half the side)
- `borderPx`, `borderColor` (or none)
- `shadow`

### `compositor.ts` — draws, decides nothing

Order unchanged: display → PiP → cursor.

1. `save()`
2. If shadow: fill the rounded-rect path with `PIP_SHADOW` (one constant) — drawn
   UNDER the clipped image, so the clip cannot cut the shadow off.
3. `clip()` to the path.
4. `drawImage(camera, source → rect)`, through a horizontal flip when `mirror`.
5. `restore()`; stroke the border on the path, centred on its edge.

The old path (no style) keeps its single `drawImage` exactly.

### Determinism

Every value is computed in `render()`, which is pure. Both sinks call the same
`composite()` in the same Chrome. A new styled fixture joins `gate:identity` (§5);
the committed `fixtures/pip/` stays frozen and pins the old path.

## 3. UI

### Shared inspector

`app/src/pip-inspector.ts` (DOM builder) + `app/renderer/pip-inspector.css`, used
by the editor and the Settings sheet — the `device-menu-dom.ts` precedent. It
reports input; `pip-style.ts` decides. Contents, top to bottom:

1. Preset chips
2. Show camera (`pip.enabled` — it has never had a control)
3. Shape: Rect / Square / Circle; corner-radius slider (disabled for Circle)
4. Size slider
5. Border on/off + width + colour swatch · Shadow on/off · Mirror on/off
6. Editor only: **Reframe…**, **Use as default**

### Editor

- A **Camera** button in the timecode row, beside Audio, opens the inspector as a
  popover built the way `#audiopanel` is. Shown only when the take has a camera.
- **Direct manipulation:** while the popover is open, `#pipoverlay` (a sibling of
  `#rectoverlay`) sits over the stage. Drag the PiP to move it, snapping per
  `snap()`; a corner handle resizes with aspect locked. Clamped live.
- **Reframe mode:** its own layer, `#pipframing`. It shows the whole camera frame
  dimmed with a window in the PiP's shape; drag to pan, scroll/slider to zoom,
  bounded by `clampFraming`. **This is the surface STC-497's guides draw on.**
- **Persistence:** every change saves through the existing `project.json` save
  path, like trim and audio. No Apply button.
- **Use as default** copies the take's style (minus `framing`, which is per take)
  into Settings.

### Settings (profile sheet)

- A **Camera** subsection under Preferences hosts the same inspector over a mock
  16:9 frame with a placeholder silhouette; the PiP is draggable there.
- No live feed, no Reframe (non-goals).
- `settings.ts` gains `pipStyle` (without `framing`), default `DEFAULT_PIP_STYLE`.

### Into a take

At take end, `main.ts`'s `recordTimeChoices` (the path `showClicks` already rides)
carries the Settings style into the new take's `project.json` **only when it
differs from `DEFAULT_PIP_STYLE`**, with `framing = defaultFraming(shape, camera)`.
A user who never touches the setting gets takes byte-identical to today's.

## 4. Validation and errors

Loaders refuse, never default.

- `project-15.schema.json` validates types and ranges.
- `checkPipStyle` refuses: framing outside the camera frame; non-1:1 framing for
  square/circle; out-of-range radius; malformed colour. The message names the field.
- `main.ts`'s `project.json` validation (the `pip` branch, ~line 2459) runs the
  same check.
- **Not an error:** a centre that would place the PiP partly off-frame (e.g. after an
  export-size change). `pipRect` clamps at render time — a legitimate state.
- **Settings** is a preference file, not a take: a stored style that fails the
  check falls back to `DEFAULT_PIP_STYLE`, as every other bad field in
  `settings.ts` already does.

## 5. Testing

- **`transform/test/pip-style.test.ts`** (Node): `pipRect` across output sizes ×
  camera aspects × shapes (integer, inside-the-frame invariants); `snap` inside /
  just outside the threshold for each anchor; every `checkPipStyle` refusal;
  `clampFraming` bounds; every preset passes `checkPipStyle`; border pt→px.
- **Back-compat:** no `style` → the rect equals `fixedCornerPipUv` exactly;
  `fixtures/pip/` and `gate:identity` byte-identical to master.
- **`fixtures/pip-styled/`**: a project with circle + border + shadow + mirror +
  non-centred framing, added to `gate:identity` — preview and export must agree on
  the new path.
- **`projectForWrite`**: v15 only when `style` is set; minimum version otherwise;
  round trip.
- **Settings**: parse, fallback on a bad style, and the take-end copy (default →
  nothing written; non-default → `style` with default framing).
- **E2E** (run in the VM first — `docs/VM-TESTING.md`): open Camera, pick the
  Circle preset, assert the saved `project.json`; drag the PiP, assert it snapped.
- **`docs/STC-461-RUNBOOK.md`** — what only eyes can settle: the presets' taste,
  whether the shadow reads on busy and on dark content, a 2 pt border at 4K,
  drag/snap feel, reframe feel, mirror direction, and the Settings mock frame.

## Files

New: `transform/src/pip-style.ts`, `transform/test/pip-style.test.ts`,
`schema/project-15.schema.json`, `fixtures/pip-styled/`, `app/src/pip-inspector.ts`,
`app/renderer/pip-inspector.css`, `docs/STC-461-RUNBOOK.md`.

Changed: `transform/src/{types,render,compositor,spaces,trim,project-version}.ts`,
`app/src/{main,settings,editor,renderer}.ts`, `app/renderer/{editor,index}.html`,
`CLAUDE.md` (table row), `docs/TICKET-LOG.md` (row on completion).
