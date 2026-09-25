# stc-screen-recorder — Claude Code handoff

macOS screen recorder. Electron UI + Swift helper. Captures display + cursor
events → deterministic transform → CFR MP4 with cursor overlay.

## Where things are

| path | what |
|---|---|
| `PHASE-1.md` | current phase plan — read this first |
| `docs/PHASE-0-FINDINGS.md` | spike results; all settled decisions sourced here |
| `docs/HANDOFF-2026-08-31.md` | what moved on 2026-08-31, what was got wrong, and the one open question |
| `docs/PRE-DEMO-CHECKLIST.md` | STC-406 — the standing pre-demo procedure: freeze Electron/deps for the week before, then confirm Screen Recording + Input Monitoring (not Accessibility) and run one real take, before anyone is watching |
| `helper/src/` | Swift helper (increment 1, in progress) |
| `helper/src/Protocol.swift` | JSON-line IPC + Clock |
| `helper/src/Watchers.swift` | display/device watchers |
| `helper/src/main.swift` | App lifecycle, command dispatch |
| `helper/build.sh` | builds and signs; `SIGN_ID="..." ./build.sh` to override |
| `helper/test/stop-bounds.test.ts` | the stop chain: camera backstop < display backstop < the client's request timeout |
| `helper/test/ipc.test.ts` | black-box IPC tests — spawn the binary, drive stdin, assert on fd3/stdout |
| `app/src/helper-client.ts` | promise-based client for the two-channel protocol (fd3 + lossy stdout) |
| `app/src/supervisor.ts` | keeps the helper alive; makes crashes and lost recordings legible |
| `app/src/main.ts` | Electron main — owns the supervisor, spawns the helper as its child |
| `app/build.mjs` | esbuild bundle -> `app/dist/`; `npm run app:start` builds and launches |
| `transform/src/` | the pure transform + shared sink modules (TS; render, time, cursor, demux, decode, compositor) |
| `transform/src/spaces.ts` | **every coordinate space, and who owns each conversion (STC-314)**. The vocabulary doc is its header — read it BEFORE writing a conversion anywhere, in either language. Time stays in `time.ts` and is named here; the four Swift conversions are named here and point back |
| `transform/src/zoom.ts` | auto-zoom stage 1 (STC-325) — `events → windows` and the easing spring. WHEN only; STC-326 decides where. Clicks and drags trigger; a plain move does not, and that one rule is the whole feature. Its header records the ONE open decision (a long drag: one window or two) and why no test here can settle it. The user's settings live on the document — `trim.ts`'s `DEFAULT_ZOOM` and `project-4` |
| `docs/STC-320-WGSL-PORT.md` | the WGSL port of the frame-difference kernel (STC-320), and **the finding that changes what auto-zoom stage 2 can be built on**: study one's per-frame number was a POINT SAMPLE of a 64x36 lattice, not a total, so it reads 1 pixel in 100 and registers a 2px blinking caret in **2 of 10 positions** — the caret being STC-319's own example of the change that matters most. The compute reduction counts the same 32 px wherever it sits. Also the first entry in this repo's WGSL vocabulary (compute-vs-fragment, `textureLoad` over `textureSample`, async device acquisition, `popErrorScope`), and why the shared rule had to round to **float32**: an f64 oracle disagreed with both shaders over arithmetic rather than over the rule. The code is in `patcartelli/studio-cartelli` (PR #524); **the WGSL leg has never run on a GPU** and the doc says exactly what a Mac must do |
| `transform/src/frame-diff-rule.ts` | the change-detection kernel (STC-322), vendored verbatim from `patcartelli/studio-cartelli`'s `src/lib/frame-diff-rule.ts` (STC-320) — the reverse direction of that repo's own vendoring of `session.ts`/`decode.ts` et al. `schema/changes-1.schema.json` + `transform/src/changes.ts` is the `changes.json` sidecar and its loader; `computeChangeDocument` (in `changes.ts`) is the post-recording pass's PURE half (`Frame[]` in, a `Changes` document out — no canvas, no WebCodecs) and the one part unit-testable here; `transform/src/change-track.ts`'s `computeChangesForVideo` is the browser half (decode + canvas readback). `harness/change-track.html`/`.ts` + `scripts/change-track-one.mjs` are the runnable page and driver for a machine with real Chrome. `docs/STC-322-change-track-spike.md` is the finding |
| `transform/src/legibility.ts` | will the viewer be able to read it (STC-318) — `textPt * embedWidth / display.pointWidth`, the 9 px threshold, and the sentence the UI shows. **The output width CANCELS**: exporting smaller does not make text bigger, and the ticket's own formula was wrong on any retina display |
| `transform/src/project-version.ts` | every project version this build can read, in ONE place, importable from the Electron main process. Four lines in a file of its own because `trim.ts` reaches DOM-typed code and `tsconfig.node.json` correctly refuses it |
| `transform/src/output-size.ts` | what size a take EXPORTS at (STC-335) — the aspect rule, the even-dimensions rule H.264 needs, and the embed presets derived from the site's own container width. The one place those three are enforced; a caller computing `width / aspect` gets an odd height about half the time |
| `schema/project-5.schema.json` | project-4 plus `textPt` — the recorded app's base text size in POINTS, the one legibility input that cannot be derived from the recording (STC-318) |
| `schema/project-4.schema.json` | project-3 plus `zoom` — auto-zoom's user SETTINGS (on/off, intensity, preset) and nothing derived. `projectForWrite` emits the MINIMUM version that can express the document, so an untouched zoom stays v3 |
| `transform/test/spaces-seam.test.ts` | the ticket's "one place to get it", as a grep over `transform/src/`, with controls proving the patterns fire on real pre-STC-314 code |
| `schema/` | versioned session schemas (anchors-1/2, events-1/2, project-1/2) |
| `transform/src/cursor-art.ts` | the macOS pointer set as vector paths (STC-239); the events-2 `shape` enum must equal its list |
| `helper/src/CursorShape.swift` | the AppKit side of STC-309: pointer → `CursorSignature`, the 30 Hz `CursorSampler`, and the `cursor-probe` spike. Decisions are in `CaptureDecisions.swift` |
| `docs/STC-309-RUNBOOK.md` | what to run on the Mac for STC-309, in order, and what each run must show |
| `docs/STC-315-RUNBOOK.md` | what to run on the Mac now that a take with no cursor telemetry is REFUSED. **§0 first: every capture test needs Input Monitoring now, not just the cursor ones.** §3 is the only thing the fault injector cannot replace, and it answers the one open question — whether macOS prompts on the first `tapCreate` |
| `helper/test/event-tap-required.grant.test.ts` | STC-315's refusal, driven by `STC_CAPTURE_FAULT=no-event-tap`, plus the CONTROL that says the fault is what made the difference |
| `docs/HANDOFF-2026-09-04-STC-309.md` | STC-309 closed: what moved, what was got wrong, and what is left (events-3 shapes) |
| `docs/STC-247-RUNBOOK.md` | what to run with a second display for STC-247, and what each result must show |
| `helper/test/multi-display.grant.test.ts` | records a NON-main display by id and pins its anchors; refuses (not skips) on a one-display machine |
| `helper/src/Still.swift` | `capture-still` and `windows` (STC-289): one frame through `SCScreenshotManager`, reached via the ObjC runtime because the 13.3 SDK has no header for it; display filter for regions, window filter for windows |
| `helper/src/StillDecisions.swift` | the still path's pure decisions — request parsing, crop, cursor localisation, `shotDocument` — tested without a display by `helper/test/still/` |
| `schema/shot-1.schema.json`, `transform/src/shot.ts` | the still document and its loader (`parseShot` refuses rather than defaults); `fixtures/shot/` |
| `docs/STC-289-RUNBOOK.md` | what to run on the Mac for the still path, and what each result means |
| `app/src/selection.ts` | the selection overlay's pure decisions (STC-290) — drag, resize, nudge, mode toggle, which display a region belongs to; no DOM, no Electron |
| `app/src/overlay-session.ts` | the overlay's windows: one per display, transparent, screen-saver level. The state machine lives HERE, not in the windows |
| `app/src/overlay.ts`, `app/renderer/overlay.html` | the overlay's view. Draws state, reports input, decides nothing |
| `docs/STC-290-RUNBOOK.md` | what to look at on the Mac for the overlay, and the one thing (Electron's display id) no test can settle |
| `transform/src/still-decorate.ts` | the decorated still's pure layout (STC-291) — canvas size, where the capture sits, shadow reach, the five presets. No canvas, no DOM |
| `transform/src/still-render.ts` | the drawing pass for a decorated still. Draws the layout and decides nothing |
| `scripts/still-gate.mjs`, `harness/still.ts` | the still gate: renders in a real browser and asserts PROPERTIES of the pixels (alpha outside the shape, no dark fringe, a shadow that reaches zero). No golden images — see the trap |
| `scripts/decorate-one.mjs` | renders one real shot in every mode, to files a person can look at. The presets can only be judged by looking |
| `transform/src/still-export.ts` | every decision a still makes on its way OUT (STC-293) — format, the JPEG flatten fork, the 1x scale factor, the filename template. Node-free; the ONE place any of it is decided |
| `helper/src/StillEncode.swift` | `export-still`: ImageIO to PNG/HEIC/JPEG and NSPasteboard. Decides nothing — `StillEncodeDecisions.swift` is the pure half, tested by `helper/test/still-encode/` |
| `app/src/still-io.ts` | the single funnel every still takes out of the app. Electron-free; the only thing in main that writes an image or touches the pasteboard |
| `helper/test/still-encode.test.ts` | the encoder for real, on CI — encoding needs no grant, so PNG colour type, the P3 `iCCP` chunk and the HEIC brand are checked on every push |
| `docs/STC-293-RUNBOOK.md` | what to run on the Mac for the export path: the pasteboard, the paste targets, and the P3 round trip an eye has to judge |
| `docs/STC-291-RUNBOOK.md` | what to look at on the Mac for the decorated still, and which dial to turn when a preset is wrong |
| `app/src/scrubber.ts` | the scrubber's decisions (STC-338) — **the interaction study's deliverable is its HEADER**: rules 1-10, which every later timeline control inherits. Position is a FRAME not a time; the grid is `time.ts`'s and this module does not own it; a drag is direct and a release only settles; the playhead is free and the trim is drawn rather than fenced; a clamp is felt as a rubber band; the minimum trim is TWO frames (arithmetic, not taste); one signed shuttle ladder; a bare letter belongs to the timeline only when nothing is being typed; a tick is drawn only when it can be seen; the readout is frame-accurate or decorative. No DOM, no Electron — and it may NOT import `trim.ts` (that chains to `cursor-art.ts` and fails the no-DOM pass), so `frameCount` is derived from `exportFrameOf` with a test holding the two together |
| `app/test/scrubber.e2e.test.ts` | the scrubber WIRED — the pure tests prove `decideKey` decides, which is a different claim from the app doing what it decided. Found both of this ticket's real bugs |
| `docs/STC-338-RUNBOOK.md` | what only a Mac can settle for the scrubber: whether the drag feels direct or dead, whether 24 px of rubber band reads as resistance or as breakage, whether ticks at 6 px are a scale or noise, and reverse shuttle on a 4K take |
| `app/renderer/editor.html`, `app/src/editor.ts` | the editor — a second window (STC-373), first of the three-surface split. Preview/trim/export/legibility/share moved out of the main window's in-page player; `editor.ts` inherits `scrubber.ts`'s ten rules VERBATIM rather than re-deriving them, and the frame<->px math needs no span-aware rewrite because the timeline's ruler and two lanes (Clip: pointer activity, weighted for clicks/drags, not frame difference — STC-319 needs a Mac and fixtures that don't exist yet; Zoom: the auto-zoom automation curve, read-only, sampled straight from `render()`'s own `zoom.amount`) are a CSS transform over the FULL-DURATION track, and `getBoundingClientRect()` already reports the post-transform box. Legibility and the viewer's eye share one `<dialog>` with export size and the export button itself — warns below 9pt, never blocks. Geist + Geist Mono land here (`font-src 'self'`); Silkscreen does not move. Window title and `<title>` are `PRODUCT_NAME` ("Capture") now, not the literal "stc editor" this shipped with (STC-443); tokens moved to the shared `app/renderer/tokens.css`, this window keeps only its own `--clip`/`--zoom` |
| `app/src/timeline-activity.ts` | the Clip and Zoom lanes' own pure signal (STC-373) — `clipActivity` buckets `events.json` by weight (clicks >> moves), `zoomCurve` samples a `(tNs) => amount` function so the editor reads `render()`'s answer rather than a second `zoomWindows`/`createZoomSim` call. No DOM |
| `transform/src/zoom-override.ts` | manual zoom override, phase 1 (STC-330) — resolving what a DERIVED window (zoom.ts's WHEN) actually looks like once `project.overrides` has had its say: `overrideFor`/`resolvedCrop`/`resolvedEasingName`, `groupByEasing` (windows sharing a resolved easing get ONE independent spring each, composed by max — the merge gap comfortably exceeds any preset's settling time, so this is exactly equivalent to one spring when nothing is overridden), `nearestWindow` (which window's crop governs a tick, including the post-`endNs` relaxation tail `inWindow` alone cannot see), and `rectFromGesture` (click → a default-sized rect, drag → the normalised drag rect, mirroring `still-redact.ts`'s `normaliseRegion` with the one deliberate difference: a bare click here still produces a rect). `schema/project-6.schema.json` adds `overrides`, a discriminated union with one `geometry` variant so far. `render.ts` now blends `zoom.crop` from `FULL_FRAME_UV` toward an override's target as `amount` eases (`spaces.ts`'s new `lerpRect`) — the FIRST version (`TRANSFORM_VERSION` 4) where the picture actually moves for a real take. `app/src/editor.ts`'s Zoom lane is a FILLED area now (one trapezoid per window) with `#override-blocks` laying click targets over it; selecting a block seeks to its midpoint and shows the picture unzoomed (this window's own override is stripped from the LIVE project the player reads, restored on commit) so a drag on `#rectoverlay` maps 1:1 to capture UV. `docs/STC-330-RUNBOOK.md`. Phase 2 (STC-331) adds a second union variant, `kind: "manual"` — a window with NO derived counterpart, carrying its own `startNs`/`endNs` and a REQUIRED `easing`; `manualWindows()` reshapes it into the same `ZoomWindow` shape the derived ones have (`CombinedZoomWindow`) so `render.ts` feeds ONE combined list to `groupByEasing`/`nearestWindow`/`createZoomSim`, and `resolvedCrop`/`resolvedEasingName` check `.manual` first rather than looking it up in the overrides table. `inWindow` (zoom.ts) and `nearestWindow` moved from a sorted-bisect to a plain scan for this — a manual window carries no promise of staying disjoint from anything else. `docs/STC-331-RUNBOOK.md` |
| `transform/src/zoom-change.ts` | auto-zoom stage 2 (STC-326) — `deriveZoomCrop(window, changes, display)`, the WHERE signal `render.ts` falls back to when a window has no MANUAL override. Change track first (`session.changes`, STC-322's sidecar — absent on every take today): per-cell burst-vs-ambient classification reasoned from this ticket's own four stated outcomes, since STC-319's actual rules list still does not exist. Greedy dead-zone cursor clustering second, when the change track is missing or uninformative — the fallback every real take hits today. Both signals share one floor/pad/clamp (`finishCrop`): a union whose tight axis already covers `MIN_ZOOM_DELTA_FRACTION` of the frame is "don't zoom" (null, a TRUSTED answer render.ts must not fall through past); otherwise padded and clamped into `[VIEWPORT_MIN_FRACTION, VIEWPORT_MAX_FRACTION]` = [0.5, 0.7] per axis, BRIEF.md's original bound. `docs/STC-326-RUNBOOK.md` |
| `app/src/editor-window.ts`, `app/src/editor-preload.ts` | the editor's `BrowserWindow` and its bridge, on `thumbnail-window.ts`'s precedent — one instance, re-navigated rather than duplicated when a different take is opened; the bridge exposes only the preview/trim/export/frame-grab/share channels, reusing `main.ts`'s existing handlers rather than a second implementation |
| `docs/STC-373-RUNBOOK.md` | what only a Mac can settle for the editor: how the window actually looks, whether the ruler's pan/zoom feels right, whether Geist/Geist Mono actually load, and the export dialog's layout at a real window size |
| `app/src/selection.ts` | the selection overlay's decisions (STC-290), header rewritten as a 14-rule manifesto for the series' second study (STC-342) — rule 4 is the one that CHANGED: `resizeRect` floors a resize at `MIN_SELECTION_POINTS` live, not just on release, so shrinking an existing marquee too far holds it at the floor instead of discarding the whole selection. Everything else documents decisions STC-290 already made |
| `app/src/overlay-hittest.ts` | the overlay's handle geometry (`handlePoint`/`handleAt`), split out of `overlay.ts` (STC-342) so it can be unit tested without a DOM — the module it used to live in runs `document.*` at import time and was never importable outside a browser |
| `docs/STC-342-RUNBOOK.md` | what only a Mac can settle for the second study: whether the resize floor (rule 4) reads as a floor or as a stuck handle, and whether a floored selection's handles are still individually grabbable once they are closer together than `HANDLE_GRAB_PADDING` |
| `app/src/hotkeys.ts` | the global shortcuts' pure decisions (STC-292) — the accelerator grammar, the reserved list, duplicates, keystroke recording, and every sentence the user is shown. No Electron, no DOM |
| `app/src/tray-menu.ts` | the menu-bar item's pure half — the template and the icon's pixels. Nothing in Electron can read a `Tray` back, so everything checkable is checked before it gets there |
| `app/src/tray.ts`, `app/src/shutter.ts` | the Electron `Tray`; the system camera-shutter sound, honouring `com.apple.sound.uiaudio.enabled` and the alert volume |
| `docs/STC-292-RUNBOOK.md` | what to press on the Mac for the hotkeys and the menu bar, and the permission round trip no test can do |
| `app/src/thumbnail.ts` | the post-capture floating thumbnail's pure decisions (STC-296), header rewritten as a 10-rule manifesto for the series' third study (STC-343) — rule 6 is the one that CHANGED: a discard now tells `thumbnail-window.ts` to stop the panel's own timer BEFORE the async delete, closing a race where a coincidental timeout could hide the window and strand a failed delete's recovery inside it. Showing/expanded state, the timeout floor, corner positioning, the swipe/drag-out gesture split, the stack's offsets, and `SETTLE_READY_MS`. No Electron, no DOM |
| `app/src/thumbnail-window.ts` | the panels' real `BrowserWindow`s and their real timers — captures STACK here, newest at the corner, and each keeps its OWN timer, which is what makes "drains oldest-first" true with no queue. Sizing, corner placement, hide-and-reshow for a capture, settle-then-destroy. Handles the `discarding` event (STC-343) that clears a panel's timer the instant its own discard commits |
| `app/renderer/thumbnail.html`, `app/src/thumbnail-preload.ts`, `app/src/thumbnail-renderer.ts` | the panel's view: collapsed thumbnail, expanded mode picker, redact, copy/save, the swipe and the drag-out. Reaches `still:export`/`still:frame` through its own, narrower bridge — the same main-process handlers every other exit uses. `thumbnail-preload.ts`'s `event` payload is `unknown` now (STC-343) — its own restated copy of the event union had already silently drifted from the real one (missing `"redact"`), the same "one value, two copies" defect this file keeps finding, fixed the way `overlay-preload.ts`'s `send` already was |
| `app/test/_windows.ts` | counting windows from the MAIN process (STC-416) — `windowCount`/`windowUrls`/`hasWindow`, the ONE owner of `BrowserWindow.getAllWindows()` in the e2e suite. Its header is the measured table: `app.windows()` NEVER lists a `BrowserWindow` that loads no url, lists a loaded one 78-147 ms after creation, and keeps a destroyed one ~25 ms; a count SCOPED BY URL sees a fresh window only at navigation commit (~78-110 ms) from EITHER process. `app.windows()` stays for what it is for — getting a `Page` to click on; every count, presence and absence read goes through here. `windows-fixture.e2e.test.ts` pins the two deterministic discriminators and fails if the helper is switched back |
| `app/test/thumbnail-discard-race.test.ts` | the discard/timeout race (STC-343), pinned at the SOURCE rather than reproduced live — the race needs a real window, a real timer and an injected delete failure to align at once, which is exactly the multi-way timing coincidence this repo has already paid for chasing as a live test |
| `app/src/thumbnail-menu.ts` | the right-click menu's template — pure, because nothing in Electron reads a `Menu` back once it is popped up, the same position `tray-menu.ts` is in |
| `docs/STC-296-RUNBOOK.md` | what to look at on the Mac for the panel: the corner, the animation, whether it really excludes itself from a capture. Predates drag-out, the right-click menu, swipe and stacking — its "What is deliberately not here" section is stale; see STC-343's own runbook for what those need |
| `docs/STC-343-RUNBOOK.md` | what only a Mac can settle for the third study: whether the discard/timeout fix changed anything visible (it should not), whether a panel sitting untouched after a successful drag-out reads as correct or as a bug, and whether the 26 px stack step and 90 px swipe threshold feel right |
| `transform/src/still-redact.ts` | redaction's decisions (STC-297) — the light/dark fill rule and its threshold, a drag to a normalised region, undo. No canvas, no pointer |
| `docs/STC-297-RUNBOOK.md` | what only an eye can settle for redaction: whether a fill reads as deliberate, whether the drag is precise enough, and the pasteboard |
| `app/src/library-items.ts` | the library's item contract and its presentation (STC-294), header rewritten as a 10-rule manifesto for the series' fourth and last study (STC-345). Badge, summary, action list, thumbnail source, the kind filter. Pure and node-free, because the renderer needs these types and the browser typecheck pass follows a type-only import |
| `app/src/library.ts` | the one scan over the storage root: anchors.json -> recording, shot.json -> still, neither -> invalid. `listTakes` is a FILTER over it, never a second scanner |
| `app/src/library-view.ts` | the library grid. Its own module so `library-seam.test.ts` can grep it for `kind` and mean it — `renderer.ts` has an unrelated one |
| `app/src/takes.ts` | `duplicateTake` (STC-345) — the race-safe half of the library's Duplicate action: a destination is claimed in-process before anything async, closing a race where two duplicates could compute the same name and interleave two unrelated shots' files into one directory. `still:duplicate` in `main.ts` is now only validation and the IPC boundary |
| `app/test/library-seam.test.ts` | the ticket's "no view branches on kind" criterion, as a grep, with controls proving the patterns can fire. Also pins STC-345's layering fix: `cameraSummary` (a raw-`anchors.json` reader) lives in `library.ts` only — a byte-for-byte dead copy in `library-items.ts` was found and deleted |
| `docs/STC-345-RUNBOOK.md` | what only a Mac can settle for the fourth study: whether double-clicking Duplicate (or duplicating two tiles inside the same second) now produces two clean tiles rather than a race — everything else about the library is unchanged and STC-294's own runbook still applies |
| `transform/src/still-annotate.ts` | annotation's decisions (STC-295) — arrow/box/text as data, the one accent colour, weights and text sizes in POINTS, the font in exactly one place, and the arrow-head geometry. No canvas, no DOM |
| `schema/shot-2.schema.json` | shot-1 plus `decoration.annotations`. `shotForWrite` emits the MINIMUM version that can express a document, so an un-annotated still stays v1 and the helper needs no change |
| `docs/STC-301-GATES.md` | which of the screenshot slice's six gates run in CI, which need a Mac and WHY, and the two places the ticket's stated method conflicts with a settled decision. Read before "fixing" a gate here |
| `app/test/nothing-lost.e2e.test.ts` | gate 4: N captures in a burst, every panel ignored, N recoverable shots AND N exports. Found two real bugs on its first run |
| `transform/test/shot-v1-frozen.test.ts`, `fixtures/shot-v1/` | gate 5: a FROZEN shot-1 document plus its committed layout. Never edit the fixture to make a test pass |
| `helper/test/still-gates.grant.test.ts` | gates 3 and 6 — capture latency and a still taken mid-recording. Need a grant, so `npm run test:capture`, never CI. Gate 3 carries TWO budgets since STC-383, because one assertion was covering two quantities: `STILL_BUDGET_MS` (200, STC-289's own, now against `captureMs` — verb to BUFFER, which is what STC-289 actually wrote) and `STILL_END_TO_END_MS` (400, new, against the wall — what the user waits, PNG encode included). Each constant documents its own derivation and, for the second, what it deliberately does NOT catch. Both are applied to `steadyMedian` — the median of the settled half of `GATE_3_SAMPLES` (10) — which is STC-341's half of the same fix: the old `max(slice(1))` assumed exactly ONE warming call and then judged the run on the least settled sample after it |
| `docs/STC-383-RUNBOOK.md` | what only a Mac can settle for gate 3's budgets: that it passes at all (it never has), what `frame encoded:` reports for your display, and whether the PNG encode really is the largest phase on hardware other than the one 20.4 MP display this was diagnosed on |
| `app/src/share.ts` | share's pure decisions (STC-242) — the STABLE published name from a slug, `planPublish`'s refusals, the embed template, and the ONE definition of the export filenames `renderer.ts` used to build inline. No node, no DOM |
| `docs/STC-242-RUNBOOK.md` | what to check on the Mac for share: the native picker, whether `showItemInFolder` really selects the file, and whether the `/lab/<slug>/` assumption matches the real site |
| `docs/STC-313-RUNBOOK.md` | the demo recording session, in order: the beats (Patrick's v3, reproduced), the pre-flight, the export-size hand edit the app cannot do, publishing, and the README GIF. **Read it before recording** — half of it is things that ruin a take rather than things you fix afterwards |
| `docs/STC-295-RUNBOOK.md` | annotation has NO UI yet — how to author one by hand, and the judgement calls (the accent colour, the head size, whether 3.5 pt is a marker or a hairline at 4K) |
| `docs/STC-294-RUNBOOK.md` | what only a Mac can settle for the library: how the grid LOOKS, the 500-take scroll, re-open and duplicate by hand |
| `docs/STC-300-FORMAT-AUDIT.md` | whether `shot.json` already holds every parameter a still editor would expose. Read it BEFORE adding a field to `shot-1` — it says which of STC-300's inspector items are already there, which one is the ticket's mistake rather than the format's, and what a re-crop actually needs |
| `fixtures/` | hand-authored 5 s fixture session + deterministic display.mp4 generator |
| `harness/` | vite-served browser harness hosting both sinks |
| `scripts/gate.mjs` | increment-0 determinism gate (Playwright + real Chrome) |
| `scripts/ticket-check.mjs` | `npm run ticket -- STC-NNN` — open PRs, merged commits and branches naming a ticket. Run it BEFORE starting one; two agents built STC-325 in parallel because nobody did |
| `transform/test/ticket-check.test.ts` | drives that script with a stub `gh` on PATH, the way `merge-when-green.test.ts` does. Every test is a way the check could answer "nothing found" while something was there — CI has no `gh`, so without the stub the whole `gh` branch is ungated |
| `scripts/gate-skip-rate.mjs` | how often each gate actually RAN on CI — run it before trusting a green tick |
| `docs/STC-259-GATE-SKIP-RATE.md` | the 100%-skip finding, its evidence, and what to do |
| `tools/test-host/` | signed bundle that spawns the helper for capture tests; `--probe` reports TCC state. **CFBundleIdentifier is load-bearing** — the grant is keyed to it |
| `fixtures/real-session/` | sidecars from a real recording (mp4 omitted, 9.4 MB) pinning click/drag semantics |
| `*.grant.test.ts` | needs a Screen Recording grant — excluded from `npm test`, run via `npm run test:capture`. A separate file, not a skip: skips read as covered and rot |
| `scratch/` | phase-0 spike code and outputs (mp4box.js, harness, sample session dirs) |
| `council/` | cross-AI reviews of the phase-1 plan |
| `schema/anchors-6.schema.json`, `schema/project-9.schema.json` | system audio, STC-418. PR 1 of 4, schemas and loader only. anchors-6 adds a `system` block (mic's present/requested split, no `device`) and `files.system` for `system.m4a`, a SECOND audio track and never mixed at capture. project-9 adds `systemAudioLevel`, linear 0..1, attenuate only, applied after the take by export's weighted sum with the mic (PR 3), never baked in at capture. The decisions are Patrick's (2026-09-24) and are on the Linear ticket and in `docs/TICKET-LOG.md`'s STC-418 row |
| `helper/src/SystemAudioCapture.swift`, `docs/STC-418-RUNBOOK.md` | system audio's capture (STC-418 PR 2): its OWN audio-only `SCStream` with a whole-display filter, because ScreenCaptureKit filters audio by app and a window take's filter would carry only its owner's. That was Patrick's call: the whole machine for every scope. Follows `MicCapture`'s rules (pause gate, retiming, bounded stop). No no-samples watchdog, on purpose. The runbook lists what only a Mac can settle: the PTS clock, window scope, and silence arriving as buffers vs nothing |
| `transform/src/audio-mix.ts` | the export's audio mix (STC-418 PR 3): `mic + system × level`, hard-limited, one stereo 48 kHz track. Pure TypeScript, so it's Node-tested sample by sample. Exact passthrough at 48 kHz; linear resampling only for a 44.1 kHz mic. `export.ts` uses it ONLY when the take has `system.m4a`; mic-only exports are untouched. The level is a compact slider in the editor's timecode row, not a lane. The preview still plays no audio |
| `transform/src/narration-clean.ts`, `scripts/clean-narration-one.mjs` | clean narration (STC-455). One strength (0..1, 0 = exact identity) drives an 80 Hz high-pass and one shared STFT carrying a decision-directed Wiener noise gain (profile learned from the take's own pauses — power subtraction was tried first and "bubbled") and a de-esser. No echo stage: tried twice, never audible, split out as STC-458. Pure TypeScript, whole mic track in and out, run BEFORE the mix. Wired in: project-10 `narrationCleanup: { enabled, strength }` (off at 0.5 by default), `audio-mix.ts`'s `exportAudioPlan` routes a cleaned mic through the mixer (mic-only takes included; off keeps the old path byte for byte), and the editor's "Clean up voice" switch + strength in the timecode row. The script writes `original.wav` + `clean-<pct>.wav` from a real `mic.m4a` (via `afconvert`) for A/B by ear. `docs/STC-455-RUNBOOK.md` |
| `schema/anchors-3.schema.json` | anchors-2 plus an optional `scope` block (STC-370) — a region or window recording's `kind`/`region`/`window`, mirroring shot-1's own kind/crop/window shapes. A whole-display take stays v2 with no `scope` at all; `helper/test/stop-reasons.test.ts` validates against this (superset) schema now, not anchors-2, since `window-resized`/`window-closed` are reachable only at v3 |
| `docs/STC-370-RUNBOOK.md` | what to run on the Mac for region/window recording scope: capturing each by hand, a REAL window resize/close mid-take, and the one design assumption (a plain move is safe) nothing here can verify |
| `helper/test/region-window-scope.grant.test.ts` | region/window scope on the real binary — a smaller capture, the right `anchors.json` scope block, a refused unknown `windowId`, and `STC_CAPTURE_FAULT=window-resized`/`=window-closed` proving the watcher's stop/sidecar path without scripting a real resize |
| `app/renderer/index.html`, `app/src/renderer.ts` | the main window (STC-374) — stripped to scope/source/camera/Record/Profile/grid at rest; still-capture prefs and the shortcuts editor moved behind the profile sheet, a slide-over panel (`#profilesheet`) rather than a fourth window. The Scope picker (Screen/Window/Area) and its "source" control are wired to STC-370's `region`/`windowId` — picking a window or an area opens the same overlay `capturestill` uses (`main.ts`'s new `pickCaptureTarget`), and the pick is a sticky preference (`settings.ts`'s new `scope` block) the same way a chosen display already was |
| `app/test/scope-picker.e2e.test.ts` | the scope picker and source control, end to end — scope switching, picking a window/area through the real (synthetic-input) overlay, persistence across a restart, and that `recorder:start` actually sends `windowId`/`region` rather than `displayId` |
| `docs/STC-374-RUNBOOK.md` | what only a Mac can settle for the profile sheet and the wired-up scope picker: whether the slide-over reads as a panel or a modal, whether picking a window or an area feels like the same gesture still capture already has, and a REAL window resize/move while it is the recording's own scope (STC-370's runbook covers a resize mid-take; this is about picking one in the first place) |
| `docs/STC-382-WORKFLOW-STUDY.md` | the recording-vs-still workflow (STC-382), as a POINT OF VIEW rather than a build — the ticket holds a design question with no acceptance criteria and this is the writeup it asked for. **The model is PATRICK's, stated 2026-09-15, and its decisions are recorded as settled rather than as options**: two capture types (still = "show something", video = "demonstrate something") x **how many SUBJECTS** — not "how focused", which was the first draft's reading and is wrong in a way that matters, since full-screen video's purpose is a workflow SPANNING apps (multi-subject), not an unfocused one. Three tensions the draft raised are CLOSED by him: area video is real but narrow (a disposable clip to a developer showing what's broken, as small as a dropdown); a window resize ending the take is FINE and must not be "fixed" or warned about; area scope and auto-zoom don't collide because you wouldn't zoom a crop — two regimes, not two owners. Where the code departs from the model: two scope VOCABULARIES (a sticky noun picker for recordings, three hotkey VERBS for stills), **"Screen" resolving to two different displays** (`settings.displayId` vs the display under the POINTER — coincides on a one-display Mac, NOBODY HAS RUN IT on two), opposite completion models (a still settles itself; a take waits in the library), and three doors to a still against one to a recording. Recommends ONE scope vocabulary across both types, then differentiating the two buttons' weight — and turns on one distinction: a shared VOCABULARY is right, a shared sticky VALUE is not (the still keeps asking). Decoration for video and whether a disposable bug-report clip wants a still's completion model are flagged OPEN and unscoped |
| `app/src/pill.ts` | the pill's pure decisions (STC-375) — no DOM, no Electron. Sizing clamp, the collapse/restore transition (driven by `HelperSupervisor`'s confirmed state, never a click — traps 1 and 3), the `mm:ss`/`h:mm:ss` timer format, and two types that structurally forbid scope creep: the level meter can only be `"hatched"` (no audio capture exists anywhere in the helper) and the resize style can only be `"snap"` (animate is the ticket's own open question, deliberately unbuilt) |
| `app/src/pill-window.ts` | the pill's real `BrowserWindow` mechanics — `collapsePill`/`restorePill` operate on whatever window they're handed (currently `main.ts`'s real main window, `titleBarStyle: "hidden"`). `restorePill` returns to the window's OWN remembered pre-collapse bounds, not the ticket's fixed `360 x instrumentHeight` pseudocode — the real window is resizable and user-positioned. `attachPillToSupervisor` is the wiring: reconciles only off the supervisor's heartbeat/`recording-ended`/`recording-lost`, sends `pill:state` so the renderer can hide everything but `#pill` |
| `app/src/supervisor-state.ts` | `SupervisorState` alone, split out of `supervisor.ts` (STC-375) — `pill.ts` needs the type and is imported by `renderer.ts`, which `tsconfig.browser.json` typechecks; that pass follows even a type-only import into the file that declares it, and `supervisor.ts` itself imports real node code (`helper-client.ts`). Same reason `library-items.ts` split from `library.ts` |
| `docs/STC-375-RUNBOOK.md` | what only a Mac can settle for the pill: dot-pulse legibility, whether the hatched meter reads as "not live" or as broken, Space-switch survival, no `-3805` across repeated Records, and the pill never outliving a take the helper stopped on its own. Pill shape, restore geometry, click-to-stop and the stop icon are already CONFIRMED on hardware (2026-09-14) |
| `docs/STC-380-RUNBOOK.md` | what only a Mac can settle for the window picker's `fullyVisible` flag (STC-380): the off-display and occlusion checks against a REAL `SCShareableContent` window list, and whether `VISIBILITY_EPSILON` is tuned right |
| `app/test/pill.e2e.test.ts` | the pill, wired, through the real app — and **this sandbox's Xvfb has NO window manager**, measured directly (a bare `win.setSize()` on a fresh window, no pill code involved, leaves `getBounds()` unchanged here, while `setResizable`/`setAlwaysOnTop` toggle correctly — Electron-internal booleans, no WM round-trip needed). Same class of finding as `app.dock.hide()` on CI. So this file checks the mechanism (heartbeat-driven, not click-driven) and the pill's real DOM content, never pixel geometry — that needs a Mac |
| `app/src/scope-indicator.ts` | the scope indicator's one pure decision (STC-381) — `resolveIndicatorTarget(scope, displays, liveWindow)`, no Electron and no window. Region scope converts its display-local rect to global points; window scope takes the window's live bounds (handed in by the caller — see `scope-indicator-window.ts`) and refuses to draw if none were given — a closed window is "don't draw," never a stale rect. Screen scope always answers null: nothing to confirm |
| `app/src/scope-indicator-window.ts` | the indicator's real `BrowserWindow` mechanics, same split `pill.ts`/`pill-window.ts` uses. ONE window, not one per display (unlike `overlay-session.ts`) — there is no drag to cross a bezel, so the window itself IS the target rect. **Redesigned FOUR times the same day from real-hardware feedback**: the ticket's original "shown on every main-window focus" read as naggy; a flash held 2000ms still read as lingering; a shortened 450ms flash with a hard cut at the end read as BUGGY (an outline gone between one frame and the next looking like a glitch rather than a choice); a fade fixed the cut but at a 200ms hold read as a misclick rather than a deliberate confirmation. `flashScopeIndicator` is the only way this is ever shown now: called once, from `pickCaptureTarget`, right after a fresh pick resolves, HOLDS at full opacity for `FLASH_HOLD_MS` (450), then FADES to 0 over `FLASH_FADE_MS` (350) via `BrowserWindow.setOpacity()` stepped ~60fps from the main process — no renderer script, `scope-indicator.html` stays static — then destroys the window. No focus/blur wiring to the main window at all. `hideScopeIndicator` cancels an in-progress hold OR fade immediately, from `recorder:setSettings` on any scope-affecting write (a kind change, a Clear) and as the first line inside `recorder:start`, before the helper is ever touched. Needs no `sup`/`BrowserWindow` reference of its own: `pickCaptureTarget` already refuses to run mid-recording, so nothing here can fire during a take by construction |
| `app/renderer/scope-indicator.html` | the outline's whole view — no script, no preload, no IPC, even with the fade (that is driven entirely by the main process stepping the WINDOW's opacity, not the page's). Main sets the window's bounds directly to the target rect; the page's only job is a `border` at its own edge, coloured to match the app's existing `--accent` token (`#3b6fe0` light / `#7aa2ff` dark) rather than inventing a second accent |
| `app/test/scope-indicator.test.ts` | `resolveIndicatorTarget` exercised with no window: region-to-global conversion, refusing a display that no longer exists, refusing an unpicked target, refusing a window with no live bounds given (or the WRONG window's bounds), and picking the display a straddling window's CENTRE falls on rather than its top-left corner |
| `app/test/scope-indicator.e2e.test.ts` | the flash wired through the real app, against `_fake-helper.mjs`'s Finder stand-in (STC-381) — appears the instant a window or area is picked (never for Screen scope, which has no pick flow), exists no longer than `FLASH_HOLD_MS + FLASH_FADE_MS` with no further input, and is cancelled EARLY by a scope change, a Clear, or Record, each asserted well inside that natural lifetime (`NATURAL_LIFETIME_MS - 150`) so a test passing by outliving its own timer isn't mistaken for the cancel actually firing. Never the indicator's on-screen geometry or whether the fade itself looks smooth, which need a Mac |
| `docs/STC-381-RUNBOOK.md` | what only a Mac can settle for the confirmation flash, now on its FOURTH design (persistent → 2000ms flash → 450ms hard-cut flash → 200ms-hold fade → 450ms-hold fade): whether `FLASH_HOLD_MS`/`FLASH_FADE_MS` (450/350) read right, whether the fade itself looks smooth or stutters, whether the accent-blue border is visible against a busy desktop, and that a freshly-picked window's real bounds are what actually gets outlined |
| `app/src/countdown.ts` | the countdown's pure decisions (STC-391) — ONE surface, two ways in: Record always counts down, a still capture only when it was started with the self-timer. Seven numbered rules in the header; the ones that bite are 2 (the number is `ceil(remaining/1000)` and is NEVER 0 — the frame that would show 0 is the frame the capture fires on), 4 (`skipped` and `elapsed` are separate outcomes that both proceed, and `countdownFired` is the ONE place that maps an outcome onto "so does it happen"), 5 (reduced motion removes the ANIMATION, not the count — a countdown that stopped counting would honour the preference by deleting the feature) and 6 (a duration of 0 is "off", which is exactly what Capture already did, so the off case needs no second code path). The duration is a real preference (`settings.ts`'s `countdownMs`, default 3000) with deliberately NO control — the ticket's own Open item, answered with Patrick before any code was written. No DOM, no Electron, no clock |
| `app/src/countdown-window.ts` | the countdown's real panel and its real clock. **A PANEL, not a full-screen scrim, and that is load-bearing**: the self-timer exists to let someone hold a hover state or an open dropdown WHILE it runs, and a full-display window either swallows those clicks or has to be click-through, at which point Skip and Cancel are unclickable. So it is small, at the bottom centre of the target display's WORK area (clearing the Dock), leaving every other pixel live. It takes focus, which is what makes Return/Escape work **without registering either globally** — a bare Return grabbed machine-wide for three seconds would be eaten from the very dropdown being photographed; the cost, stated rather than hidden, is that clicking into another app takes the keyboard with it (`docs/STC-391-RUNBOOK.md` §0/§3 is where that gets judged). Never in the frame, belt and braces exactly as `overlay-session.ts` does it: hide, `HIDE_SETTLE_MS`, DESTROY, and hand the CGWindowID back for a still's `excludeWindowIds` — a recording gets the first three and needs no fourth, since the countdown is over before `start` is called at all. **CENTRED as of the first hardware pass (2026-09-16)** — it shipped bottom-centre on the reasoning that a countdown should keep out of the way, and watched on real hardware the centre is what reads as a countdown rather than as a notification. **`finish()`'s teardown is in a `try/finally`, and that is the fix for a reported wedge rather than tidiness**: it used to run bare, so a throw there (a window destroyed in the gap after the `isDestroyed()` read) rejected a `void this.finish(...)` call, `settle` was never reached, the caller's promise never resolved, and `captureStill` waited on it forever with `capturing` true and `active` set — every later capture AND Record refused for a capture that had already ended. `runCountdown` also publishes the session to `active` BEFORE starting it and clears it by IDENTITY, closing the same wedge from the other end (a session settling inside its own construction ran `active = undefined` before the assignment completed, then the assignment put the dead session back). `STC_COUNTDOWN_FAULT=teardown-throws` is what makes that path reachable, because its natural trigger is a timing coincidence no test can schedule |
| `app/src/panel-focus.ts` | taking the keyboard for an overlay panel WITHOUT activating the app (STC-391 follow-up, 2026-09-16). `PANEL_WINDOW_TYPE` (`type: "panel"`, an NSPanel — macOS will let one become key without making its application active) in ONE place so `overlay-session.ts` and `countdown-window.ts` cannot drift, plus `focusPanel`, which asks for focus, WAITS a window-server round trip, CHECKS whether it arrived, and escalates to the old `app.focus({ steal: true })` only if it did not — panel key semantics belong to the OS and this was written on Linux, where the failure mode of getting them wrong is a dead Escape on an overlay covering the whole screen. The escalation logs which path it took, because "the library still comes forward" and "the panel never got focus" are different faults with one symptom |
| `docs/STC-391-RUNBOOK.md` | what only a Mac can settle for the countdown: whether 3 s is right (§1), whether the panel is really absent from a take's first frames and from a self-timed `frame.png` (§2), and **§0/§3, the item most likely to send this back** — whether losing the keyboard to the app you clicked into during a self-timer reads as acceptable or as broken |
| `app/renderer/tokens.css` | the one shared stylesheet (STC-443) every renderer window `<link>`s — fonts, the type ramp, and the light/dark color tokens, lifted verbatim from `index.html`'s own STC-372 `:root` block. Main, the video editor and the still editor all load it now instead of each keeping (and silently drifting from) their own copy; a window's own `<style>` may EXTEND it with a semantic token this file has no opinion on (editor.html's `--clip`/`--zoom`) but must not redefine one it already declares. Each window's CSP needed `style-src 'self'` added for the `<link>` to load at all — `'unsafe-inline'` alone only covers the inline `<style>` tag that's still there beside it |
| `app/renderer/still-editor.html`, `app/src/still-editor-renderer.ts`, `app/src/still-editor-window.ts` | the still editor ("Redact", STC-300) — the ONLY door to a still already in the library (`main.ts`'s `still:reopen`; the library tile itself offers no export). v1's whole job is redaction: drag a box, normalise it, persist on every change rather than on a way out. Used to force `color-scheme: dark` unconditionally and hardcode every color; now loads `tokens.css` and follows the OS preference like the other two windows (STC-443, confirmed with the requester before changing it — the ticket's own prose only asked for the accent token). `#undo`/`#save`/`#done` are hairline icon buttons (STC-443) — aria-label, a tooltip naming the shortcut, hover/focus-visible/active/disabled states, Undo disabled with no boxes, new ⌘Z/⌘S bindings alongside the pre-existing Esc-closes |
| `docs/STC-443-RUNBOOK.md` | what only a Mac can settle for the token-set unification: light/dark in all three windows (the still editor's is a genuinely new combination — it never had a light appearance before), the video editor's now-shared `--warn`, the still editor's icon toolbar (glyph legibility, all three states, the new shortcuts actually firing), and whether two windows both titled "Capture" read as confusing in Cmd-`~`/the Window menu. Written with no Xcode/swiftc at all in this session's environment, so NONE of it has been run, only typechecked |
| `docs/STC-444-RUNBOOK.md` | the editor's header row (STC-444 slice 1 of 4, a rough-in): timecode / icon transport / output on one `minmax(0,1fr) auto minmax(0,1fr)` row, Home/End now reaching the trim's in/out, the frame-grab icon (click copy, ⌥-click save, right-click menu). What only a Mac can judge: centring under resize, glyph legibility, Space after clicking a focused icon |
| `docs/HANDOFF-2026-09-24-STC-444.md` | STC-444 mid-flight: slice 1 approved on hardware, slices 2–3 to build, bookmarks deferred. The next pass matches Patrick's FIGMA (connector needed); lists which decisions are settled, the Linux-sandbox test traps, and the element IDs the e2e suite depends on |
| `docs/TICKET-LOG.md` | full ticket-by-ticket build history — what shipped, what was learned, what's still open per ticket. Read it for "why is this built this way" archaeology; not loaded automatically into every session |
| `docs/CORRECTNESS-TRAPS.md` | specific mistakes this repo already made once — gate flakiness, TCC/signing quirks, capture threading hazards, CI timeout traps. Read before touching gates, capture/helper internals, signing, or CI |
| `app/src/device-picker.ts` | the mic and camera device popovers' pure decisions (STC-414) — no DOM. `deviceRows` builds one shared row list (off / automatic / a named device / a stale "(not connected)" entry) for both pickers; `autoLabel` present or absent is the type-level fork between them, since the mic has no safe automatic choice (STC-233) and the camera does (`pickCamera`'s existing ranking, STC-286). `decidePopoverToggle` is the one real decision in the open/close mechanics — closing on a selection, Escape, or an outside click is unconditional and needs no function. Wired into `renderer.ts`, replacing the camera checkbox and mic `<select>` that used to live in the profile sheet: both pickers now live on the always-visible `#devicestate` row (`#camera-state`/`#mic-state`, unchanged ids), since that is the control that "already shows its feedback" before a take even starts — the pill's own meter/preview, which the ticket names literally, only ever renders while `SupervisorState === "recording"`, the one state this ticket wants read-only |
| `docs/STC-414-RUNBOOK.md` | what only a Mac can settle for the device pickers: whether `cameraDeviceUid` actually selects the named camera in `CameraCapture.swift` (unverified — no swiftc in this session's environment), the popover's visuals in light and dark, and whether it can clip past the window's edge with several devices connected |

## Where things stand (2026-08-26)

**Phases 0, 1 and 2 are complete.** The app records, previews and exports, verified on real
hardware and confirmed by eye on the composited cursor. 137 tests, four gates.

CI on `master` went red on 2026-08-25 (the `#6` and `#7` merges) with the STC-254 crash —
intermittent, so PR runs passed while the push runs failed. Root-caused and fixed on 2026-08-26;
master is green again. See the append/teardown trap below. **Do not read a green PR run as proof
for an intermittent fault** — the regression test is the evidence, the green tick is corroboration.

Repo: https://github.com/patcartelli/stc-screen-recorder — **public** (unlimited Actions minutes;
macOS bills 10x on private repos and burned ~42% of a monthly allowance in one day).
Licensed **PolyForm Noncommercial 1.0.0** (`LICENSE.md`, STC-302) — read, fork and build on it for
any noncommercial purpose; commercial use is not granted. GitHub's licence detector does not know
PolyForm, so the repo sidebar shows no licence; that is expected, not a missing file.

**STC-302's pre-public checklist, run 2026-09-08 (Linux):** gitleaks 8.28.0 over all 50 commits on
every branch — no leaks; the same history grepped for AWS/GitHub/OpenAI/Slack/Google key shapes,
private-key blocks, JWTs and `secret|token|password = "…"` assignments — no hits; no file ever
committed under a `.p12/.pem/.key/.mobileprovision/.env` name; no email address anywhere in the
tree; the only signing material is `SIGN_ID` as a shell variable and a truncated public cert
fingerprint in prose. `fixtures/shot-window/frame.png` was LOOKED AT and is a synthetic mock, not a
real window. Two items are open and neither is a secret: `fixtures/pip/camera.mp4` is a real camera
track of a real person (112 KB — a synthetic one needs macOS, ffmpeg and a matching
`camera-frames.json` PTS table), and the README's demo slot still needs the phase-3 recording.

### Claim a ticket before you write any of it

**Two agents built STC-325 in parallel on 2026-09-09 and a whole session's work
was thrown away.** #108 merged at 14:49:58 UTC; the other agent's first commit
was at 14:42:48 — so when the second started, #108 was an OPEN PR in plain
sight, and nobody looked. The better implementation won by luck rather than by
anyone comparing them.

```
npm run ticket -- STC-325     # BEFORE writing anything. Exits 1 if work exists.
```

Then **claim it in Linear**: set the status to In Progress and comment with the
branch you will use. That is the courtesy half.

**The check is the load-bearing half, and the reason is worth keeping.** Linear
would not have caught this one: the ticket read `Backlog`, `startedAt: null` —
the FIRST agent had not claimed it either. A claim convention only works once
everybody follows it, so it cannot be the thing you rely on; the check protects
you unilaterally, and it is the step that was actually missing. It belongs in
the RECOMMENDATION too, not only at implementation time — the collision here
began with a ticket being proposed as "the logical next one" without anybody
looking at the open PRs.

`scripts/ticket-check.mjs` reports open PRs, merged commits and remote branches
naming the ticket, and deliberately does not decide whether they collide:
"#108 is stage 1 and mine is stage 2" is a judgement, and a script that guessed
would be ignored the first time it guessed wrong. Its exit codes are **0**
nothing found, **1** something found, **3 the check could not run** — three and
not one, because an exception falling through Node's default exit is the same
code as a real finding, and a broken check that reads as a finding is the same
family as a pass that means nothing.

**Every failure mode lands on 3, and truncation is one of them.** The listings
are paged and the walk THROWS when it hits its ceiling rather than returning
what it has: a prefix is indistinguishable from a clean answer, and the entries
that truncate first are the alphabetically-last `claude/*` session branches —
exactly the parallel work being looked for. Same reason `gh` is tested with
`auth status` and not `--version`: an installed but logged-out `gh` used to
send every query down a path that throws, so the REST fallback in the same file
was never tried and the check was permanently 3 on a machine it works fine on.

### Hand off a runbook WITH its branch

**Every time you point Patrick at a runbook, name the branch to run it from**, together with the fetch/checkout commands. A runbook written for unmerged work lives only on that PR's branch, next to the code it tests. Run from `master`, it either isn't there or quietly tests the OLD build. If the work is unmerged, say so in the hand-off ("not on `master` yet, run it from `<branch>`"). Once it merges, say `master`.

### Concurrent sessions — isolate with a worktree

**Multiple Claude Code sessions on this repo share the SAME working directory unless told otherwise, and that is not hypothetical.** On 2026-09-21, working STC-417, `git status`/`git branch --show-current` changed between consecutive commands with no checkout of that session's own — `git reflog` showed branch checkouts and commits from two OTHER live sessions (STC-416, STC-403, STC-421) interleaving in real time, and `ListAgents` confirmed three peer sessions active in this project at once. The same afternoon, STC-417 and STC-403 (a differently-numbered ticket, filed separately) independently root-caused and fixed the IDENTICAL bug — `npm run ticket -- STC-NNN` only greps for one ticket's own key, so it caught neither side of that collision (see the STC-403 row below). Worse: mid-session the shared directory was found mid-`git merge` (dozens of files staged) from a different peer session — touching anything there would have corrupted someone else's in-flight work.

**Every session doing non-trivial work in this repo (more than reading/searching) should call `EnterWorktree` near the start**, before creating a branch or writing any file — this is exactly the condition `EnterWorktree`'s own instructions ask for ("CLAUDE.md or memory instructions direct you to work in a worktree"). It costs one tool call, creates an isolated checkout under `.claude/worktrees/`, and removes both hazards above: no branch gets switched out from under you, and no half-finished operation in the shared tree is at risk from your commands. Exit with `ExitWorktree` when done (`"keep"` if the branch should survive for a PR someone else picks up, `"remove"` for a clean finish). Skip it only for read-only exploration that never edits or runs `git checkout`/`git commit`.

### Workflow — master is protected

`master` requires the `test` check and enforces it on admins, so **direct pushes are blocked**.
Everything goes through a PR:

```
git checkout -b accounts/stc-NNN-slug
# work, commit
git push -u origin HEAD
gh pr create --base master
npm run merge -- <pr>      # merges ONLY if that PR's CI is green
```

Use `npm run merge`, not `gh pr merge --auto` — see the trap below about why `--auto` was useless
here (it is now backed by a required check, but the script also refuses to read a green result
belonging to a different commit).

### Next up

Full ticket-by-ticket history lives in `docs/TICKET-LOG.md` — what shipped,
what was learned, and what's still open per ticket. Not loaded
automatically; read it when you need to know why something is built the
way it is, or to check whether a specific ticket's open items are still
open. **When you finish a ticket, append your own row to its table** —
that file is where the convention every row before it followed still
lives; don't start a second table back here.

## Build & smoke

```
helper/build.sh                                    # -> helper/build/stc-helper (see Signing)
echo '{"cmd":"status"}' | helper/build/stc-helper  # expect ready -> status -> bye JSON lines
npm run typecheck                                  # ALL THREE tsc passes — bare `tsc` runs one
npm test                                           # everything that runs anywhere (must be green)
npm run test:capture                               # the one test needing a Screen Recording grant
npm run test:slow                                  # cross-implementation export identity (minutes)
npm run gate / gate:export / gate:seek / gate:identity
npm run gate                                       # increment-0 sink-identity gate (needs Chrome)
npm run app:start                                  # build + launch the Electron shell
npm run merge -- <pr>                              # merge a PR, but ONLY if its CI is green
```

## Current status

- **Increment 0 (transform contract):** DONE — schemas, fixture session (incl. generated
  display.mp4 with exact-ns sample table), pure `render()`, both sinks, and the gate all pass:
  200 sampled t byte-identical between sinks, two independent exports identical, encode works
- **Increment 1 (helper control plane):** DONE — lifecycle, watchers, command set, and the
  two-channel IPC (fd3 reliable + seq echo; stdout lossy drop-oldest ring on a dedicated writer
  thread) all built and tested black-box against the real binary. No capture yet.
- **Increment 2 (capture ported in):** DONE and verified on real hardware. An 8 s recording
  produced 458 frames / 865 events / 0 dropped, both sidecars schema-valid, clicks and drags
  correct, and events sharing one time origin with the frame grid. Verified through
  `tools/test-host` (a signed bundle that spawns the helper, so the helper inherits its TCC
  identity — the same arrangement Electron will use, now known to work).
- **Increment 3 (Electron shell):** DONE — `app/src/{helper-client,supervisor,main,preload,renderer}.ts`.
  Client and supervisor are Electron-free and tested against the real helper binary; the shell is
  verified by a Playwright-Electron E2E test that launches the app for real.
- **PHASE 2 IS COMPLETE** — record → preview → export in the app; take library, labelling, delete
  to Trash.
- **Increment 4 (composite + export):** DONE — gate passed on a 60 s real recording (3414 source
  frames -> 3617 CFR output frames, two independent exports byte-identical pre-encode, peak
  buffered 16 frames). `npm run gate:export [sessionDir]` — defaults to the newest take.
  **Visually confirmed** (2026-08-24): cursor present, correctly positioned, in sync with the
  video, click highlight visible, motion smooth. Hashes prove the two sinks AGREE; only watching
  proves the agreed answer is right — a uniformly mispositioned or time-shifted cursor passes
  every automated check in this repo. `node scripts/export-one.mjs <sessionDir> [seconds]` writes
  a watchable file. The cursor was a placeholder circle until STC-239 (2026-09-02); it is macOS
  pointer artwork now, arrow by default.
- **Increment 5 (smoke test):** DONE. 5-minute capture (9311 frames, 0 dropped, 0 non-monotonic,
  peak 60.0 fps in the second half — no throttling). Display-change stop (clean, correct
  `stop.reason`, partial mp4 parses and plays). 30 s export from 2:30 into the take watched and
  confirmed: cursor tracking, correct segment, smooth.
- **PHASE 1 IS COMPLETE** — record -> composite -> export, verified end to end on real hardware.
- **The helper can stop itself** — a display change makes it stop cleanly and emit an unsolicited
  `stopped`. Anything holding recording state must reconcile, or it sits there believing a
  recording is live; the supervisor listens for that event and treats the heartbeat's `state` as
  the authority so any desync self-heals.

**Critical ordering rule:** the transform defines the schemas; the helper is a producer to spec.
Increment 0's `events.json` / `anchors.json` / `project` schemas must exist before increment 1
ships; the helper must emit to them before increment 2 ships. (Increment 1 has no capture and
writes none of these files — the schema gate is on it existing, not on the helper using it yet.)

## The non-negotiable

`render(project, events, t) → FrameState` is a pure function — no wall clock, no decoder
scheduling, no live helper stats, no current display state. Preview and export are two sinks
that call it with different `t` sequences. One implementation; sinks may not fork the transform.

## Settled decisions (do not relitigate)

See `PHASE-1.md` → "Settled by phase 0" for the full table. The ones most likely to matter:

- **Frame selection:** at time `t`, use the source frame with the greatest PTS ≤ `t`; hold,
  never interpolate. Same rule in both sinks — never "latest decoded frame."
- **Simulation step:** 120 Hz (`dt = 1/120 s`); 60 fps export samples every other tick. All
  times are integer nanoseconds or integer sim ticks — no float seconds inside the transform.
- **Cursor state:** function of sim tick `n = floor(t_ns × 120 / 1_000_000_000)`, not render
  call count. `stateAt(n)` must be identical whether reached by stepping or seeking.
- **Clock:** `mach_timebase_info()` at helper startup; numer/denom written into `anchors.json`.
  `displayTimeNs = displayTime × numer / denom` (41.667 ns/tick here, but read it, don't assume).
  `CGEvent.timestamp` is already nanoseconds — do not convert. `displayTime` is the *scheduled
  VBL presentation time* — SCK delivers the frame ~7 ms before it. It is when the pixels hit the
  glass, not when the frame was captured; treat it as such in frame selection.
- **Capture resolution: ≤3840×2160, H.264.** Hardware encode falls off a cliff immediately above
  4K (0.81 → 0.25 Gpx/s, software fallback) — and this machine's own display is 6016×3384.
  Chrome's H.264 *decoder* shares the ceiling, so 4K caps both sides of the pipeline.
- **Capture:** VFR at capture, CFR at export. Hardware encode only (`prefer-hardware`);
  `prefer-software` truncated at 19% of frames at 4K60 — it is not a fallback.
- **IPC:** stdout = lossy/non-blocking stats (drop-oldest, never block capture callbacks);
  stdin + fd3 = reliable request/response with sequence numbers. Never let stats back-pressure
  the capture graph. *(built — `IO.send` reliable, `IO.stat` lossy; capture callbacks use
  `IO.stat` only.)* When fd3 is absent both fall back to blocking stdout so a bare terminal run
  still works; they must never share fd 1 in split mode, or the lossy writer's partial
  non-blocking writes would interleave with reliable lines.
- **Signing:** ad-hoc revokes TCC on every rebuild. The self-signed **"STC Dev Signing"** cert
  (`d9ea4803…`, login keychain) already exists and both the helper and the probe are signed with
  it — *verified* to keep grants across rebuilds (PHASE-1.md → Signing). `find-identity -v` still
  reports 0 identities because it filters on *trust*; that is cosmetic and does not affect signing
  or TCC, and build.sh already falls back to the unfiltered list. **Do not open Keychain Access to
  "fix" it** — on macOS 27.0 it hung hard enough to require a force reset, and the setting buys
  nothing.

## Increment 0 — what to build next

1. Write `events.json`, `anchors.json`, and `project` schemas (versioned; `project` holds
   PiP geometry, cursor style, output fps — the edit document, even if it's 3 fields for now).
2. Hand-author a 5-second fixture session (no capture) containing cursor motion that exercises
   easing across VFR grid boundaries.
3. Implement `render(project, events, t)` against the fixture — no WebCodecs or DOM dependencies.
4. Wire two sinks: canvas preview + WebCodecs encode (demux via mp4box.js).
5. Gate: for 200 sampled `t`, the pre-encode RGBA buffer from each sink is byte-identical.
   Two independent exports produce matching pre-encode hashes. Encoded MP4s need not be
   byte-identical (container timestamps and encoder state are not contractually deterministic).

## Phase 1 scope (sprint)

Display capture + cursor events only. No camera, mic, system audio, display hot-swap rebuild,
segmentation, or fault-injection soak. See `PHASE-1.md` → Non-goals for the explicit deferred list.

`AVAssetWriter` cannot change output dimensions mid-file — a display resolution change must stop
the recording cleanly, not rebuild mid-stream (phase 2 concern).

## Toolchain

No Xcode.app — `swiftc` 5.8 with the MacOSX13.3 SDK (Command Line Tools) on macOS 27. SwiftPM
cannot resolve without full Xcode, so **build with `helper/build.sh`, not `swift build`**
(`Package.swift` is kept for when Xcode lands). macOS 14+ SCK API (`SCContentSharingPicker`, HDR,
`SCScreenshotManager`) is out of reach; `captureResolution` is absent from the 13.3 headers but
reachable via KVC (`setValue(3, forKey: "captureResolution")`, verified in phase 0).

## Correctness traps

Before touching gates, capture/helper internals (Swift), CI timeouts and
retries, or signing: read `docs/CORRECTNESS-TRAPS.md` first. It is a list
of specific mistakes this repo already made once and fixed — don't
re-discover them.
