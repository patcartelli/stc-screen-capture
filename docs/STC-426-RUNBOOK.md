# STC-426 — visible vertical previews

The floating still previews use their full window sizes, separated by 12
screen points, instead of the old 26px overlapping sliver. Newest stays at
the selected corner; older previews run vertically into the work area. On a
short display the next preview starts a column farther inward. Entering or
leaving Redact, or a preview closing, reflows the whole column.

**Revised after the first hardware pass (2026-09-21).** The stack was
originally frozen to the display each panel opened on; watched on hardware,
that meant checking two corners on two displays to find every waiting
capture. It now follows: a fresh capture RE-HOMES every existing panel onto
its own display before laying the stack out (`presentThumbnail`'s `rehome`),
so the whole stack always sits together on wherever you are currently
working. The thumbnail image now fills its pane (a "cover" crop) rather than
shrinking to fit inside it with empty space around a smaller picture — Redact
mode is exempt, since every edge of the capture has to stay reachable while
placing a box over it, so it keeps the original "never crop" fit. The action
row (Style/Redact, Copy/Save/Edit/Trash) is hidden until the pointer is over
the card, or while actively redacting; the overflow badge and the status line
are exempt, since they are status rather than controls. The "Recording"
placeholder label (`#takekind`, unreachable from any capture path today) is
gone.

This checkout was drafted against the panel design STC-392 has since
replaced (a `showing`/timeout state, a fixed five-panel stack, eviction on
overflow) — see `docs/HANDOFF-2026-09-17-STC-392.md`. It has been rebased
onto that design: `MAX_STACKED` is now 3 and a VISIBLE cap rather than a
survival one, past-cap panels are HIDDEN rather than settled-and-destroyed
(reachable through STC-392's `+N` badge), and there is no more expand
door — every panel is one size (`PANEL_SIZE`) until it grows into
`REDACT_SIZE`. `stackLayout` (`thumbnail.ts`) replaces the old
`stackPosition` for whichever panels are actually visible right now — the
capped three ordinarily, or the whole stack once the overflow badge is
clicked — and `thumbnail-window.ts`'s `restack`/`showAllOverflow` both lay
that set out fresh on every change rather than patching a stored offset.

A `silent` (skip-the-panel) capture never occupies a slot in `MAX_STACKED`'s
count at all: it never paints, so counting it toward the cap could push a
real, visible preview into hiding for a screenshot nobody will ever see.

## Check on the Mac

1. Capture three stills in succession. Each image should be fully visible,
   with a gap between previews; newest should be nearest the selected corner.
2. Open Redact on the middle preview, then leave it. Its neighbours should
   move to make room and then move back, without ever covering one another.
3. Close the middle preview. The remaining previews should close the gap.
4. Repeat from a top corner and on a shorter work area (or with four-plus
   captures, forcing the overflow badge). Overflow within one column should
   continue as a second column inward from the selected edge.
5. Capture while previews are visible. They should disappear during capture,
   then return in the same places.
6. With two displays, move the pointer to the other display and capture
   again. Every existing preview should relocate to join the new one on that
   display, in a single stack.
7. With the skip-the-panel preference on, fire a capture while three other
   previews are visible. The visible three should not move or hide — the
   silent capture should never appear and should not count toward the cap.
8. Rest the pointer off a card. Only the picture and, if any are waiting, the
   overflow badge should be visible. Move the pointer over the card: the
   action row should appear. Enter Redact and move the pointer away: Undo and
   Done should stay visible.
9. Look at a card at rest. The picture should fill the pane edge to edge, not
   sit smaller than it with the card's own background showing around it.
   Enter Redact: the whole capture should be visible, letterboxed if its
   aspect ratio does not match the (bigger) redact window.

The automated window test (`thumbnail.e2e.test.ts`) checks real window
rectangles through redact and removal. Pure layout tests (`thumbnail.test.ts`)
cover all corners, negative display origins, mixed sizes (including
`REDACT_SIZE` mid-stack) and short-display wrapping. `panel-waits.e2e.test.ts`
covers the overflow cap and badge, unchanged in its own claims by this
rebase. None of this judges whether the 12-point gap feels right, whether the
hover reveal feels responsive, or how macOS presents several always-on-top
windows moving at once.

## Not done here

Two more revisions from the same hardware pass are bigger design questions
rather than local fixes, and are not in this checkout:

- The Style picker (`#stylerow`'s `<select id="mode">`) is arguably redundant
  in this compact card.
- Redact should move into an "Edit" mode backed by a still editor, rather
  than growing the panel in place. There is no still editor yet (STC-300 is
  explicitly gated behind exactly this signal — "wanting to nudge a
  redaction rectangle" is one of its own two stated triggers) and `panel-
  actions.ts`'s own module doc states "a shot has no Edit... a shot's
  editing is Redact, which lives in the panel." Removing in-panel Redact
  before a replacement exists would mean a capture could no longer be made
  safe to share at all, so this needs its own scoping before it is built.
