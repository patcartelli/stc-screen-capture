# Correctness traps

Specific mistakes this repo already made once — gate flakiness, TCC/signing
quirks, capture threading hazards, CI timeout traps, and more. Read this
before touching gates, capture/helper internals (Swift), signing, or CI
configuration. Don't re-discover these.

## Correctness traps to watch for

- **Byte-identical MP4 is not the gate** — muxer timestamps and encoder state differ between
  runs. Hash pre-encode RGBA buffers, not container output.
- **The two channels are independent, and that is now MEASURED, not just described (STC-249).**
  A stalled stdout — stalled hard enough that the ring is actively dropping — does not stop fd3
  answering: 24 ms for a `status` on this machine. The failure that rules out is silent and total,
  because a parent whose UI stopped reading stats would find it could no longer stop the recording
  either, and the take would be unfinishable.
  Proven by MUTATION, which is the only way this claim means anything: move `cond.unlock()` in
  `LossyChannel.writeLoop` to AFTER the writes — the lock held across I/O, exactly the
  back-pressure bug the design forbids — and both tests in `ring-overflow.slow.test.ts` fail.
  Getting the lossy channel into a dropping state is escalated, never a fixed stall: measured idle
  here, 2000 ms dropped NOTHING, 4000 ms dropped 1051, 8000 ms dropped 5038. The kernel's pipe
  buffer decides, and CI's is bigger — a fixed stall calibrated here is the portability bug that
  file already hit on its first CI run.
  **The capture-side half is now VERIFIED on real hardware (2026-08-31).**
  `helper/test/lossy-under-capture.grant.test.ts` recorded for 8 s with stdout never read, and the
  ring overflowed on the first attempt without escalating. Frames captured, ZERO dropped, zero
  non-monotonic; `stop` was issued and answered over fd3 while stdout was stalled; and a drained
  control of the same length captured comparably. So the claim that stats cannot back-pressure the
  capture graph is measured, not merely described.
  It needs a Screen Recording grant for the TERMINAL that runs it — the helper is spawned directly,
  so it inherits the launching process's TCC identity, and STCTestHost being granted says nothing
  about that. `npx vitest run --config vitest.grant.config.ts helper/test/lossy-under-capture.grant.test.ts`;
  the SKIP-GRANT path returns before any recording, so a missing grant costs seconds.

- **The pre-encode hash DEPENDS ON THE RASTERIZATION BACKEND, and that was found by CI.**
  Measured on `fixtures/basic`, same code and same project: GPU gives
  `10a05a33…`, swiftshader gives `bc03e397…`. `composite()` draws to a canvas and the pixels are
  Chromium's to produce, so the determinism this repo gates on holds WITHIN a backend, not across
  two. Every gate compares inside ONE browser and is unaffected — but any cross-engine comparison
  is asserting something the codebase does not control.
  `app/test/export-identity.slow.test.ts` is exactly that: the app's Electron against the CLI's
  Chrome. It passed here for weeks and failed on its first CI run with precisely those two hashes,
  because Electron rasterized in software and Chrome used the GPU. Reproduced locally in one
  command by forcing swiftshader, which is how it was identified rather than guessed.
  Both sides are pinned to software now (`scripts/render-backend.mjs`, `STC_FORCE_SOFTWARE_RENDER`
  for the CLI side) — software because it is the backend every environment can provide. The flags
  live in ONE module and `transform/test/render-backend.test.ts` refuses a second copy; this is the
  fourth "one value, two copies" defect fixed in a single session.

- **`test:slow` runs in CI now, and the reason it never could was a Desktop dependency.**
  `app/test/export-identity.slow.test.ts` reached into `~/Desktop/stc` for a take and threw when
  it found none, so the one check that catches a UI-vs-CLI export divergence ran nowhere
  automatically — and it has caught two real ones. CLAUDE.md already recorded four E2E files being
  moved off the Desktop for exactly this; this file was missed because it is not in `npm test` and
  nobody was watching it. It uses `fixtures/basic` now (171 s -> 81 s), with
  `STC_EXPORT_IDENTITY_TAKE=real|<path>` to restore the heavier check by hand.
  The step is bounded as ONE process (`SLOW_TESTS_MS`, 12 min) the way each gate is, counted in
  `worstCaseJobMs` (56.8 min against a 65 min cap), and three guards assert the chain: ci.yml's
  step bound equals the declared constant, the model MOVES when the term is deleted, and a slow
  test's own `testTimeout` stays under the step's bound. That last one was missing and the config
  allowed **30 minutes per test** — three tests could have claimed 90 inside a 12-minute step and
  a 65-minute job, and a hung one would have died anonymously at the cap.
  **CI runs only `export-identity` from that suite, not the whole thing.**
  `ring-overflow.slow.test.ts` escalates a stall until the KERNEL's pipe overflows, so its
  duration is a property of the machine; its own comment already recorded that it "timed out on CI
  at 180 s", which is why it lived outside CI — and putting the whole suite in took it along. It
  passed three runs and timed out on the fourth. A test that reddens PRs at random is worse than
  one that does not run, so CI names the file it runs and `gate-bounds.test.ts` refuses
  `ring-overflow` there. The cost is real and stated in the doc: the lossy channel's end-to-end
  wiring and STC-249's channel-independence check are local-only commands.
  `vitest.slow.config.ts` was also UNSCOPED (`**/*.slow.test.ts`), so it globbed
  `.claude/worktrees/` — the same defect fixed in `vitest.grant.config.ts` on 2026-08-27, one file
  over. It is not cosmetic: it made a mutation test lie, reporting "2 failed | 2 passed" where the
  passes were other checkouts. Scoped, the same mutation fails 2 of 2.

- **Stats on stdout can block capture** — all stats writes must go through a bounded ring buffer
  on a dedicated writer thread with non-blocking fd; no capture callback may touch the pipe.
  *(`LossyChannel` does this. When capture lands, emit stats with `IO.stat`, never `IO.send`.)*
- **A failed `swiftc` leaves the previous binary in place** — `helper/build/stc-helper` is not
  removed on failure, so anything that runs the binary without checking build.sh's exit code
  silently tests stale code. The IPC tests rebuild in `beforeAll` and let a non-zero exit throw.
- **Node's paused child-stdio streams need an explicit `resume()`** — attaching a `data` listener
  to a child's stdout after `pause()` does NOT re-enable reading; the stream silently delivers
  nothing forever. Any test that stalls a consumer to exercise back-pressure must call `resume()`.
- **`stateAt(n)` seek cost** — at 120 Hz, 30 min = 216k ticks. If seek is implemented as
  "step from tick 0," a 60 fps export of a long recording is quadratic. Plan checkpoints.
- **`AVAssetWriter` dimension rigidity** — see above; display hot-swap is a stop, not a rebuild.
- **WebCodecs demux** — WebCodecs accepts `EncodedVideoChunk`, not MP4. mp4box.js (already in
  `scratch/`) is the demuxer. `VideoDecoder` is async; the sink needs a pre-decoded frame cache,
  not synchronous decoder calls inside `render()`.
- **WebCodecs tab-killers** (all three crashed the spike harness — PHASE-0 §4b): (1) drive a
  `VideoDecoder` with exactly **one in-flight request** — any scrub/seek UI needs a coalescing
  queue keeping only the latest requested frame; (2) close `VideoFrame`s in the output callback,
  never buffer them (~30 MB each at 6K); (3) mp4box.js exposes `DataStream` as a **browser
  global**, not `MP4Box.DataStream` — the latter throws inside the demux promise executor and the
  `await` hangs forever with no error.
- **mach timebase** — 41.667 ns/tick on this machine; Intel is 1/1. Always `mach_timebase_info()`.
- **Never block on `SCStream.startCapture`'s completion** — it dispatches to the same
  ScreenCaptureKit queue that delivered `SCShareableContent`'s callback, so a semaphore wait
  there deadlocks against itself and only clears when the timeout fires. This cost a flat 10 s
  on every `start` until it was found; `start` is ~0.2 s once the wait is removed.
- **`display.mp4`'s first sample is NOT at session time zero** — AVAssetWriter records the gap
  between "start received" and "first frame arrived" as an **empty edit** (`media_time: -1`) and
  leaves sample CTS starting at 0. A demuxer that reads only the sample table reports every frame
  early by that gap: measured at 231.7 ms on a real capture, ~14 frames of cursor desync — small
  enough to look like a rendering bug rather than a clock one. `demux.ts` adds the empty-edit
  duration; `fixtures/offset/` is the regression fixture.
- **A no-op rebuild is a vacuous TCC test** — `swiftc` is deterministic and
  `codesign --timestamp=none` adds no entropy, so unchanged source rebuilds to the *same* CDHash.
  Any "did the grant survive a rebuild?" check must confirm the CDHash actually changed first.
- **A bare CLI binary has a different TCC identity than a bundle** — exec'ing it inherits the
  launching terminal's grants (PHASE-0 §6), so terminal-testing the helper proves nothing about
  the shipped app. Permission work needs a bundle launched via `open`. Use `tools/test-host`.
- **`codesign` blocks on a GUI keychain dialog** — signing with "STC Dev Signing" can raise a
  SecurityAgent prompt, and an unattended build then hangs *forever* rather than failing. If a
  build wedges, look for the dialog (and answer "Always Allow", not "Allow"). A `timeout` around
  codesign kills the dialog before a human can find it.
- **`~/.Trash` cannot be enumerated** — macOS refuses `scandir` on it (EPERM) without Full Disk
  Access, for the test runner AND for Electron, while still allowing a targeted `existsSync`. A
  test that lists the Trash silently asserts nothing.
- **`await import()` inside a Playwright `evaluate` is rewritten by vitest** into
  `__vite_ssr_dynamic_import__`, which does not exist in the process the code is shipped to. Use
  `process.getBuiltinModule(...)`.
- **Seeking to a frame's exact PTS can land BEFORE it** — `seek()` floors time to a 120 Hz tick,
  and the floor of a first frame at 209.1 ms is 208.33 ms, where frame selection correctly reports
  "nothing yet" and paints black. Round up: `PreviewPlayer.firstRenderableNs`.
- **A custom protocol cannot be fetched from a `file://` window** — Chromium blocks cross-origin
  fetches from a file origin to any non-http scheme, so `protocol.handle` is useless unless the
  app itself is served over a custom scheme. The preview passes bytes over IPC instead, which also
  means the renderer never names a path.
- **mp4box reports a malformed file by never calling back** — no `onReady`, no `onError`, so a
  promise wrapping it never settles and the caller waits forever with no error and no stack.
  `demux.ts` checks `sawReady` after the synchronous parse and carries a watchdog. Any callback
  API wrapped in a promise needs the same question asked: what happens when it stays silent?
- **`performance.memory.usedJSHeapSize` does not count ArrayBuffers** — they live outside V8's
  heap, so a 458 MB buffer can read as "0 MB heap growth". Measure renderer RSS via
  `app.getAppMetrics()` instead; anything else quietly measures nothing.
- **Preview holds the whole video in memory** — measured 458 MB file → +548 MB renderer RSS
  (chunked; it was +862 MB read in one message). Roughly 1.2x the file, so a ~15-minute 4K take is
  the practical ceiling before the renderer is in trouble.
- **Tests must not depend on `~/Desktop/stc`** — four E2E files used to reach for "whatever real
  recording is there". That broke the moment those takes were deleted and CI could never have run
  them. `app/test/_take-fixture.ts` copies the committed `fixtures/basic` session instead; the
  GATES still default to a real take, which is where 4K behaviour gets exercised.
- **`gh pr merge --auto` does NOT wait for CI here** — auto-merge waits for *required* status
  checks, and requiring one needs branch protection, which needs GitHub Pro or a public repo. This
  is a free private repo, so there are no required checks and `--auto` merges IMMEDIATELY. It
  landed PR #2 while its run was still in progress. Use `npm run merge -- <pr>`
  (`scripts/merge-when-green.mjs`), which polls the run matching the PR's head SHA and refuses to
  merge anything not green.
- **`gh pr checks --watch` exits 0 when no checks exist yet** — it does not wait for one to
  appear. Run it in the seconds between opening a PR and GitHub registering the workflow and it
  prints `no checks reported` and exits **successfully**, which reads as "passed" to anything
  that checks the exit code. Seen on PR #10: the watch returned exit 0 before the run existed,
  and the run then started 20 s later and was still in progress. Same family as the `--auto`
  trap above — a command that succeeds by finding nothing to do, in a place where success is
  read as verification. Confirm a run exists for the PR's head SHA first
  (`gh run list --branch <branch>`), then watch that run by id with
  `gh run watch <id> --exit-status`.
- **Every wait needs a bound and a reason** — the rule this codebase kept re-learning. Five hangs
  in one day traced to promises settled only by someone else's callback: mp4box, `VideoDecoder`,
  `VideoEncoder`, `AVAssetWriter` and `SCStream` all signal trouble by never calling back. Wrap
  them in `withTimeout(p, ms, what)` from `transform/src/timeout.ts`; `what` becomes the error
  message. Two waits are deliberately unbounded and say so in comments — the lossy writer thread
  idling on its condition, and the event tap's `CFRunLoopRun` — because nothing is waiting on them.
- **A `VideoDecoder` can swallow input and emit nothing** — it buffers before its first output,
  so waiting for output when the queue has drained deadlocks on a perfectly healthy decoder. Feed
  more, flush only when there is nothing left to feed, and never wait unbounded. Related: flushing
  mid-stream to force output leaves it demanding a keyframe (`a key frame is required after
  configure() or flush()`), which breaks the next forward continue.
- **A stray `~/node_modules` hijacks module resolution** — the home directory holds a broken pnpm
  tree (rollup missing its native binary, esbuild built for x64 on an arm64 machine). Anything not
  installed *locally* may resolve there and fail bizarrely. Install tools as project devDeps.
- **Recordings go to `~/Desktop/stc/<timestamp>/`, never a temp dir** — `os.tmpdir()` on macOS is
  `/var/folders/.../T`, purged on boot and swept after ~3 days. A take is a deliverable, not
  scratch. `STC_RECORDINGS_DIR` overrides it (the E2E suite sets it so runs never touch the Desktop).
- **`-3805 "application connection being interrupted"` usually means OUR OWN app is still running**
  — a leftover `electron .` (or any second SCStream from this project) holds the display and every
  new capture fails this way. It reads like a permission or entitlement problem and is not one:
  with the stray app gone, the same helper immediately reports the honest `no-displays` instead.
  Check `ps -Ao pid,command | grep stc-screen-recorder` before debugging anything else.
  **STC-292 made this much easier to hit, and this note predates it.** The app is menu-bar-FIRST
  now: `window-all-closed` no longer quits on macOS, the Dock icon goes with the last window and
  the menu-bar item stays. So ⌘W leaves a live `Electron` + `stc-helper` holding the display with
  **no window and no Dock icon** to remind you it is there — the app is working exactly as
  designed and is invisible in both of the places you would look. Hit for real on 2026-09-09: a
  bare `start` from the terminal failed `-3805` twice in a row while `ps` showed pid 65217
  (`Electron … /stc-screen-recorder`) and its child helper. Quit it from the MENU BAR rather than
  `kill`, unless you are sure it is idle — `ps` cannot tell you whether a take is live, and
  killing mid-recording loses it.
  NB the grep matches other apps' Electron crashpad helpers (Linear, Discord, Claude, Wispr Flow
  all shipped Electron); scope on the absolute path `stc-screen-recorder/node_modules/electron`,
  which is the same "the shell running the check matched itself" lesson the saturation note
  already records one screen down.
- **`SCStream` can fail through `didStopWithError` INSTEAD of `startCapture`'s completion** — seen
  as `-3805 "application connection being interrupted"`. Wiring only the completion left `start`
  permanently unanswered. Every request path must resolve exactly once: the delegate answers a
  pending start, and a 15 s backstop answers if neither fires.
- **An `AVAssetWriter` append and its teardown must not overlap** — a take's FIRST append lazily
  creates the video compressor and takes milliseconds. If `markAsFinished`/`finishWriting` run on
  another thread inside that window, AVFoundation retains a track it has already released and the
  process dies. This was STC-254: intermittent on CI, invisible here, because on this machine the
  first frame lands long before any stop and on a CI VM it can land inside one. Appending *after*
  `markAsFinished` has returned is safe — it returns `false` — so guarding the nil checks alone
  fixes nothing; the fatal window is the append's own duration. `WriterGate` holds its lock across
  the append. Reproduces out of process in one to two iterations (`helper/test/writer-gate/`).
- **A fault does not pick one signal** — the same use-after-free landed as `EXC_BREAKPOINT`/SIGTRAP
  on CI (both reports) and as `EXC_BAD_ACCESS`/SIGSEGV in the local repro, depending on what the
  freed memory happened to hold. The crash handler originally covered SIGSEGV/BUS/ILL/FPE/ABRT but
  not SIGTRAP, so the variant that actually reached CI died mute — the parent saw a bare signal
  number from precisely the fault the handler existed to explain. SIGTRAP is now installed and
  every signal is named explicitly; the old `default: "SIGABRT"` would have mislabelled anything
  added to the loop, and a diagnostic that lies is worse than one that admits ignorance.
  `helper/test/crash-signals.test.ts` signals the real binary and asserts the stderr line.
- **A camera that OPENS and then delivers nothing is the failure that looks like success
  (STC-286).** Confirmed on real hardware 2026-08-31, laptop in clamshell on an external display:
  `camera-started` fires with `device: "FaceTime HD Camera"`, `camera.mp4` is created at 0 bytes,
  `captureOutput` is never called once, and `anchors.camera` ends `{present: false}` with NO device
  name — `track()` returns nil on zero frames and takes `deviceName` with it, which is why the
  test-host transcript was needed to identify the device at all.
  It is NOT a failed open, NOT a permission problem, and NOT the wrong device: `pickCamera` chose
  the built-in over an Elgato virtual camera and a Continuity iPhone, so #44's `transportType`
  ranking is holding. `startRunning()` simply returns on a camera that will never produce a frame.
  STC-287's work made this look WORSE before it made it better: the app showed the device name for
  the whole take — accurate, and actively misleading — and only admitted the truth in the library
  afterwards. `CameraCapture.noFramesWarningSeconds` (3 s, armed after `startRunning`) now warns
  while the take is still running. Three seconds because frames follow `startRunning` almost
  immediately: the ~1.4 s a viewer waits for the PiP is the OPEN, already done by then.
  Clamshell is only the reproducible case — a covered lens, another app holding the device, or a
  Continuity camera wandering off all look identical, and all are now reported.
  **BOTH ARMS are verified on hardware (2026-08-31), which no automated test can do — nothing in
  the suite can produce a camera delivering frames.** Lid shut, three runs: the camera opens, names
  itself, delivers nothing, and the warning fires 3.06 s after `camera-started`. Lid OPEN, control
  run: the same camera opens, `present: true`, first frame at 1.759 s, ~29 fps over a 10.6 s track,
  and the watchdog stays SILENT. The margin is real rather than assumed — almost all of that 1.76 s
  is the OPEN, and frames follow `startRunning` immediately, which is what the 3 s is measured
  against.
  NB the control very nearly read as a second clamshell run: `ioreg -r -k AppleClamshellState -d 4`
  prints a whole subtree, and `grep -o 'Yes\|No'` on it matches an unrelated token long before the
  clamshell line. Scope the grep to `"AppleClamshellState"` or the reading is not about the lid at
  all.

- **Two checks can each exist and still leave a hole between them, if they are on different
  VALUES (STC-311).** `anchors-2`'s `stop.reason` was a closed enum of five reasons and their
  `-timeout` variants. The helper writes four families it refused: `quit`, `stdin-closed` and
  `signal-N` from `App.shutdown` (STC-304), and `stopped-during-start` (STC-305). Both halves of
  the check were already in the repo and neither could see it —
  `shutdown-during-recording.grant.test.ts` asserted `reason === "signal-15"` without validating
  the document, and `anchors/main.swift` validated documents against the schema but only ever
  built them with `stopReason: "user"`. Assertion on one value, validation on another; the gap
  sat exactly between. Nothing broke downstream only because NOTHING validates anchors.json at
  load — `recording.ts` and `takes.ts` read `stop.t` and never `stop.reason` — so it was a schema
  that lies rather than a take that fails, which is why it survived three tickets.
  The fix is not a longer enum: `CaptureSession.stop`'s backstop answers `\(reason)-timeout` for
  WHATEVER reason it was given, so the suffix is a property of every family and hand-listing the
  cross-product is the drift that caused this. The schema states the rule (enum + a `signal-`
  pattern), and `helper/test/stop-reasons.test.ts` READS the reason literals out of the Swift call
  sites — expanding `signal-\(sig)` from the signal list it finds in `installSignalHandlers`, and
  THROWING on any interpolation it cannot expand rather than skipping it — and holds the schema to
  them. Deliberately no list of its own: a fourth copy is the defect, not the fix. Watched failing
  against the pre-STC-311 schema, against a schema missing only `stopped-during-start`, and — the
  one that matters — against `{"type": "string"}`, which is what "fixing" a schema by widening it
  until nothing fails looks like.
  NB the signal list is grepped by WHAT ITS LOOP DOES (`shutdown(reason:)`), not by position:
  `main.swift` has two `for sig in [...]` loops and the FIRST is `installCrashHandlers`
  (SIGSEGV/BUS/ILL/FPE/ABRT/TRAP), which dies with a stderr line and never writes a reason at all.
  A fourth copy was found while fixing this and deleted rather than corrected: `transform/src/
  types.ts` typed `stop.reason` as a union of four, missing `stream-stopped` and every shutdown
  reason. A union that cannot express values real files carry type-checks a lie and makes a
  `switch` look exhaustive; it is `string` now, with the enumeration living only in the schema.

- **A raw `display.mp4` never has a cursor, and a "the cursor is missing" report must say which file
  was watched.** `showsCursor` is off by design; the pointer exists only in an EXPORT, drawn from
  events.json. The first STC-309 watch (2026-09-04) was reported as "no cursor at all", and the file
  had 726 moves and 37 shape changes — the raw capture had been opened in QuickTime. Ask which file
  before reading a transform regression into it; `node scripts/export-one.mjs <take> 30` is the
  fastest way to a watchable one.
- **`stop()`'s own `tapEnable(false)` comes back to the tap callback as `tapDisabledByUserInput`,
  and the helper used to count it as a re-enable — and then RE-ENABLE the tap it had just
  disabled.** Invisible until STC-309 asserted `tapReenables == 0` on a real take and got 1, on a
  build where the sampler was already off the tap's thread. Two stories fit one number (starvation
  vs. our own disable), so `decideCursorEvent` now names the reason, `stoppingBegan` is set BEFORE
  the disable, disables after it are counted apart (`stats().tapDisabled.afterStop`) and not acted
  on, and `STC_NO_CURSOR_SAMPLER=1` records a control take with no sampler at all. The capture
  grant test prints the counts on success. A `timeout` in that breakdown would be real starvation.
- **`NSCursor.currentSystem` costs 1 ms typical and 41 ms worst per read (measured, STC-309).** Not
  microseconds. Anything on the tap's run loop that can take 41 ms risks `tapDisabledByTimeout`, so
  the cursor sampler has its own thread and `orderedEvents` restores time order at write time. The
  ticket's plan put it on the tap thread for ordering; the measurement overruled the plan.
- **The camera's whole lifecycle was invisible to the user (STC-287).** The complaint was "the PiP
  pops in ~1.9 s, so it reads as if the camera didn't work". Two corrections. The visible blank
  corner is the gap against the FIRST DISPLAY FRAME, not against session zero — the display track
  starts late too, so it is **1.26-1.39 s** measured across five real takes, not 1.9. And the
  pop-in is only the symptom people noticed: the helper had always emitted `camera-started` (with
  the device name), `camera-failed` and `virtual-camera-only`, and **the app subscribed to none of
  them**. `renderer.ts`'s warning handler matched exactly one code and dropped the rest, so a
  camera that could not open looked identical to one that worked, and a camera that opened and
  wrote zero frames (the clamshell case, STC-286's tail) looked identical to no camera at all.
  The gap itself is NOT a bug to fix: the camera opens off the critical path on purpose
  (`startRunning()` blocks and must not delay every `started` reply), and holding a future camera
  frame to fill the corner would violate the settled frame-selection rule. So the fix states the
  three facts instead — opening / live-and-named / failed-with-a-reason while recording, and on
  each take either when the PiP starts or that the camera recorded nothing.
  `_fake-helper.mjs` emits the camera events AFTER `started`, deliberately: a stand-in that
  announced the camera inside `started` could not reproduce the window being complained about.

- **The Camera pane only lists apps that have already REQUESTED access** — there is no
  add button, so a bundle that merely *reads* `AVCaptureDevice.authorizationStatus` never
  appears there and can never be granted. Reading status is not enough to become grantable;
  something must call `requestAccess` once to raise the prompt. `requestAccess` shows the
  dialog WITHOUT opening the device or lighting the LED, which is what makes it safe to call
  from a probe. `tools/test-host --camera-request` exists for exactly this.
- **Camera TCC inherits through the bundle, same as Screen Recording — verified 2026-08-26.**
  `helper/test/camera.grant.test.ts` launches the helper from the signed test-host and the
  helper reports `authorized`. This was STC-232 increment 1's gate, sequenced first precisely
  because a failure would have invalidated the shared-process capture design.
- **An empty events.json does not mean the tap is broken** — an automated capture records zero
  events simply because nothing moves the mouse, which is indistinguishable from a dead button
  path. Verifying input needs deliberate input; `fixtures/real-session/` pins the result.
- **CI's H.264 encoder can block forever on first touch — MEASURED, not inferred (STC-259).**
  Run 33102859258, same commit, two attempts: the first had `VTCopyVideoEncoderList` block past
  15 s; the re-run listed 21 encoders and acquired a hardware session in 144.9 ms. CI reports
  `paravirtualized:Apple Video Encoder`, a passthrough to a host shared with other tenants, so
  the verdict is per-host and per-moment. Any FIRST touch is exposed — the inventory, the
  acquisition, and `AVAssetWriter`'s lazy compressor creation, which is where both original
  STC-254 crash reports pointed. This is what made unrelated PRs go red for days. `writer-gate`
  bounds both encoder queries at 15 s, retries the run three times, then reports a loud SKIP.
- **A new bound must be checked against every bound already covering the same code**, not just
  against the thing it bounds. Three bounds added to `writer-gate` in one day each failed to
  fire: a synchronous call blocked the event loop its timer lived on; collected stderr was
  discarded because the promise never settled; and an inner bound was set exactly equal to the
  outer one, so the informative message always lost the race. Each was individually sound. The
  harness now prints its own bound and the test asserts it against the runner's exported
  `HARNESS_RUN_MS`, so the clearance is checked rather than kept in step by hand.
- **A bound nobody has watched fire is indistinguishable from one that cannot fire.** Same for a
  retry nobody has counted. `STC_WG_FAULT` hangs the encoder query on demand and
  `STC_WG_ATTEMPT_LOG` records one line per process start, so both are asserted against observed
  behaviour. The load-bearing assertion is that the failure is OURS and not the runner's
  (`not.toContain("did not finish within")`) — an inner bound that loses that race is decorative.
- **Vitest DISCARDS `console.*` output from a test that ends up skipped** — it attributes console
  output to the producing test, and a skipped one prints nothing. A skip notice written with
  `console.warn` therefore vanishes exactly when it is needed, leaving a silent green tick where
  a gate did not run: CLAUDE.md's "success by finding nothing to do" trap, self-inflicted. Write
  skip notices with `process.stderr.write`, which survives, and verify by actually skipping.
- **A test seam that fakes state the subject contradicts races the subject's own self-healing.**
  `supervisor.test.ts`'s crash-mid-recording test called `markRecordingForTest()` against a live,
  *idle* helper. The supervisor treats the heartbeat as the authority and heals any desync, so any
  stats line landing between the kill and `waitForExit` resolving cleared `recordingDir` and the
  crash had nothing left to report as lost — `expected +0 to be 1`, green on this Mac 8/8 and on
  reruns, red on a loaded CI VM (run 33104414974). Nothing was wrong with the product: the
  self-healing is the documented feature. The fix is a world the fake can be true in —
  `app/test/_fake-helper.mjs` speaks the control plane, can actually be recording, and lets the
  test drive the real `startRecording`. Waiting for the helper's own heartbeat to AGREE is the
  load-bearing step; it is precisely what the old fake could not survive.

- **The gates' encoder is bounded on BOTH sides of the process line, and the outer one is the
  load-bearing half.** #30 bounded every `page.evaluate` (Playwright has no default timeout on it);
  #31 added the in-page half — `harness/main.ts` now has the bounded back-pressure drain that
  `transform/src/export.ts` already had, so a stalled encoder fails at the frame it stopped on
  ("encoder stopped draining at frame 35 of 300, queue stuck at 31") instead of surfacing minutes
  later with the count lost. **The inner bound cannot replace the outer one**: every in-page bound
  is a JS timer, and a timer cannot fire while the renderer's main thread is blocked.
  `VideoEncoder.configure()` is synchronous and CI's encoder is a paravirtualized passthrough that
  STC-259 measured blocking past 15 s on first touch — when that happens only another PROCESS can
  notice, which is why the gate ran 24 min with nothing to say. The page is HANDED its bound by the
  runner and echoes it back for the driver to assert, and `runGate` refuses to run without one: a
  bound the page defaults on its own is a bound nobody checks. `ENCODER_MS < EVAL_MS` is asserted in
  `gate-bounds.test.ts`, not left true by luck.
  NB pacing the encode loop changed gate C's encoded size (537167 -> 314306 bytes) — rate control
  responds to submission timing. Pre-encode determinism is untouched, which is what the gate proves;
  gate C only asserts the encoder produced bytes at all.

- **"E2E flake" on this machine is usually SATURATION, not a test bug — and the tell is which tests
  fail.** A loaded run takes down `transform/test/schema.test.ts` (pure JSON-schema validation, no
  Electron, no subprocess) and `spawnSync xcrun ETIMEDOUT` alongside the Electron suites. When a
  pure-computation test and the toolchain itself time out, nothing is wrong with the E2E tests:
  the box is starved and the most timing-sensitive tests simply fail first, which is why the app
  E2E files look like the culprits. Measured 2026-08-27: the full suite is 207+ tests spawning
  Electron many times over plus the helper's process-heavy tests, and a `npm run gate` loop
  alongside it is enough to push it over. Before debugging a flake, check `uptime` and
  `ps -Ao command | grep -c '[s]tc-screen-recorder/node_modules/electron'` — a killed run leaves
  Electron orphans behind (`afterEach` closes with `.catch(() => {})`, which swallows the failure),
  and they accumulate across interrupted runs until everything times out. A CLEAN completed run
  leaks nothing; interrupted ones do.
  Cautionary tale from the same session: a load experiment using `(while :; do :; done) &` spinners
  survived both `kill $(jobs -p)` and a `pkill -f` whose pattern did not match the resulting bare
  `/bin/zsh`. They ran for 26 minutes at 8 cores, load hit 404, and every before/after measurement
  taken in that window was worthless — including one that appeared to show a fix making things
  worse. If you generate load, kill it by PID and CONFIRM with `ps` before believing any number.

- **The E2E files run one at a time; everything else stays parallel.** `vitest.config.ts` is two
  projects — `unit` (default parallelism) and `e2e` (`fileParallelism: false`). Measured
  2026-08-28 with a sampler counting Electron MAIN processes: a full run peaked at FIVE apps on the
  machine at once before, and ONE after. That is the largest single source of the saturation
  described above. The cost is real and was measured too: the full suite goes 19 s -> 36 s, since
  the E2E files no longer overlap. `vitest.grant.config.ts` reached the same conclusion earlier for
  its own reason (concurrent `open -W` on one app bundle).
  **This is not proven to reduce the flake** — both arms were green on an idle machine, and a flake
  that needs a loaded machine cannot be measured on a quiet one without generating load, which is
  itself how a whole afternoon of measurements got invalidated. It removes a known saturation
  source; that is the whole claim.
  When counting processes to check any of this, filter with `startsWith` on the absolute binary
  path and list `ps` ONCE from inside the script. Three separate measurements in one session were
  wrong because the shell running the check had the search string in its own command line and
  matched itself — a phantom baseline of 2 with nothing running, and a "peak 6" that was mostly
  the grep. Calibrate against a known state (0 idle, 1 with one app) before trusting a number.

- **`npm run merge`'s exit code has been wrong in BOTH directions; it is now decided by asking
  GitHub, not by trusting `gh`.** First it looked like it exited 0 after giving up — that was an
  invocation piping it through `tail`, and a pipeline reports its LAST command's status, not the
  script's. Then it genuinely exited 1 after a merge that landed (PR #34): `gh pr merge
  --delete-branch` merges server-side and then deletes the LOCAL branch, which means switching off
  it, which fails from a worktree because master is checked out in the main checkout
  (`fatal: 'master' is already used by worktree`). The merge stood and the script called it a
  failure. It no longer passes `--delete-branch`: it merges, re-reads the PR's state as the
  authority, and deletes the remote ref over the API — which touches no local branch. A cleanup
  that did not happen is not a merge that did not happen, so that failure is REPORTED and does not
  change the exit code. `transform/test/merge-when-green.test.ts` drives the real script with a
  stub `gh` on PATH and watches all four outcomes, including both directions of wrongness.
  When writing such a test: `execFileSync` returns stdout ONLY, so an assertion on a message
  written to stderr fails for the wrong reason. Use `spawnSync` and read both streams.
  **It also read the head SHA exactly once, before the poll loop.** Push during the wait and the
  poller kept matching runs against a commit that was no longer the head — found that commit's
  green run, and merged. Hit for real on 2026-08-30 (PR #51) when a doc fix was pushed in the same
  breath as the merge; GitHub's branch protection refused it, which is luck, because this script
  exists FOR repos with no required check and that is exactly where nothing else would catch it.
  A verifier that can merge something other than what it verified is not a verifier. The head is
  now re-read every poll (fail fast, and do not wait out a full CI timeout on a dead SHA) and the
  merge itself passes `--match-head-commit`, which closes the remaining gap server-side.

- **The 26-minute "gate stall" was TEARDOWN, not the gate — and not the encoder.** Root-caused from
  the logs of run 33108160534: the gate did not hang. It FAILED correctly 66 s in with
  `TimeoutError: decoder flush did not complete within 60000ms`, printed that, and then sat for
  another 26 minutes in `finally` on an unbounded `browser.close()` — closing a browser whose
  renderer is wedged inside a stuck decoder never returns. The job timeout killed it, which reports
  as "cancelled", so the log looked like a hang with no explanation. #30's `closeQuietly` bounds
  teardown at 30 s and now names it: master runs 33194258237 and 33193936334 show the whole thing
  finishing in 96 s with `(teardown: browser.close() did not return within 30000 ms)` and a clean
  exit 1. **The earlier guess that this was `VideoEncoder.configure()` blocking synchronously was
  wrong** — the encoder is not involved; read the failing step's log before theorising.
  The REMAINING fault is the decoder: `VideoDecoder.flush()` not settling for a 90-frame 640x360
  fixture on CI, on roughly HALF of master's push runs. `decode.ts` now reports, on the failure path
  only, how many chunks went in, how many frames came out, `decodeQueueSize`, `state`, and what
  `isConfigSupported` says for hardware and software — because "did not complete" cannot tell a
  decoder that never started from one that stalled at the last frame, and those are different bugs.
  `FLUSH_MS` is one constant so the bound and the message it prints cannot disagree.

- **The determinism gate retries on the MACHINE and skips loudly; it never retries a wrong answer.**
  `npm run gate` is now `scripts/gate-retry.mjs`, which runs `gate.mjs` up to 3 times and keys
  strictly on the `ENVIRONMENT:` label the gate prints when a BOUND fired. Every determinism check
  reports through `fail()` with a concrete number — a hash mismatch, a frame count, zero encoded
  bytes — and a run containing any `FAIL:` line, a death by signal, or the runner's own bound is
  disqualified from being retried. After 3 environment failures it announces a SKIP (an Actions
  `::warning`, and stderr not `console.warn`) and exits 0: the annotation is the record that the
  gate did NOT run, which is not the same as a pass.
  Why this and not "let it fail loudly": master was red on ~half of pushes, and a red X that means
  either "you broke determinism" or "Apple's shared GPU did not answer" is AMBIGUOUS, not loud —
  it is how a real breakage survives, and one did on 2026-08-28 (#28/#32). Red now always means the
  code; SKIP means the machine.
  `STC_GATE_FAULT=environment|regression` makes both paths reachable on demand and
  `STC_GATE_ATTEMPT_LOG` counts attempts, so the retry is asserted against observed behaviour:
  3 attempts then SKIP for the machine, 1 attempt then exit 1 for a regression. Each guard was
  mutation-tested — dropping the `FAIL:` disqualifier, the signal check, or the condition itself
  each breaks 3 tests.

- **The retry is part of the job's worst case, and the clearance test now says so.** #39 wrapped
  the determinism gate in 3 attempts bounded at 10 min each, and the existing clearance test —
  `PRE_GATE + EVAL_SLOTS x EVAL_MS + SEEK_MS = 21.5 min < 30 min cap` — did not model it and stayed
  green while that ONE gate could consume the entire cap before the other three ran. Third time
  this repo has met "a new bound must be checked against every bound already covering the same
  code", and the first two are in this file. `scripts/gate-bounds.mjs`'s `worstCaseJobMs()` now
  models the job per gate INCLUDING `ATTEMPTS`, `ATTEMPT_MS` is 5 min (was 10), and the cap is 45.
  Two assertions the old test could not make: `ATTEMPT_MS > attemptFloorMs()` (`EVAL_MS` + both
  teardown bounds + launch + the 60 s `__ready` wait) — below that, gate-retry's own bound fires
  before the gate can print `ENVIRONMENT:`, `isEnvironmentFailure()` correctly refuses to retry, and
  the retry silently stops working — and the worst case must scale with `ATTEMPTS`.
  **The first draft of that floor was itself 60 s short**, because it omitted the `__ready` wait
  that sits inside every retried attempt, which let `ATTEMPT_MS` sit BELOW the true cost of an
  attempt — the exact failure the assertion existed to prevent. Caught in review, not by the test.
  Worse, the first repair was VACUOUS: raising `ATTEMPT_MS` and the cap left enough slack that
  removing the term again still passed. **Assert composition, not magnitude** — the guards now say
  the floor must ACCOUNT FOR each named bound, and `READY_MS` is checked against the timeout parsed
  out of `gate.mjs` so it cannot drift from what the gate actually waits. All four mutations
  watched failing after that change, not before it.
  What the model does NOT cover is stated in `gate-bounds.mjs`: the three non-retried gates each
  retry their evaluate up to 3x on Playwright's "garbage collected" error, re-entering the 60 s
  readiness wait each time. Counting all of them gives ~80 min, which is too loose to be a bound;
  the structural fix is a per-process bound per gate, like `ATTEMPT_MS` gives the determinism gate.
- **Every gate must tear down through `closeQuietly`, and a test enforces it.** #30 bounded
  teardown in three gates and missed `seek-gate.mjs`, which then did the identical 17.5-minute
  `browser.close()` hang on the handoff PR — failing correctly in 10 s with a full decoder dump
  first, exactly like the original. `gate-bounds.test.ts` now refuses a direct `browser.close()` in
  any gate and requires each to import `closeQuietly`.

- **Retry logic must key on the failure being the MACHINE's, never on "it failed"** — a retry
  that absorbs a real regression is worse than no retry. `writer-gate` keys strictly on the
  harness's `ENVIRONMENT:` marker and excludes death-by-signal, failed assertions, and the
  runner's own timeout by name, each covered by a test. STC-254 arrived as SIGTRAP on CI and
  SIGSEGV locally; retrying either three times and calling it a skip would have buried it.
- **The PiP is visually confirmed (2026-08-28), and that is a separate fact from every gate.**
  Watched on a real 15 s 4K take (`Elgato Facecam 4K [USB2]`, 60 fps): camera bottom-right,
  correctly proportioned, appearing when the camera track starts, in sync with the screen. This
  is the same class of check PHASE-1 recorded for the cursor, and it is not redundant with the
  determinism gate — a uniformly mispositioned or time-shifted PiP passes every automated check
  in this repo, including the blind-hash check, which only proves the PiP changed *some* pixels.
  NB the first clip produced for this check was WRONG: `scripts/export-one.mjs` hardcoded a
  project with no `pip`, so it exported the take with the PiP disabled and the reviewer correctly
  reported seeing no PiP. Any artifact made for human verification must come from the take's own
  `project.json` — fixed, but the lesson is that the verification path needs verifying too.
  STILL NOT MEASURED: the camera-to-display sync NUMBER. "Looks in sync" is an eye's tolerance,
  not a millisecond figure; `scratch/` has `avsync.cjs` for producing one, and increment 5 owns it.
- **The fourth caller assembled a project outside `parseProject`, exactly as predicted — and CI
  could not see it.** `harness/sink-identity.ts` used a fetched `project.json` VERBATIM and fell
  back to a literal it built itself, with no `pip`. A hand-rolled object cannot know that
  `parseProject` turns the PiP on for a camera take (from its `hasCamera` argument), so every
  camera take with no `project.json` rendered without a PiP and `npm run gate:identity` failed on
  a real 5.6 MB camera track. `harness/main.ts` had the same bypass, benign only because
  `fixtures/basic` has no camera.
  **CI ran the identity gate on the camera-LESS fixture**, which is why nothing caught it. It now
  runs on `fixtures/pip` (224 KB, committed, a real camera track) with `project.json` deliberately
  NOT copied — a take recorded by the app has none until it is edited, so that is the path that
  must be exercised. Proven to discriminate: the same fixture take FAILS on the old code and
  passes on the new. It is a strict superset of the camera-less run, so it costs no job budget.
  `transform/test/trim.test.ts` is now the fifth caller's tripwire.

- **A gate with its OWN loader does not prove the app can open anything.** The
  PiP determinism gate passed on a real camera take while the Electron app
  could not open one at all: `harness/sink-identity.ts` supplied `camera.mp4`
  to `loadSession`, and `app/src/renderer.ts` and `harness/export.ts` did not,
  so every camera take died at load with "anchors.camera.present is true but no
  camera.mp4 was supplied" — `loadSession` correctly refusing to silently drop
  the PiP. Nothing caught it because every other fixture is camera-less. When a
  loader gains an input, grep `loadSession(` and fix EVERY caller; the gate is
  not one of the app's code paths. `app/test/preview.e2e.test.ts` now opens a
  PiP take from the committed fixture, and fails without the renderer fix.
- **`vitest.grant.config.ts` globbed the agent worktrees.** Its
  `include: ["**/*.grant.test.ts"]` had no directory scoping, so once
  `.claude/worktrees/` held other agents' checkouts, `npm run test:capture` ran
  their copies too — which resolve `tools/test-host/STCTestHost.app` relative to
  their own root, where it does not exist, and fail with "build it first" for a
  bundle that IS built. Seven failures, none about this checkout.
  `vitest.config.ts` was always scoped; the grant config was not.
- **Preview-memory ratios are regime-dependent — quote absolute growth.**
  PHASE-2's "~1.2x file size" came from a 458 MB take where the file dominates;
  on a 24 MB take the fixed costs dominate (decoder buffers plus a decoded 4K
  frame at ~30 MB) and display-only reads as 5.7x its own file. Same code, same
  metric, incomparable numbers. `scripts/measure-preview-memory.mjs` is the
  committed harness; PHASE-2 records what it measured and what it does NOT
  answer.
- **A 720p camera track is not automatically small next to 4K.** Measured: on a
  15 s take `camera.mp4` was 1.7x the size of `display.mp4` (15 MB vs 9 MB). A
  static screen compresses far better than a moving face, so the design spec's
  "a 720p camera adds ~10-15%" assumed a ratio that does not hold on short
  takes.
- **`tsconfig.json`'s `include` is the whole scope of static checking in this repo** — vitest
  transpiles without typechecking and esbuild does not check either, so a directory left out of
  `include` has NO static checking at all, not merely weaker checking. `include` was
  `["transform/**/*.ts"]`, so `harness/` and `app/` were never checked: adding a parameter to
  `composite()` broke `harness/main.ts:40` and `:71` while `npx tsc --noEmit` stayed green and all
  195 tests passed, and only `npm run gate` — a real browser run — caught it, as a runtime
  `TypeError`. Same family as the `--auto` and `--watch` traps: a command that succeeds by finding
  nothing to do, in a place where success is read as verification. `transform/`, `harness/`, `app/`,
  `helper/` and the root `vitest.*.ts` are all in `include` now (`helper/test/` was a third
  unchecked tree, found while fixing the first two), and `paths` maps `@transform/*` because tsc
  cannot read vite's or esbuild's aliases.
  Verified by re-adding the `composite()` parameter and watching tsc fail on those exact lines.

- **`scripts/*.d.mts` are HAND-WRITTEN and nothing compared them to the `.mjs`.** `allowJs` is off,
  so tsc reads the declaration and never looks at the implementation — the two can disagree while
  all three passes stay green. It bit twice in one day: `worstCaseJobMs` gained a parameter and
  `bounded` gained a thunk label, and both stale declarations produced errors. Those errored the
  SAFE way. The dangerous direction is the opposite — a declaration promising MORE than the code
  delivers (a renamed export, a `function` that became a constant) typechecks clean at every call
  site and fails at RUNTIME, in a script that only runs on CI or by hand.
  `transform/test/declaration-drift.test.ts` imports each module for real and checks the declared
  surface exists. It cannot check parameter types; it catches the failure that actually reaches
  runtime. All five scripts are import-safe — two are main-guarded precisely so they can be.

- **Typechecking is THREE passes — `npx tsc --noEmit` runs only the first.** Use
  `npm run typecheck`, which is what CI runs. `tsconfig.json` is the coverage pass (every .ts file,
  DOM and node both visible) and is deliberately what a bare `tsc` runs, so the default can never
  be a partial check that reads as a full one. `tsconfig.browser.json` (`types: []`) and
  `tsconfig.node.json` (`lib` without DOM) then add RUNTIME constraints on top: `document` in the
  Electron main process and `process`/`require` in the renderer or the transform are both runtime
  crashes, and both are now type errors at the use site. The browser pass also guards the
  non-negotiable structurally — a node import in `transform/src/` would quietly make the pure
  transform node-only. Scope is by directory with `app/src/renderer.ts` carved out, not an explicit
  file list, so a new file under `app/src/` gets the constraint automatically and must opt out.
  `skipLibCheck` is on in the two narrowed passes ONLY, and only because `electron.d.ts` declares
  the main, renderer and `<webview>` APIs in one file and cannot parse without `lib.dom` (11x
  TS2304); the coverage pass has it off, so declaration files are still checked exactly once.
  All four constraints were verified by watching them fail — `document` in main, `process` in the
  renderer, `require` in the transform, and the `composite()` arity drift — each confirmed to make
  `npm run typecheck` exit non-zero, then reverted.
- **Every gate carries its own PROCESS bound, and the job's worst case is a SUM, not a model.**
  Only the determinism gate had an outer bound (`ATTEMPT_MS` via `gate-retry`); the other three ran
  unbounded while `worstCaseJobMs()` guessed at their internals. That guess went wrong twice — once
  omitting the retry entirely, once the readiness wait — and on 2026-08-28 an unbounded seek gate
  held a CI job to its cap for 17.5 minutes after failing correctly in 10 seconds. `gate-run.mjs`
  now bounds each gate from `GATE_PROCESS_MS`, so the worst case cannot be under-counted the way a
  model can, and the previously-absorbed GC-retry path is accounted for rather than named in a
  comment. A gate with no declared bound is REFUSED, not silently defaulted.
  The cap rose 30 → 45 → 55 → 65 as the model stopped lying, and that is not a regression: a wedged
  gate now dies at its own 7.5-13 min bound instead of holding the job, so failures got faster while
  the number went up. The cap is a backstop behind four tighter bounds.
- **A bound's own slack will hide a missing term in its floor — assert COMPOSITION, not magnitude.**
  Dropping `GC_RETRIES * READY_MS` from export-gate's floor left all 20 gate-bounds tests green,
  because a 780 s bound clears the reduced floor comfortably. Same shape as #42's vacuous first
  repair, and as a PiP test that passed with the compositor wiring removed because the display frame
  filled that corner anyway. The fix in all three cases was a positive discriminator: name the parts
  and require each, or compare against a control that differs ONLY by the thing under test. Five
  mutations are watched failing in `gate-bounds.test.ts`, including that one.
- **The gates' wedge is the DECODER's synchronous `configure()`, and the checkpoint trail found it
  without any GPU logs.** Run 33384105552 wedged all four gates; every trail stopped at the first
  decoder touch, 391-633 ms after page start — `decodeAll`, `loadSession`, `frameAt(0)`. Not the
  encoder, and not late in a long run.
  The seek gate's own IN-PAGE bound fired there (`the decoder accepted chunks and emitted none`),
  so ITS thread was alive — Mode A, already well diagnosed. The other three ran the full 180 s
  outer bound while their own 60 s in-page flush bound never fired, which is only possible if no JS
  timer could run: blocked inside the SYNCHRONOUS `VideoDecoder.configure()`. Both modes, same job,
  both the decoder.
  This SUPERSEDES "Mode B cannot be diagnosed from inside the page — Chrome's GPU logs are the
  avenue". A console message escapes a blocked renderer when nothing else does, which is the whole
  reason the trail works.
  `configure()` had no `hardwareAcceleration`, so Chromium was free to pick CI's paravirtualized
  video hardware — the class of device STC-259 already measured blocking on first touch from Swift.
  The gates now ask for `prefer-software` (`GATE_DECODER_PREFERENCE`, handed to the page by the
  runner and ECHOED BACK so a failed addInitScript cannot leave the gate quietly testing the
  default). The app never sets it and keeps hardware decode.
  **It did not work, and the echo could not tell you (measured 2026-09-01).** The gates still skip
  post-change and the trail still stops at the first decoder touch 317-406 ms in — the same
  signature. But that echo runs AFTER `bounded(page.evaluate(...))` returns, and a wedge never
  returns, so on exactly the runs it exists for it cannot fire: the conclusion rested on assuming
  `addInitScript` had applied. Same shape as every wrong number in the 2026-08-31 handoff — a
  measurement that could not see what it was being read as evidence about. `harness/decoder.ts`
  now applies the preference and MARKS it, so a wedged run says which decoder it was asking for;
  it is `[gate-mark 1]`, ahead of the first decoder touch, watched firing under
  `STC_GATE_FAULT=wedge:`.
  **CI then wedged on the very run that merged it (33576888543) and settled it.** All four gates
  skipped and every trail carried `decoder preference: prefer-software` ahead of its own first
  decoder touch — 393/466 ms determinism, 531/584 seek, 450/482 export, 348/375 identity. The page
  GOT software decoding and `configure()` blocked anyway, so the hypothesis is dead on evidence
  rather than on assuming `addInitScript` applied. NB that verdict needs no step attribution (the
  run has none): `decoder preference:` is printed only by `harness/decoder.ts`, and the two
  references in its test sit behind a `console.log` spy, so no test can emit it. That file is also the ONE place the runner's value is read — four
  harness entries carried an identical copy of the block, and `main.ts` separately re-read the
  global to echo it, which would have reported `prefer-software` even if `setDecoderPreference`
  had never been called.
  **It changes the pre-encode hash** — 10a05a33 -> bc03e397 on `fixtures/basic`, the same two
  values the rasterization pin produces, because forcing either the decoder or the renderer onto
  the CPU lands in the same state. An earlier draft of this note claimed H.264's bit-exactness made
  that impossible; the decode is bit-exact in YUV, the RGBA that reaches the canvas is not. It is
  survivable only because the gates compare within ONE browser and never against a stored constant.

- **`[gate-mark N]` is numbered per DOCUMENT, not per run — three of the four gates reload.**
  `seek-gate.mjs`, `export-gate.mjs` and `identity-gate.mjs` each `page.reload()` deliberately, to
  settle vite's dep re-optimisation; `gate.mjs` does not. `mark.ts`'s `seq` lives in the page, so a
  reload restarts it, and run 33576888543 duly printed TWO `[gate-mark 1]` lines in exactly those
  three trails — which reads as the same code running twice in one page and is not. Only the
  DRIVER can tell the difference, because noticing it from inside would need the thread that is
  stuck. `attachCheckpointTrail` announces it on `framenavigated`, which commits BEFORE the new
  document's scripts run; `load` and `domcontentloaded` both fire after module evaluation and would
  sort the separator to the wrong side of the marks it explains. Nothing is printed before the
  first mark — a reload with nothing yet collected has no ambiguity to resolve.
  This only became visible when the preference mark gave each load something to emit early; before
  that, the pre-reload document died before reaching any mark. A diagnostic gaining detail is how
  you find out what the old one was not showing you.

- **The gates skip on a large minority of CI runs, ALL FOUR TOGETHER, and that is the number to
  watch.** 60% measured 2026-08-30 over 10 runs, 25-28% measured 2026-09-01 over 20 — different
  run sets, samples too small to separate, and NOT evidence of a trend either way;
  `docs/STC-259-GATE-SKIP-RATE.md`, re-derive with `node scripts/gate-skip-rate.mjs`. In every run
  where one gate skipped all four did, and where one passed all four did — it is a property of the
  JOB (can this machine service a video pipeline right now), not of any gate.
  Healthy, the determinism gate clears A, B and C in **9 s** and the whole job takes 2.7 min.
  Wedged, that one step used to burn **641 s**. The signature is the OUTER bound (`in-page gate run
  did not return within 180000 ms`) plus `browser.close()` hanging its full 30 s: a WEDGED
  renderer, not a slow one, so no in-page JS timer can fire. Mode B — Chrome's GPU logs, not more
  instrumentation inside the page.
  **The retry bought nothing** — all three attempts failed identically at the same bound and 2 and
  3 never succeeded where 1 failed, so `ATTEMPTS` is **1** since 2026-08-30 (worst case 58.8 ->
  44.8 min). Dropping that constant quietly guts two guards, both rewritten to survive it:
  `worstCase >= ATTEMPTS * ATTEMPT_MS` is satisfied at 1 by a model that deleted the term (PROVEN —
  the old form was put back against a mutated model and passed), and `gate-retry`'s
  `toBe(ATTEMPTS)` becomes indistinguishable from the retry loop having been deleted. Assert that
  the model MOVES with the count; drive the loop with an explicit count.

- **A CI log is not one text — scope every verdict to its STEP.** This finding was first published
  as "the determinism gate has not run in 19 consecutive runs, 100% skip". That was WRONG. The
  script searched the whole-job log for `Determinism gate DID NOT RUN`, and
  `transform/test/gate-retry.test.ts` prints that line verbatim into the **Test** step because it
  exercises `announceSkip` for real — so every run that ran the unit tests read as a skipped gate,
  including runs where the gate passed in nine seconds. The same document had already warned that
  `decoder flush did not complete within 60000ms` is a FIXTURE STRING and not a fault; documenting
  a trap is not immunity to it. `gh run view --log` emits `job<TAB>step<TAB>message`, so slice by
  the step column. Step attribution is often ABSENT (`UNKNOWN STEP` for every
  line) — those runs are unmeasurable and must be named and excluded, never folded into the
  denominator. When it is available is NOT understood: measured over 12 runs, everything younger
  than ~200 min had none and everything between 212 and 319 min had it, so it appears hours after
  a run rather than ageing out — but some day-old runs lack it too. A first version of this note
  said it "ages out within a day or two" and advised measuring FRESH runs, which is exactly
  backwards: a just-finished run cannot be measured at all. Wait a few hours. A boundary claim built on the broken method (last pass `cb03ee9`, first skip
  `9df1e27`) had to be RETRACTED, because the runs needed to re-check it had already aged out.

- **"Red means the code" only became true once ALL FOUR gates could say ENVIRONMENT.** #39 gave the
  determinism gate a machine label and the claim was made then; it was 1-of-4 true. The other three
  routed machine faults through `fail()`, so on 2026-08-29 a decoder that accepted 8 chunks and
  emitted none reddened a PR twice through the seek gate — on the PR whose subject was that
  distinction. All four now label a bound firing as ENVIRONMENT.
  The three non-determinism gates SKIP on the first one and are NOT retried: retrying all four at
  3 attempts models to 118 min and would need a ~2 hour cap, against 58.8 min as it stands. The
  cost is stated rather than buried — with the fault near 50%, those gates will skip often, and a
  skipped gate is not a passed gate. If skipping becomes the norm the answer is fixing the decoder,
  not adding attempts.
- **Ask the ERROR whether a bound fired; do not match its text.** `bounded()` tags its own timeouts
  (`e.boundFired`), so a gate with a single catch-all can tell "my bound fired" from "I found a
  wrong answer" structurally. Text patterns survive only for bounds that fire INSIDE the page,
  which reject across the process boundary as plain Errors and cannot carry a property — and that
  list lives once in `gate-bounds.mjs` rather than being reinvented per gate.
  Where a gate ALREADY branches on the distinction, use the branch: `seek-gate`'s
  `stuckOnFirstSeek` is split by `classifyDecoderStall()` on the source's own state — fed,
  configured, no error, nothing out is the machine; never fed, errored, needs-keyframe, or already
  producing is OURS. Labelling the whole branch ENVIRONMENT would let a broken `SeekingFrameSource`
  skip silently, which is the regression-absorbing skip the retry rules exist to prevent.
- **`gate-bounds.mjs` owns every bound; `gate-retry.mjs` imports them.** The reverse — bounds
  importing the retry's constants — was right while the retry was the only runner, and became a
  cycle the moment every gate got a bound. ESM resolves that cycle by hanging on the top-level
  await and exiting 13, not by failing clearly. One direction: the runner depends on the bounds,
  the bounds depend on nothing.
- **You cannot bound an append in the product, and STC-259 step 3's answer is that you must not
  try.** The ticket asked whether `Capture.swift` and `CameraCapture.swift` need the append bound
  the writer-gate harness now has. They do not, and the reason is structural rather than a
  judgement call: `WriterGate.append` holds its lock ACROSS the append — that IS the STC-254 fix —
  so a bound there would have to abandon a thread still holding that lock, and
  `closeAndMarkFinished()` would go on blocking forever exactly as before. Nothing is bought at
  the append; the wedge reaches the lock whatever the append does. The containing bound belongs
  one layer out, at teardown, and both files already had one (`CaptureSession.stopTimeoutSeconds`
  20 s, `CameraCapture.stopTimeoutSeconds` 10 s, each answering exactly once). A wedged first
  append therefore costs a take its finalised mp4 and answers `<reason>-timeout` with a
  `stopWarning`; it cannot leave the app holding a recording it is unable to end. The appends also
  run OUTSIDE both objects' own `lock`, so `stats()`, `track()` and `writeSidecars()` still work
  while one is wedged — the timeout path can still produce a complete answer.
  What was actually missing was not a bound but a comparison: those two numbers and the client's
  30 s `DEFAULT_REQUEST_TIMEOUT_MS` are three constants in two languages, and the only thing
  relating them was a comment. `start` got a clearance test after STC-258 bit; `stop` never did.
  `helper/test/stop-bounds.test.ts` asserts the chain, and the camera-shorter-than-display
  ordering is load-bearing, not incidental: `CaptureSession.stop()` waits on a DispatchGroup the
  camera teardown is entered into, so reversing them makes the display side report
  `<reason>-timeout` for a camera that was about to answer cleanly — a diagnostic that lies.

- **A harness gets a DEADLINE handed down by its runner, not a sum of its own bounds.** Adding the
  append bound would have made the writer-gate harness's worst case 15+15+15 = exactly
  HARNESS_RUN_MS, which is the "inner bound set equal to the outer one" trap already in this file.
  A summed model was the alternative and it rots — it had already rotted twice for the gates. So
  `_swift-harness.ts` now hands every harness `STC_HARNESS_DEADLINE_MS` (= `runMs` minus a
  5 s exit margin), `bounded()` CLAMPS each wait to the budget remaining, and a watchdog thread
  fires at the deadline naming the last checkpoint reached. The runner's mute "did not finish
  within" kill — the shape of all five STC-259 sightings — is now unreachable in principle rather
  than by arithmetic. The harness REFUSES to run without being handed the value, and that refusal
  deliberately does not say `ENVIRONMENT:`, so a wiring mistake cannot be retried three times and
  announced as a skip.
  **The race loop's 120 appends stay inline and individually unbounded, on purpose.** The race is
  between the appending thread and the teardown thread; wrapping the append would insert a third
  thread and a dispatch of unknown latency between them — the one edit that could quietly stop
  this harness reproducing STC-254 while still passing every assertion. The watchdog covers them
  instead. Verified by mutation, not by argument: with the lock-across-append removed, the harness
  still dies SIGSEGV in race iteration 0, three runs out of three.
  **`HARNESS_RUN_MS - deadline >= HARNESS_EXIT_MARGIN_MS` is a TAUTOLOGY** while the deadline is
  defined as that subtraction — it stays green with the margin set to zero, at which point the
  harness's explanation always loses the race. Same shape as #42's vacuous repair and the PiP test
  that passed with the compositor removed. The falsifiable version compares the margin against
  what it must COVER: 26 ms of measured overshoot (runner-observed process lifetime minus the
  deadline handed in — spawn, Swift runtime init, print and `_exit`; worst of 8 runs) times a
  stated 20x CI allowance. Five mutations watched failing before any of this was believed.

- **The camera-to-display sync number is 65 ms, and `scratch/avsync.cjs` is NOT how you get it.**
  That script measures camera-to-MIC from a clap and needs a `mic.wav` this project does not
  produce; a handoff pointed at it for this measurement and was wrong. The camera faces the user,
  so the shared event is a full-screen FLASH — recorded directly in `display.mp4`, seen as
  reflected room light in `camera.mp4`, both on the same mach clock.
  `scripts/flash-for-sync.mjs` while capturing, then `scripts/measure-camera-sync.mjs <take>`.
  Measured 2026-08-29: FaceTime HD at 30 fps lags a 4K display track by 65 ms, r=0.895. The
  resolution floor is the camera's own frame interval (33.4 ms), so it is 65 +/- ~33, not 65.0.
- **Correlate the whole signal; do not pair edges.** The first version of the sync measurement
  found 5 luminance steps in the display and 1 in the camera, paired them by index and reported
  **-1233 ms** — the camera seeing a flash before the screen showed it, which is not a measurement
  but a bug with a decimal point. Auto-exposure ramps rather than steps, and one spurious
  transition shifts every later pair. Cross-correlation survives different frame rates, different
  brightness scales and an extra transition, and it reports how far its peak stands above
  unrelated lags so a weak answer can be refused instead of printed.
- **Screen Recording TCC for the DEV app depends on how it was launched, and I got this wrong.**
  Driving Electron from Playwright, capture is denied and no entry ever appears in System Settings:
  the responsible process is the launching shell, not `Electron.app`, so there is nothing for the
  user to grant. Launched normally with `npm run app:start`, macOS attributes the request to
  Electron, prompts, and the grant sticks — verified 2026-08-30 by recording a real camera take
  from the app. I told the user granting Electron "wouldn't reliably help"; that was true of the
  automated path only and wrong as stated.
  The dev `Electron.app` is ad-hoc signed (`TeamIdentifier=not set`), so per the signing trap above
  the grant is fragile across reinstalls. `tools/test-host` remains the stable-identity bundle for
  permission work.

- **Two functions with the SAME NAME and DIFFERENT rules is the two-copies defect inverted, and
  much harder to see (STC-314).** `roundRect` existed in `app/src/selection.ts` and (as of this
  ticket) in `transform/src/spaces.ts`, and they disagreed by a pixel: selection's snapped both
  EDGES and let the size follow, which is right for a region someone dragged — round the size
  instead and a rounded origin pushes the far edge off the thing they were framing. spaces.ts's
  rounds each component, which is right for placing something of a known size, like the PiP's
  decoded frame. Every other defect of this family in this file was caught by the names agreeing
  and being *looked* for; this one was found only because one ticket happened to touch both. They
  are `snapRectEdges` and `roundRect` now, in one module, each documented against the other, and
  `spaces.test.ts` asserts they DISAGREE — otherwise naming them apart is decoration.
- **A UV rect derived from a pixel rule must keep the pixel rule's ROUNDING ORDER (STC-314).**
  Folding the PiP into UV, the obvious form is to normalise the ideal rectangle and round once at
  the end. It is a different answer: the PiP's height has always come from the ROUNDED width, and
  round-once differs by a pixel on some camera aspect ratios — measured, not feared, and the
  committed PiP fixture and `gate:identity` pin the current one. `fixedCornerPipUv` therefore
  derives UV from the pixel rule rather than the other way round, and `spaces.test.ts` sweeps 864
  combinations against the original inline formula plus a control proving round-once really does
  disagree somewhere. A comment claiming an order matters, with no test that the other order
  differs, is decoration.
- **A structural grep must let a file name the rule in a MESSAGE, not just in a comment
  (STC-314).** `spaces-seam.test.ts` blanks comments before scanning — the lesson
  `library-seam.test.ts` already recorded — and still cried wolf on its first run, against
  `shot.ts`'s `throw new ShotLoadError("display.originX/originY must be numbers")`. Inside a
  string, `.originX/originY` is indistinguishable from a division. An error message naming a
  field is exactly as legitimate as a comment naming it, and arithmetic never lives in a string,
  so string literals are blanked too — it costs the guard nothing and buys it the right not to be
  turned off. The guard was then watched FAILING against the real pre-STC-314 `render.ts` line,
  which is a different claim from passing.
- **A grep-based seam guard is worth having only where the pattern is unambiguous, and where it
  is not, say so out loud (STC-314).** The event space is grepped: display geometry next to an
  arithmetic operator is a conversion and nothing else. UV is NOT, and that is recorded in the
  test rather than hidden — `* content.width` is also how you centre a rect, take an aspect ratio,
  find a midpoint, size an ellipse and fit a preview into a box, and `still-render.ts`,
  `overlay.ts` and `thumbnail-renderer.ts` are full of legitimate ones. A pattern matching those
  would be turned off within a day. Half a guard that nobody disables beats a whole one that
  everybody does.
- **A ticket's estimate can rest on a belief about the DATA, and that is the expensive kind of wrong
  (STC-325).** The ticket said *"Keystrokes count as events — this is the amendment's half that costs
  nothing. `events.json` already carries them."* Both sentences were false: `events-2` has three
  kinds (move, down/up, cursor) and the tap's mask is mouse-only, so nothing has ever recorded a
  keypress. It is also the opposite of free — a `keyDown` tap needs a permission class STC-292
  verified the app has never required, plus events-3, plus a decision about storing what someone
  typed. Second time in two days a ticket was scoped from a false premise about existing data; the
  first was STC-314's "crop-UV does not exist". Both were found by checking the claim against the
  schema before building on it, which took a minute in each case. Split as STC-327; the correction
  is a dated note on STC-325 rather than a rewrite.
- **"Changes no pixels" is worth having BY CONSTRUCTION rather than by measurement (STC-325).**
  Stage 1 is in the render path with the crop stubbed to the whole frame. The obvious wiring is a
  nine-argument `drawImage` with a full source rect, which is equivalent to the five-argument form
  BY SPEC — and this repo does not make claims about rasterisers it does not control, having
  already measured the pre-encode hash differing between GPU and swiftshader for far simpler
  drawing. So `composite` keeps the five-argument call when the crop is the whole frame and takes
  the nine-argument one only when it is not; the drawing operations are then identical to before on
  every rasteriser, and no gate run is needed to believe it. The full-frame assertion alone is
  ALSO satisfied by a compositor that ignores the crop entirely — the exact bug that would make
  STC-326 look wired up while drawing the whole frame — so the control asserting the two paths
  differ is the load-bearing half.
- **The gates cannot run on this Linux box, and the reason is the codec (STC-325).** Established by
  trying, not by inferring: the gates launch `channel: "chrome"` and no system Chrome is installed;
  `npx playwright install chrome` is refused by the proxy (403 CONNECT on `dl.google.com`); and the
  bundled Chromium at `/opt/pw-browsers/` runs but dies with `NotSupportedError: H.264 decoding is
  not supported`, which is the codec the sinks require and why ci.yml uses real Chrome. That last
  one prints `IDENTITY GATE: FAIL` and reporting it as a gate result would be this file's own
  "a measurement that could not see what it was being read as evidence about". CI is the first
  real run for any gate change made here.
- **A schema version is a property of the WRITE, not a constraint on the READ (STC-295).** Minting
  `shot-2` for `decoration.annotations`, the first rule tried was the strict one: a v1 document may
  not carry the key at all, matching shot-1's `additionalProperties: false`. It broke immediately
  and instructively. `Decoration` always carries the array IN MEMORY — so no consumer has to tell
  "no annotations" from "an older document" — which means a stored v1 shot that has been parsed,
  had one field changed and been handed back now has the key, and `still:writeShot` does exactly
  that on every shot. A strict read refuses a document for a key the caller never asked for.
  The rule that works: the loader accepts an EMPTY array at any version (it says nothing v2-only)
  and refuses a NON-empty one at v1 (that document claims a version and then uses a feature it does
  not have). What keeps shot-1 documents clean is `shotForWrite`, which emits the MINIMUM version
  that can express the document and strips the key at v1 — and which was not previously the write
  path at all: `still:writeShot` serialised `parseShot`'s output directly, so it would have written
  `annotations: []` into a v1 document that fails its own schema. Nothing in the app called
  `shotForWrite`; only tests did. A funnel nothing goes through is not a funnel.
  NB `shotForWrite` returns a `ShotDocument`, not a `Shot`, and the distinction is real rather than
  bookkeeping: in memory the array is always there, on disk it must not be.
- **A local test config that is MORE PERMISSIVE than CI hides failures rather than merely missing
  them (STC-294/295).** Twice in two tickets. `vitest.global-setup.ts` builds the Swift helper and
  dies without `swiftc`, so running anything locally needs a throwaway config — and a throwaway
  config is a place to quietly disagree with the real one. First: `git stash` + re-run with no
  `globalSetup` never rebuilds `app/dist/`, and Electron loads the BUILD, so the "baseline" ran the
  UNSTASHED app against the stashed tests; it reported a failure on a different line in each arm,
  which is the only reason it was caught. Second: the throwaway config set `testTimeout: 90_000`
  while `vitest.config.ts`'s e2e project uses 15_000, so nine new E2E tests with NO explicit
  timeout passed locally and three of them timed out on CI. Every other E2E file in the repo passes
  an explicit `}, 60_000)`; the new one did not, and the permissive local config is what made that
  invisible. Pin a throwaway config to the REAL numbers and rebuild before any baseline.
- **A structural guard must be able to fire, must not fire on legitimate code, and must let a file
  DISCUSS the rule it keeps (STC-294).** The ticket's fourth acceptance criterion — "no view
  component branches on kind" — is not checkable behaviourally: a view saying
  `if (item.kind === "still")` draws exactly the right pixels and passes every E2E. So it is
  grepped, and getting the grep right took three corrections, each a different failure mode.
  (1) Grepping `renderer.ts` for `.kind` fires on an UNRELATED one — a capture result's shot kind
  (`display-crop`/`window`) in the status line. A guard that cries wolf is a guard someone turns
  off, so the library's view is its own module (`library-view.ts`) that may never mention kind at
  all, and the grep is exact. That is not a trick to satisfy a test: if the view can be written
  without knowing what kinds exist, the seam really is in one place.
  (2) The view module EXPLAINS the rule it keeps, so its own doc comment contains `.kind` and the
  guard flagged it. Comments are blanked before scanning.
  (3) The controls matter more than the assertion. `expect(found).toEqual([])` is satisfied just as
  well by a pattern that matches NOTHING, so the test asserts its patterns catch four lines that
  should leak and leave five alone — and the whole guard was watched failing against a leak planted
  in the real view file, not only against synthetic strings.
  A related design point, because it nearly got away: "filters by kind" is a scope bullet whose
  obvious implementation is `items.filter((i) => i.kind === sel)` in the renderer, which is exactly
  the branch the criterion forbids, arrived at by doing what the ticket asked for. The filter is in
  the adapter, and the view renders chips from data.
- **A new file under `app/src/` inherits the no-DOM typecheck and must opt OUT — and the browser
  pass follows a type-only import (STC-294).** Both halves bit within a minute of each other.
  `library-view.ts` is renderer code and failed `tsconfig.node.json` with 10x TS2304 until it was
  added to the carve-out, which is the fail-safe direction working as designed. Then
  `renderer.ts` did `import type { LibraryItem } from "./library.js"` — erased at build, so the
  bundle was fine — and `tsconfig.browser.json` correctly typechecked the whole node module and
  reported `Cannot find name 'node:fs/promises'`. That is what forced `library-items.ts` (pure
  contract) apart from `library.ts` (the scan), which is the split this repo already uses
  everywhere — `selection.ts`/`overlay-session.ts`, `thumbnail.ts`/`thumbnail-window.ts`. The
  typecheck produced a better structure than the comment asking people to be careful would have.
- **The Electron E2E suite RUNS on this Linux box under `xvfb-run`, and the blocker was never the
  display (STC-294).** `vitest.global-setup.ts` builds the Swift helper, which needs `swiftc`, so
  `npm test` dies before any test runs and E2E has been treated as CI-only from a Linux checkout.
  A throwaway config with the `@transform` alias and no `globalSetup`, run under
  `xvfb-run -a`, launches Electron for real: `app/test/library.e2e.test.ts` was developed against
  it and caught a wrong assertion of mine before CI ever saw the branch. Without a display Electron
  dies with `The platform failed to initialize` and Playwright reports a launch failure, which
  reads like a Playwright problem and is not.
  It is not a substitute for CI and THREE FILES CANNOT PASS HERE, measured rather than assumed:
  `shell.e2e.test.ts` and `frame-png.e2e.test.ts` launch with no `STC_HELPER_BIN` and so want the
  real Swift binary (identical failures with and without a change under test), and
  `manage.e2e.test.ts`'s delete test asserts the take landed in `~/.Trash`, which is a macOS path —
  on Linux `shell.trashItem` uses `~/.local/share/Trash`. Everything else passed: 73 of 83 on the
  first full run, and the 10 failures were those three files plus two assertions of MINE that
  needed updating. Know which is which before believing a red one.
  **Baseline it with a REBUILD or the comparison is worthless.** A throwaway config has no
  `globalSetup`, so nothing rebuilds `app/dist/` — and Electron loads the BUILD, not the sources.
  A `git stash` + re-run therefore tests the stashed TESTS against the UNSTASHED APP, which is not
  a baseline of anything. It reported `manage.e2e` failing at a different line in each arm, which
  is the only reason the mistake was caught rather than believed; with `node app/build.mjs` between
  the stash and the run, both arms failed identically and the failure was correctly identified as
  pre-existing.
- **`shot.crop` is PROVENANCE, not a re-crop dial — writing to it moves the cursor and rescales the
  export (STC-300 audit).** It records which region of which display the pixels came from, and
  ScreenCaptureKit already applied it (`cfg.sourceRect` in `Still.swift`), so `frame.png` holds
  only that region. In the transform `layoutStill` sizes the content from `shot.frame.width/height`
  and never from `crop`; `crop` is read in exactly two places — `cursorLayout` (moving the pointer
  into the crop's frame) and `pxPerPointOf` (`frame.width / crop.width`, which `still-export.ts`'s
  `scaleFactor` then depends on for what a 1x export means). So an editor that wrote a tighter
  `crop` expecting a tighter picture would get an unmoved picture with a displaced pointer, a
  rescaled shadow and a different 1x output resolution: a correctly-rendered wrong answer, which is
  the worst kind. A real re-crop is a NEW field — normalised over the frame like
  `decoration.redactions`, so it moves with the content — and it can only ever SHRINK, because the
  pixels outside the captured region were never taken. Full reasoning, and the six inspector
  parameters that ARE already in the document, in `docs/STC-300-FORMAT-AUDIT.md`.
- **A filename built in one process and looked for in another is the "one value, two copies"
  defect with a process boundary hiding it (STC-242).** `renderer.ts` built the export's name as an
  inline template literal — `` `export-${openTakeName}.mp4` `` — and STC-242's publish path, in the
  MAIN process, has to find that exact file afterwards. Two authors for one filename rule, and no
  typecheck can see the pair because neither side names the other. That is the fifth instance of
  this defect in this file, and the first where the copies are not even in the same process.
  Both names live in `share.ts` now and `share.test.ts` GREPS the renderer, because a test that
  only checked `exportMediaName` would pass just as well with the literal back where it was. The
  grep is exact rather than hopeful, verified in both directions: **0 matches on the clean file,
  exactly 1 with the literal planted back**. Comments are blanked before scanning, so the file may
  DISCUSS the rule it keeps (STC-294's lesson, met again).

- **A test can fail on a selector that could never have matched, and it reads as a product fault
  (STC-242).** All seven share E2E tests failed on `waitForSelector("#share")` timing out at 30 s.
  Nothing was wrong with the code: the share row lives inside `<div id="player" hidden>`, so the
  button is ATTACHED but never VISIBLE, and `waitForSelector` waits for visible by default.
  Reordering would not have fixed it either — these tests deliberately drive `window.recorder`
  rather than clicking (STC-292: a UI-driven test only ever reaches the first refusal it meets), so
  the renderer's own open path never runs and the panel never unhides. A visibility wait could not
  pass in ANY order. `{ state: "attached" }` is the fix, and it is what the wait was for in the
  first place: proof the preload is in place before the first `evaluate`.
  **The green run then wanted disbelieving too**: 4.5 s for seven Electron launches is fast enough
  to be the "success by finding nothing to do" trap. It was real — the verbose run shows all seven
  at ~500 ms with none skipped, and a MUTATION (publish under the take's name instead of the slug)
  fails exactly the two tests asserting that property and correctly leaves the other five green.
  These tests are fast because they wait on nothing; the slow E2E files here poll on panel
  timeouts and file appearance.

- **This box cannot attribute a full-suite failure, and CI is the instrument that can (STC-242).**
  A local run including `helper/test/**` reported 75 failures and I could not say which were mine:
  those tests need `swiftc`, which is why `vitest.global-setup.ts` dies here and why every local
  run needs a throwaway config. Two attempts to build one failed in different ways — deleting it
  before vitest had READ it (it worked once, so I generalised from a single instance), then putting
  it outside the repo where `vitest/config` will not resolve. The answer was not a third throwaway
  config: the PR's CI runs `npm test` on macOS with a real toolchain, went green, and settled the
  attribution in one step. When a local environment structurally cannot run a check, reach for the
  one that can rather than engineering around the gap.

- **An overlay that hides itself is still in the photograph, sometimes (STC-290).** `BrowserWindow
  .hide()` and a `SCScreenshotManager` capture reach the window server down different paths with no
  ordering between them, so "hide, then capture" is a race — and the one time it loses is the one
  time the user sees the dimming baked into their screenshot. The fix is both belts: the windows are
  hidden AND their CGWindowIDs go to `capture-still`'s `excludeWindowIds`, which the display filter
  drops. Window shots need neither, because `desktopIndependentWindow` contains exactly one window.
  Electron names a window as `"window:12345:0"` via `getMediaSourceId()`, and on macOS that number
  is the CGWindowID the helper matches against.

- **A per-window state machine cannot track a drag across a bezel (STC-290).** The window under the
  pointer changes mid-gesture, and neither half knows about the other, so the marquee stops at the
  edge. The overlay is therefore one state in the MAIN process and N dumb views — which also puts
  the whole interaction in a pure function that runs without a display server.

- **A macOS 14+ class the 13.3 SDK cannot name is still callable — by name, through the runtime
  (STC-289).** `SCScreenshotManager` has no header in the SDK `helper/build.sh` compiles against, and
  the ticket's first note concluded that meant waiting for Xcode. It does not: the class exists on
  the running OS, `NSClassFromString` finds it, and `class_getClassMethod` + `unsafeBitCast` to a
  `@convention(c)` type calls the one class method with a real block — `ScreenshotAPI` in
  `Still.swift`. It is the same family as the `captureResolution` KVC in `Capture.swift`, one step
  further. The cost is stated where the code is: a misspelt selector is `still-unsupported` at
  RUNTIME, not a compile error, so `ScreenshotAPI.available` checks class AND selector before any
  request, and `still.grant.test.ts` is the only thing that proves the call. The 14+ configuration
  knobs a still needs (`ignoreShadowsSingleWindow`, `shouldBeOpaque`) go through KVC guarded by
  `responds(to:)`, and the reply reports whether each was taken rather than assuming.
  NB `captureResolution` in `Capture.swift` is set to 3; `SCCaptureResolutionType` is
  automatic 0 / best 1 / nominal 2. Explicit width/height govern, so it has never mattered — the
  still path sets 1. Not changed in the recording path here; it is not this ticket's.

- **Padding expressed as a percentage cannot hold a shadow expressed in points, and the gate found
  it on its first run (STC-291).** The preset padding is a fraction of the capture's short edge —
  right, because a 1x and a 2x capture of the same window must look the same — and the preset
  shadow is 48 blur / 18 offset in points. On a small capture the percentage loses: 6% of a 320 px
  edge is 19 px against a shadow reaching ~90, so the shadow was CLIPPED against the canvas edge,
  which does not look like a bug, it looks like a hard grey band someone chose. `paddingPixels`
  now takes the max of the requested percentage and `shadowReachPixels` (1.5x blur, since Canvas's
  `shadowBlur` is a Gaussian with sigma = blur/2 and is dead by three sigma, plus offset and
  spread). It is a CORRECTNESS floor, not taste: if the result looks too generous the dial is the
  shadow. Measured before and after on the gate's own ray — alpha 40 at the canvas edge over 10
  samples, versus reaching 0 over 45.
  The gate's FIRST failure on that run was my own assertion being wrong, not the code:
  `window-shadow` legitimately has shadow just outside the corner, so "alpha is 0 outside the
  shape" only holds for `window-only`. Two problems in one output, one of them the test's.

- **Golden images were asked for and are the wrong instrument HERE, for a reason this file already
  recorded (STC-291).** The ticket specified golden-image comparison for the decorated still.
  Gradients, blurred shadows and antialiased curves are Skia's output, and the rasterization-backend
  trap above measures this project's pre-encode hashes ALREADY differing between GPU and swiftshader
  for far simpler drawing — so a committed golden is a stored constant across engines the codebase
  does not control, and it goes red on a Chromium bump rather than on a regression. The still gate
  asserts PROPERTIES that hold in any correct rasteriser (alpha zero outside the window's real
  shape, the corner fringe not pulled toward black, the shadow monotonically reaching zero, a
  background with no holes) plus determinism between two renders inside ONE browser, which is the
  same scope every other gate here compares in. The capture it renders is SYNTHESISED in the page
  rather than committed, because the assertions have to name where the corner curve is.

- **`app.dock.hide()` works on a real Mac and NOT on the CI runner — the runner is what is wrong,
  and no bound was ever going to fix it (STC-292).** `dock.isVisible()` stayed `true` there with the
  last window closed — as a single read, then through a full 10 s poll (runs 34243729730 and
  34244375788) — while the window count was zero, the menu-bar item was alive and the shortcuts were
  still registered. WATCHED on hardware 2026-09-08: ⌘W removes the Dock icon, the menu-bar item
  stays. So it is a property of the runner's session, not of this code.
  The route there is the lesson. The first push widened the read into a poll on the theory that
  AppKit applies an activation-policy change asynchronously; the second, identical failure ruled
  that out, and a third bound would have been a slower way of asserting the same false thing. The
  claim moved to `docs/STC-292-RUNBOOK.md` §2 instead, where a person can look at a Dock — and a
  person then did, which is the only reason this is settled. **Do not put the assertion back**: it
  would be red forever for a behaviour that demonstrably works, and the next person would loosen it
  until it passed without meaning anything. The two assertions that ARE the ticket's acceptance
  criterion (no window, still running, still bound) stayed in the E2E and pass. A green tick bought
  by loosening an assertion is worth less than a red one that named something true — and a claim an
  automated environment cannot see is worth more in a runbook than in a test.

- **A list of constants written in the reader's order is compared in the CODE's order, and the
  mismatch is silent (STC-292).** `SYSTEM_CLAIMED` holds the macOS bindings the app refuses, and it
  reads the way Apple writes them — `Command+Shift+4`. The canonical order `parseAccelerator`
  produces is Control, Alt, Shift, Command, so the literal entries matched NOTHING: every system
  screenshot binding was quietly accepted, and the acceptance criterion "rejects bindings already
  claimed by the system" was false while looking implemented. Caught by the test on its first run,
  not by reading the code. The list is normalised at load now, through the grammar with the reserved
  check lifted out so it cannot recurse — and a typo in it THROWS at startup rather than becoming an
  entry that silently never matches. Same family as every "one value, two copies" defect in this
  file, with the second copy being an ordering convention rather than a number.

- **A renderer-side guard can shadow the main-side one, and the E2E will not notice (STC-292).**
  `shortcuts:set` refuses a reserved binding before storing anything, and the preferences field
  refuses it too so the UI never briefly shows it as accepted. Both are wanted; the trap is that the
  UI test can only ever reach the first refusal it meets. With `shortcuts:set`'s own check disabled,
  the UI-driven test still passed — the renderer had already declined and main was never called.
  Proven by mutation, and the fix is a second test that goes straight at the IPC through the preload
  (`recorder.setShortcut(...)`), which fails with the guard removed and passes with it. Any time a
  check exists at two layers, the outer one needs a test that cannot be satisfied by the inner.

- **`skipIf(platform !== "darwin")` is the skip this repo already warns about, unless the BEHAVIOUR
  is platform-specific (STC-292).** `shutter.ts` originally read `process.platform` directly, which
  made four of its tests unrunnable on a Linux checkout — a skip that reads as covered and rots,
  exactly what the `*.grant.test.ts` split exists to avoid. The platform is an injected dependency
  now and all fifteen run everywhere, including the "off macOS it is suppressed" case. The one
  remaining platform skip is legitimate and says so: `window-all-closed` quits on non-darwin BY
  DESIGN, so there is no menu-bar-first survival to check on Linux rather than an unchecked one —
  and its notice goes to `process.stderr`, because vitest discards `console.*` from a skipped test.

- **A colour profile is NOT metadata, and one switch must not govern both (STC-293).** The ticket
  asks for an optional metadata strip "since a shot of a screen can carry the display's colour
  profile and a capture timestamp", which reads as one feature and is two. The TIMESTAMP is
  metadata: it says when the user was at their desk and wanting it gone before sending a screenshot
  to a stranger is reasonable. The PROFILE is what makes the numbers mean colours — strip it from a
  Display P3 capture and every viewer falls back to sRGB, which is a visible shift and is exactly
  what the same ticket's "round trip through PNG preserves the wide-gamut colours ... without a
  visible shift" forbids. So `stripMetadata` governs the timestamp and the profile is embedded on
  every path, stripped or not. Two tests pin it, one either side of the process line.
  There is also nothing to REMOVE: the pixels reach the encoder as raw RGBA with no container, so
  the strip is "do not add" rather than a filtering pass that might miss a field — the one version
  of this feature that cannot be incomplete.

- **A canvas cannot be the encoder here, and `toBlob` being one line is the trap (STC-293).**
  `canvas.toBlob("image/png")` is the obvious way to get a composited still onto disk and it fails
  three of the ticket's requirements at once: it cannot write HEIC at all, it gives no control over
  the embedded ICC profile (so the P3 acceptance criterion is unreachable), and it has no way to
  attach or withhold a capture timestamp. ImageIO does all three. The cost is that 33 MB of RGBA
  for a 4K still has to cross into the helper, which it does as a temp FILE rather than inline in
  a JSON line — fd3 is deliberately for small reliable messages, and a still exported during a
  recording must not be able to delay that take's `stop`.
  `PreviewPlayer.captureFrame` used to return an encoded PNG for exactly this reason and now
  returns pixels; STC-298's copy/save were the second encoder the ticket's Note forbids.

- **`getImageData` is UNPREMULTIPLIED and `CGImage` may or may not take that layout (STC-293).**
  The canvas spec says straight alpha; `CGImage` documents `kCGImageAlphaLast` as valid (it is
  `CGBitmapContext` that refuses it). Both are true and neither could be checked from the Linux
  machine this was written on, which is precisely where a confident single path becomes a nil
  return on someone else's Mac. `StillEncode.makeImage` asks for `.last` first and falls back to
  premultiplying the buffer and retrying with `.premultipliedLast`, and the REPLY says which it
  took (`premultiplied`) rather than the runbook assuming. The premultiply rounds
  (`(c * a + 127) / 255`) — truncating darkens every partially transparent pixel by up to one
  level, which along a window's antialiased corner is the dark fringe the whole still path exists
  to avoid.

- **"Say what will happen" means a fork the export WAITS on, not a warning after the fact
  (STC-293).** A JPEG cannot carry alpha, and every encoder's default answer is to fill black —
  which on a window shot with a shadow looks like a rendering fault rather than a format limit,
  with no way for the user to tell which. So `flattenPlan` returns a `conflict` that the export
  path may not act on: the UI has to put "flatten onto a colour" and "use PNG instead" to the user
  and come back with one. `stillIsBlocked` is the one-liner so no caller has to remember which plan
  kinds are actionable, and the default offered colour is WHITE — a default of black would satisfy
  the letter of the requirement and none of its point.

- **A file URL, not a file promise, and the process model is why (STC-293).** The ticket asks for
  "a file URL promise so a drag into Finder or a Slack upload gets a real file".
  `NSFilePromiseProvider` needs a live provider object to answer the receiver's callback at paste
  time, and the helper has answered its request and gone idle by then — a promise nobody answers
  hands the receiver a ZERO-BYTE file, which is worse than offering nothing. So a copy writes a
  real file first and puts its URL on the pasteboard. The user-visible behaviour is the one asked
  for; the mechanism is the one that survives.
  That file goes to a CACHE directory, never the user's shots folder: someone who pressed Copy did
  not ask for a file, and one appearing on every paste is the app inventing tidying-up for them.

- **Nothing in the still path resamples the capture, and that is load-bearing rather than tidy
  (STC-291).** Canvas presets grow the canvas around the frame; padding grows the canvas around the
  frame; the frame is always drawn at its natural pixel size. Resampling a premultiplied image with
  a hard alpha edge is exactly how a dark fringe appears at a window's rounded corner, and the
  cheapest way not to have one is not to resample. For the same reason the corners are never
  synthesised: a window capture arrives WITH its real corners as alpha (`desktopIndependentWindow`,
  STC-289) and the shadow is cast from that same alpha, so a re-derived radius would throw away the
  fidelity window mode exists for. A canvas preset also only ever GROWS — a 16:9 preset that shaved
  the top off a window would be a decoration silently destroying the thing being decorated.

- **An E2E that injects input must be the ONLY thing injecting input, and the overlay was not
  (STC-290).** `still-overlay.e2e.test.ts` drives the overlay through `window.overlay.send`, and
  the view's own DOM handlers call that SAME bridge — so the window server was a second writer
  into one state machine. A real `pointermove` at whatever coordinate the cursor happens to
  occupy, landing between an injected move and its pointerup, rewrites the marquee mid-gesture.
  Reproduced under Xvfb as a crop **540 wide instead of 200**, where 540 is exactly the distance
  from the drag's anchor to the centre of a 1280-wide screen — the parked cursor. The arithmetic
  is what identified it; "flaky E2E" would not have.
  On CI it landed the other way and was far less legible: the polluted rect confirmed to NOTHING,
  and `reduce` treats an unconfirmable Return as a **no-op**, so the overlay never settled,
  `still:capture` never answered, and the assertion read `expected '' to contain 'macOS 14'`
  fifteen seconds later with no error anywhere. It reddened master runs #209 and #213 — two of the
  four master pushes after it landed — while passing every PR run, which is precisely the
  "reddens PRs at random" failure this repo already paid for with `ring-overflow`.
  The fix is `STC_OVERLAY_SYNTHETIC_INPUT=1` → `?synthetic=1` → the view does not install its real
  listeners. **Measured over 12 runs each, identical code but for the flag: 3 failures without,
  0 with.** Nothing is lost: the E2E already called the bridge directly, so those handlers were
  never covered by it. The chain spans three files and `app/test/overlay-listeners.test.ts` holds
  it together, because dropping the env var reintroduces the flake and nothing else would notice.
  NB the E2E now asserts the marquee is CONFIRMABLE (the `#size` chip, which is drawn from
  `confirm()`'s own result) before pressing Return, and reports the overlay's state when it is
  not. A test that presses Return on a hope reports an empty string when the hope fails.

- **`confirm()` returning undefined is a HANG, not "no outcome yet" (STC-290).** `reduce` makes an
  unconfirmable Return a no-op, `openOverlay`'s promise is settled only by an outcome, and
  `still:capture` awaits it — so any of `confirm()`'s five refusals strands the whole still path
  forever, with the app politely waiting for a selection the user already made. A human can still
  press Escape; an automated caller cannot. `OverlaySession` now keeps its display list LIVE
  (`screen.on("display-added"/"display-removed"/"display-metrics-changed")`) so a context snapshot
  taken before the window server settled cannot be the cause. **This was the first hypothesis for
  the flake above and turned out NOT to be it** — it is a separate latent fault, fixed on its own
  merits and not verified on hardware.

- **A feature can make a LATENT hazard reachable, and both of STC-296's follow-up bugs were that
  shape (2026-09-08).** Neither was introduced by the change that exposed it; both had been sitting
  in the code unreachable, and building the next feature is what handed them a path. When a change
  makes something possible that was not possible before — a second panel, a second concurrent
  export — the question is not only "does the new thing work" but "what did the OLD code rely on
  being impossible".
  **(1) A settle before the first composite exported NOTHING, silently.** `onSettle` is registered
  before the async load that reads `frame.png`, decodes it and calls `draw()`, and `composite` is
  only assigned inside `draw()`. A settle arriving during those awaits reached `runExport`, hit its
  `if (!composite)` guard, and the `finally` fired `done` — the window destroyed having written
  nothing and said nothing. The take directory still held `shot.json` and `frame.png`, so it looked
  fine; only the decorated file the panel promised was missing, which is the acceptance criterion
  "there is no path where a capture is silently lost".
  The way in is a SECOND CAPTURE while the first panel is still loading, since `presentThumbnail`
  settles the outgoing one. The timeout path was never exposed, because its timer is armed on
  `painted` — after the first draw. That asymmetry is why it survived: **the case anyone would
  test is the safe one.** `settle()` waits for the first composite now, bounded by
  `SETTLE_READY_MS`, which MUST clear `SETTLE_BACKSTOP_MS` or the window is destroyed before the
  wait can finish — `app/test/thumbnail-bounds.test.ts` asserts that clearance, reading the
  backstop out of `thumbnail-window.ts`'s SOURCE rather than restating it (importing that module
  pulls in electron, and a third copy of the number is the drift the test prevents).
  **(2) Two exports in the same second collided on ONE filename.** `namesIn` lists the destination
  BEFORE the encode and the file appears AFTER it, so between those moments the name exists
  nowhere: two exports overlapping in that window both render the same stem from
  `{app} {date} at {time}` and one silently overwrites the other. `still-io.ts`'s own comment
  already named the hazard — "a counter derived from a listing is correct only until two exports
  race" — and it had no way to happen while one panel meant one settle. STACKING is the first thing
  in this app that can export twice at once. Names are CLAIMED for the duration of an export now
  and released in the same `finally` as the scratch file; in-process only, and the comment says so,
  because a cross-process guarantee needs the helper to create the file exclusively.
  Found by REWRITING a test rather than by reading: the old E2E proved "the outgoing shot is not
  lost" via the REPLACEMENT settling it, so once stacking removed replacement that property had to
  be re-tested as each panel keeping its own clock — and the new test asked for two files and got
  one. Reproduced at the UNIT level (two concurrent `exportStill` calls, same `at`) before anything
  was fixed, which is where it stays proved without an Electron run.

- **An E2E asserting the OLD contract is a finding, not a test to loosen (STC-296).**
  `thumbnail.e2e.test.ts` required exactly ONE panel window after a second capture, and stacking
  deliberately leaves two. The tempting repair is to relax the count; the right one is to state the
  new contract — two panels, the first still among them — because the assertion was never about a
  number, it was about replacement being the behaviour. Its own comment had even anticipated the
  change ("even though stacking itself is deferred"). Relaxing it would have kept the suite green
  and thrown away the split that found the filename race.

- **TWO SESSIONS BUILT STC-325 IN PARALLEL, TWICE IN ONE AFTERNOON, and the section that would have
  caught it had been deleted that morning (2026-09-09).** PR #111 implemented the same ticket
  independently and opened seven minutes before #108 merged; the merge left it conflicted against a
  branch that had none of its work. Then it happened AGAIN while the first collision was being
  cleaned up: a port of #111's extras was being written here at the same moment #112 landed the
  same thing on master from the other session, and the port was thrown away half an hour after it
  typechecked green. Nothing malfunctioned either time — each session had a locked ticket and a
  clear plan, and neither looked at the other's open PRs.
  CLAUDE.md carried an "Open PR from another agent" section for exactly this hazard, and #109
  retired it the same morning as unused. It was unused because nothing had collided YET.
  **BEFORE STARTING A TICKET, AND AGAIN BEFORE PUSHING, LIST THE REPO'S OPEN PRS AND ITS RECENT
  MASTER COMMITS.** `list_pull_requests` and a `git fetch origin master` cost one call each, and a
  ticket key or a slug in a branch name is the whole check. The second look is the one that would
  have saved the wasted port: a branch reset from master an hour ago is not a branch that knows
  what master says now. A ticket sitting in the "Next up" table is not evidence nobody is on it —
  that table is updated after a merge, which is the last moment it can help.
  What the first collision cost was not the duplicate work. It was that the SECOND implementation
  had three things the first did not — a per-easing sim cache key, `defaultProject`/`parseProject`
  agreeing on shape, and the `project-4` document at all — so the merged branch was the weaker of
  the two, and two of those three were real defects in what had already landed. Reviewing a
  conflicted duplicate PR for what it got RIGHT is worth more than closing it unread.
  It also produced one genuine design disagreement rather than a merge conflict — whether a long
  drag is one window or two — recorded in `zoom.ts` as an open question for STC-313's take, because
  a race between two branches is not a way to decide it.

- **A failure that must be ANSWERED cannot be discovered on a thread the answer has already left
  (STC-315).** `CGEvent.tapCreate` was called inside the tap's own `Thread`, which is the right
  place to RUN a tap and the wrong place to learn it could not be made: by the time that thread
  ran, `begin()` had gone on to start the stream and `finishStart(.success)` had answered. The
  only report left was a warning about a take already underway — which is exactly the shape the
  old behaviour had, and why "warn and record video only" was not a policy anybody chose so much
  as the only thing that arrangement could do. The fix is not a semaphore or a bound: `tapCreate`
  fails SYNCHRONOUSLY, and nothing about a tap depends on which thread created it — the run loop
  the source is added to is what decides where the callback lands. So creation moved to the
  caller and the thread kept only the running. **Before adding a wait to hear back from a
  thread, check whether the failing call needed that thread at all.**

- **The refusal's PLACEMENT is load-bearing in both directions, and each direction breaks a
  different thing (STC-315).** Too late — after `setupWriter()` — and the take directory holds a
  display.mp4 with frames in it, at which point `App.removeIfNothingWorthKeeping` correctly
  declines to delete it and the acceptance criterion ("no take directory can exist without a
  cursor track") is false while every test still passes. Too early — before
  `SCShareableContent` — and it displaces `no-displays` as the first answer on every machine
  without a Screen Recording grant, which is every CI run: `capture.test.ts`'s display-not-found
  test, `ipc.test.ts`'s camera-flag test and the whole no-grant suite would then stop at the tap
  and go on passing while exercising nothing they were written for. The window is one statement
  wide, and the cost of the placement that survives is that the refusal is unreachable on CI —
  paid deliberately, with `STC_CAPTURE_FAULT=no-event-tap` and a grant test as the substitute.

- **A second grant needs a second diagnosis, or the first one's message becomes a lie
  (STC-315).** Every capture grant test now needs Input Monitoring as well as Screen Recording,
  because the helper refuses any take it cannot record the cursor for — so a machine whose
  Screen Recording grant is perfect can now fail every one of them. `_start-outcome.ts` existed
  because that file's own predecessor said "no Screen Recording grant" for ANY refusal and was
  wrong on a real Mac; folding `event-tap-unavailable` into `no-grant` would have reproduced
  that defect one grant later, sending someone to a pane they had already ticked. Three
  refusals, three answers, and the test asserts they are told APART rather than only that each
  is recognised.

- **An E2E asserting "the take carries on" was the OLD contract, and the tempting repair was to
  keep it green (STC-315).** `warnings.e2e.test.ts` asserted that a tap warning left the button
  saying Stop — a correct statement of what the app did, and the exact behaviour this ticket
  removes. Relaxing it to "an alert appeared" would have passed and said nothing about the only
  thing that changed. It states the new contract instead (no take, button says Record, the
  recordings root is empty) and was mutation-proven three ways: dropping the renderer's message
  entry, dropping the stand-in's refusal, and setting `recording = true` on the failure path each
  fail exactly that one test of the four. **A fourth mutation deliberately did NOT fail and is
  the more useful finding:** making the stand-in claim `state = "recording"` while still refusing
  changed nothing, because the app takes its recording state from the `start` REPLY and the real
  helper can never be in that state after a refusal. That is CLAUDE.md's own "a test seam that
  fakes state the subject contradicts" from the other side — the mutation was unfalsifiable, not
  the assertion weak.

- **Two halves of one answer, decided in different places, and only one half checkable from here
  (STC-313).** STC-242 splits publishing into a COPY (the file goes wherever the native picker
  points) and a SNIPPET (the path the page will ask for, built by `publicSrc`). The copy is
  correct by construction — the user chose the folder — so every test, every runbook step and
  every hardware check passed while the snippet named `/lab/network/network.mp4`, a path nothing
  would ever serve. The runbook had even NAMED it as the most likely thing to be wrong and written
  down its exact symptom. That is not enough: a documented trap is not immunity to it, and this
  repo has now learnt that twice (see the `Determinism gate DID NOT RUN` fixture-string finding).
  What actually settled it was reading the other repository and loading the URL. **When one half
  of a decision lives in a system this checkout cannot see, no amount of local rigour closes it**
  — the only move is to go and look, and until someone does, say the question is open rather than
  that the tests pass.
  NB the same trip found the snippet's SHAPE was wrong too, in a way no amount of care here would
  have caught: the site renders lab demos from a data module, so the "obviously correct HTML
  whatever wraps it later" default was a tag that must not be pasted onto that page at all.

- **PROJECT-4 WAS UNWRITABLE ON MASTER FOR A DAY, and the comment above the bug had predicted
  it (STC-318).** `main.ts`'s `preview:writeProject` gate hand-listed versions 1-3 while
  `parseProject` accepted 1-4, so a take with a non-default zoom could not be SAVED at all —
  the renderer wrote, main threw, and the setting vanished. Found by accident, from a probe in
  an unrelated debugging session.
  The gate's own comment said it *"cannot share a constant with the transform's"* and recorded
  that the pair had **already drifted once**, when project-2 was minted: main rejected every
  document the renderer wrote and `project.json` silently never appeared. That claim was simply
  untrue — `main.ts` imports from `@transform/*` on three other lines — and documenting a trap
  is again not immunity to it.
  **Nothing could have caught it as it stood.** The unit tests never cross that process line;
  every document the E2E tests happened to write was a v3, because the minimum-version rule
  means only a NON-default setting promotes a document. So the version that could not be saved
  was exactly the version no test produced.
  One list now: `transform/src/project-version.ts`, four lines with no imports. It is its own
  module rather than an export on `trim.ts` because importing `trim.ts` into main drags
  `transform-version.ts` → `cursor-art.ts` and fails `tsconfig.node.json` with `Cannot find name
  'CanvasGradient'` — the no-DOM guard working exactly as designed, and worth recording as the
  reason the file looks over-small.
  `project-version-seam.test.ts` refuses a third copy, and is DELIBERATELY not a repo-wide grep:
  its first draft cried wolf on `session.ts` and `shot.ts`, which chain on ANCHORS and SHOT
  versions — different documents, different lists, both legitimate. It names the two files that
  gate a project document instead, and says so.
  It also asserts `PROJECT_VERSIONS` equals the `schema/project-N.schema.json` files on disk, so
  minting a schema without wiring it fails immediately rather than a day later.

- **A canvas-size assertion cannot tell "the render moved" from "the canvas moved" (STC-318).**
  The viewer's-eye toggle renders the preview at the embed width. The plausible half-fix is to
  resize the canvas and keep calling `render()` with the export's output: the video still fills
  the frame, so it LOOKS right, and only the cursor is wrong — drawn at the export's coordinates
  and the export's `pxPerPoint` into a smaller canvas. **The first version of the E2E passed with
  exactly that mutation in place**, because it only compared `canvas.width`.
  The discriminator is the cursor's position as a FRACTION of the canvas, which is a property of
  the take and must not move with the view size. `fixtures/basic` makes it cheap: the video is a
  flat colour and the cursor is the only near-white thing in the frame, so a centroid over
  near-white pixels locates it in one `getImageData`. The mutation shifts it 2.7x the tolerance;
  a second assertion on the cursor's ink as a fraction of canvas AREA catches the same fault by
  (1728/1232)^2, which is the louder half. Both were watched failing.

- **A canvas-size assertion cannot see what the canvas is DISPLAYED at either, and both bugs it
  hid were live on master for an hour (STC-318, #120).** The entry above records one thing
  `canvas.width` cannot tell; these are two more, found reviewing #117 after it had merged.
  **(1) `captureFrame` sized its buffer from `this.canvas`**, and the viewer's eye shrinks the
  canvas — so with the toggle on, Copy/Save frame wrote a 1232-wide still for a 1728-wide take,
  with no warning and a file that looks entirely plausible until measured. A way of LOOKING must
  not change what comes OUT; the view is dropped for the capture and restored in a `finally`, so
  a failed capture cannot silently turn the toggle off either. The discriminator is not the
  canvas at all — it is the size the helper is actually asked to encode, which
  `STC_FAKE_STILL_LOG` already exposes.
  **(2) `#stage { width: 100% }` stretched the smaller render back to the player column**, so the
  picture appeared at the ORIGINAL size with fewer pixels — which flatters small text instead of
  testing it, the exact inversion of what the toggle is for. Intrinsic size was correct in both
  bugs, which is why every existing assertion passed. `getBoundingClientRect().width` is the one
  that discriminates, and the control matters: asserting it merely CHANGED would pass for any
  resize, so the test also asserts the column width it used to be stretched to.
  The general form, and the reason this is a third entry rather than a footnote: **a canvas has
  three sizes** — what it is rendered at, what it is displayed at, and what is read back out of
  it — and a test naming only the first cannot see a fault in the other two.

- **And then the FIX for that display bug outlived the thing that justified it (STC-318, #123).**
  The CSS pin above is scoped to one player, and nothing cleared it when that player went away:
  close the preview with the toggle on and open any take, and the new player has `viewSize` null
  and a checkbox reading OFF on a canvas still displayed at the old embed width. Measured on a
  1728-point take — 1232 CSS px in a 465 px column, so the picture overflowed the player and
  scrolled, with nothing on screen saying why. The toggle's effect with the toggle off, which is
  the same lie the pin was added to remove.
  Cleared in `closePreview`, because `openPreviewOrThrow` begins with it and it is therefore the
  single choke point every new player passes through — one owner beats two that must agree.
  The lesson is not a fourth thing about canvases, it is about LIFETIMES: **when a fix pins global
  state on behalf of one object, ask what clears it when that object dies**, and put the clear on
  the path everything takes rather than on the paths that happen to set it. Watched failing before
  the fix and mutation-proven after — removing the one line fails exactly one test of eleven.

- **An export reading a LIVE document is a file that disagrees with itself, and disabling the
  controls is the half that rots (STC-337).** `exportSession` destructures `width, height, fps`
  ONCE — the canvas, the muxer and the encoder are all built from that — while `render()` re-reads
  `project.output` on EVERY frame, for the display->output mapping, the output rect and the PiP's
  UV rect. So changing the export size mid-export gives the rest of the file markup computed for
  the new size on a canvas sized for the old, and it still reports "Done". A 50 s demo at the
  measured 1.52x realtime is ~75 s of window to change your mind in.
  The obvious fix is to disable `#outsize` alongside `#export`, and it is only the courtesy half:
  it is correct today and wrong the first time someone adds a fourth control that touches
  `openProject`. The load-bearing fix is that **the export gets its own `structuredClone`**, which
  is immune to controls nobody has written yet — and the manifest is built from that copy too, so
  it describes the file that was actually made rather than whatever the UI holds by the time the
  write lands. Both are in, because a control that silently does nothing is worse than one that
  says it cannot be used.
  The test DEFEATS the disabled attribute on purpose (`sel.disabled = false`, then dispatch), which
  is the only way to reach the snapshot: driving it through the disabled control would prove the
  control and pass with the snapshot removed. It also asserts `#export` was still disabled at the
  moment of the change — otherwise a fast export makes the whole thing vacuous — and that the
  DOCUMENT moved to 1232 while the manifest stayed at 1280, because asserting only the manifest
  would pass if the change had never landed at all.
  NB the first draft used the fixture's own 640x360 and proved nothing: at 640 every preset
  UPSCALES and the change handler correctly refuses those, so the size never changed. The helper's
  own comment had already said so. **A test whose setup is refused by a guard looks exactly like a
  test whose subject works.**

- **`setOutputSize` showed the user a size the document did not have (STC-337).** It mutated
  `openProject.output`, repainted the select and resized the preview BEFORE awaiting the write.
  The handler alerts on failure so it was never silent — but the UI and the picture then showed a
  size `project.json` lacked, and it reverted on the next open with no further word. Persist
  first, roll back and re-throw on failure.
  The test needs a write that REALLY fails, and the seam is already in the preload:
  `recorder.closePreview()` clears main's `openTake` while the renderer's player is untouched, so
  the next `preview:writeProject` refuses with "no take is open" through the actual IPC. A fault
  flag would have tested the flag. `chmod` would have been worse than useless — the container runs
  as root, so it is a no-op locally and only bites on CI, which is a test that lies in the one
  direction nobody checks.
  **Reading immediately after a poll raced TWICE in this one change, and CI caught the second.**
  A poll resolves at one point in a sequence and the assertion is about a LATER one, so the gap is
  invisible on a fast machine and real on a slow one. (1) Persist-first made the document lead the
  picture by a repaint, so an assertion reading the canvas the instant `project.json` appeared
  started racing — caught in a full local run, passing 20/20 in isolation. (2) `runExport` sets
  "Done" and THEN awaits `refreshTakes()`, so the `finally` re-enabling the controls runs one IPC
  round trip after the status a poll was waiting on — passed here, failed on CI.
  Neither was a product fault and neither wanted a product change; both wanted the assertion to
  wait for the thing it is actually about. **Before reading a value straight after `expect.poll`,
  ask whether the polled signal and the asserted one are set at the same point in the code** — if
  there is an `await` between them, poll the second too.
- **A native control can be a SECOND AUTHOR of the state your module owns, and the pure test
  cannot see it (STC-338).** `decideKey` correctly refuses a modifier chord — ⌘→ is the app's,
  not the scrubber's — and the playhead moved anyway, because `#scrub` is an `<input type=range>`
  and a focused range steps on arrows BY ITSELF. The module's decision was right and irrelevant:
  there were two writers to the position and only one of them consulted the rules. `PageUp`,
  `PageDown` and the vertical arrows were worse, moving the playhead by a chunk with no rule
  behind them at all. The fix is `preventDefault` on the CONTROL's native keys — which cancels
  the default action without stopping the event, so a modifier chord still reaches the app's own
  accelerators. Found only by an E2E driving real keystrokes; watched failing again by mutation
  (removing the suppression fails exactly those two tests and no others). **Whenever a pure
  decision module sits on top of a native control, ask what the CONTROL does with the same input
  before believing the module is the only path to the state.**

- **A layout measurement taken while the element is hidden reads as a legitimate answer
  (STC-338).** `tickStrideFrames` returns null when no tick stride clears the legibility floor,
  and drawing nothing is the CORRECT response to that. `updateTrimUI` ran before
  `$("player").removeAttribute("hidden")`, so the track measured 0 px wide, no stride could
  clear the floor, and the grid never appeared on open — a null that meant "I could not see the
  element" being consumed as "this take has no legible stride". The two are indistinguishable at
  the call site. Same family as `performance.memory` not counting ArrayBuffers and as STC-318's
  canvas having three different sizes: **a measurement that cannot fail loudly will fail
  quietly and plausibly.** Measure after the reveal, and prefer a null that the caller can tell
  apart from a zero.

- **A rubber band's sign was wrong in BOTH branches, so it looked asymmetric to a human
  and was actually symmetric — reported 2026-09-09 on real hardware.** `onHandleMove`'s `excess`
  and `band` were each computed backwards for BOTH "in" and "out": `rubberBandPx` always saw a
  NEGATIVE number and returned 0, so a trim handle pinned dead at its clamp with no creep in
  EITHER direction — only the red/wide `.held` styling ever fired. A small overshoot in one
  direction reads as "the handle turned red, fine"; a large one in the other reads as "stuck
  bright red, all red" — the SAME zero-band bug, reported as two different symptoms because the
  two test drags happened to travel different distances. Verified numerically before touching the
  code (`node -e` reproducing the exact sign flip) rather than guessed from the report.
  No existing test could have caught it: `scrubber.test.ts` exercises `clampTrimFrame`/
  `rubberBandPx` in isolation (both individually correct), and `scrubber.e2e.test.ts`'s keyboard
  tests never touch `onHandleMove`'s pixel math at all — the wiring between the pure functions and
  the screen was untested. `app/test/scrubber.e2e.test.ts`'s new "rubber band, dragged with a real
  pointer" describe block drives a real `mouse.down`/`mouse.move` past the clamp and asserts the
  margin actually moves (not just that `.held` is set); mutation-proven — reverting the sign fix
  fails exactly those 3 tests and none of the other 15.
- **Two 10px-wide trim handles a few frames apart OVERLAP almost entirely on a narrow window, and
  whichever is LATER IN THE DOM wins every click.** The first draft of the rubber-band E2E put the
  in/out handles 10 frames apart (matching the runbook reviewer's own scenario) — on this
  environment's ~32px-wide timeline that is under 2px of screen separation between two 10px
  buttons, so EVERY click meant for `#trim-in` silently landed on `#trim-out` (added second in the
  HTML, so it wins z-index/paint ties) and `onHandleMove` never fired for the handle under test at
  all. The tell was that `left` stayed at the handle's PRE-drag position no matter how far the
  drag went, for any overshoot down to a few pixels — not a threshold effect, a totally different
  element receiving the pointerdown. The fix is not to click more precisely; it is to set up the
  trim with the two handles FAR apart (frame 20 and 280 of 299) so the INITIAL mousedown is
  unambiguous — pointer capture (already set at mousedown) is what makes it safe for the drag to
  travel past the other handle's position once under way, so only the very first click needs the
  separation.
- **A test that clicks a control to focus it may MOVE the control (STC-338).** `win.click("#scrub")`
  on a range input sets its value from the click's x, so a test that clicked "to give it focus"
  and then asserted the position was asserting against a seek it performed itself — it reported
  `expected 149 to be 120` and looked exactly like the product bug it was written to catch. Focus
  through `element.focus()` in an `evaluate`. The tell was that the number was the MIDDLE of the
  track rather than one step from where the test put it; arithmetic identified it, "flaky E2E"
  would not have.

- **Two PRs merged unreviewed within an hour on 2026-09-09, and a review of each found real
  defects the same hour.** #116 produced five follow-ups (STC-337, and four fixed later in #128); #117
  carried two blockers that then sat on master until #120. Neither session did anything wrong —
  both PRs were well tested, and both defects were of the shape their own tests could not see.
  The cost is not the defects, it is WHEN: a finding on an open PR is a change request, and the
  same finding an hour later is a follow-up ticket, a second branch and a second CI cycle. The
  repo already learned to check for parallel work BEFORE starting (see the STC-325 collision);
  the matching half is that a PR nobody has read is not ready to merge just because CI is green,
  and this file is now full of defects that CI was structurally incapable of catching.

- **A budget and the quantity it is asserted against can be two different things, and the gap
  reads as a product failure (STC-383).** STC-301's gate 3 held STC-289's "well under 200 ms from
  verb to BUFFER" against the wall clock of the whole `capture-still` request — which is verb to
  ANSWER, and also carries the PNG encode and the shot.json write. On a 6016x3384 display those
  differ by more than a factor of two: `captureMs` is 92-101 ms and the wall is 250-253 ms,
  because the PNG encode alone is 137-141 ms, ~55-60% of the request. So the gate failed
  consistently on hardware while its subject was comfortably meeting the budget that had actually
  been written down, and every reading of it — including the ticket that found it — started from
  "is the code too slow" rather than "is this the number we agreed".
  **The tell was in the budget's own words**, and `docs/STC-289-RUNBOOK.md` had even drawn the
  same distinction one phase over, calling `contentMs` "not the ticket's number but IS what the
  user waits". Nobody carried that sentence across to the phase on the other side.
  Both repairs that suggest themselves are wrong. Raising the 200 makes it stop meaning what
  STC-289 wrote, which is the whole value of a number agreed before the measurement; deleting it
  loses the slice's only latency check. The fix is to assert each quantity against its own
  budget: 200 ms on `captureMs`, unchanged, and a separate, separately-derived bound on the wall.
  **Before loosening a threshold that fails, check that it is pointed at the thing it names** —
  and prefer a second budget to a bigger one, because two numbers that each mean something beat
  one that means whichever the reader assumes.
  **The ticket check passed and did not catch a live collision, because a collision does not
  have to share a ticket key (STC-383/STC-341).** `npm run ticket -- STC-383` correctly reported
  nothing on GitHub naming STC-383 — and PR #156 was open at that moment, editing the same gate 3
  body in the same file, under STC-341, a ticket filed six days earlier about the same failing
  gate. It was found only by listing the repo's workflow runs while checking this PR's own CI,
  which is luck rather than method. CLAUDE.md's own STC-325 rule already says the check is not
  enough — **"BEFORE STARTING A TICKET, AND AGAIN BEFORE PUSHING, LIST THE REPO'S OPEN PRS"** —
  and that is the step that was skipped here, on the reasoning that the keyed check had already
  answered. It cannot: `ticket-check.mjs` greps for a ticket key, so it is blind by construction
  to any parallel work filed under a different one, which is exactly what a duplicate FILING of
  one bug produces. One `list_pull_requests` is the whole check, and the file titles alone
  ("Fix gate 3 steady-state detection") would have said it.
  **#156 then MERGED while its work was being folded in here**, roughly half an hour after the
  collision was spotted — so the window in which this was cheap to fix was about that wide, and
  the cost of missing it was a merge conflict in the one file both touched rather than a lost
  session. Resolving it was mechanical only because the fold had already happened: every
  master-only line in the conflict was #156's INLINE implementation of the same statistic this
  branch had already extracted, checked line by line before taking `--ours` rather than assumed.
  Had the fold not happened first, the same merge would have been a choice between two correct
  diagnoses under time pressure.
  Reviewing the other PR for what it got RIGHT (STC-325's own lesson) was the load-bearing move:
  the two diagnoses were **different halves of one fix**, and each alone leaves the gate red on
  the other machine's data. Verified numerically against both datasets before folding, rather
  than assumed. A duplicate ticket is also a signal in itself: the same bug filed twice,
  from two machines, by the same person, is evidence the original report was incomplete rather
  than evidence somebody forgot.
  Same session, two smaller lessons worth keeping. **A worked example in a doc is read as a
  record of a passing run**: `docs/STC-301-GATES.md` showed gate 3 output of `412.7, 61.2, 58.9,
  60.4, 57.8 ms`, invented on Linux for a gate that has always needed a Mac, and its existence is
  part of why "it must have been calibrated against something" went unquestioned for a week. Mark
  an illustrative number as illustrative or do not write one. And **the diagnosis needed no new
  instrumentation at all** — `capture-still` had always returned the whole shot document in its
  reply, so the frame dimensions the ticket asked to log were already on the wire and the gate
  just printed the raw cumulative `timing` map instead of the subtractions. Before adding a probe,
  check what the reply already carries.

- **A vitest run's `Duration` is not a file's duration, and reading it as one invented a 30x
  slowdown that never happened (STC-386).** Two of the last six master pushes went red, each on a
  different E2E file, and the ticket filed it as one fault: *"one E2E file intermittently runs ~30x
  slow"*, with `scrubber.e2e.test.ts` at **341.00s** in run 407 and `preview.e2e.test.ts` at
  **462.69s** in run 418 against a 14.4s baseline. Both numbers are the run-level summary line —
  `Duration  341.00s (transform 1.62s, setup 0ms, import 10.25s, tests 333.56s, …)` — which sits a
  few lines below the per-file list and matches the ticket's "(tests 333.56s)" parenthetical
  exactly. The real per-file numbers were in the same logs the whole time: **scrubber 37.4s and
  preview 19.9s**, against greens of 42-60s and 14-19s.
  The correction inverts the finding. Run 407 — a FAILURE — was the FASTEST of five sampled master
  runs, every single one of its 24 e2e files quicker than the same file in any green run, and its
  failing file ran 18% faster than in the green run ten minutes later. Total run Duration across
  the five spans 341-463s, a 1.36x spread. There is no saturation to find, and the ticket's
  proposed mitigation — a per-file bound that "would make a stalled file fail fast" — would have
  been machinery built for a phantom, permanently green and proving nothing.
  Three lessons, and the first is the cheap one. **A number read off a log needs the line it came
  from quoted with it**: "341.00s" and "Duration 341.00s (tests 333.56s)" are the same characters
  and different claims, and the ticket was careful in every other respect — it had a control run,
  it ruled out the crash reports, it ruled out the merge. **Two failures sharing a shape are not
  evidence of a shared cause**: "a different file each time" was read as one fault with a common
  mechanism, and it was two unrelated races that happen to live in e2e files. And **a ticket's own
  "secondary" finding can be the whole bug** — its one-paragraph aside about a click racing a
  window teardown, explicitly discounted with *"fixing that alone would move the failure elsewhere,
  not fix master"*, was the only live fault of the two. The other (run 407's tick assertion) was
  already fixed on master by `7ef06bf` before the ticket was written.
  The surviving fault is worth its own note, because the fix is a tolerance and tolerances rot.
  `editor.ts` wires Close to a synchronous `window.close()`, so `page.click("#closepreview")`
  destroys the page Playwright is still doing its post-click bookkeeping on and REJECTS for a click
  that landed — run 418's log shows "visible, enabled and stable", "done scrolling", "performing
  click action", then the target gone. Four test files clicked that button and three paired it with
  `waitForEvent("close")` by hand, so it is one hazard in four copies, this file's most-repeated
  defect. `_editor-fixture.ts`'s `closeEditorWindow` is the single owner now. It tells three
  outcomes apart rather than swallowing the error: the click resolving still waits for the close,
  the click rejecting *while the window closes* passes, and the click rejecting while the window
  STAYS OPEN rethrows the click's own error. No message string is matched and no ordering between
  the rejection and the `close` event is assumed. `app/test/close-editor-window.test.ts` drives all
  four branches against a stub page — the race needs a real window to lose a real click at a real
  instant, which is the coincidence STC-343 already paid to stop chasing live — and both mutations
  were watched failing: a blanket `catch(() => {})` loses the error-identity case, and dropping the
  `await closed` loses two.

- **`app.windows()` is Playwright's list of attached PAGES, not the app's list of windows, and 45 e2e
  assertions were counting with it (STC-416).** Measured on 2026-09-19, three runs each: a
  `BrowserWindow` that never loads a url is NEVER in `app.windows()` (that is the decoy STC-392's
  review planted and the assertion missed); one that loads appears 78-147 ms after creation; a
  destroyed one stays listed ~25 ms. Watched on a real site, not only in a probe: `hotkeys.e2e`'s
  "no overlay ever opening" PASSED with a decoy overlay created at the reply. Every count, presence
  and absence read now goes through `app/test/_windows.ts` (main-process `getAllWindows()`), and
  `app.windows()` is left exactly where it is right — `find`/`for…of` to get a `Page` to drive.
  **The finding that changed the fix's shape: a count scoped by URL is NOT immediate from the main
  process either.** `webContents.getURL()` is empty until the navigation commits (~78-110 ms), so
  "no window whose url contains overlay.html" passed with the decoy from BOTH processes, and so did
  an allow-list of urls — the real post-capture panel was the one still loading. The strong form of
  "nothing appeared" is an exact UNSCOPED total, before and after (the STC-392 worked example had it
  right); the hotkeys site asserts `before + 1` and names the one newcomer once it commits. The same
  lag means **a `poll(count) → 0` can only claim the window it was tracking is gone** — it is
  satisfied by its first sample, so a replacement appearing in the same tick is invisible to it
  from either process (watched: a decoy spawned inside `destroy()` failed NONE of the 21
  "went away" polls; the same decoy spawned at presentation failed every one). And **a
  `poll(count) → N` proves AT LEAST N**: a `file:` load commits ~30 ms before an `about:blank#…`
  one, and thumbnail.e2e's "a second capture STACKS" passed with two decoys up because its poll
  sampled inside that gap — only a later exact read proves exactly N. Neither is a weakness to
  fix by polling harder; both are what the assertion means, and both are written on the helper
  so nobody reads more into it. 40 of the 45 converted sites were watched failing at their own
  line (an at-present decoy for counts, hide-instead-of-destroy for "went away", a 300 ms vanish
  for "still here"); the other five "still here" reads sit behind a click that needs the window
  and share the watched sites' exact expression. Six mutation families, all in the PR, all
  reverted.
- **`app.focus({ steal: true })` raises EVERY ordinary window, and a comment saying otherwise survived
  eight days because nothing depended on it (STC-391 follow-up, 2026-09-16).** `overlay-session.ts` has
  called it since STC-292 so a hotkey or menu-bar capture starting in the background could reach Escape,
  under a comment asserting "the main window is not activated by this; only the overlay is". On macOS that
  is an APPLICATION-level activation: the library came forward on every menu-bar capture, and once the
  overlay was torn down the main window was the app's remaining ordinary window and took key status back
  off whatever opened next.
  For eight days that cost nothing — a raised library during a still capture is noise, not a fault — so
  the claim was never checked. **STC-391's countdown is the first thing that DEPENDED on who held focus**,
  and its §0 ("the panel takes focus, which is what makes Escape and Return work without a global
  registration") was therefore false on hardware from the day it shipped, while every test passed: this
  sandbox's Xvfb has no window manager and CI's runner is headless, so neither can observe key status at
  all. Reported by a person, on a Mac, running the runbook — which is the only instrument that could have
  found it, and the argument for §0 existing as a runbook item rather than an assertion.
  The fix is `type: "panel"` (an NSPanel takes key without activating its app) on both windows, with the
  activation kept as a CHECKED fallback rather than deleted — `panel-focus.ts`'s `focusPanel` waits a
  window-server round trip, reads `isFocused()`, and escalates only if the polite path did not take,
  because the failure mode of being wrong about the OS's panel semantics is an overlay covering the screen
  that Escape cannot dismiss. **The fallback firing and the fix working are different outcomes and the
  code says which**, so a hardware run can report it rather than infer it.
  Two lessons worth keeping apart from the bug. **A comment asserting a platform behaviour is a claim
  nobody has tested**, and this one was load-bearing for a permission-shaped API where the obvious reading
  ("focus this window") and the real behaviour ("activate this application") differ. And **a verdict
  collected against a flow carrying an unrelated fault is contaminated, not a pass**: §3's "extra work,
  but maybe acceptable" was judged with the library popping up throughout, which is itself extra work and
  not the cost §3 asks about, so it has to be re-run rather than banked.
