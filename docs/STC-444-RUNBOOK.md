# STC-444 runbook — the editor's header row (slice 1 of 4)

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

Not in this slice: the ruler and trim brackets (slice 2), Export absorbing
Share (slice 3), and bookmarks (deferred). The trim bar's In, Out and Full take
buttons, and the share bar, are still text buttons until those slices replace
them.

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
