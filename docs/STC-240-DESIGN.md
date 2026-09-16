# STC-240 — Recording pause/resume

Design, written 2026-09-16. **No code yet.** This document is the agreed shape;
the implementation follows in three PRs (§9).

Filed at `docs/STC-240-DESIGN.md` rather than the brainstorming skill's default
`docs/superpowers/specs/`, because every other design note in this repo is
`docs/STC-NNN-*.md` and the table in CLAUDE.md indexes them there.

## The ticket's key question, answered

> Should paused intervals be cut (invisible) or shown as a static frame?
> Export-time decision with a project schema flag is the right shape.

**Cut. No flag.**

The instinct that it is an export-time decision is right, and the reason is
worth keeping, because it inverts which half looks expensive:

Frame selection is *"the source frame with the greatest PTS ≤ t; hold, never
interpolate"* (`transform/src/time.ts`, `frameIndexAt`). If the helper simply
stops appending while paused, `display.mp4` has a gap in its sample table and
**every sink already holds the last frame across it, with no transform change
at all.** The static-frame option is therefore free, and already the behaviour
we would get by accident.

Cutting is the expensive one. `export.ts` walks
`tNs = exportFrameTimeNs(from + k)` — a straight line from output frame to
session time — and cutting makes that mapping piecewise.

So the recording side is identical either way and the decision really is
downstream. The flag is dropped rather than built: with cut implemented,
"freeze" is the do-nothing branch, and a flag whose second value is
*disable the feature* is a setting nobody chooses. Ship one behaviour.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Paused intervals are **cut**; no project flag | Above. A three-minute pause must cost zero seconds of output — that is what a pause button means. |
| 2 | **Nothing is recorded during a pause**, plus one synthetic `move` at resume | The cursor sim eases toward the pointer at 120 Hz. Discarding events alone makes the cursor *glide* across the seam from its pre-pause position; re-anchoring makes it land. Keeping the events would also land it, but records pointer activity the user believes is paused — and puts clicks (which `zoom.ts` turns into zoom windows) inside time that no longer exists. |
| 3 | The **output axis is the pause-free axis**; a `timeline.ts` module owns both directions | `scrubber.ts`'s rule 1 is already *"position is a FRAME, not a time"*, and trim, the ruler and both editor lanes inherit it. Putting the cut on the frame axis means those surfaces are already correct. The alternative — normalising every time at load — is one rule applied in five places (`framesNs`, decoder chunk timestamps, camera frames, audio chunks, the anchors cross-checks), which is this repo's most-repeated defect and bit twice in two days on the mic path alone (STC-233). |
| 4 | The transport is a **split pill**: `#pill-pause` + `#pill-stop` | The pill is the only control that can reach a live recording. A hotkey-only pause would be undiscoverable and the pill would still have to render a paused state, so the pill is touched either way. |

### Rejected, on the record

**Map inside `export.ts` only.** Smallest possible diff, and it breaks the one
non-negotiable: preview would still play through the pauses while export cut
them, forking the transform between two sinks.

## Non-goals

- **Seam markers in the editor ruler.** The ticket floats "optionally inserting
  a visual gap indicator"; cut makes it unnecessary, and whether an editor
  should reveal where time was removed is a separate judgement.
- **Pausing a still capture.** Stills are instantaneous; there is nothing to
  pause.
- **A hotkey for pause.** The first shortcut that reaches a live recording is
  STC-388's subject (`hotkeys.ts`'s action list is stills-only today, which
  STC-391 already had to widen once). Not this ticket's to open.
- **Retiming or re-encoding on the helper side.** The helper drops; the
  transform cuts. Nothing is rewritten.

---

## Part A — the recording side

### Commands

`pause` and `resume`, on the existing fd3 reliable request/response channel,
answering exactly once like every other verb, and reporting the resulting
paused-ness in the reply.

**Idempotent.** `pause` while already paused succeeds and reports the current
state; it does not error. The pill can be double-clicked, and a refusal there is
noise rather than safety. Same for `resume` while running.

### No new state case — deliberately

`App.State` stays `idle | starting | recording | stopping`. A paused take is
still `.recording`.

Adding `.paused` would mean auditing every `state == .recording` site in the
helper, and this repo has already paid for exactly that mistake:
**STC-376** was `shutdown()`'s guard reading `.recording || .starting` and
falling through neither when the state had reached `.stopping` — which
reproduced live as a `display.mp4` with no `moov` atom and no sidecars at all.
A sixth state value is the same hazard with a different name.

Paused-ness rides as a separate `paused: Bool` on the heartbeat, and
`SupervisorState` gains a sibling boolean rather than a sixth member, for the
same reason one layer up (`main.ts`, `pill.ts`, `countdown-window.ts` and
`scope-indicator-window.ts` all branch on `"recording"`).

### Pause means nothing is written, anywhere

Four writers gate on one flag:

| writer | why it must stop |
|---|---|
| display frames (`Capture.swift`) | the point of the feature |
| camera frames (`CameraCapture.swift`) | otherwise the PiP carries the paused period into the cut |
| mic samples (`MicCapture.swift`) | **a pause that left `mic.m4a` recording captures audio the user believes is off.** This one is not symmetry, it is the privacy property. |
| the event tap (`Capture.swift`) | decision 2 |

The tap is **held, not torn down**. Re-creating a `CGEvent` tap means
re-entering the Input Monitoring path STC-315 mapped (and `tapCreate` fails
*synchronously*, which is why its creation already moved to `begin()`), and
nothing about a tap needs re-creating in order to stop delivering. Disabling and
re-enabling it also lands in `decideCursorEvent`'s `tapDisabledByUserInput`
branch — the same path the helper's own `stop()` already has to tell apart from
starvation — so pause must mark its own disables the way `stoppingBegan`
already does, or `stats().tapDisabled` starts counting our own pauses as
timeouts.

### Disk and the sidecar agree by construction

The interval is stamped from the helper's own clock at the moment the command is
processed, and **all four gates test one predicate**: *is this sample's
session-relative pts inside a recorded interval?* That is the identical
predicate the transform uses to cut.

So the invariant is checkable rather than hoped for:

> **No sample on disk may have a pts inside a pause interval.**

A drift between "what the helper dropped" and "what the sidecar says was
paused" would otherwise be invisible until an export was watched — the picture
would be right and one frame would be wrong, which is the class of fault this
repo keeps recording as *correctly-rendered wrong answers*.

### The synthetic re-anchor

On `resume`, one `{t, kind: "move", x, y}` at the resume instant carrying the
pointer's current position, from the same `NSEvent.mouseLocation` read
`Still.swift` already uses. This is the whole of decision 2's implementation.

It needs no `events` schema change: `move` is an events-1 kind and the
synthetic one is indistinguishable in shape from a real one. Deliberately so —
a `synthetic: true` field would be a fact about the helper, not about the take,
and nothing downstream would branch on it.

### Edge cases

- **Stop while paused** — the open interval closes at `stop.t`. The resulting
  trailing cut is empty and costs nothing.
- **Pause with zero frames inside it** — recorded normally; the cut removes zero
  output frames. Harmless, and *not* special-cased, since suppressing it would
  make the pill's timer disagree with the file.
- **A display reconfiguration or a window resize while paused** — ends the take
  exactly as today. Pause changes what is written, not what ends a take.
- **`quit` / stdin close while paused** — goes through `shutdown()`'s existing
  `idleWaiters` path (STC-376). Paused-ness must not be a reason to skip
  `writeSidecars()`.

### Testing

`PauseDecisions.swift`: interval accumulation, the gate predicate, and the
idempotence rules, as pure functions tested with no display — the pattern
`helper/test/still/` already uses. Plus a grant test for the real round trip
(`pause` → no frames appended → `resume` → frames resume), which needs a Mac.

---

## Part B — the schema

**`anchors-5`** adds one optional block:

```jsonc
"pauses": [ { "startNs": 12000000000, "endNs": 19500000000 } ]
```

Session-relative integer nanoseconds, `endNs > startNs`, disjoint and
ascending.

Emitted **only when non-empty**, per this repo's minimum-version rule — a take
that was never paused still writes `anchors-4`, so nothing about a normal take
changes and an older build can still read it. Same discipline `scope` used at
v3 and `mic` at v4.

`transform/src/session.ts`'s loader parses it with the refuse-rather-than-default
behaviour the other sidecars use: an out-of-order or overlapping array is a
load error, not something quietly sorted. A take whose pauses cannot be trusted
cannot be cut correctly, and cutting it wrongly produces a plausible file.

---

## Part C — the transform

### `transform/src/timeline.ts`

One module, built from `anchors.pauses`, owning both directions in nanoseconds:

```ts
createTimeline(rawDurationNs, pauses) -> {
  durationNs                 // pause-free
  sessionNsOf(outputNs)      // user axis -> file axis
  outputNsOf(sessionNs)      // file axis -> user axis
}
```

Frames stay derived from the existing grid: `exportFrameTimeNs(k)` gives an
output-axis ns, the timeline converts it, and **`render(project, session, tNs)`
receives session ns and does not change at all.** It stays pure in session time,
as do `cursor.ts`, `zoom.ts`, `zoom-change.ts`, `zoom-override.ts` and
`spaces.ts`.

Two properties make this safe rather than merely plausible:

1. **Within a segment the shift is constant**, so consecutive output frames land
   exactly 1/60 s apart in session time. Everything inside a segment behaves
   bit-for-bit as it does today; only the seams jump. This is what keeps
   `stateAt(n)`'s seek-equals-step guarantee meaningful — the cursor and zoom
   sims still step a uniform 120 Hz grid, and a seam is a seek, which they
   already support.
2. **With no pauses the two axes are identical.** Every project document already
   on disk is therefore already correct on the new axis; nothing migrates.

That identity is also the load-bearing **control** in the tests. A timeline that
ignored its intervals entirely would still pass a naive "pauses present →
duration got shorter" test if that test derived its expectation the same way the
code did. The tests must assert the no-pause case is an exact identity *and*
that a specific frame maps to a specific hand-computed session ns.

`outputNsOf` for a time **inside** a pause is defined as the cut point (the
segment boundary), not an error — the editor samples arbitrary times and needs a
total function.

### Consumers

#### `export.ts` carries two times per frame, and that is the crux

Today one value does two jobs. `tNs = exportFrameTimeNs(from + k)` is passed to
`render()` **and** is what stamps the encoder
(`new VideoFrame(..., { timestamp: (tNs - originNs) / 1000 })`, line 169). That
works only because the two axes currently coincide.

With a timeline they split, and each job takes the other axis:

```ts
const outNs     = exportFrameTimeNs(from + k);   // output axis: the ENCODER's
const sessionNs = timeline.sessionNsOf(outNs);   // file axis:   render()'s

render(project, session, sessionNs)
new VideoFrame(ctx.canvas, { timestamp: (outNs - originNs) / 1000 })
```

**The trap is swapping `tNs` to session time in one place and forgetting the
other.** Stamp the encoder with session time and the muxed file carries the
pauses back in its own timestamps — a video that renders the right pixels and
plays with the gaps still in it, which no pre-encode hash can catch, because the
gates compare pre-encode RGBA and never look at container timestamps. The same
split applies to audio: `sampleNs` is matched against the session axis to decide
*which* samples survive, and shifted onto the output axis to decide *when* they
play.

#### Consumers

| file | change |
|---|---|
| `export.ts` | the two-axis split above; audio clipping goes per-segment (below) |
| `preview.ts` | `durationNs` and the playhead become output-axis; convert before calling `render()` |
| `trim.ts` | `availableFrames` takes the pause-free duration; the rest is already frame-shaped |
| `editor.ts` | the Clip lane (`timeline-activity.ts` buckets `events.json` by session time) and the Zoom lane (samples `render()`'s own `zoom.amount`) convert when sampling |
| `session.ts` | parse and validate `pauses`; build the timeline |

Untouched: `render.ts`, `cursor.ts`, `zoom*.ts`, `spaces.ts`, `legibility.ts`,
`output-size.ts`, `change-track.ts`.

### Audio

`retimeAudioData` currently clips once to `[originNs, endNs)` and shifts to
clip-relative. It must clip **per surviving segment**, each shifted by that
segment's own cumulative offset, then concatenate.

This is the part most likely to be wrong, and it is worth saying why: the mic
path has now produced four separate defects in two days from *a video-side
guarantee copied onto the audio path without asking whether it still held*
(the `mediaTimeScale` crash, the integer-PTS assumption, the missing edit list,
the channel count). The video frame walk and the audio segment walk are the same
idea and **not** the same code, and a fifth instance would be one function
assuming the other's grid.

### `TRANSFORM_VERSION` → 8

No new tunable constant reaches the pixels, so `transformFingerprint` is
unchanged; the bump records that a sidecar can now cut time. Exactly the
reasoning STC-331 used for manual zoom windows.

### One accepted artifact, stated rather than fixed

Because the helper gates camera frames too, there are no camera frames inside a
pause — so at the first frame after a resume, `frameIndexAt(cameraFrames, t)`
holds the last **pre**-pause camera frame until the next one arrives, up to one
camera interval (~16–33 ms). Same hold rule the display uses, too brief to see,
and a special case here would be a second frame-selection rule.

---

## Part D — the UI

`#pill` becomes a `<div>` container holding two real buttons, `#pill-pause` and
`#pill-stop` (nested `<button>`s are invalid HTML, so the current
single-button pill cannot simply gain a child).

```
recording:   [ ●  00:42  ░░░  ⏸  ■ ]
paused:      [ ○  00:42  ░░░  ▶  ■ ]
```

- the dot stops pulsing and goes hollow
- the glyph swaps pause ↔ resume
- **the timer shows recorded elapsed, not wall clock.** With cut, those
  genuinely differ, and a timer counting paused seconds would disagree with the
  file it produces.

`pill.ts` takes the decisions (pure, no DOM); `pill-window.ts` keeps the window
mechanics. `pill-window.ts` measures `#pill`'s content width through a
`ResizeObserver` to size the collapsed window — that still works on a `div`, but
the width now changes when the glyph swaps, so the measurement must survive a
mid-recording resize rather than being taken once.

`body.pill-collapsed` currently hides everything but `#pill`; `#record` was kept
deliberately reachable because the pill *was* the stop button. With a dedicated
`#pill-stop` that reasoning is preserved, not weakened.

`_fake-helper.mjs` learns `pause`/`resume` and the `paused` heartbeat field so
the E2E can drive the real pill without a grant.

---

## Testing

| level | what |
|---|---|
| Swift, no grant | `PauseDecisions` — interval accumulation, the gate predicate, idempotence |
| Swift, grant | the real round trip: frames stop, frames resume, `anchors.pauses` matches, **no sample on disk inside an interval** |
| transform, pure | `timeline.test.ts` — both directions, round trip, hand-computed boundary values, **zero pauses is an exact identity**, a pause at t=0, a pause at the end, back-to-back pauses |
| transform, pure | seek-equals-step across a seam; export frame count equals pause-free duration; audio segment clipping |
| transform, muxed | **the exported file's own duration and sample table equal the pause-free duration.** The only check that can see a wrongly-stamped encoder timestamp — the gates hash pre-encode RGBA and never read the container, so the two-axis trap above has no existing net under it |
| E2E | pill pause/resume against the stand-in helper; the timer not advancing while paused |
| gate | a paused variant of the deterministic fixture, produced by extending `fixtures/gen-display.swift` rather than hand-editing a take — a hand-authored "paused" fixture over an mp4 that still has frames in the interval would violate the disk invariant and quietly test a state the helper cannot produce |

**Mutation checks**, because several assertions here are the kind that pass for
the wrong reason:

- a timeline that ignores its intervals must fail the hand-computed mapping test
- a gate predicate that is off by one interval end must fail the disk invariant
- removing the synthetic resume event must fail a cursor-position assertion at
  the first post-resume frame, and nothing else
- stamping the encoder with `sessionNs` instead of `outNs` must fail the muxed
  duration check, and must **not** fail any pre-encode hash — confirming both
  that the new check works and that the old ones genuinely could not see it

## Sequencing

Three PRs, each independently green, with the feature unreachable until the
last so master is never in a half-state:

| | scope | user-visible |
|---|---|---|
| **A** | helper commands, the four gates, `PauseDecisions`, `anchors-5`, grant test | **none** — nothing can trigger a pause |
| **B** | `timeline.ts`, export/preview/trim/editor wiring, audio segments, `TRANSFORM_VERSION` 8 | **none** — but a hand-authored paused take now exports cut |
| **C** | the pill split, the supervisor `paused` flag, `_fake-helper.mjs`, E2E | the feature turns on |

Ordering A→B→C rather than A→C→B is deliberate: A+C without B would ship a
pause button whose takes *freeze* on export, which is a visible wrong answer on
master for the length of a PR cycle.

## What only a Mac can settle

This session is unusually well placed: `swiftc` 6.4 is present on
`arm64-apple-macosx27`, so unlike most of this repo's history the helper can
actually be compiled and unit-tested here rather than first meeting a compiler
on CI. What still needs hardware and a human:

1. **That pausing really stops the stream** — `SCStream` keeps running and we
   drop its frames. Whether dropping is enough, or whether the stream should be
   stopped outright, is a power/thermal question no test answers. Dropping is
   chosen because stopping and restarting `SCStream` re-enters the start path
   that STC-306 and the `-3805` family live in, and a pause that could fail to
   resume is worse than one that costs some battery.
2. **The seam, watched.** The cursor landing without a glide, and the picture
   cutting without a visible hitch, can only be judged by eye — the same class
   of check the cursor and PiP each needed.
3. **Audio across a seam.** Whether a cut is audible as a click. Nothing here
   crossfades, and if it clicks, that is a follow-up rather than a fix inside
   this ticket.
4. **The pill at 26 px with two targets** — whether two buttons in a 26 px pill
   are individually hittable, which is the same question STC-342 had to ask of
   the selection overlay's handles.

## Open questions

- **Does a pause survive a crash?** STC-394 writes the movie in fragments so a
  killed take is recoverable. A take crashed *while paused* would recover with
  an unterminated final pause interval. Proposal: the recovery path closes it at
  the last written sample. Confirm during A.
- **Maximum pause length.** None proposed. A take paused for an hour is a
  legitimate use (a long interruption) and nothing degrades — the intervals
  array is tiny and the frames simply do not exist.
