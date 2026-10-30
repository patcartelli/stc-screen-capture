# STC-604 runbook — the editor's inspector pane

What only a person with the real editor can settle. The five sections were built
from Figma Capture-SK-016 v2 (Frame 171:78, Zoom 171:561, Camera 171:1066, Audio
171:1546, Export 171:2050) and checked only as **rendered snapshots with sample
data**: no section has been seen in the running editor, and no e2e has run
locally. The ticket's done criterion is Patrick's sign-off on a screenshot of
each section next to its frame.

**Branch.** None of this is on `master` yet. It is five stacked draft PRs; run
from the top one, which contains all of them:

```
git fetch origin
git checkout accounts/stc-604-frame-section
npm ci && npm run app:start
```

(#407 Audio → #408 Camera → #409 Zoom → #410 Export → #411 Frame. Merge in that
order, retargeting each to `master`. Once all are merged, say `master`.)

Use a take with a mic **and** system audio, a camera, and recorded keys, so every
section has something to show. Open it from the Library.

## 1. Each section next to its frame

Take a screenshot of the editor at 1280 × 856 in each section and set it beside
the Figma node. Look at: the row rhythm (12 px, hairline dividers), the numeric
readouts in the mono face, the section accent (teal Audio/Frame, coral Camera,
brass Zoom and the Export button), and real fonts. The snapshots had **no fonts**
(a serif fallback), so type is unjudged.

## 2. Audio (#407)

- The meter line under each level slider is hidden until the preview plays (the
  Figma rows draw none), and stays up while a clip mark is lit. The meters run
  only while Audio is the active section. Play with the section open: does the
  line appear and move with the voice, and hide again when you pause?
- The Microphone / System audio switch is the track's mute and reads inverted
  (on = heard). Mute keeps the slider where it was, dimmed.
- Double-click a slider resets it; the value is also a reset button while it
  differs; Shift+arrow nudges 0.1 dB and the playhead does not move.
- With focus in the pane, Space toggles the focused control and does **not** play.
- "Mute while editing" is the same setting as the transport's sound button; flip
  one and watch the other.

## 3. Camera (#408)

- Choosing Camera shows the PiP's outline (coral) and its label
  (`Rounded · 190 · Bottom right`) over the stage. Is the label legible over a busy
  picture, and does it stay on the stage when the PiP is at the top?
- Drag and resize the PiP: the Anchor row follows the drop, and the **section does
  not close** (the popover did).
- Anchor: pick each of the nine places; the PiP lands on the margin a drag snaps
  to. "Custom" shows between places.
- Snap to edges off: a drag lands where dropped. It is a session setting, never
  saved: reopen the take and it is on again.
- Reframe: the section closes while reframing and Done returns to the real style.

## 4. Zoom (#409)

- Select a zoom block on the lane: the pane switches to Zoom. Drag the block's
  edges: Starts and Ends update as you drag. Amount follows the rectangle.
- Leave Zoom (any tab) mid-edit: the edit is committed and closed, as Done would.
- **Delete window** shows for a derived block only; it is hidden for a manual one.
- With nothing selected the section tells you how to pick or add a block.

## 5. Export (#410)

- The Export button in the timeline row and the pane's brass Export both work;
  the section is not modal and there is no Close.
- Legibility still warns below 9 pt and never blocks; Viewer's eye draws the
  preview at the embed width.
- Share to site and Show in Finder; the share status line while it runs.
- Run a real export and confirm the progress bar, Cancel, and the result.

## 6. Frame (#411)

- Padding and Corners repaint live while dragging and write on release; open the
  export and confirm the saved padding is what the preview showed.
- Shadow off then on returns to the preset's own shadow.
- Choosing a new style keeps the numbers you set.
- The Colour swatch shows for every style but None: the fill for Solid, the
  **first colour of the gradient** for Clean and Dark (its second colour and
  angle stay the preset's). Pick one and watch the preview repaint while the
  picker moves; switch to another style and confirm it starts on its own colours,
  not the one you edited.
- Clicks and Keys switches still change the preview and the export.

## 6b. "More" groups

Each section's default view is what its Figma frame draws; what the frame omits
sits behind a collapsed **More** (a native `<details>`, open state kept while the
editor window lives): Camera's Look, Show camera, Corners, Border width and
colour, Shadow, Mirror, Reframe and Use as default; Frame's Overlays (Show clicks
and keystrokes); Export's Legibility inputs. The legibility *sentence* stays on
show under Format, because it warns below 9 pt. Check that nothing you use daily
is now too hidden (Show camera, Show clicks are the likeliest), and say if any
should come out of More.

## 7. Decisions for Patrick

Left out of the build because nothing in the project backs them (the ticket keeps
saved fields as they are). Each is a new field or a new feature if wanted:

- **Audio:** Limit peaks, Ceiling (the mix's hard limit is fixed).
- **Camera:** none missing; extra rows (presets, corners, shadow, mirror, reframe,
  use as default) are kept from the popover.
- **Zoom:** Ease In / Out / Both (the project's easing is Calm / Standard /
  Snappy), Follow cursor, Draw region, Amount as a slider.
- **Export:** Type (MP4 / GIF / WebM), Frame rate, Quality, Folder / Change…,
  Copy to clipboard, the Estimate group.

Also his call:

- Anchor (Camera) and Ease (Zoom) are **flat native selects**. Settings draws its
  own dropdown menu; the editor's could. (Frame's Style is segmented, as in Figma,
  with None as a fourth segment.)
- `--camera` is a new token, set equal to `--bookmark`, because Figma's Camera
  frame is coral and STC-609 defined accents for Audio and Zoom only.
- Size on Camera reads in output pixels; Amount on Zoom reads the frame over the
  drawn region's longer side. Figma's example numbers do not agree with either.

## 8. CI

The e2e suite has not run on any of this. Tests changed: `mic-level`,
`voice-clean`, `system-audio-level`, `audio-pane-feel` (popover → section),
`pip-editor` (the drag no longer closes the section; a new Anchor / Snap test),
`export-size`, `legibility`, `product`, `export-identity.slow` and the
`_editor-fixture` helper (dialog → section), `framing-editor` (a new test for
padding, corners and shadow). The zoom override tests were not edited: the bar
kept its ids. **#410 matters most.**
