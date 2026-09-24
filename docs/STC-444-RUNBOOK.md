# STC-444 runbook — the editor's header row, timeline, share and bookmarks (all 4 slices)

**Run from:** `claude/fervent-goodall-rkautv` (PR #217). Until that PR merges, this runbook is not on `master`.

**Result, 2026-09-24:** Patrick ran every item on real hardware and approved all seven of slice 1's original checks. Separately, the design still differed from his Figma mockups. That gap was closed from the Figma file itself, not from the screenshots on the ticket, through several rounds of HTML variant comparisons — each slice below names which comparison and which picks came from it.

None of slice 2, slice 3 or slice 4 has run on a Mac yet.

## Slice 1 — the header row, built 2026-09-24

Slice 1 is a **rough-in**. It went into the product so we could see how it felt
there, not to settle the design. Patrick's mockups were inspiration, not a spec.

**Update, same day:** item 1 of this slice's own checks (below) is now WRONG
and kept only for history. Patrick reviewed an HTML variant comparison (four
artboards: the shipped centred layout, a Figma-close left-aligned/bigger-icon/
near-black variant, a centred-but-larger variant, and three divider/timecode
treatments) and picked the left-aligned transport ("variant B") plus the
shipped hairline divider/tight timecode ("variant 1"). The header no longer
centres the transport at all — see the CSS comment in `editor.html`.

### What moved

- **One header row** under the preview: the transport anchored to the LEFT
  edge, output pinned to the right — `justify-content: space-between`, no
  longer the centred 3-column grid slice 1 shipped with (superseded
  2026-09-24, see the update above). The timecode sits above the ruler, not
  in this row.
- **The panel is near-black** (`#0a0a0b`), darker than the rest of the app's
  shared dark tokens (`#131315`) — picked from the same variant comparison.
- **Icons are bigger**: 40px buttons / 20px glyphs at a 1.15 stroke, up from
  slice 1's original 30px/16px at 1.25.
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

### Only a Mac can settle these

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

## Slice 2 — the ruler and timeline, built 2026-09-24

Built from a second HTML variant comparison (`timeline-variants` canvas: ten
artboards, several rounds of feedback) — every choice below traces to a
specific pick from that comparison, not a guess made while writing the real
code.

**Update, 2026-09-24 (real-hardware pass):** the first real look at this
slice on a Mac (a 2:03 take with real activity) found it cluttered — three
stacked lanes with a dense LED-bar Clip lane sitting directly against the
Zoom lane. Two changes, both now in the same commit history as the rest of
this slice: **Clip activity moved off its own lane onto the ruler**, as a
faint backdrop toggled by a small button in the ruler's corner
(`#ruleractivitytoggle`) — off by default, session-only, not persisted. The
Clip lane itself is unchanged otherwise (still the trim controls: kept bar,
`[`/`]` brackets, dimming, scrub). And **the Zoom lane now sits 16px below
the Clip lane** instead of the uniform 2px every row otherwise shares. The
bullet below describing the Clip lane's bars is about where that drawing
CAME from; item 2 of this slice's Mac checklist is now stale in the same
way slice 1's item 1 was — see the new checklist item 6.

### What moved

- **The ruler is no longer blank.** Adaptive ticks (1s → 5s → 10s → 30s →
  1m → …, never closer than 6px — scrubber.ts's rule 9, now actually
  implemented rather than only documented) plus a blue played line and a
  bright playhead mark. Ticks stayed the plain thin-line treatment ("variant
  A") — dots and a glowing/LED look were tried on the ruler specifically and
  dropped; only the Zoom lane kept a screen-like texture.
- **Clip activity's bars are LED rows**, lit from the bottom, at the real
  480-bucket density (`LANE_BUCKETS`) the code already computed — no new
  density was invented for the visual. Originally drawn in the Clip lane
  itself; moved onto the ruler the same day (see the update above).
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
2. ~~Is the LED striping on the Clip lane visible at real activity levels?~~
   **Superseded 2026-09-24** — the LED bars moved off the Clip lane onto the
   ruler, as an off-by-default toggle; there is no standing Clip-lane
   striping to check any more. See item 6 below for what replaced it.
3. **Does the Zoom lane's dithered fill look like a screen** at real size,
   or too busy/noisy against real auto-zoom windows (which are usually
   wider than the synthetic ones in the comparison)?
4. **Are the 1px bracket handles still comfortably grabbable** at actual
   size, not just legible? They kept the old handle's 10x20 hit box, but a
   thinner glyph can still read as harder to find with the pointer.
5. **Does the cross-lane dimming read as one cut**, or does the Zoom lane's
   now-dimmed edge look broken/disabled rather than "outside the trim"?
6. **The activity toggle (2026-09-24 update)**: is the small icon in the
   ruler's corner easy to find and click at real size (it's only 16px)? Is
   the LED overlay legible at 0.4 opacity against real (denser) activity
   once toggled on, or does it need to be darker/lighter, or bigger? Does
   toggling it on and off read as showing/hiding a judgment aid, or does it
   look like something broke (a flicker, a layout shift)?

## Slice 3 — export dialog absorbs Share, built 2026-09-24

The ticket's own three items: "export dialog absorbs Share; per-take slug;
site folder moves to Preferences; 'Show published' goes." Three product
decisions the ticket left open were settled by asking directly (not from an
HTML comparison this time — this slice is information architecture, not
visual): the slug auto-derives from the take's own name and is editable per
take; "Show published" folds into Share's own success feedback rather than
surviving as a standing button; the site folder picker mirrors the
still-capture save-folder row exactly.

### What moved

- **The old `.sharebar` (Share to site / Site folder… / Show published /
  status) is gone.** A Share section lives inside `#exportdialog` now: a
  slug input, a read-only line naming the configured site folder, a Share
  button, a status line, and a `Show in Finder` button that only appears
  after a publish succeeds THIS SESSION.
- **The slug is per-take now** (`Project.slug`, project-7), not one global
  setting shared by every take in the app. It prefills from the take's own
  name (`autoSlug`, e.g. `2026-08-24_10-00-00` → `2026-08-24-10-00-00`) until
  something is actually shared under a specific string, at which point that
  string is what gets remembered — so a deliberate re-shoot of an existing
  demo still needs the same slug typed in once, matching an existing
  published path on purpose, but nothing is invented on the take's behalf.
- **"Show published" is gone as a standing button.** `share:reveal` now
  answers only for a file THIS PROCESS actually published — main.ts keeps an
  in-memory `lastPublishedFile`, never re-derived from settings (there is no
  global slug left to derive it from), and never a path the renderer names.
  A reveal from a previous app launch, or of a take nobody has shared this
  session, is refused rather than guessed at.
- **The site folder moved to the main window's Preferences**, a new row
  (`Shared demos publish to` / `#sitedest` / `#sitechoosedest`) styled and
  wired exactly like the save-location row above it — except `#sitedest`
  shows the RAW stored value ("Not set" included) rather than a resolved
  default, because `share.destination` has no real default to resolve to
  the way `saveFolder` does.

### Only a Mac can settle these

1. **Does the export dialog read as one thing now**, Export and Share
   together, or does Share feel bolted on at the bottom? The two are
   deliberately still separate actions (Export, then Share), not folded
   into one button.
2. **Is the slug field's prefilled value legible and obviously editable** —
   does `2026-08-24-10-00-00` read as "type over this" or as a real,
   finished-looking value nobody would think to touch?
3. **Does the read-only site-folder line make sense** without a picker next
   to it, or does its absence read as a bug ("where do I change this?")
   rather than a deliberate move to Preferences? If it reads wrong, the
   fix is very likely a `title` tooltip pointing at Settings → Preferences,
   not bringing the picker back.
4. **Does "Show in Finder" appearing only after a fresh publish feel right**,
   or does its absence on a take that WAS published in an earlier session
   read as broken rather than as the deliberate "no stale reveal" choice
   documented on `share:reveal`?
5. **The site-folder Preferences row** — does it read as belonging with the
   save-location row above it, or does the pairing feel arbitrary since one
   is about recordings and the other about a published copy of one?

## Slice 4 — bookmarks, built 2026-09-24

The ticket's deferred fourth item. Three product decisions, settled by
asking directly (no HTML comparison — this slice is a data model and a
keyboard grammar, not a visual question): bookmarks are per-take and
persisted (a new schema field, `project.bookmarks`), not a session-only
scratch list; ArrowUp/ArrowDown jump between them, on top of the mark/jump
keys the scrubber already has; and a bookmark is removable, not
write-only.

### What moved

- **`project-8.schema.json`** adds `bookmarks`: session-relative integer ns
  (the same units `trim` uses, not an export-frame index — a bookmark must
  still mean the same instant if a later build's export fps ever changes,
  which frame N cannot promise across that change). Absent means none;
  `parseProject`'s new `cleanBookmarks` sorts, de-duplicates and clamps to
  the take, the same "one bad entry must not cost the others" rule every
  other array field in `trim.ts` already follows. `projectForWrite` also
  fixed the slug line from `version === 7` to `version >= 7` — the same
  "promoting the version must not drop the field below it" bug class
  `overrides` was found with when v7 was minted, now caught by a test
  (`V8 IS A SUPERSET OF V7`) rather than by hand a second time.
- **M bookmarks the playhead's own frame; a second M there removes it.**
  `scrubber.ts`'s `decideKey` does not decide add vs. remove itself — the
  same reason `mark`/I/O do not decide what "in" means against the
  existing trim — `editor.ts`'s `toggleBookmarkAtPlayhead` resolves it
  against the take's actual bookmark list, which lives on the project, not
  in scrubber state. **ArrowUp/ArrowDown jump to the nearest bookmark**
  in that direction (Premiere's own convention) and do nothing at the near
  end — never wrap to the far one. Both keys were free: nothing in this
  window claimed bare Up/Down before this (only Left/Right/Home/End did),
  and M was not used anywhere in the editor.
- **A marker per bookmark on the ruler** (`#ruler-bookmarks`, a new
  `--bookmark` gold token distinct from the played bar's blue and the
  Zoom lane's orange), positioned as a fraction of full duration exactly
  like a tick so the shared pan/zoom transform carries it for free, with
  the same `1/scale` width correction a tick's width already gets.
  **Click seeks to it; right-click removes it** — the second, mouse-only
  way to remove one, since M only reaches a bookmark the playhead is
  exactly parked on. A `#togglebookmark` text button sits in the trim bar
  next to In/Out/Full take, doing exactly what M does — this file's own
  stated rule that every keyboard action gets a matching visible button.

### Only a Mac can settle these

1. **Do the markers read as bookmarks** at 3px (the same width-correction
   trick a tick uses) against the ruler's other marks — the tick lines,
   the played bar, the playhead — or do they get lost, especially at a
   zoomed-out view of a long take where several might sit close together?
2. **Right-click to remove** — is that discoverable at all without the
   tooltip, or does it need a visible affordance (a small × on hover)
   rather than relying on the title text alone?
3. **Up/Down as the jump keys** — do they feel natural, or does reaching
   for Up/Down while the rest of the grammar lives on J/K/L/I/O/Home/End
   read as an odd key to reach for? (Premiere's own convention was the
   reasoning, not a usability test on this app specifically.)
4. **M while playing** — does bookmarking mid-shuttle feel right, or does
   it need to pause the take the way I/O do not either? (Unbuilt on
   purpose, matching I/O's own existing behaviour — flagged here in case
   a real take changes that judgement.)
