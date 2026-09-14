# STC-330 — manual zoom override, phase 1, on a Mac

Written on Linux, so **every judgement about look and feel is unmade**, and
one thing the ticket's own Done bar names — `gate:identity` passing with an
override applied — has never run at all: the gates need real Chrome, which
this sandbox does not have (same blocker recorded throughout CLAUDE.md for
every gate here). Everything else the pure and E2E tests can check is
checked: 39 pure tests (`zoom-override.test.ts`,
`zoom-override-project.test.ts`) plus 9 real-pointer E2E tests
(`app/test/zoom-override.e2e.test.ts`) drive the actual editor window under
`xvfb-run` — block selection, a real mouse drag on the preview, the preset
picker, removing an override, and the "just looking costs nothing" property.

```
npm run app:start          # NOT via Playwright — see the TCC trap in CLAUDE.md
npm run gate:identity       # the one thing this session could not run at all
```

Open a take that has at least one click or drag in it (the demo Music
Network take, or any take with a click) so the Zoom lane has a block.

---

## §0 — is this the build you think it is?

* The Zoom lane (under Clip, in the editor's timeline) now shows a FILLED
  shape — a trapezoid per zoom window — rather than a thin stroked line.
* Clicking inside a trapezoid selects it: the block gets an outline, a new
  row appears below the trim controls ("Ease" dropdown, Remove override,
  Done), and the preview jumps to somewhere inside that window.

If the lane still shows a bare line with nothing clickable, `editor.js` is
stale — rebuild.

---

## §1 — the fill vs. the old line

The curve being sampled did not change — same `render().zoom.amount`, same
`zoomCurve` helper. Only the draw call changed (fill instead of stroke). On
a take with ONE isolated click, does the trapezoid actually look like an
ease-in ramp / flat top / ease-out ramp, or does it look like a triangle or
a rectangle? If a preset is very snappy relative to the sample resolution
(480 buckets across the whole take), the ramps may be too abrupt to read —
worth knowing whether the bucket count needs to scale with zoom level.

## §2 — selecting a block, and what the preview shows while editing

* Click a block. The preview should jump straight to somewhere inside that
  window and show the picture UNCROPPED (full frame) even if this window
  already has a saved override from a previous session — this is
  deliberate (see the header comment in `app/src/editor.ts`'s override
  section) so a drag maps 1:1 to the picture.
* Does the jump read as intentional, or does it feel like the player lost
  its place? There is no transition/animation on the seek — instant cut.
* Click **Done** (or press Escape) without dragging anything. The preview
  should NOT change (still full frame while editing showed it that way),
  and nothing about a previously-saved override should be lost — reopen the
  same block and confirm the rect is still there. (The E2E suite pins this
  exact property; this is a chance to feel it rather than just prove it.)

## §3 — the rect tool

* Drag a rectangle over some content. Does the drag feel direct — does the
  box track the pointer, or does it lag?
* Try a bare click with no drag: it should place a rect of a fixed relative
  size (roughly 40% of the frame's short edge) centred on the click. Is
  that a useful default, or too big/small to be worth having?
* Drag from inside the frame to OUTSIDE it (off an edge or corner). The box
  should clamp to the frame rather than let you draw a rect the export
  could never honour. Does the clamp feel natural, or does the box seem to
  "stick" unexpectedly?
* At 4K, is a small drag (say, a toolbar icon) actually draggable with a
  mouse/trackpad, or does the target read too small to hit reliably?

## §4 — the preset picker and per-window easing

Set one window's Ease to something different from the project's own zoom
preset (Settings → whatever the project default is), then play through
that window and the next one (if there are two). The overridden window
should visibly ease at a different rate than an un-overridden one on the
SAME take. This is the one place this ticket's design differs from stage
1's original single-spring-per-take model — `zoom-override.ts`'s own header
explains why grouping by resolved easing and composing by max is
mathematically equivalent to one spring when nothing is overridden, but
"equivalent on paper" and "reads right on a real take" are different
claims, and only this can settle the second one.

## §5 — the "overridden" indicator and Remove

* A block with a saved override should show a small dot/mark distinct from
  the selection outline (`.zoomblock.overridden`). Is it visible enough at
  the lane's height (22px), or does it disappear against the fill?
* Click **Remove override** on a block that has one. It should close the
  editor for that block immediately (no separate confirmation) and the dot
  should be gone. Is "no confirmation" the right call for something this
  reversible (just drag again), or does it feel too easy to lose work?

## §6 — does the whole thing survive an export?

Tune an override, export the take, and watch the file. This is the
literal Done bar the ticket states and the one thing `gate:identity`
would otherwise prove automatically — with no gate available here, this
step is the only verification there is:

* Does the picture actually zoom into the tuned rectangle during that
  window, easing in and out smoothly?
* Does a SECOND window on the same take — one with no override — stay at
  full frame the whole time, unaffected?
* Scrub through the export in a real player (QuickTime) rather than trusting
  the in-app preview alone — the preview and the export share one `render()`
  call, but only watching the actual file closes the loop STC-232's own
  phase-1 notes insist on ("only watching proves the agreed answer is
  right").

## What is deliberately NOT here

* STC-331 (author a brand-new window auto-zoom never proposed) and STC-329
  (remove/retime a derived window) — phases 2 and 3 of STC-328, separate
  tickets.
* Any confirmation dialog, undo/redo beyond "drag again", or a history of
  past rects — the ticket's own scope is rect + easing on an EXISTING
  derived window, once.
* Blending between TWO different overridden rects if a user changes their
  mind mid-window — there is one rect per window, replaced whole.
