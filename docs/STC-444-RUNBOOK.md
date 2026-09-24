# STC-444 runbook — the editor's header row (slice 1 of 4)

Slice 1 is a **rough-in**. It goes into the product so we can see how it feels
there, not to settle the design. Patrick's mockups are inspiration, not a spec.

## What moved

- **One header row** under the preview: timecode, then the transport, then
  output. The grid is `minmax(0,1fr) auto minmax(0,1fr)`, which keeps the
  transport centred on the window.
- **Transport:** `|<` `◁|` `▶` `|▷` `>|` as hairline icons. `|<` and `>|` are
  Home and End, which now go to the trim's in and out points (the ends of the
  take when untrimmed, as before). The step buttons are ← and →; ⇧-click
  steps ten frames, the same as ⇧←/⇧→.
- **Frame grab** is one icon in the right group. Click copies, ⌥-click saves,
  and right-clicking the icon or the preview opens a Copy frame / Save frame
  menu.
- **Export** is now a download icon and **Close** is an ×. Close stays because
  the e2e suite closes the window through it, and there is no ⌘W binding to
  replace it yet.
- Clicking the **preview** toggles play. A play glyph shows over it only while
  paused.
- The timecode is JetBrains Mono. Its `/ duration` half hides below a 680px
  header width, and the frame status line hides below 820px.

Not in this slice: the ruler and trim brackets (slice 2), Export absorbing
Share (slice 3), and bookmarks (deferred). The trim bar's In, Out and Full take
buttons, and the share bar, are still text buttons until those slices replace
them.

## Only a Mac can settle these

1. **Does the transport feel centred?** Drag the window from 640px up to full
   width while playing. The play button must not move sideways as the timecode
   ticks or the window resizes.
2. **Are the glyphs legible** at 16px with a 1.25 stroke, in light and dark?
   Pay most attention to `◁|` and `|▷`: do they read as "step", not "skip"?
3. **Hover, active and focus.** Tab through the row. Every button should show a
   focus ring, and hovering one should show its tooltip with the shortcut.
4. **Space after a click.** Click `|▷`, then press Space. Playback must toggle
   exactly once. A focused button would normally also "click" on Space, and
   this checks that the keyboard grammar's `preventDefault` still wins.
5. **⌥-click saves.** Confirm macOS doesn't take ⌥-click on a button for
   anything else.
6. **Right-click on the preview** opens the frame menu at the pointer. Escape
   or a click outside closes it.
7. **Play glyph over the preview.** Is it legible on a white or busy frame? It
   uses a thin dark outline, not a drop shadow; the runbook's reason is that a
   CSS filter over a canvas that repaints every frame is costly.
