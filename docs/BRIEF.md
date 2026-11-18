# STC Screen Recorder — brief and locked decisions

**Status: current as of 2026-11-18 (STC-662).** This is the project's conventions document:
`CLAUDE.md` is the handoff log and the trap index, `PHASE-*.md` are the phase plans, and this is
the thing they are all measured against. When a decision here changes, change the row in the same
PR. The 2026-11-13 review found this file nine rows behind the code, which is the cost of not doing
that.

Statuses used: **holds** (decided and the code does it), **deliberate drift** (the code differs
for a stated reason), **not built** (decided, no code).

## The product

A macOS screen recorder for a single person making a recording of their own screen, with their
camera in a corner and a cursor that is drawn, not captured. Recording is capture only; every
decision about how the take *looks* is an edit made afterwards, in a document, and rendered by one
pure function that preview and export both call. The recorder must never lose a take it has
started, and must never let a take that is missing something look like a take that is not.

## Locked decisions

### Determinism and the transform

| decision | status | evidence |
|---|---|---|
| `render(project, session, t) → FrameState` is a pure function: no wall clock, no decoder scheduling, no live helper stats, no current display state. Preview and export are two sinks that call it with different `t` sequences. One implementation; sinks may not fork it | **holds** | `transform/src/render.ts`; `preview.ts` and `export.ts` both call `render` + `composite`; `gate:identity` compares them shuffled vs ascending; `test:slow` compares the app's export against the CLI's |
| Fixed simulation step, 120 Hz. All times inside the transform are integer nanoseconds or integer ticks. 60 fps export samples every other tick | **holds** | `transform/src/time.ts`; `tickOf`/`tickTimeNs` are the only conversions |
| Cursor state is a function of tick `n`, never of render-call count. `stateAt(n)` is identical stepped or sought | **holds** | `transform/src/cursor.ts`: checkpoints *are* the stepped state, so a seek replays the exact float sequence |
| Frame selection at `t`: the source frame with the greatest PTS ≤ `t`; hold, never interpolate; per track | **holds** | `frameIndexAt`; camera track bounded by `anchors.camera.{firstFramePtsNs, lastFramePtsNs + frameIntervalNs}` so a dead camera does not freeze a face on screen |
| "Export ≠ preview" is the defining bug class. Pre-encode RGBA is what the gates hash; encoded bytes are never compared | **holds** | `scripts/gate*.mjs`; the hash is compared only within one browser and one raster backend (CI pins Chrome, STC-640) |
| Anything that changes rendered pixels lives in the project document or is a versioned constant. Easing constants are not per-take settings; they are stamped | **holds since STC-308** | `transform/src/transform-version.ts`: `TRANSFORM_VERSION` is stamped into `project.json` and every export manifest; a fingerprint test over every pixel-deciding constant fails until the version is bumped and `TRANSFORM_HISTORY` says what changed |

### Data model

| decision | status | evidence |
|---|---|---|
| `recording.json` is a **segments array** from day one; each segment's media is a **replaceable identity** (stable id, not path or index), so re-take can swap media, keep the edit, regenerate auto-zoom. It is a sibling to `anchors`/`events`/`project`, never folded into `project.json`, which stays the edit document only | **schema + loader done (STC-307); not wired into the app** | `schema/recording-1.schema.json`, `transform/src/recording.ts`. `synthesizeRecording` derives one from any `anchors.json` in memory. Nothing downstream (re-take) exists to consume it, so `loadSession`, `takes.ts` and the renderer do not read it |
| Sidecars are versioned; readers accept every version they have a schema for, **writers emit the MINIMUM version that can express the document**, so an untouched feature leaves a take at its older version and an older build can still open it | **holds** | `schema/` holds `anchors-1..16`, `events-1..3`, `project-1..22`, `shot-1..3`, `changes-1`, `recording-1`. `anchorsDocument`, `projectForWrite` and `shotForWrite` are the three writers; `loadSession`, `parseProject`, `parseShot` and `takes.ts` are the readers. `transform/src/project-version.ts` lists every project version this build reads |
| `project.json` is the edit document: output size, cursor style, PiP geometry and style, trim, zoom settings and overrides, framing and background, audio levels and mutes, narration cleanup, keycast. The take's own camera decides whether a PiP is on by default | **holds** | `transform/src/trim.ts` `parseProject` / `defaultProject`; there is exactly one parser and every caller goes through it |
| Times in sidecars are session-relative integer ns; `t0Ns` is a decimal string because boot-relative ns can exceed 2^53 | **holds** | `schema/anchors-2`; `AnchorsDoc.swift` |
| The camera block is **absent** when no camera was requested; `present:false` means requested and yielded nothing | **holds since STC-303** | `AnchorsDoc.swift` writes the block only when `requested` is true, so a display-only take is no longer labelled a camera failure in the library |

### Capture

| decision | status | evidence |
|---|---|---|
| All capture lives in the Swift helper — display, cursor events, camera, mic and system audio — so everything shares one mach-time clock family. No capture or timestamping on the Electron/JS side | **holds** | `helper/src/Capture.swift`, `CameraCapture.swift`, `MicCapture.swift`, `SystemAudioCapture.swift`; `getUserMedia` explicitly rejected. System audio is its own audio-only `SCStream` over the whole display, a second track never mixed at capture (STC-418) |
| Clock: `mach_timebase_info` at helper start, written to anchors. `displayTime` is mach ticks and is converted; `CGEvent.timestamp` and camera PTS are already ns and are **not** | **holds** | `CaptureDecisions.swift` `machToNs`; `CameraCapture.ptsNs` |
| ≤ 3840×2160, H.264, hardware encode only; VFR at capture, CFR at export | **holds** | `CaptureGeometry.swift`; writer settings; `export.ts` |
| The helper is a long-running child of Electron, so it inherits the app's TCC identity | **holds** | `app/src/main.ts`, `supervisor.ts` |
| Two IPC channels: fd3 reliable with sequence numbers; stdout lossy drop-oldest telemetry that can never back-pressure capture | **holds, measured** | `Protocol.swift`, `Ring.swift`; STC-249 |
| A display reconfiguration **refits the same stream** into the take's fixed capture size and the take continues. A lost display, or a region pushed out of bounds, still stops it | **holds since STC-235** | `AVAssetWriter` cannot change dimensions mid-file, so the file keeps its size and the picture is refitted into it; `DisplayChangeDecisions.swift`, `anchors-7`'s `geometry` timeline, `display-geometry.ts` |
| A take can be paused and resumed; paused time is not in the take | **holds** | `PauseDecisions.swift`, the helper's `pause`/`resume` commands, `PauseGate` for the side tracks |
| Camera: opt-in, default off, sticky; never held idle. Opened when the countdown starts so it is delivering when the screen is (`camera-warm`, STC-578), released at stop or if the take never starts; opened off the critical path | **holds** | `CameraWarm.swift`, `settings.ts`, `startCameraAsync` |
| Never take the default audio input blind: the mic request always names an exact device, and a Bluetooth mic is refused in favour of any wired/USB device | **holds** | STC-233; PHASE-0 §2a; `MicCapture.swift` pins the format and refuses mislabelled audio (STC-485) |
| Every request to the helper is answered exactly once, by whichever path gets there first, and every wait has a bound and a reason | **holds, one gap** | `finishStart`, `stop`'s `finishUp`, `withTimeout`; the gap is a `start` that completes after a `stop` (review P3) |
| A take the helper dies in, or that a full disk ends, is still a take: partial anchors are kept current and recovered, and the stop says why | **holds** | `PartialAnchors.swift`, `recover-take.ts`, `DiskDecisions.swift`, `stop-copy.ts` (STC-527, 530, 531) |

### Cursor

| decision | status | evidence |
|---|---|---|
| Rule 2: the cursor is **never only in the video**. Telemetry is always captured, with no toggle | **holds; a take without telemetry does not start** | no code path or setting disables the tap, and since STC-315 a missing Input Monitoring grant is an ERROR on `start` (`event-tap-unavailable`), not a warning over a video-only take; STC-480 also requires the grant to be readable, since a created tap is not proof it delivers. The refusal precedes `setupWriter()`, so no take directory is created. **Still open:** a tap DISABLED mid-take (`tapDisabledByTimeout`) is re-enabled and counted (`stats().tapDisabled`), so a starved run loop costs a gap in the track rather than the take. Nothing in the suite can starve a run loop on demand |
| Pixel exclusion (`showsCursor = false`) is the default | **holds** | `Capture.swift` |
| Baking in the system cursor is an opt-in that disables cursor styling for that take | **not built** | no setting, no field in `project`, no branch in the compositor |
| The cursor is drawn from events by the transform, from the macOS pointer set as vector paths, with the shape (arrow, I-beam, hand, …) recorded in `events-2` | **holds since STC-239 / STC-309** | `transform/src/cursor-art.ts`; `helper/src/CursorShape.swift`; the events-2 `shape` enum equals the art's list |

### Editing

| decision | status | evidence |
|---|---|---|
| Editing is non-destructive. Source media is never mutated | **holds** | trim is a `project.json` field; exports are written beside the take; delete goes to the Trash; `export:write` refuses the take's own filenames |
| Auto-zoom is two stages on two signals: **clicks decide when** (`zoom.ts`, STC-325) and **change decides where** (`zoom-change.ts`, STC-326): the region that changed near the event is the primary signal, and greedy dead-zone clustering of cursor movement is the fallback when the change track is missing, which is true of every take today because nothing writes `changes.json` yet. They are not entangled in one pass. A manual override (STC-330) wins over both, a manual window (STC-331) needs no derived one, and a block can follow the cursor (STC-617) | **built** | `transform/src/zoom.ts`, `zoom-change.ts`, `zoom-override.ts`, `zoom-follow.ts`; `render.ts` blends the result exactly as an override's target is blended. `docs/STC-326-RUNBOOK.md`: the classifier's thresholds are reasoned from the ticket's stated outcomes, not from a rules list |
| Trim is in/out points in session ns, clamped to the 60 fps grid | **holds** | `trim.ts` |

### Platform and rendering

| decision | status | evidence |
|---|---|---|
| macOS 26 floor; no compatibility scaffolding for older targets | **holds** | Xcode is not required: `helper/build.sh` builds with the Command Line Tools' `swiftc` against the macOS 26 target (STC-317). `Still.swift`'s `setIfSupported` (a generalized KVC helper) is the one scaffold of that species left, deliberately |
| Compositing in WebGPU/WGSL; no GLSL fallback | **not built, no phase** | Canvas 2D (`compositor.ts`). The one GPU path is WebGL2 for a still's gradient-mesh background (`still-mesh.ts`, STC-622). The WGSL frame-difference kernel is a spike in `patcartelli/studio-cartelli` that has never run on a GPU (`docs/STC-320-WGSL-PORT.md`). The pre-encode hash will change if a GPU compositor lands; survivable because the gates compare within one backend |
| Electron shell; renderer is sandboxed and never sees a path or node | **holds** | the preload scripts enumerate every channel; `tsconfig.browser.json` makes `process` a type error in the renderer |
| Signing: a stable identity (self-signed dev cert, Developer ID for releases) because ad-hoc revokes TCC on every rebuild | **holds** | PHASE-1 → Signing |

### UI

| decision | status | evidence |
|---|---|---|
| No UI framework. Windows are vanilla DOM over pure decision modules (`selection.ts`, `scrubber.ts`, `pill.ts`, `library-items.ts`, …) that take data and return data, and are tested without a DOM. SolidJS (signals, not effects-as-glue) was decided and never built | **deliberate drift; SolidJS not built, no phase** | `app/src/*.ts` and the `app/renderer/` pages. The pure/sink split is what the framework was going to buy |
| Every failure the helper reports reaches the user; a warning on the reliable channel is never dropped by the UI. A stop the helper decides on is said by the panel, not a toast | **holds** | `stop-copy.ts` is the one stop-to-words mapping; a test fails on a stop reason with no row |
| Takes are listed even when broken, with the reason; a corrupt sidecar costs the label, never the recording | **holds** | `takes.ts`, `library.ts` |

## Design rules

The rules as they stand on 2026-11-18. The single source for the values is
`app/renderer/tokens.css`; this section is the reasoning and the exceptions. Each rule was a
decision, and the ticket is named so the next change can read why.

**Type (STC-583).** Geist carries language. JetBrains Mono, "the readout face", carries every
value that changes (timers, sizes, lengths, key chords, the countdown) and literal text such as
file paths. Silkscreen is retired; Departure Mono was tried and not adopted. The sans ramp is
20 / 15 / 13 / 12 / 11 / 10, and 10 is the floor. Readout sizes are 34 (countdown), 24 (record
bar), 16 (pill), 12 and 11 (Library meta, keys). Menu rows are device names, not values, so they
stay Geist. No view sets a font size inline; it takes a `--type-*` token.

**Theme (STC-504).** There is no in-app theme switch and no appearance setting. A surface's theme
follows what it sits on. Seven of the ten pages are dark always, by `<html data-surface="dark">`:
the Library (`index.html`), Settings, the video editor, the pill, the countdown, the selection
overlay and the floating panel (`thumbnail.html`). Two follow the OS appearance: the still editor
and the toast. The tenth, `copy-render.html`, is a hidden render window with no UI. The dark values
exist twice in `tokens.css` (the media query and the `data-surface` block), because CSS cannot share
one declaration list between them; `tokens-parity.test.ts` holds the two equal.

**Accent and colour roles.** `--accent` is the app's blue (`#3b6fe0` light, `#7aa2ff` dark). It
marks selection and primary action. `--rec` is recording and nothing else, `--warn` is a warning,
`--focus` is the focus ring. **The video editor is the one window that redefines `--accent`**, to
its teal (`--clip`), on `:root[data-surface="dark"]` in `editor.html` (STC-601), so the played bar,
focus and pressed states follow the editor's primary. Inside the editor, `--section-accent` is the
accent a toggle, slider or focus state takes within one section: teal in Audio, brass in Zoom
(STC-609). Red in the waveform (`--wave-clip`) means audio peaks only, and carries a hatched
non-colour cue. No other window redefines `--accent`.

**Raw colour.** `tokens.css` owns the shared set: a window may extend it with tokens of its own but
may not redefine a shared one, except the editor's accent above. Three windows also carry a local
dark palette in raw values, each built to the Capture SK 016 frames and each a decision, not drift:
the Library (`index.html`, STC-584), Settings (`settings.html`, STC-581) and the editor's lane
colours (`editor.html`, STC-601). The pill carries its own raw colours too. The rule is therefore
not "no raw hex" but: **a colour used in two windows belongs in `tokens.css`; a colour used in one
may be local, with a comment saying why.**

**Spacing and radius.** `--space-1..6` is 4 / 6 / 8 / 10 / 12 / 16 px, only the steps these
surfaces repeat. An off-scale one-off (a 5 px button pad) is left as written rather than snapped.
Radii are named by use: `--radius-xs` 2, `-sm` 6, `-md` 8, `-card` 16 (countdown, panel, record
bar), `-pill` 999.

**Motion.** Three durations: `--dur-quick` 120 ms (hover fades, the countdown sweep), `--dur-base`
160 ms (panel enter, swipe release), `--dur-move` 180 ms (a marquee glide). Every window that
animates honours `prefers-reduced-motion` by removing the movement and keeping the information: the
countdown still counts, a switch crossfades instead of sliding, a held trim bracket crossfades
instead of scaling (STC-391, STC-587, STC-607). Glass title bars (Library, Settings) are CSS
`backdrop-filter` and go opaque under `prefersReducedTransparency` (STC-586).

**Focus.** One ring for every control a Tab reaches: `2px solid var(--focus)`, offset 1 px, at zero
specificity so a surface's own `:focus-visible` still wins (STC-506, STC-587). A control that hides
at rest (the editor's trim brackets in Export) must show itself and sit above whatever draws over
it when it holds focus.

## Settled by measurement — do not relitigate

The numbers behind the rows above, each measured on real hardware. Full detail in
`docs/PHASE-0-FINDINGS.md` and `PHASE-1.md` → "Settled by phase 0".

- Above 4K, hardware H.264 encode drops from 0.81 to 0.25 Gpx/s (software fallback); Chrome's decoder shares the ceiling.
- CFR-by-repeat at capture spent 82% of a loaded encoder on duplicates and dropped 60% of real frames.
- `prefer-software` encode truncated at 19% of frames at 4K60; it is not a fallback.
- mach ticks are 41.667 ns on Apple Silicon and 1 ns on Intel; `CGEvent.timestamp` offset to the display clock is 0 ms, drift 0.0000 ms.
- Camera lags the display by 65 ms (±33, the camera's own frame interval); camera-to-mic +1.8 ms median.
- A cold USB camera can take 2.2 s to open, which is why it opens off the start path, and why it is warmed at the countdown (STC-578).
- Export runs at 1.52× realtime at 4K on GPU raster; the editor reads video by range rather than holding the file in memory (STC-236, `docs/STC-236-RUNBOOK.md`).
- A `VideoDecoder` must be driven with one in-flight request, frames closed in the output callback, and never reset on an empty output queue.

## Conventions the code follows

Stated as rules. The intent is what the review found the code already doing.

1. **Boundary.** The helper owns every device and every timestamp; main owns every path, every preference and the helper process; the renderer owns pixels and never sees a path, a file or node. Helper↔main is JSON lines (fd3 reliable with `seq`, stdout lossy); main↔renderer is bytes on channels enumerated once in the preload scripts.
2. **Pure core vs. sink.** If it can be written as a function of data already read, it goes in `transform/src/` (or the Swift equivalents: `CaptureDecisions`, `CaptureGeometry`, `AnchorsDoc`, `Ring`, `WriterGate`, and the other `*Decisions.swift` files) and is tested with fixtures. Only reading, writing, scheduling and waiting stay in the sink or the callback.
3. **Naming.** `<module>.ts` in `src/`, `<module>.test.ts` in the sibling `test/`. The suffix states the runtime requirement: `.test.ts` runs anywhere; `.e2e.test.ts` needs Electron and runs serialised; `.slow.test.ts` needs minutes; `.grant.test.ts` needs a TCC grant and is a separate file, never a skip; `.soak.test.ts` is the fault soak. `_`-prefixed files are test support. Fixtures are directories named for what they exercise.
4. **Every wait has a bound and a reason** (`withTimeout(p, ms, what)`). Every bound has a fault injector and a test that watched it fire. A bound that fires says whether the machine or the code was at fault.
5. **One value, one place.** Where two languages force a copy, a test pins the copies together.
6. **Reported, never silently skipped.** Invalid takes are listed with a reason; dropped stats are counted; a skipped gate prints an annotation; a request is answered exactly once.
7. **A test seam must be a world the fake can be true in.** The stand-in helper speaks the control plane and can actually be recording; it never claims anything about capture.
8. **A new test is watched failing before it is believed.** Mutation-check the guard, not just the happy path.
9. **The comment states the failure the code prevents**, with date and ticket. `CLAUDE.md` is the index of those traps.

## Non-goals and deferrals

Multiple cameras, camera-only recording, HDR, anything cross-platform, N-minute segmentation
(STC-236 redirected it to reading video by range). Each of these was deferred explicitly in a phase
plan; none is a decision against, only a decision about order. Shipped since this list was first
written, and so no longer on it: system audio (STC-418), pause, display hot-swap (STC-235), device
loss and crash recovery (STC-237, 530), and the fault soak (STC-238).

## Open decisions

The questions this file used to carry are answered: the macOS 26 floor is a requirement (STC-317),
a take without cursor telemetry is refused (STC-315), `recording.json` is a sibling file (STC-307),
and easing constants are stamped by `TRANSFORM_VERSION`, not held per take (STC-308). What is open:

1. **A tap that dies mid-take.** Re-enabled and counted today; see the Cursor row.
2. **A GPU compositor and a UI framework.** Both were decided and neither has a phase. Say so when
   one is scheduled; until then the rows above are the truth.

## Where to read next

- `CLAUDE.md` — handoff log, current status table, and every trap found so far. `AGENTS.md` points here.
- `PHASE-1.md`, `PHASE-2.md`, `docs/superpowers/specs/2026-08-26-camera-pip-design.md` — the phase plans as shipped.
- `docs/review-2026-09-02.md`, `docs/review-2026-11-13.md` — the reviews this file was drafted and then corrected from.
