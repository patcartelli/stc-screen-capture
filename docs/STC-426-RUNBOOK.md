# STC-426 — visible vertical previews

The floating still previews use their full window sizes, separated by 12
screen points, instead of the old 26px overlapping sliver. Newest stays at
the selected corner; older previews run vertically into the work area. On a
short display the next preview starts a column farther inward. Entering or
leaving Redact, or a preview closing, reflows the whole column. Each preview
stays on the display it opened on, even if the pointer later moves to
another one.

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
6. With two displays, move the pointer to the other display and capture again.
   The existing previews should stay on their original display; the new one
   should stack on the display the pointer is now over.
7. With the skip-the-panel preference on, fire a capture while three other
   previews are visible. The visible three should not move or hide — the
   silent capture should never appear and should not count toward the cap.

The automated window test (`thumbnail.e2e.test.ts`) checks real window
rectangles through redact and removal. Pure layout tests (`thumbnail.test.ts`)
cover all corners, negative display origins, mixed sizes (including
`REDACT_SIZE` mid-stack) and short-display wrapping. `panel-waits.e2e.test.ts`
covers the overflow cap and badge, unchanged in its own claims by this
rebase. None of this judges whether the 12-point gap feels right or how
macOS presents several always-on-top windows moving at once.
