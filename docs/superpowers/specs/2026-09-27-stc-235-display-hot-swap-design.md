# STC-235 — Display hot-swap: refit and continue mid-recording

**Date:** 2026-09-27
**Branch:** `accounts/stc-235-display-hot-swap` (off `origin/master` @ `0fe7e21`)
**Linear:** [STC-235](https://linear.app/studio-cartelli/issue/STC-235)

## What this changes

Today every display reconfiguration during a take stops it — a resolution
change, an unrelated display unplugged, an arrangement drag, a display added.
`Watchers.handleDisplayChange` never inspects the flags or which display
changed; `main.swift`'s `onDisplayChange` calls `stop(reason:
"display-reconfigured")` unconditionally. That was deliberate (review P7,
`docs/review-2026-09-02.md` §P7): even an unrelated change can move the
captured display's global origin, and the transform maps every cursor event
through ONE `anchors.display`.

After this ticket, **a take continues through any display change it can
survive**, in the SAME `display.mp4`, and stops only when it cannot:

| change | outcome |
|---|---|
| captured display gone (not in `SCShareableContent`) | **stop**, `display-reconfigured` (unchanged) |
| region scope, region no longer inside the display's new point bounds | **stop**, new reason `region-out-of-bounds` |
| anything else — mode/scaling change on the captured display, another display added/removed/moved, main display changed | **continue** (refit) |

Window resize/close still ends a window take (STC-382, Patrick's call — not
touched here).

## Decisions (Patrick, 2026-09-26/27)

1. **Scope: any survivable change continues.** Losing the captured display is
   the only display-change stop. No fallback to another display. This also
   closes review P7: each geometry entry carries its own origin, so the
   separate "origin timeline" ticket P7 proposed is subsumed.
2. **A different aspect is fitted, letterboxed** — never stretched, never
   cropped. For a same-aspect change (the common one) the fit is the full frame.
3. **The first geometry sets the output.** The take's capture size — and so its
   default export size and presets — is what it started at, exactly as today.
4. **Region continues only if it still fits**; otherwise `region-out-of-bounds`.
   No clamping (it would silently record a different area). Window scope
   continues at its new backing scale.
5. **Approach B: one file, scaled at capture.** Considered and rejected:
   approach A, the ticket's literal "finalize display.mp4, open a new writer,
   segments in the schema, export stitches". A breaks nearly every
   one-geometry-per-take assumption in the transform (demux's single `avcC`,
   three decoder sites configured once, one flat `frames`, the compositor's
   stretch, `TAKE_FILES`, the editor, the library, five gate scripts) and is
   ~4 PRs. B never changes the writer's dimensions, so `AVAssetWriter`'s
   rigidity is never engaged, and only the cursor/zoom/legibility maths learns
   about time-varying geometry. **Accepted costs:** a switch to a higher-res
   mode is downscaled into the original capture size; the letterbox is baked
   at capture rather than chosen at export. STC-307's `recording.json` segment
   list remains unconsumed — STC-236 and re-take still need it; this ticket
   does not.

## Helper

### Detect and classify — `helper/src/DisplayChangeDecisions.swift` (new, pure)

CG fires the reconfiguration callback once per affected display, often several
times for one physical change. `Watchers` keeps emitting its
`display-reconfigured` warning per callback exactly as now (the app's idle
display-list refresh depends on it); the RECORDING's reaction changes:

- `onDisplayChange` no longer stops. It (re)arms a **debounce** of
  `DISPLAY_CHANGE_SETTLE_MS = 250` on the capture queue; each further callback
  restarts it. When it fires, the session runs ONE refit decision.
- The decision is a pure function:
  `decideDisplayChange(scope, capturedDisplayPresent, newDisplayPointBounds) ->
  .stop(reason) | .refit`, where
  - captured display absent → `.stop("display-reconfigured")`
  - region scope and region not ⊆ new point bounds → `.stop("region-out-of-bounds")`
  - otherwise → `.refit`
- A change arriving while `.starting` or `.stopping` is ignored, as now. A
  change arriving mid-refit re-arms the debounce and is decided after the
  current refit settles (never two refits in flight).

The existing `self.capture === session` identity guard pattern
(`onStreamDied`, `onWindowChanged`) is added to the display path, which today
has none.

### Refit — `CaptureSession.refit()` in `Capture.swift`

1. Fetch fresh `SCShareableContent`; re-resolve the target through
   `resolveCaptureTarget` (display, window or region), giving the new
   geometry's points, pixels, origin and backing scale.
2. Compute the **fit rect** — `fitRect(source: Size, into: capture) -> Rect`
   in `CaptureGeometry.swift` (pure): the source's aspect fitted inside the
   fixed `captureW × captureH`, centred, every edge rounded to an even pixel.
   Same aspect ⇒ exactly `{0, 0, captureW, captureH}`.
3. Apply it to the live stream: `updateContentFilter` (new `SCDisplay`/window
   object) then `updateConfiguration` with the SAME `width`/`height`,
   `destinationRect = fitRect`, `scalesToFit = true`,
   `preservesAspectRatio = true`, `sourceRect` recomputed for a region. If
   either call errors, **fall back to restarting the display stream only**
   (`stopCapture` → `startStream` with the new config). The `AVAssetWriter`,
   `WriterGate`, pause gate, event tap, cursor sampler, camera, mic and system
   audio are never touched.
4. **Record the geometry from a frame, not from the callback.** The first
   frame whose SCK `contentRect` attachment (`SCStreamFrameInfo.contentRect`)
   matches the new fit rect ends the refit; its PTS is the entry's `startNs`.
   If SCK reports a rect that differs from the computed one by more than 1 px,
   the helper warns `display-refit-rect-mismatch` and records SCK's rect — the
   file's pixels are the truth. If no matching frame arrives within
   `REFIT_FRAME_TIMEOUT_MS = 3000`, the take stops with
   `display-reconfigured` (a take whose geometry is unknown must not continue).
5. Append `{startNs, display, contentRect}` to the session's geometry list and
   send an unsolicited `display-refit` event
   `{startNs, display, contentRect, path: "update" | "restart"}`.

Frames arriving between the change and the first refitted frame are appended
normally; they are the old geometry and are covered by the previous entry. A
restart leaves a PTS gap in the one file — the STC-408/STC-448 hazard applies
only to gaps ≥ 3 s, and the runbook measures the real seam.

### Fault — `STC_CAPTURE_FAULT=display-refit`

Armed like `window-resized` (`armWindowFault`): 0.5 s into the take it drives
the debounced path as if CG had called back, and the refit runs against the
SAME display with a forced synthetic aspect (a fit rect narrower than the
frame), so the grant test sees a real letterbox and a real second geometry
entry without anyone touching System Settings. `STC_CAPTURE_FAULT=display-gone`
drives the classifier's stop arm.

### Sidecar — `AnchorsDoc.swift`

`anchorsDocument` gains the geometry list; `geometry` is emitted only when it
has ≥ 2 entries, and its presence forces **version 7** (the minimum-version
rule — a take with no refit stays v2–v6 byte for byte).

## Schema — `schema/anchors-7.schema.json`

anchors-6 plus:

```json
"geometry": {
  "type": "array", "minItems": 2,
  "items": {
    "type": "object", "additionalProperties": false,
    "required": ["startNs", "display", "contentRect"],
    "properties": {
      "startNs": { "type": "integer", "minimum": 0 },
      "display": { "$ref": "#/$defs/display" },
      "contentRect": {
        "type": "object", "additionalProperties": false,
        "required": ["x", "y", "width", "height"],
        "properties": {
          "x": { "type": "integer", "minimum": 0 },
          "y": { "type": "integer", "minimum": 0 },
          "width": { "type": "integer", "minimum": 2 },
          "height": { "type": "integer", "minimum": 2 }
        }
      }
    }
  }
}
```

and `region-out-of-bounds` (plus its `-timeout` variant, per the enum's
existing convention) in `stop.reason`.

Invariants the loader enforces (`parseAnchors` refuses, never defaults):

- `geometry[0].display` deep-equals top-level `display`;
  `geometry[0].contentRect` is the full capture frame;
  `geometry[0].startNs === capture.firstFrameNs`.
- `startNs` strictly increasing.
- every `contentRect` lies within `capture`, with even `x/y/width/height`,
  positive size.

Top-level `display` keeps meaning "the display at the start of the take", so
no v≤6 reader changes meaning.

## Transform

`render(project, session, t)` stays pure; geometry is session data.

### `spaces.ts` — the owner (STC-314)

- `geometryAt(session, frameNs) -> { display, contentRect }`: the entry with
  the greatest `startNs ≤ frameNs`, where `frameNs` is the PTS of the frame
  being SHOWN at `t` (`frameIndexAt`), not `t` itself. The cursor is mapped
  with the geometry of the picture beneath it, so the seam follows the same
  hold rule as frame selection. A take with no `geometry` returns
  `{ anchors.display, fullFrame(capture) }`.
- `displayToOutput(display, contentRect, capture, output)`: global points →
  display-local points → `contentRect` in capture pixels → output. With a
  full-frame `contentRect` it reduces exactly to today's
  `sx = output.width / display.pointWidth` map. The header's vocabulary table
  gains the `contentRect` space.

### `render.ts`

Calls `geometryAt` once per `t` and passes the result to `displayToOutput`.
`pxPerPoint` follows the new scale after a refit (the content really did
change scale).

### `zoom-change.ts` — stage 2 WHERE

`deriveFromCursor` converts each cursor sample to capture UV with the geometry
at that sample's own time before the union, so a window spanning a seam is
cropped around where the activity actually appeared. The square-UV rule is
unchanged (the capture aspect never changes). Manual overrides are already in
capture UV — untouched. The change track works in capture pixels — untouched.

### `legibility.ts`

Effective px becomes
`textPt × embedWidth × zoom × (contentRect.width / capture.width) / display.pointWidth`,
evaluated per geometry entry; `app/src/editor.ts` shows the **worst** entry,
so a take that downscaled mid-way is warned about for its smallest text.

### `types.ts`, `session.ts`

`Anchors` gains `geometry?`; `loadSession` accepts anchors v1–7.

### Not changed

demux, decode, `frame-source.ts`, `seeking-frame-source.ts`, frame selection,
the compositor (frames arrive already letterboxed), `output-size.ts`,
`defaultProject`, manual-zoom `aspectWH`, preview, export, `TAKE_FILES`,
change track, every gate script.

### Known, accepted imprecision

Between the physical change and the first refitted frame (the seam — expected
well under 1 s, measured by the runbook), cursor events are already in the new
global coordinate space but are mapped with the held frame's OLD geometry, so
the cursor can be misplaced for the length of the seam. Closing it would need
a `changedNs` field to hide the cursor across the seam; not built unless the
runbook shows the seam is long enough to see.

### `TRANSFORM_VERSION`

Every existing take renders byte-identically (tested). Whether a new input
field alone warrants a bump is settled in the plan against `render.ts`'s own
bump rule, not here.

## App

- `library-items.ts`: `SUPPORTED_ANCHORS_VERSIONS` gains 7 (pinned by
  `take-list.test.ts`).
- `supervisor.ts`: `display-refit` is not a stop and does not change
  recording state; forwarded to the renderer.
- `renderer.ts`: `display-refit` → a quiet, non-blocking note ("Display
  changed — recording continues") and `refreshDisplays()`; no alert.
  `display-change-during-recording` is no longer sent for a refit.
  New stop copy for `region-out-of-bounds`: "The display changed and the
  recorded area no longer fits on it, so the recording was stopped."
- Stale statements corrected: `supervisor.ts:224-226` comment,
  `CaptureDecisions.swift:471-480`, `PHASE-1.md` hot-swap row,
  `docs/CORRECTNESS-TRAPS.md` ("display hot-swap is a stop, not a rebuild"),
  CLAUDE.md's hot-swap sentence and its Toolchain paragraph (the machine now
  builds with Swift 6.4 / SDK 27.0, `build.sh` targets macOS 26 — the "13.3
  SDK, KVC for captureResolution" description is stale).

## Tests

**Swift, pure (CI):** `decideDisplayChange` — each row of the outcome table,
region exactly-fits vs one point over; a burst of callbacks collapses to one
decision (debounce as a pure reducer over timestamps). `fitRect` — wider,
taller, same aspect ⇒ full frame, odd source sizes ⇒ even edges, always
centred and inside.

**Grant (`npm run test:capture`, not CI):**
`helper/test/display-refit.grant.test.ts` —
- `STC_CAPTURE_FAULT=display-refit`: take continues, ends by the client's
  `stop`, ONE `display.mp4`, anchors v7, 2 geometry entries, entry 1's
  `startNs` equals a real demuxed frame PTS, and pixels outside entry 1's
  `contentRect` in a frame after it are black.
- `STC_CAPTURE_FAULT=display-gone`: stops with `display-reconfigured`.
- **Control:** the same take with no fault is v≤6 with no `geometry` — proving
  the fault is what made the difference.

**`helper/test/stop-reasons.test.ts`:** validates against anchors-7 (not
anchors-3) and pins `display-reconfigured` and `region-out-of-bounds`
explicitly.

**Transform (CI):** schema/loader acceptance and every refusal above;
`geometryAt` selects by shown-frame PTS, including a `t` inside the seam;
**byte-identity** of existing fixtures' render output before/after;
a hand-authored `fixtures/refit/` v7 session (reusing the fixture video, with
a letterboxed second entry) where the cursor lands inside `contentRect`;
a zoom window spanning the seam; legibility worst-entry.

**App e2e:** a fake-helper `display-refit` event raises no alert and the take
keeps recording; `region-out-of-bounds` shows its stop copy.

## Delivery — two PRs

1. **Schema + transform + app.** Everything above except the helper. Fully CI
   testable against the hand-authored fixture; safe to merge first because
   nothing emits v7 yet.
2. **Helper + runbook.** Classifier, debounce, refit, faults, sidecar, grant
   test, `docs/STC-235-RUNBOOK.md`.

## Runbook — what only a Mac can settle (`docs/STC-235-RUNBOOK.md`)

The acceptance ("a recording that spans a display resolution change produces a
watchable, correctly-timed export") is met only by §3.

1. Whether `updateConfiguration` survives a real mode change, or the restart
   fallback fires (`display-refit.path`).
2. The real seam length (gap between the last old and first refitted PTS).
3. **A real scaled-resolution change mid-take, then WATCH the export**: the
   letterbox where anchors says, the cursor on target on both sides of the
   seam, timing continuous.
4. Unplug an unrelated display mid-take → continues; origin shift absorbed.
5. Unplug the captured display → stops, `display-reconfigured`.
6. A region near the edge, then a scaling change that shrinks the display →
   stops, `region-out-of-bounds`.
7. Whether system audio's own display-filtered stream survives the change
   (if not: its existing `system-audio-stopped` warning; fixing it is not this
   ticket).
8. Whether SCK's `contentRect` attachment matches the computed fit rect
   (`display-refit-rect-mismatch` never fires).
