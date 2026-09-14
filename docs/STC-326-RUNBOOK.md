# STC-326 — auto-zoom stage 2 (change decides where), on a Mac

Written on Linux, so **the classifier's every threshold is reasoned, not
seen**, and the ticket's own literal Done bar — `gate:identity` with both
stages on — has never run at all: no gate can run from this sandbox (no
system Chrome, no H.264 decode), same blocker recorded throughout CLAUDE.md
for every gate here.

A second, sharper gap: the ticket says to "apply the temporal-filter rules
the lab study wrote" (STC-319). That document's own deliverable — the rules
list distinguishing change that starts near an event from change that is
continuous or ambient — **is not written**, and STC-319's own entry in
CLAUDE.md says so; it is blocked on the same thing this ticket is (a Mac,
real footage). So `zoom-change.ts`'s classifier is reasoned directly from
the FOUR outcomes this ticket's own text states must be right, not sourced
from a document that does not exist. Every threshold it uses
(`BURST_LEAD_NS`, `BURST_TRAIL_NS`, `AMBIENT_FRAME_FRACTION`,
`BURST_CONCENTRATION`, `MIN_ZOOM_DELTA_FRACTION`, `CROP_PAD_FRACTION`,
`VIEWPORT_MIN_FRACTION`/`MAX_FRACTION`, `CURSOR_DEAD_ZONE_UV`) is a stated,
provisional number, the same posture `zoom.ts`'s presets are already in.

```
npm run app:start          # NOT via Playwright — see the TCC trap in CLAUDE.md
npm run gate:identity       # the one thing this session could not run at all
```

Open a take that has at least one click or drag in it. **No take has
`changes.json` yet** — nothing here can run STC-322's browser decode pass on
a real recording — so every real take exercises the FALLBACK path (cursor
clustering), not the change-track path, however this is opened. The
change-track path is proven only by hand-authored fixtures
(`transform/test/zoom-change.test.ts`).

---

## §0 — is this the build you think it is?

* Open a take with a click in it (no manual override needed — this is the
  point). Play through the window (roughly 300 ms before the click to
  2500 ms after). The picture should visibly crop toward the click, ease in,
  hold, and ease back out — with **no override set** on that block.
* If the picture never moves without an override, `render.ts` is stale or
  `project.zoom.enabled` is off — rebuild and check the zoom toggle first.

## §1 — does the fallback (every real take today) read as intentional?

Since no take has a change track, EVERY window you see move is the cursor
fallback: `deriveZoomCrop`'s `deriveFromCursor`, a greedy dead-zone cluster
of the window's own down/up/move positions, padded, then clamped into
[`VIEWPORT_MIN_FRACTION`, `VIEWPORT_MAX_FRACTION`] = **[0.5, 0.7]** of the
frame on each axis.

* A bare click: does the crop it produces (roughly 60% of the frame,
  centred on the click) read as "zoomed toward what I clicked", or as an
  arbitrary square?
* A drag: does the crop grow to cover the drag's own path, and does that
  feel like the right amount of context, or too tight/too loose?
* Two clicks close together in different places (inside `ZOOM_MERGE_GAP_NS`
  of each other, merging into one window): the cluster should cover BOTH —
  does that read as "this window is about two things" or as an
  overcorrected wide crop?

This is the single most consequential judgement in this ticket, because it
is what every real take will show until someone runs STC-322's browser pass
on real footage.

## §2 — the viewport clamp (0.5 / 0.7)

These two numbers came from BRIEF.md's original "movement decides where"
design line, carried over rather than re-derived — they were never watched
either. Tune by feel:

* Does a 0.5-wide crop (the floor, hit by any tight cluster — a bare click
  is the common case) feel like a real zoom, or too subtle to notice?
* Does a 0.7-wide crop (the ceiling, hit by a wide drag or a union spanning
  much of the frame) still read as "zoomed in", or does it start to look
  like the full frame with a slightly different edge?

## §3 — the "don't zoom" cases (only reachable with a real change track)

These need `changes.json`, which needs STC-322's browser pass run against
a real take — not reachable by opening the app alone. If/when that pass has
been run on a real recording:

* A window over a video playing, or a page scrolling (continuous change
  everywhere): does the take correctly NOT zoom?
* A click with no visible result (nothing changes): does the take correctly
  NOT zoom, rather than zooming to an arbitrary empty region?
* Three dashboard panels updating together: does the crop frame their
  UNION, not just one of them?

## §4 — a manual override still wins

Tune an override on a window that stage 2 was already cropping on its own
(§0/§1). The override should take over completely — the fallback's answer
should be invisible once a manual rect is set, and removing the override
should return to whatever stage 2 was doing before, not to the full frame.

## What is deliberately NOT here

* The change-track path on real footage — needs STC-322's browser pass run
  against a real recording, which needs a Mac to even attempt.
* STC-319's own rules list — still not written; this ticket's classifier is
  a best-effort stand-in, not a claim that the real rules are known.
* Any UI for previewing "what stage 2 would crop to" before committing to an
  override, or for seeing which signal (change vs. cursor) produced a given
  crop — not asked for, and everything a take shows today is the cursor
  fallback regardless.
