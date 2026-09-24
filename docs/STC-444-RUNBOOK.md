# STC-444 runbook — the editor's header row and timeline (slices 1–2 of 4)

**Run from:** `claude/fervent-goodall-rkautv` (PR #217). Until that PR merges, this runbook is not on `master`.

**Result, 2026-09-24:** Patrick ran every item on real hardware and approved all seven. Separately, the design still differs from his Figma mockups. That gap is being closed from the Figma file itself, not from the screenshots on the ticket.

**Update, 2026-09-24 (same day):** item 1 below is now WRONG and kept only for
history. Patrick reviewed an HTML variant comparison (four artboards: the
shipped centred layout, a Figma-close left-aligned/bigger-icon/near-black
variant, a centred-but-larger variant, and three divider/timecode
treatments) and picked the left-aligned transport ("variant B") plus the
shipped hairline divider/tight timecode ("variant 1"). The header no longer
centres the transport at all — see the next section and the CSS comment in
`editor.html`.

Slice 1 is a **rough-in**. It goes into the product so we can see how it feels
there, not to settle the design. Patrick's mockups are inspiration, not a spec.

## What moved

- **One header row** under the preview: the transport anchored to the LEFT
  edge, output pinned to the right — `justify-content: space-between`, no
  longer the centred 3-column grid slice 1 shipped with (superseded
  2026-09-24, see the update above). The timecode sits above the ruler, not
  in this row.
- **The panel is near-black** (`#0a0a0b`), darker than the rest of the app's
  shared dark tokens (`#131315`) — picked from the same variant comparison.
- **Icons are bigger**: 40px buttons / 20px glyphs at a 1.15 stroke, up from
  slice 1's 30px/16px at 1.25.
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

Not in slice 1: the ruler and trim brackets (built in slice 2, below), Export
absorbing Share (slice 3), and bookmarks (deferred). The trim bar's In, Out
and Full take buttons, and the share bar, are still text buttons until slice
3 replaces them.

## Slice 2 — the ruler and timeline, built 2026-09-24

Not yet run on a Mac. Built from a second HTML variant comparison
(`timeline-variants` canvas: ten artboards, several rounds of feedback) —
every choice below traces to a specific pick from that comparison, not a
guess made while writing the real code.

- **The ruler is no longer blank.** Adaptive ticks (1s → 5s → 10s → 30s →
  1m → …, never closer than 6px — scrubber.ts's rule 9, now actually
  implemented rather than only documented) plus a blue played line and a
  bright playhead mark. Ticks stayed the plain thin-line treatment ("variant
  A") — dots and a glowing/LED look were tried on the ruler specifically and
  dropped; only the Zoom lane kept a screen-like texture.
- **The Clip lane's bars are LED rows**, lit from the bottom, at the real
  480-bucket density (`LANE_BUCKETS`) the code already computed — no new
  density was invented for the visual.
- **Trim handles are `[`/`]` brackets at a 1px stroke**, not a filled
  rectangle. Compared against a 2px stroke at both actual size and 4x
  magnified before picking 1px.
- **Trim dimming now crosses both lanes** — a plain dim, not the old
  diagonal hatch, so a cut reads as one cut through the whole timeline
  rather than a Clip-lane-only visual language.
- **The Zoom lane's fill is a dithered blue checkerboard**, the finer of two
  compared pitches, replacing the old solid orange. `--zoom` (orange) is
  untouched everywhere else (override selection, the manual-window dashed
  border) — this was a scoped fill change, not a re-theme.

### Only a Mac can settle these

1. **Does panning/zooming the ruler feel right** with the new ticks and
   played line riding along? They're authored as a fraction of full
   duration exactly like `.kept`/`.cut-head`, with each tick's WIDTH
   corrected by `1/scale` so it stays roughly a constant on-screen pixel at
   any zoom — confirm that actually holds together at real zoom levels
   rather than just on the sandbox's Xvfb screenshot this was built against.
2. **Is the LED striping on the Clip lane visible** at real activity levels,
   or does it read as a plain solid bar until you look very closely? The
   fixture take used to build this has fairly flat/sparse activity.
3. **Does the Zoom lane's dithered fill look like a screen** at real size,
   or too busy/noisy against real auto-zoom windows (which are usually
   wider than the synthetic ones in the comparison)?
4. **Are the 1px bracket handles still comfortably grabbable** at actual
   size, not just legible? They kept the old handle's 10x20 hit box, but a
   thinner glyph can still read as harder to find with the pointer.
5. **Does the cross-lane dimming read as one cut**, or does the Zoom lane's
   now-dimmed edge look broken/disabled rather than "outside the trim"?

## Only a Mac can settle these

1. ~~Does the transport feel centred?~~ **Superseded 2026-09-24** — the
   transport is left-anchored now, by choice; there is nothing to check here
   any more. Check instead that it stays flush against the left edge (not
   drifting, not clipped) as the window resizes from 640px to full width.
2. **Are the glyphs legible** at 20px with a 1.15 stroke, against the
   near-black panel? (The editor is always dark now — no OS-light-mode case
   to check here any more.) Pay most attention to `◁|` and `|▷`: do they
   read as "step", not "skip"?
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
