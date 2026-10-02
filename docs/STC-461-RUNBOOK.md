# STC-461 — customizable camera PiP: what to run on the Mac

**Until it merges, run this from `accounts/stc-461-customize-pip-webcam-image`; once it has merged, run it from `master`.** Run from a `master` that predates the merge, the runbook is absent and the app is the OLD build.

```
git fetch && git checkout accounts/stc-461-customize-pip-webcam-image && helper/build.sh && npm run app:start
```

Spec: `docs/superpowers/specs/2026-10-02-stc-461-pip-customize-design.md` (amended while planning; the three amendments are in the ticket-log row). Plan: `docs/superpowers/plans/2026-10-02-stc-461-pip-customize.md`.

## What this ticket does

A camera take's PiP can be given a shape (rect / square / circle, corner radius), a size, any position (free drag with snapping), a border, a shadow, a mirror, and a reframe of what the camera shows inside it. Four presets are one click from finished. The style is chosen per take in the editor's **Camera** popover, or as a sticky default in Settings that new camera takes inherit. One layout for the whole take.

Every decision is in `transform/src/pip-style.ts`; `render()` is still pure and `TRANSFORM_VERSION` is 15. `schema/project-16.schema.json` adds optional `pip.style`; a document without it renders exactly as before. With STC-396's framing on, the PiP is placed (and dragged) inside the framed picture, not the whole canvas.

Verified on the build machine (not a Mac with a camera): typecheck, unit suite, and `gate:identity` on `fixtures/pip-styled` and `fixtures/pip`. **Not run by a person:** everything below. **Not run in the VM:** the new e2e files (`app/test/pip-editor.e2e.test.ts`, `app/test/pip-settings.e2e.test.ts`, `app/test/preview-write-project.e2e.test.ts`); `docs/VM-TESTING.md`'s route installs the packaged app and cannot run Playwright files, and the camera PiP cannot be tested in a VM at all. They run on CI.

## 0. Setup

`npm run app:start`. Record a take of at least 10 s with the camera on and some on-screen motion (a window dragged around, a scrolling page). Open it in the editor. The **Camera** button sits in the timecode row beside Audio and is shown only when the take has a camera.

## 1. Presets

Try all four (Classic, Circle, Rounded square, Large circle). Judge each over a busy background and over a dark one. A preset is a LOOK: shape, radius, size, border and shadow change; position, framing and mirror survive, so picking one must not undo a drag you just made. If one is wrong, the dial is `PIP_PRESETS` in `transform/src/pip-style.ts`.

## 2. Shadow and border

- Does the shadow read without looking muddy? Dial: `PIP_SHADOW` (`color`, `blurFraction`, `offsetYFraction`).
- Is a 2 pt border visible but not heavy at a 4K export? Dial: `DEFAULT_BORDER`, and the border width control's range (`PIP_BORDER_PT_MIN`/`MAX`).
- **Dark fringe.** With the shadow on, look at a clipped circle's edge for a dark halo. The shadow is drawn UNDER the clipped image so the clip cannot cut it off, which is also what could leave a thin dark ring where the antialiased clip meets it.
- **Flush to the edge.** Drag the PiP hard into a corner so it sits against the output edge with a border on. The border is stroked centred on the shape's edge, so the outer half may be clipped by the output; does it look thinner there than elsewhere?

## 3. Drag and snap

- Does the snap feel like a pull or a jump? Dial: `PIP_SNAP_THRESHOLD_SCREEN_PX` (12), margin `PIP_SNAP_MARGIN_PX` (32). Nine anchors: corners, edge centres, dead centre, per axis.
- The Camera popover opens over the stage on the side AWAY from the PiP (`inspectorSide`) so it never covers what you are dragging. Drag the PiP from one side to the other: does the panel switch sides sensibly, or jump while you hold it?
- Does the popover close and reopen around a stage drag, and does that flicker?
- Corner handle: resize with aspect locked. A PiP too wide to fit the output is capped (`pipSize`), not clipped; check at the largest Size slider value.

## 4. Reframe

**Reframe…** swaps the LIVE project's PiP for the whole camera frame, centred and large; `#pipframewindow` is the crop, in the PiP's shape, with the rest dimmed. Drag to pan, scroll or the Zoom slider to zoom (1..3, `PIP_FRAMING_ZOOM_MAX`).

- Does the dimmed window read as "what will show"?
- Is the pan direction right with Mirror ON and with Mirror OFF? (This is the one place a mirrored picture is panned by hand; a wrong sign shows here and nowhere else.)
- Is the wheel zoom speed right?
- A reframe is never thrown away. An edit made during reframe (a trim, a level) saves at once, and what it writes is the take's REAL style with the framing as it stands — never the temporary whole-frame display. Close the editor (or open another take) mid-reframe and reopen: the take must have the framing you had reached, in its own shape and size, not the whole camera frame and not the pre-reframe framing.
- Export, publish and frame-grab started during a reframe must commit it first (they read the live project): the output must show the framing you chose, not the whole camera frame.
- A PiP that is switched off (Show camera unchecked) cannot enter reframe; confirm Reframe is unavailable rather than entering a mode with nothing to show.

## 5. Mirror

With Mirror on, raising your right hand should look like looking in a mirror (the hand on the same side of the PiP as in a mirror). Recorded camera files are never flipped; mirror is a draw-time flip.

## 6. Export

Export the styled take. The exported file must match the preview: shape, place, framing, border, shadow, mirror. Hashes prove the two sinks agree (`gate:identity`); only watching proves the agreed answer is right.

## 7. Settings

Settings > Camera: the same inspector over a mock 16:9 frame (no live feed, no reframe). Set a default (for example Circle, moved top-left). Close and reopen the sheet: it re-reads the saved default each time. Record a NEW camera take: the editor must open with that style and a centred framing. Record a take with the camera OFF: its `project.json` must have **no** `pip`. A user who never touches the setting must get takes with no `pip.style` at all.

Editor's **Use as default** copies the take's style (without `framing`, which is per take) into Settings; check it appears there.

## 8. Old takes

Open a take recorded before this branch. Its PiP must sit exactly where it always did (bottom-right, 12.5% wide, 32 px margin), and the first drag must not make it jump (`styleFromFixedCorner` seeds the style from the fixed corner).

## What is deliberately not here

- Framing guides (thirds, fifths): **STC-497**. `#pipframewindow` is the surface they will draw on.
- Mid-take PiP changes or keyframes. One layout per take.
- Undo. The editor has none; revert by hand or with a preset.
- A live camera feed in Settings (it would light the camera LED to set a preference), and reframe in Settings.
- Tunable shadow parameters. One tuned shadow, on or off.

## Gates

```
npm run gate:identity -- <dir containing fixtures/pip's media + fixtures/pip-styled/project.json>
npm run gate:identity -- <dir containing fixtures/pip as-is>
```

The styled gate needs a copy of `fixtures/pip`'s media next to `fixtures/pip-styled/project.json`; the project file alone has no `display.mp4`.
