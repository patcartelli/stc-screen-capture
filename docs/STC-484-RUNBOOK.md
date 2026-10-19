# STC-484 runbook — editor timeline zoom

Run from `accounts/stc-484-editor-timeline-zoom-interaction-is-unclear` until it merges
(not on `master` yet). `npm run app:start`, open any take with a few seconds of
audio and at least one click.

What CI covers: the pure decisions (`app/test/timeline-zoom.test.ts`) and the
wired buttons, page keys, synthetic wheel, overview drag and override-box hover
(`app/test/timeline-zoom.e2e.test.ts`). What only a Mac can settle:

1. **⌘= / ⌘− / ⌘0 reach the timeline, not the page.** Electron's default View
   menu owns these (Zoom In / Zoom Out / Actual Size). `editor-window.ts` claims
   them in `before-input-event`. Press each in the editor: the overview window
   changes, and the editor's own text size does NOT. Also try ⌘⇧= (the `+` on a
   US layout) and the numpad. **Clash to list in the PR:** the same three chords
   still scale the page in every OTHER window (main, still editor); the View menu
   items in the editor window still do, when clicked with the mouse.
2. **Trackpad pinch** zooms around the pointer (the instant under the cursor stays
   put). If it feels too fast or too slow, the dial is the `* 4` for ctrl-only
   wheels in `wheelIntent` (`timeline-zoom.ts`).
3. **⌘-scroll zooms, plain two-finger scroll pans**, over the ruler and over each
   lane. A sideways swipe pans; a vertical scroll also pans.
4. **+ / − / Fit** zoom around the playhead when it is on screen, else the middle.
   Fit and − are disabled at the whole take; + at the 1/64 floor.
5. **Overview strip**: its window matches what the lanes show; drag it to pan;
   press outside it and it comes to the pointer; Left/Right pan it when focused.
6. **Readout** is hidden until the view changes, then fades after 1.5 s.
7. **Override box**: select a Zoom block; the box is drawn only while the pointer
   is over the block, over the box's rect on the preview, or while dragging.
8. **Reduced motion** (System Settings → Accessibility → Display → Reduce motion):
   the readout and box appear without a fade. The lanes never animate on zoom.

## Decided here, flagged for Patrick

- **When the hidden readout appears** (the ticket's open question): built as
  *while zooming* (1.5 s after any change of the view). Alternatives are hover or
  a setting; the one dial is `ZOOM_READOUT_MS` in `editor.ts`.
- STC-451's other leftovers (dither, disconnected lanes) are not touched.
