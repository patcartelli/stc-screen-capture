# Capture

A macOS screen recorder for making polished tutorials and demos, built on one principle: **the
recording is immutable data; every decision about how it looks is made afterwards by a pure
function.** The helper captures pixels, cursor events and camera frames on one clock with microsecond
precision. The cursor is never baked into the pixels — it's recorded as events and drawn at render
time, enabling smooth motion, real macOS pointer artwork, and intelligent auto-zoom based on what
changed.

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE.md)

## Demo

> *[Phase-3 recording coming soon — see STC-313]*
> 
> In the meantime: [browse real takes in `/lab/network`](https://www.studio-cartelli.com/lab/network) (work in progress)

## Features

### For creators
- **Dead-simple UI**: press Record, say what you want to say, press Stop
- **Precise cursor**: real macOS pointer art (arrow, I-beam, hand, crosshair) with smooth motion and click highlights
- **Picture-in-picture camera**: seamlessly composite your face on the video at any corner
- **Smart trimming**: frame-accurate scrubber with rubber-band clamping, no off-by-one surprises
- **Auto-zoom**: intelligently zoom to regions where you clicked, or manually set zoom windows
- **Export dialogs**: choose output resolution and format (MP4 H.264)
- **Screenshot stills**: capture any frame as a decorated still with optional redaction, annotation, and effects
- **Global hotkeys**: ⌃⌥⇧⌘1/2/3 for full screen, window, or area capture (customizable)
- **Menu bar quick access**: capture stills without the main window, right from the menu bar
- **Library**: browse, organize, and manage all recordings and stills in one place
- **Take library**: persistent collection of recordings and stills with search and duplicate control

### For developers
- **Pure transform**: `render(project, session, t)` — one function, two sinks, zero sync bugs
- **Byte-for-byte determinism**: preview and export produce identical pixels (proven by a gate running
  on every commit)
- **Cursor as data**: events recorded separately from pixels, enabling smooth rendering and advanced
  features like auto-zoom
- **Hardware H.264 encode**: optimized for 4K at 60 fps, with software fallback
- **Modular architecture**: capture (Swift), preview/export (WebCodecs), and transform (pure TypeScript)
  cleanly separated
- **Comprehensive test suite**: 137 tests covering pure logic, IPC, capture lifecycle, and E2E flows

## Installation

### System Requirements

- **OS**: macOS 14.0 or later (macOS 26.0+ tested)
- **RAM**: 2GB minimum (4GB+ recommended for smooth 4K recording)
- **Storage**: 10GB free space for typical recording sessions
- **Permissions**: Screen Recording (required for capture), Input Monitoring (required for cursor recording)

### Download and Install

1. Download the latest release from [GitHub Releases](https://github.com/patcartelli/stc-screen-capture/releases)
2. Open the `.dmg` file and drag **Capture** to Applications
3. Launch from Applications or Spotlight (⌘Space)
4. On first launch, macOS will prompt for Screen Recording permission — grant it
5. Follow the same process for Input Monitoring when prompted

### Permissions

The app needs two permissions to work correctly:

- **Screen Recording**: Required to capture what's on screen
- **Input Monitoring**: Required to track cursor position and clicks for recording and animation

Both are one-time prompts. To reset permissions:
```bash
tccutil reset ScreenRecording com.github.Electron
tccutil reset ListenEvent com.github.Electron
```

## Quick Start

### Recording

1. Open **Capture**
2. Use the **Scope** picker to choose what to record:
   - **Screen**: entire display
   - **Window**: a single window (opens overlay to select)
   - **Area**: custom rectangular region (opens overlay to draw)
3. Optional: Toggle **Camera** to include your face in the corner
4. Press **Record** (or use global hotkey ⌃⌥⇧⌘3 for full screen)
5. Perform your demo or tutorial
6. Press **Stop** or close the window

Recordings are saved to `~/Desktop/stc/<timestamp>/` and appear in the Library immediately.

### Editing

1. In the Library, select a take and preview it
2. Use the **Scrubber** to trim the start/end points (drag handles or use keyboard)
3. Optional: Enable **Auto-Zoom** to intelligently frame interactions, or manually select zoom windows
4. Set **Export Size** (defaults to capture resolution)
5. Press **Export** to save as MP4

### Still Capture

1. Use **Capture Still** (button in main window, hotkey ⌃⌥⇧⌘1/2, or menu bar icon)
2. Select screen, window, or area
3. A floating panel appears with the capture:
   - **Copy**: paste into Slack, Mail, or other apps
   - **Save**: save to disk as PNG/HEIC/JPEG
   - **Redact**: black out sensitive information
   - **Reveal in Finder**: open the save location
   - **Delete**: discard the capture

## The architecture

### Philosophy

**The recording is data. Decisions about appearance are made at render time.**

This means:
- The cursor is never baked into video pixels (recorded as events instead)
- Export quality is independent of preview (both call the same pure function)
- Changes to trim, zoom, or effects don't touch the original recording
- Project metadata is stored in JSON and survives across app versions

This design prevents the most common video editor trap: exporting and realizing you got the trim
or effects wrong, then re-recording or re-editing from scratch.

### Data flow

```
Swift helper (ScreenCaptureKit + CGEventTap + AVFoundation)
    display.mp4 (VFR, cursor excluded)   events.json (cursor, ns)   camera.mp4   anchors.json (clock, geometry)
        │
        ▼   one mach clock; every time is session-relative integer nanoseconds
Electron main (owns paths, preferences, the helper process)
        │   bytes over IPC, never a path
        ▼
Renderer: render(project, session, t) → FrameState → composite()
        ├── preview sink: seeking decoder, wall clock chooses the next t
        └── export sink:  forward decoder, 60 fps grid, WebCodecs → CFR MP4
```

`project.json` is the edit document: output size, cursor style, PiP geometry, trim, zoom settings.
Change it and re-render; the source media is never touched.

## How the cursor works

The cursor is **not in the video frames**. Instead:

1. **Capture**: `CGEventTap` records every mouse move and click with nanosecond timestamps
2. **Store**: Events are written to `events.json` alongside the video (same clock)
3. **Render**: At export or preview, the transform draws the cursor from events using real macOS pointer artwork
4. **Animate**: A spring-based motion model smooths jumpy cursor movement (120 Hz simulation)
5. **Decode**: Click highlights appear on the frame where the click occurred

Why? Because:
- Baking the cursor into pixels locks its size, style, and position forever
- Recording it separately enables smooth motion, cursor customization, and smart features like auto-zoom
- It's more efficient (cursor data is KB, not MB)
- You can re-export with different cursor styling without re-recording

## The route

## Known Limitations

- **macOS only**: Built with ScreenCaptureKit, which is Apple-specific
- **Region recordings**: Cannot record display changes mid-take (e.g., plugging in a second monitor);
  the take stops cleanly with a reason
- **Camera sync**: ~65ms lag between display and camera (inherent to the USB camera pipeline)
- **Preview memory**: 4K videos use ~1.2x the file size in memory during preview; a 15-minute 4K take
  approaches the practical ceiling
- **Auto-zoom stage 1**: Currently responds to clicks and drags only; keystroke-based changes are
  recorded but not auto-zoomed (see auto-zoom stage 2, not yet implemented)
- **No audio**: Microphone capture is not implemented (phase 4 consideration)
- **No app bundle yet**: there is no packaging step, so the app runs from source under Electron's
  own identity — see "Name and identity" below

## Name and identity

The product is **Capture**; **STC** is the label; the model code is **SK-016** (fixed for the life of
the job — the version moves under it). `app/src/product.ts` is the one place any of that is written
down, and `package.json`'s `productName` has to agree with it because Electron derives both the name
a launcher matches and the `userData` folder settings live in from that field.

**The bundle identifier is still Electron's own `com.github.Electron`, and that is not an oversight.**
There is no packaging step in this repo — no electron-builder, no forge, no `Info.plist` of the app's
own — so there is nowhere to put `com.studiocartelli.capture` yet. Two consequences worth knowing
before you go looking for something that isn't there:

- macOS lists this app as **Electron** under Privacy & Security, and `tccutil` takes
  `com.github.Electron`. Permissions are keyed to that identifier, so they are shared with anything
  else run the same way.
- Spotlight and Raycast will not find "Capture" until a real bundle exists.

Renaming the product did move `userData` (from `…/Application Support/stc-screen-recorder` to
`…/Capture`). Settings and any unsaved takes are carried across once, on first launch after the
rename; the old folder is left in place, so rolling back to an earlier build finds its own settings
where it left them. Takes themselves live in `~/Desktop/stc` and were never affected.

## Troubleshooting

### "Application connection being interrupted" (-3805)

This usually means **another Capture process is still running**. The display can only have
one active ScreenCaptureKit stream at a time.

**Fix**: Kill the existing process or check the menu bar — the app may have no window visible but is
still running. Match your **checkout directory**, not the product name: run from source, the process
is `electron` and the only distinguishing part of its command line is the path it was launched from.
```bash
pkill -f "$(pwd)/node_modules/electron" || killall Electron
```

### Screen Recording permission not working

If you granted permission but capture still fails:

1. Verify the permission: **System Settings → Privacy & Security → Screen Recording**. Run from
   source it is listed as **Electron**, not Capture — the app has no bundle of its own yet, so it
   inherits Electron's identity (`com.github.Electron`). See "Name and identity" below.
2. If it's there but not working, try revoking and re-granting:
   ```bash
   tccutil reset ScreenRecording com.github.Electron
   ```
3. Launch the app again and re-grant when prompted
4. If using a bundle from source, not the .dmg, you may need to `codesign -fs -` it

### Input Monitoring permission not showing up

Input Monitoring grants are only created when the app first **requests** them, not when it's installed.
If you don't see it in System Settings:

1. Make sure you opened the app and tried to record (which triggers the grant request)
2. Check for a permission prompt that may have been denied by accident
3. Reset it: `tccutil reset ListenEvent com.github.Electron`, then open the app again

### Take is missing or won't export

Recordings go to `~/Desktop/stc/<timestamp>/` by default. If a take is missing:

1. Check that directory exists
2. Look in the Library — it may be cached but not on disk
3. If the export fails partway through, check disk space (4K video is ~130 MB/min)
4. Check the app's debug output for errors: run from Terminal with `npm run app:start` to see logs

### Cursor is wrong or lagging

If the cursor appears delayed or positioned incorrectly:

1. **Export, not preview**: A preview with a slow decoder may render behind real-time. Export to see
   the authoritative result.
2. **Check camera sync first**: If camera and display are out of sync, cursor timing is likely
   correct but *appears* wrong. Use the scrubber to verify frame-by-frame.
3. **Known flake**: Very rarely, cursor events can desync from frames if the helper's event tap
   becomes starved. This is tracked as an open question; open an issue with your recording steps.

### Zoom windows don't move the picture

Check that **Auto-Zoom** is enabled and set to an intensity level (not off). Also verify:

1. **Stage 1 (clicks/drags)**: Make sure you're clicking or dragging while recording, not hovering
2. **Manual override**: If you manually set a zoom window but the picture isn't moving, refresh the
   preview by seeking to a different frame, then back

---

## For Developers

### Local Development

#### Prerequisites

- **macOS 14.0+** with command-line tools: `xcode-select --install`
- **Node.js 24** or later: `node --version`
- **swiftc**: Installed with Xcode command-line tools

Verify everything is installed:
```bash
which swiftc node npm
xcode-select -p  # should print /Library/Developer/CommandLineTools
```

#### Build from Source

```bash
# Install dependencies
npm ci

# Build the Swift helper
helper/build.sh          # outputs to helper/build/stc-helper
                         # re-runs codesign each time (grants may not survive ad-hoc rebuilds)

# Type checking (three passes: coverage, browser, node)
npm run typecheck

# Run tests (everything that doesn't need a grant)
npm test

# Run capture tests (need Screen Recording + Input Monitoring grants)
npm run test:capture     # requires grants; use `npm test` without grants

# Build and launch the app
npm run app:start        # builds app/dist/ and opens the Electron window
```

Recordings go to `~/Desktop/stc/<timestamp>/` by default. Override with:
```bash
STC_RECORDINGS_DIR=/tmp/stc npm run app:start
```

### Architecture for Developers

#### Source Layout

- **`helper/src/`** — Swift capture process (ScreenCaptureKit, CGEventTap, AVFoundation)
  - `main.swift` — Lifecycle, command dispatch
  - `Capture.swift` — Display stream setup
  - `Still.swift` — Screenshot capture
  - `CursorShape.swift` — Cursor tracking and sampling (30 Hz)
  - `CameraCapture.swift` — Camera track setup
  - `Protocol.swift` — IPC protocol, clock setup
  - `Watchers.swift` — Display reconfiguration detection

- **`app/src/`** — Electron main + renderer bridge
  - `main.ts` — Window management, IPC handlers
  - `helper-client.ts` — Promise-based protocol client
  - `supervisor.ts` — Helper lifecycle (restart on crash)
  - `renderer.ts` — Main window UI logic
  - `preview.ts` — Video preview playback
  - `library.ts` — Take library scanning and filtering
  - `editor.ts` — Trim/export controls in editor window

- **`transform/src/`** — Pure transform (one function, two sinks)
  - `render.ts` — Main render loop: `(project, session, t) => FrameState`
  - `composite.ts` — Canvas drawing: cursor, PiP, background
  - `decode.ts` — H.264 frame decoding (WebCodecs)
  - `demux.ts` — MP4 demux (mp4box.js)
  - `cursor-art.ts` — macOS pointer paths and animation
  - `zoom.ts` — Auto-zoom curves (stage 1)
  - `zoom-change.ts` — Auto-zoom WHERE signal from changes (stage 2)
  - `spaces.ts` — Coordinate space conversions (display → capture → output → UV)
  - `project-*.ts` — Schema loaders for project versions
  - `time.ts` — Time conversions and tick calculations

- **`app/test/`** — E2E tests (Electron + real helper)
- **`transform/test/`** — Pure function tests
- **`helper/test/`** — Swift helper tests (including grant tests)

#### Key Locked Decisions

See `docs/BRIEF.md` for the full table. Important ones:

- **Frame selection**: At time `t`, use the source frame with greatest PTS ≤ `t` (hold, never
  interpolate)
- **Simulation step**: 120 Hz; 60 fps export samples every other tick
- **Capture**: VFR at capture, CFR at export; H.264 up to 3840×2160
- **IPC**: fd3 (reliable with seq numbers) for commands; stdout (lossy ring buffer) for stats
- **Cursor**: Events are data; rendering is done at encode time to enable smooth animation and
  intelligent auto-zoom

#### One Rule: `render()` is Pure

There is one implementation of "what does a frame look like at time `t`". Both preview and export
call it:

```typescript
render(project: Project, session: Session, t_ns: number): FrameState
  → FrameState { video, pip, cursor, zoom, ... }
    → composite(frameState): ImageData
      → canvas toBlob() or WebCodecs encode
```

The gate (`npm run gate:identity`) proves preview and export produce bit-identical pixels on shuffled
vs. sequential frame access. See `scripts/gate.mjs`.

### Testing

#### Run all tests (no grants required)

```bash
npm test                    # everything
npm run test:capture        # needs Screen Recording + Input Monitoring
npm run test:slow           # includes cross-implementation export check (~2 min)
npm run gate                # determinism gate (needs Chrome with H.264)
```

#### Run specific test files

```bash
npx vitest run transform/test/spaces.test.ts
npx vitest run app/test/preview.e2e.test.ts
npm run test:capture helper/test/ipc.grant.test.ts
```

#### Add a new test

- **Pure logic**: `transform/test/` — no Electron, no helper
- **IPC behavior**: `helper/test/*.test.ts` — test against the real Swift binary
- **E2E in app**: `app/test/*.e2e.test.ts` — real Electron, real helper (no grants needed if testing
  UI logic)
- **E2E with grants**: `helper/test/*.grant.test.ts` — full capture lifecycle

### Important Traps

See `CLAUDE.md` for the full list, but the most critical:

- **Byte-identical MP4 is not the gate** — pre-encode RGBA is what matters (muxer timestamps and
  encoder state differ). Hash pixel buffers, not files.
- **A failed `swiftc` leaves the old binary** — `helper/build/stc-helper` is not removed on error,
  so tests silently run stale code if the build fails.
- **Node's paused child-stdio streams need `resume()`** — attaching a `data` listener after `pause()`
  doesn't re-enable reading without calling `resume()`.
- **Every wait needs a bound** — WebCodecs, AVFoundation, ScreenCaptureKit all signal trouble by
  never calling back. Use `withTimeout()`.
- **`render()` takes `t_ns` in nanoseconds**, not milliseconds or ticks.
- **`~/Desktop/stc/` is the storage root** — tests that don't override it dirty the real desktop.
  Use `STC_RECORDINGS_DIR` or `_take-fixture.ts`.

### Git and PRs

#### Claiming a ticket

Before starting work, check that it's not already claimed:

```bash
npm run ticket -- STC-NNN   # exits 0 if nothing found, 1 if work exists
```

If nothing found, claim it in Linear (set status to **In Progress**, comment with branch name).

#### Creating a PR

```bash
# Create a branch and work
git checkout -b accounts/stc-NNN-slug
# ... make changes ...
git add <files>
git commit -m "message"
git push -u origin HEAD

# Create PR (will open in your browser)
npm run merge -- <pr>       # merges ONLY if CI is green (preferred over gh pr merge --auto)
```

The PR will run CI on: tests, type checking, linting, determinism gates, and slow tests.

#### Master is protected

- All commits require a PR
- CI must be green before merge
- Use `npm run merge -- <pr>` to merge (it checks CI status)
- **Do not push directly to master**

### Resources

- **`CLAUDE.md`** — Running handoff log of every trap found, decision made, and what's next
- **`PHASE-1.md`**, **`PHASE-2.md`** — Phase plans and status
- **`docs/BRIEF.md`** — Locked decisions with current code status
- **`docs/STC-*.md`** — Individual ticket runbooks and findings

## Status

**Phases 0–3 complete:** Record → Preview → Trim → Export, with real cursor artwork and camera
picture-in-picture, all verified on hardware.

### What's shipped

- ✅ Screen capture (display + cursor events + camera)
- ✅ Preview with seeking
- ✅ Trim (start/end), export to MP4 H.264
- ✅ Auto-zoom stage 1 (clicks/drags trigger zoom)
- ✅ Manual zoom override (per-window geometry and easing)
- ✅ Picture-in-picture camera
- ✅ Screenshot stills with decoration (effects, redaction, annotation)
- ✅ Library with search and organize
- ✅ Real macOS cursor art (arrow, I-beam, hand, crosshair)
- ✅ Global hotkeys (customizable)
- ✅ Menu bar quick capture

### In progress / planned (phase 4+)

- ⏳ Auto-zoom stage 2 (change detection decides WHERE to zoom)
- ⏳ Audio capture and mixing
- ⏳ HDR support
- ⏳ Multi-monitor recording
- 🔄 Keyboard input recording (privacy consideration — scope TBD)

### Diagnostics and testing

- 137 tests covering pure logic, IPC, and E2E flows
- Determinism gate proves preview/export byte-equivalence
- Capture tests with real ScreenCaptureKit
- Gate-skip monitoring for CI reliability

### Documentation

- **`CLAUDE.md`** — Comprehensive handoff log with every trap, decision, and architectural notes
- **`PHASE-1.md`, `PHASE-2.md`** — Phase plans and acceptance criteria
- **`BRIEF.md`** — Locked decisions with current code compliance status
- **`docs/STC-*.md`** — Individual ticket runbooks and technical findings
- **GitHub Issues/PRs** — Issue tracker and review history

## Contributing

### Non-Commercial Use

This project is licensed under **PolyForm Noncommercial 1.0.0**. You can freely:

- Fork and study the code
- Build on it for hobby projects, education, or nonprofit use
- Run it in a school, charity, or public body
- Submit issues and pull requests

**Commercial use requires explicit permission.** If you're interested in commercial licensing, open
an issue or contact via the repository.

### Reporting Issues

Before opening an issue:

1. **Check existing issues** to avoid duplicates
2. **Reproduce reliably**: Include steps to reproduce, expected vs. actual behavior
3. **Attach logs**: If the bug involves capture or export, include debug output:
   ```bash
   npm run app:start 2>&1 | tee app.log   # launch with logs captured
   ```
4. **System info**: macOS version, hardware (M1/Intel), screen resolution

### Submitting Code

1. **Claim the ticket first**: `npm run ticket -- STC-NNN` to check, then claim in Linear
2. **Run tests locally**: `npm test` (and `npm run test:capture` if it involves capture)
3. **Type check**: `npm run typecheck` (all three passes must pass)
4. **Create a PR**: Push to a branch, open a PR, and request review
5. **CI must be green**: Don't merge until all checks pass
6. **Use `npm run merge`**: Let the script verify CI status before merging

#### Code Style

- **TypeScript**: Use existing patterns; no `any` in new code
- **Swift**: Follow the existing code style; 2-space indents
- **Tests**: Use existing test structure (pure tests in `test/`, E2E in `e2e.test.ts`)
- **Commits**: Clear, concise messages; reference the ticket

#### Architectural Principles

Before starting a significant change, read:

- **`transform/src/spaces.ts`** header — coordinate systems and conversions
- **`CLAUDE.md` → "The non-negotiable"** — settled decisions that should not be relitigated
- **`docs/BRIEF.md`** — Current status of each locked decision

The most important rule: **`render()` must remain pure.** No wall-clock time, no live helper stats,
no current display state inside the transform.

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) — Read it, fork it, change it, build on it for any
noncommercial purpose. Commercial use is not granted; [ask](https://github.com/patcartelli/stc-screen-capture/issues/new).

GitHub's license detector doesn't recognize PolyForm, so the sidebar shows nothing. The license file
is authoritative.
