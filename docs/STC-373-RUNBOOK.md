# STC-373 — the editor window, on a Mac

Written on Linux, so **every judgement about look and feel in this document is
unmade.** Everything the pure and E2E tests can check is checked — the ruler's
pan/zoom transform, the trim math, the export dialog's wiring, the id
migration for the five heaviest E2E files plus three more found by grep — all
of it runs for real under `xvfb-run` in this repo's sandbox. What no headless
Xvfb run can settle is whether any of it reads as an editor rather than as a
diagram of one.

```
npm run app:start          # NOT via Playwright — see the TCC trap in CLAUDE.md
```

Open a take from the library. "Preview" now opens a SECOND window — confirm
that literally happens (a new window, with its own traffic lights) before
judging anything else; if it does not, you are looking at a stale build.

---

## §0 — is this the build you think it is?

* A second, resizable window opens with the take already loading.
* The transport bar reads **Play / clock / (blank) / Export… / Close** — no
  `#outsize`/`#vieweye`/`#legibility` visible until Export… is clicked.
* Below the transport: a thin ruler, then two lanes labelled **Clip** and
  **Zoom**.

If any of that is missing, `app/dist/editor.js` is stale — rebuild.

---

## §1 — fonts (the ticket's own line item)

Labels and buttons should be **Geist**; every numeric value (the clock, the
frame readout, durations) should be **Geist Mono** and hold a fixed width as
digits change, the way `app/src/scrubber.ts`'s runbook already asked for the
old build. Silkscreen must NOT appear anywhere in this window — it is the
take's own face, not chrome, and never shipped here.

Open the dev console (if reachable) and check `document.fonts` — all five
weights (`Geist` 400/500/600, `Geist Mono` 400/500) should report `loaded`
with no CSP or 404 errors in the console. A missing `font-src 'self'` would
fail silently otherwise — the CSP meta tag is what makes the local files
loadable at all under `default-src 'none'`.

---

## §2 — the ruler: pan and zoom

Drag on the ruler — the whole timeline (both lanes, the trim handles, the
playhead) should PAN together, staying in sync. Scroll/pinch on the ruler —
it should ZOOM, anchored under the pointer: whatever frame is under the cursor
should stay under the cursor as the timeline stretches.

**This is the one piece of UI in the ticket with no precedent to copy** — it
is implemented as a CSS `scaleX`/`translateX` transform on the full-duration
track, so the existing trim/scrub pixel math (`scrubber.ts`, unchanged) reads
the POST-transform bounding rect and needs no rewrite. What that buys is
correctness; it says nothing about feel. Judge:

* Does the zoom actually feel anchored, or does the anchor drift after a few
  scroll ticks?
* At the narrowest zoom (near `MIN_SPAN_FRACTION`, 1/64 of the take), is the
  Clip lane's activity bar chart still legible, or is it a wall of bars?
* Does panning past either end of the take clamp cleanly, or overshoot?

If the anchor drifts, the likely cause is `zoomSpan`'s `anchorFraction`
being computed against the OLD span after `panSpan` has already run once in
the same gesture — a fast scroll-while-still-moving case no synthetic test
here reached.

---

## §3 — the Clip and Zoom lanes themselves

**Clip** is `app/src/timeline-activity.ts`'s `clipActivity` — a bucketed
weighting of `events.json`, clicks and drags weighted far above bare moves,
normalised so the loudest bucket always reads full-height. On a take with a
few deliberate clicks and a lot of idle mouse travel, the clicks should stand
out as clear spikes against a low, mostly-flat floor. If the whole lane looks
uniformly loud, the take is probably drag-heavy (a drag's many `move` events
each contribute) rather than the weighting being wrong — cross-check against
`events.json` before touching `MOVE_WEIGHT`.

**Zoom** is `render()`'s own `zoom.amount`, sampled read-only across the take
— it should rise and fall exactly where the Clip lane spikes, since stage 1's
auto-zoom windows are built from the same clicks and drags. On a take with
`project.zoom` disabled or absent, the curve should be **flat at zero** the
whole way across.

Neither lane is interactive yet (v1 is read-only) — the manual override lane
is STC-328/330/331. The filmstrip texture-swap (pointer-activity vs. frame
tiles) that the ticket flags as an open question was **left out of this
build**, per the ticket's own default framing; judge whether the Clip lane's
bar-chart-only rendering is good enough on its own before that is picked back
up.

---

## §4 — the export dialog

Click **Export…**. It should open as a real modal `<dialog>` — the transport
bar and lanes behind it should be visually dimmed/inert (a click on `#scrub`
while it is open should do nothing until the dialog closes).

Inside: export size, "Shown at" / embed width / text size, the viewer's eye
checkbox, the legibility sentence, then Export itself with its progress bar.

* On a take whose display is 4K, the legibility line should read something
  like "…renders at 4.2px — below 9px, hard to read" **and the Export button
  must stay enabled** — the ticket is explicit that this warns and never
  blocks.
* Toggle the viewer's eye and confirm the canvas behind the dialog visibly
  resizes while the dialog stays open and interactive.
* Close the dialog (Close, or however this OS's `<dialog>` responds to
  Escape) and confirm Save/Copy frame and the trim controls are usable again
  immediately.

**Judgement to make:** does bundling legibility + the viewer's eye + export
size + the export action itself into ONE dialog read as "the export step,
all in one place" (the ticket's intent) or as "too much in one modal"? If the
latter, the natural split is legibility+viewer's-eye as their own always-
visible row (closer to the old layout) with only size+export+share in the
dialog — a follow-up, not a blocker.

---

## §5 — share

Below the transport (outside the export dialog): Share to site / Site
folder… / Show published. Functionally unchanged from the old in-page
layout, just relocated — confirm publishing and re-publishing still read
"Wrote" vs. "Replaced" correctly, and that the snippet still copies to the
clipboard.

---

## §6 — the main window, after the split

The main window keeps capture, the still-capture preferences, the shortcuts
editor, the helper stats table and the library grid — nothing else. Confirm:

* The library's "Preview" action on a **recording** opens the editor window.
* The library's "Preview"/open action on a **still** is unaffected — it still
  opens the floating thumbnail panel, not the editor.
* Deleting a take that the editor currently has open does not crash either
  window; the editor's own writes should start refusing (see
  `app/test/manage.e2e.test.ts`'s "reports the failure" test for the
  load-failure case, which is the same shape).
* Opening two DIFFERENT takes in a row re-uses the same editor window rather
  than stacking a second one.

---

## What to write down

Everything numeric here (`MIN_SPAN_FRACTION`, the zoom factor per wheel
notch, `LANE_BUCKETS`) was chosen with no screen, the same position
`scrubber.ts`'s own runbook records for `RUBBER_BAND_PX` and `MIN_TICK_PX`.
If §2 or §3 reads as wrong, the fix is a constant in `app/src/editor.ts` or
`app/src/timeline-activity.ts`, not a UI restructure — record the number
that felt right and why.
