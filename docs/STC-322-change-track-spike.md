# STC-322 — Change-track spike: a post-recording pass that writes changes.json

**The kernel, schema and pure reduction are built, tested and pinned. The
end-to-end run against a real take — and therefore the actual yes/no on "is
the signal usable" — could not happen from this sandbox, for the same reason
STC-319/320 already hit: no real video decode here. That is stated here
rather than implied by a green test suite.**

## What is built

- `transform/src/frame-diff-rule.ts` — the change-detection kernel, vendored
  (not imported — separate repos, no package between them) from
  `patcartelli/studio-cartelli`'s `src/lib/frame-diff-rule.ts` (STC-320,
  commit `7df03edc`). Same Rec.601 luma weights, same `>=` threshold
  convention, same 64x36 grid, same per-pixel-visited-once reduction (not
  study one's NEAREST point-sampled raster — see
  `docs/STC-320-WGSL-PORT.md` for why that distinction is the whole point).
  Trimmed on the way in: `pointSampledFraction` and `compareGrids` exist
  upstream only to support a GLSL/WGSL cross-check this repo has no second
  implementation to run against, so they were left out rather than carried
  as dead code.
- `schema/changes-1.schema.json` + `transform/src/changes.ts` — the sidecar
  document and its loader (`parseChanges`/`changesForWrite`), same
  refuses-rather-than-defaults shape as `recording.ts`. Per-frame: PTS
  (`t`, matching `Session.frames`), a row-major `cells` grid, and
  `changedFraction` (free from the same reduction, so a consumer wanting one
  scalar — same as STC-319's own sparkline — need not re-derive grid
  geometry). Frame 0 carries an all-zero grid rather than being omitted, same
  convention the study page used, so a consumer can index by frame position
  without a special case.
- `transform/src/changes.ts`'s `computeChangeDocument` — the pass's PURE
  half: `Frame[]` + PTS array in, a `Changes` document out. No canvas, no
  WebCodecs — which is what makes it the one part of this spike that could
  actually be unit tested and measured from this sandbox
  (`transform/test/changes.test.ts`, `transform/test/frame-diff-rule.test.ts`
  — 33 tests, including the closed-form fixtures adapted from upstream's
  `frame-diff-fixtures.ts` and the caret-phase-sweep proving the reduction
  has no blind spot at any of the 10 lattice positions where a point sample
  misses it 8 times out of 10).
- `transform/src/change-track.ts`'s `computeChangesForVideo` — the browser
  half: `decodeAll` + a reused `OffscreenCanvas` readback (same idiom
  `harness/main.ts`'s `makeCtx`/`getImageData` already uses) + the pure
  reduction above. Typechecks; see below for what running it actually showed.
- `harness/change-track.html`/`.ts` + `scripts/change-track-one.mjs` — a
  runnable page and driver script, mirroring `export.ts`/`export-one.mjs`'s
  shape exactly, for a machine with real Chrome to point at a real take and
  get a `changes.json` plus a printed cost.

`npm run typecheck` is clean on all of it (all three passes). Nothing else in
the repo changed — no IPC handler, no UI, per the ticket's own "no UI, no
gate, throwaway branch acceptable."

## What running it actually showed

`scripts/change-track-one.mjs` (and the underlying `harness/change-track.ts`
page) were driven against `fixtures/basic` with the bundled Playwright
Chromium here (this repo has no system Chrome, and the proxy blocks
installing one — same starting point STC-325 recorded). The result: fetch
and `demuxTrack` both succeed, `computeChangesForVideo` runs, and it fails
**exactly** at `VideoDecoder.configure()` inside `decodeAll` —

```
NotSupportedError: H.264 decoding is not supported.
```

— the identical failure `npm run gate*` already documents on this machine,
not a new or different one. An earlier draft of this investigation reported
something worse (`VideoDecoder` entirely `undefined`) from a raw
`page.evaluate` probe on `about:blank`; that was an artifact of the probe's
own opaque-origin context, not a property of this Chromium build, and was
corrected by driving the real served harness page instead — worth recording
because it is exactly the kind of "a measurement that could not see what it
was being read as evidence about" trap CLAUDE.md already warns about
elsewhere, caught here by re-checking rather than by trusting the first
number.

So: **everything up to and including the codec touch is validated as
wired correctly.** What is NOT validated, and cannot be from here:

1. Whether the produced `changes.json` looks USABLE on real footage — the
   ticket's actual question. STC-319 already established this needs the two
   real fixtures (Music Network from STC-313, a form-heavy app) and neither
   exists yet; STC-313's own status is still "the recording is not done."
2. `extractFrames`'s canvas-readback correctness against a real decoded
   frame — reasoned about (same `drawImage`/`getImageData` idiom already
   proven correct elsewhere in this codebase, e.g. `compositor.ts` via the
   identity gate) but never actually run.
3. The full pass's real cost (decode + canvas readback + reduction, together,
   per frame, at capture resolution) — see below for what a partial answer
   could and could not say.

## What the cost measurement actually says

The ticket asks to measure the cost and record the number. The one part of
that this sandbox could genuinely measure — no decode, no canvas, no
browser, just the reduction itself on synthetic RGBA buffers in plain
Node — is `changeGrid`'s own compute cost at capture resolution:

```
[STC-322] changeGrid 3840x2160 (64x36 grid): 240-296 ms (4 runs, this machine)
```

Against the export path's measured 11.0 ms/frame at 4K (PHASE-2), this is
**roughly 25x slower**, for the reduction alone — before decode and before
the canvas readback, both unmeasured here and both real costs on top of this
number. That is not close to "a fraction of" the export cost the ticket
hoped for; it is the opposite, and worth saying plainly rather than rounding
away: **a pure-JS CPU reduction at full capture resolution is not the
production answer.** This is not a surprise — it is exactly why STC-320
exists as a WGSL port in the first place ("the recorder's compositor is
locked to WGSL... auto-zoom stage 2 keys off the signal it produces"); this
spike's CPU path was always meant to validate correctness and shape, not to
be shipped as the compute backend.

What is not measured, and matters for whether the real number is better or
worse than this one: this machine's CPU characteristics are unknown relative
to a real Mac's, `changeGrid`'s tight nested loop has not been profiled or
optimized (a typed-array reduction like this is a plausible target for
further tuning even short of moving it to the GPU), and the real per-frame
cost in production would be decode + readback + reduction together, which
could not be measured here at all.

## Is the signal usable? (the ticket's actual question)

**Not answered, and for the same reason STC-319 could not answer it: no real
footage, no real decode.** The plumbing (schema, loader, pure reduction, and
now the browser-side wiring up to the codec) is built and correct as far as
this sandbox can show. Whether a coarse 64x36 grid actually distinguishes "a
panel changed" from "a spinner is idling" on real screen-recording
footage — the question the ticket exists to answer — needs the two real
fixtures STC-319 already asked for, and a machine that can decode H.264.

Per the ticket's own "if no, say why — that is a result": the answer here is
**not yet answerable**, not because anything built is wrong, but because two
separate blockers (real footage, real decode) that predate this ticket still
stand. `scripts/change-track-one.mjs <sessionDir> [threshold]` is what a
session with both should run — it writes `changes.json` beside the take and
prints the real end-to-end cost, which is the number this doc could not get.

## What a future session needs

1. A Mac, to run `node scripts/change-track-one.mjs <sessionDir>` against a
   real take (STC-313's Music Network take, once it exists, and a form-heavy
   app fixture — the same two STC-319 asked for) and report the real
   per-frame-pair cost including decode and readback.
2. Look at the resulting `changes.json`'s grid alongside the take's
   `events.json` — does a click/drag correlate with a change spike the way
   STC-319's own study hoped to show? Does a spinner or a live chart register
   as a small continuous hump rather than a discrete one? That comparison is
   auto-zoom stage 2's actual rules list, still unwritten.
3. If the CPU reduction's cost holds up on real hardware (it may well be
   faster on a Mac's CPU than this sandbox's), a production pass might not
   need the WGSL kernel after all for a POST-recording (not live) computation
   — that is worth deciding with a real number before assuming GPU compute is
   required. If it does not hold up, `docs/STC-320-WGSL-PORT.md`'s WGSL leg
   is exactly what stage 2 would build the real compute backend on.
