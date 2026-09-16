# STC-240 PR A — helper pause/resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The helper accepts `pause` and `resume`, writes nothing to any of its five outputs while paused, and records the intervals in `anchors.json` — with no user-visible change, because nothing can trigger a pause yet.

**Architecture:** One thread-safe `PauseGate` owns the intervals and answers one predicate — *is this sample's session-relative pts inside a paused span*. All five writers (display frames, camera frames, mic samples, the event tap, the cursor-shape sampler) ask it the same question, so what lands on disk and what the sidecar claims cannot drift. `App.State` gains no case; paused-ness is a separate boolean.

*(Corrected during final review: this was originally written as "four writers" / "four outputs", missing the cursor-shape sampler's own gate in `recordCursorShape` — see `docs/STC-240-DESIGN.md`'s "Pause means nothing is written, anywhere" table.)*

**Tech Stack:** Swift 5.8+ compiled by `helper/build.sh` (no SwiftPM — Xcode is absent); pure-function tests via `runSwiftHarness` compiling production sources with a `main.swift` of assertions; vitest for the TS-side drivers; Ajv for schema validation.

**Spec:** `docs/STC-240-DESIGN.md` — read it first. This plan implements §"Part A" and §"Part B" of that document only.

## Global Constraints

- **No new `App.State` case.** A paused take stays `.recording`. (Spec §Part A; STC-376 is the precedent.)
- **Session-relative integer nanoseconds everywhere.** No floats, no boot-relative values leaving the helper.
- **Intervals are half-open `[startNs, endNs)` and must satisfy `endNs > startNs`**, disjoint and ascending.
- **Minimum-version emission.** A take with no pauses must still write `anchors-4` byte-for-byte as it does today.
- **`helper/build.sh`, never `swift build`.** SwiftPM cannot resolve without full Xcode.
- **A failed `swiftc` leaves the previous binary in place** — always check build.sh's exit code before believing a test result.
- **`npm run typecheck` is three passes**, not a bare `tsc`.
- This plan adds **no** transform, schema-loader, or UI change. `transform/`, `app/` are untouched.

---

## File Structure

| file | responsibility |
|---|---|
| `helper/src/PauseDecisions.swift` | **new.** `PauseInterval`, the pure `isPausedNs` predicate, and the thread-safe `PauseGate` that owns the intervals. The only place pause semantics are decided. |
| `helper/test/pauses/main.swift` | **new.** Pure assertions over the above, compiled with the production source. |
| `helper/test/pauses.test.ts` | **new.** Drives that harness. |
| `schema/anchors-5.schema.json` | **new.** anchors-4 plus optional `pauses`. |
| `helper/src/AnchorsDoc.swift` | modify: `anchorsDocument` takes `pauses:`, raises the version floor to 5 when non-empty. |
| `helper/src/Capture.swift` | modify: owns the `PauseGate`; `pause()`/`resume()`; gates the display frame append, the tap, and the cursor sampler; `framesPaused` stat; the synthetic resume move. |
| `helper/src/CameraCapture.swift` | modify: takes a `PauseGate`, checks it before `gate.append`. |
| `helper/src/MicCapture.swift` | modify: same. |
| `helper/src/main.swift` | modify: `pause`/`resume` dispatch; `paused` in the heartbeat. |
| `helper/test/capture.test.ts` | modify: no-grant IPC tests for the new commands. |
| `helper/test/capture.grant.test.ts` | modify: the real round trip and the disk invariant, added to the suite that already has the spawn helpers. |

---

### Task 1: `PauseDecisions.swift` — the interval model and the one predicate

**Files:**
- Create: `helper/src/PauseDecisions.swift`
- Create: `helper/test/pauses/main.swift`
- Create: `helper/test/pauses.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `struct PauseInterval: Equatable { let startNs: Int64; let endNs: Int64; var json: [String: Any] }`
  - `func isPausedNs(_ tNs: Int64, closed: [PauseInterval], openSinceNs: Int64?) -> Bool`
  - `final class PauseGate` with `var isPaused: Bool`, `func isPaused(atNs: Int64) -> Bool`, `@discardableResult func pause(atNs: Int64) -> Bool`, `@discardableResult func resume(atNs: Int64) -> Bool`, `func close(atNs: Int64)`, `var intervals: [PauseInterval]`

- [ ] **Step 1: Write the failing test harness**

Create `helper/test/pauses/main.swift`:

```swift
// Pure-function tests for pause semantics, compiled with the production
// source — same arrangement as helper/test/decisions/main.swift.
import Foundation

var failures = 0
func check(_ label: String, _ got: some Equatable, _ want: some Equatable) {
    if String(describing: got) == String(describing: want) {
        print("ok   \(label)")
    } else {
        print("FAIL \(label): got \(got), want \(want)")
        failures += 1
    }
}

// ── the predicate ───────────────────────────────────────────────────────────
// Half-open [start, end): the frame AT startNs is paused, the frame AT endNs
// is not. Off by one here is a frame that exists on disk inside a span the
// sidecar says was paused, which the transform then cuts — a real frame
// silently deleted from the export.
let a = PauseInterval(startNs: 1_000, endNs: 2_000)
check("before the span", isPausedNs(999, closed: [a], openSinceNs: nil), false)
check("exactly at start IS paused", isPausedNs(1_000, closed: [a], openSinceNs: nil), true)
check("inside", isPausedNs(1_500, closed: [a], openSinceNs: nil), true)
check("exactly at end is NOT paused", isPausedNs(2_000, closed: [a], openSinceNs: nil), false)
check("after", isPausedNs(2_001, closed: [a], openSinceNs: nil), false)
check("no intervals at all", isPausedNs(1_500, closed: [], openSinceNs: nil), false)

let b = PauseInterval(startNs: 5_000, endNs: 6_000)
check("second span, between", isPausedNs(3_000, closed: [a, b], openSinceNs: nil), false)
check("second span, inside", isPausedNs(5_500, closed: [a, b], openSinceNs: nil), true)

// An OPEN pause has no end: everything at or after it is paused. This is the
// live case — every gate is asked about it thousands of times per take.
check("open: before", isPausedNs(999, closed: [], openSinceNs: 1_000), false)
check("open: at", isPausedNs(1_000, closed: [], openSinceNs: 1_000), true)
check("open: far after", isPausedNs(9_999_999, closed: [], openSinceNs: 1_000), true)
check("open plus closed", isPausedNs(1_500, closed: [a], openSinceNs: 5_000), true)

// ── the gate: idempotence ───────────────────────────────────────────────────
// The pill can be double-clicked. A refusal there is noise, not safety, so a
// redundant call succeeds and changes nothing — but reports false so a caller
// that cares can tell it was redundant.
let g = PauseGate()
check("fresh gate is not paused", g.isPaused, false)
check("first pause takes", g.pause(atNs: 1_000), true)
check("gate now paused", g.isPaused, true)
check("second pause is a no-op", g.pause(atNs: 1_500), false)
check("still one open pause, no intervals closed", g.intervals.count, 0)
check("resume takes", g.resume(atNs: 2_000), true)
check("gate no longer paused", g.isPaused, false)
check("one closed interval", g.intervals, [PauseInterval(startNs: 1_000, endNs: 2_000)])
check("second resume is a no-op", g.resume(atNs: 2_500), false)
check("no interval was invented by it", g.intervals.count, 1)

// The open pause must win over the closed one it has not become yet.
let g2 = PauseGate()
g2.pause(atNs: 100)
check("live pause gates a sample", g2.isPaused(atNs: 5_000), true)
g2.resume(atNs: 200)
check("after resume, a later sample is live", g2.isPaused(atNs: 5_000), false)
check("but a sample inside the closed span stays paused", g2.isPaused(atNs: 150), true)

// ── zero-length spans are discarded ─────────────────────────────────────────
// anchors-5 requires endNs > startNs. A pause and resume in the same
// nanosecond paused nothing, so it must not produce an interval that fails
// the schema the moment it is written.
let g3 = PauseGate()
g3.pause(atNs: 7_000)
check("resume in the same ns reports no real pause", g3.resume(atNs: 7_000), false)
check("and writes no interval", g3.intervals.count, 0)
check("gate is running again", g3.isPaused, false)

// A resume BEFORE its pause cannot happen from one clock, but the gate must
// not produce a negative-length interval if it ever did.
let g4 = PauseGate()
g4.pause(atNs: 9_000)
check("backwards resume writes nothing", g4.resume(atNs: 8_000), false)
check("and leaves no interval", g4.intervals.count, 0)

// ── close(): stop while paused ──────────────────────────────────────────────
let g5 = PauseGate()
g5.pause(atNs: 1_000)
g5.close(atNs: 4_000)
check("stop while paused closes the span", g5.intervals, [PauseInterval(startNs: 1_000, endNs: 4_000)])
check("and the gate is no longer paused", g5.isPaused, false)

let g6 = PauseGate()
g6.pause(atNs: 1_000); g6.resume(atNs: 2_000)
g6.close(atNs: 4_000)
check("close with nothing open adds nothing", g6.intervals.count, 1)

// ── json shape ──────────────────────────────────────────────────────────────
let j = PauseInterval(startNs: 12, endNs: 34).json
// Unwrapped deliberately. `check`'s two `some Equatable` parameters infer
// INDEPENDENTLY, so `as? Int` gives an Int? that stringifies as "Optional(12)"
// and can never equal the literal 12 — an assertion that fails for a reason
// that has nothing to do with its subject. -1 is a safe sentinel: both fields
// are non-negative by construction.
check("json startNs", j["startNs"] as? Int ?? -1, 12)
check("json endNs", j["endNs"] as? Int ?? -1, 34)

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
```

Create `helper/test/pauses.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * Pause semantics (STC-240). Pure, so this needs no grant and no display —
 * which matters because the interesting cases (a sample exactly on a boundary,
 * a zero-length span) are ones a live recording cannot be made to produce on
 * demand.
 */
describe("pause decisions (STC-240)", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "pause",
      sources: [
        "helper/src/PauseDecisions.swift",
        "helper/test/pauses/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run helper/test/pauses.test.ts`
Expected: FAIL — the harness will not compile, `cannot find 'PauseInterval' in scope`.

- [ ] **Step 3: Write the implementation**

Create `helper/src/PauseDecisions.swift`:

```swift
import Foundation

/// Pause semantics (STC-240), as pure decisions plus one thread-safe holder.
///
/// The whole feature rests on ONE predicate being asked by everybody. The
/// helper drops a sample when it is inside a paused span; the transform cuts
/// exactly those spans out of the exported timeline. If those two ever
/// disagree, the export contains a frame from a period the user believes was
/// not recorded, or loses one that was — and both look like correct video.
/// So the predicate lives here once, the intervals it reads are the same
/// intervals written to `anchors.json`, and every writer asks through a
/// `PauseGate`.

/// One paused span, session-relative integer nanoseconds, HALF-OPEN
/// `[startNs, endNs)`. The sample at `startNs` is paused; the sample at
/// `endNs` is live again.
struct PauseInterval: Equatable {
    let startNs: Int64
    let endNs: Int64

    var json: [String: Any] { ["startNs": Int(startNs), "endNs": Int(endNs)] }
}

/// THE predicate. `openSinceNs` is a pause that has begun and not yet ended —
/// the live case, which no closed interval can express yet.
///
/// A linear scan, deliberately: a take has a handful of pauses, never
/// thousands, and a sorted bisect here would answer WRONG rather than merely
/// slowly if intervals were ever non-disjoint. `zoom.ts` and
/// `zoom-override.ts` both had to make exactly this move (STC-331).
func isPausedNs(_ tNs: Int64, closed: [PauseInterval], openSinceNs: Int64?) -> Bool {
    if let open = openSinceNs, tNs >= open { return true }
    for i in closed where tNs >= i.startNs && tNs < i.endNs { return true }
    return false
}

/// Owns a take's pause intervals and answers the predicate under a lock.
///
/// Handed to every writer rather than each keeping its own copy of the state:
/// display frames arrive on ScreenCaptureKit's queue, camera and mic frames on
/// their own AVFoundation queues, and tap events on the tap's run loop. Four
/// copies of "am I paused" is four chances to disagree.
final class PauseGate {
    private let lock = NSLock()
    private var closed: [PauseInterval] = []
    private var openSinceNs: Int64?

    /// For the heartbeat — is a pause open right now.
    var isPaused: Bool {
        lock.lock(); defer { lock.unlock() }
        return openSinceNs != nil
    }

    /// For the four writer gates — was this sample's instant inside a pause.
    func isPaused(atNs tNs: Int64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return isPausedNs(tNs, closed: closed, openSinceNs: openSinceNs)
    }

    /// True if this call actually began a pause; false if one was already open.
    @discardableResult
    func pause(atNs tNs: Int64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard openSinceNs == nil else { return false }
        openSinceNs = tNs
        return true
    }

    /// True if this call ended a pause that had real duration. A resume in the
    /// same nanosecond as its pause (or, impossibly, before it) paused nothing
    /// and writes no interval — anchors-5 requires `endNs > startNs`, and an
    /// interval that fails its own schema the moment it is written is worse
    /// than no interval at all.
    @discardableResult
    func resume(atNs tNs: Int64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let start = openSinceNs else { return false }
        openSinceNs = nil
        guard tNs > start else { return false }
        closed.append(PauseInterval(startNs: start, endNs: tNs))
        return true
    }

    /// Stop arrived while paused: close the open span at the stop instant so
    /// the sidecar describes the whole take. Same zero-length rule as resume.
    func close(atNs tNs: Int64) {
        _ = resume(atNs: tNs)
    }

    var intervals: [PauseInterval] {
        lock.lock(); defer { lock.unlock() }
        return closed
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run helper/test/pauses.test.ts`
Expected: PASS, with `ALL PASS` in the harness output.

- [ ] **Step 5: Mutation-check the boundary**

Temporarily change `tNs < i.endNs` to `tNs <= i.endNs` in `isPausedNs`.
Run: `npx vitest run helper/test/pauses.test.ts`
Expected: FAIL on `exactly at end is NOT paused`. Revert the change and re-run to confirm PASS.

This is the one assertion whose failure mode is invisible in a finished video, so it is the one worth watching fail.

- [ ] **Step 6: Commit**

```bash
git add helper/src/PauseDecisions.swift helper/test/pauses/main.swift helper/test/pauses.test.ts
git commit -m "STC-240: pause intervals and the one predicate every writer asks

Half-open [startNs, endNs), a linear scan rather than a bisect (intervals
carry no promise of being disjoint if anything ever appends out of order —
the move zoom.ts and zoom-override.ts both had to make), and a gate that
discards a zero-length span rather than writing one anchors-5 would reject.

Pure, so the boundary cases a live take cannot be made to produce on demand
are tested without a grant or a display."
```

---

### Task 2: `anchors-5` — the schema and its emission

**Files:**
- Create: `schema/anchors-5.schema.json`
- Modify: `helper/src/AnchorsDoc.swift` (`anchorsDocument`, version floor at line ~159)
- Modify: `helper/test/anchors/main.swift`
- Modify: `helper/test/anchors.test.ts`

**Interfaces:**
- Consumes: `PauseInterval` from Task 1.
- Produces: `anchorsDocument(..., pauses: [PauseInterval], ...)` — a new required parameter, placed immediately after `scope:`. Emits `version: 5` and a `pauses` array when non-empty; otherwise emits exactly what it emits today.

- [ ] **Step 1: Create the schema**

Copy `schema/anchors-4.schema.json` to `schema/anchors-5.schema.json`, set `version` to `{"const": 5}`, and add to `properties`:

```json
"pauses": {
  "description": "Spans the take was paused (STC-240). Session-relative ns, half-open [startNs, endNs), disjoint and ascending. Absent when the take was never paused — such a take stays at version 4.",
  "type": "array",
  "minItems": 1,
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["startNs", "endNs"],
    "properties": {
      "startNs": { "type": "integer", "minimum": 0 },
      "endNs": { "type": "integer", "minimum": 1 }
    }
  }
}
```

`minItems: 1` is load-bearing: an empty array is not a valid v5 document, because a take with no pauses must be a v4 document. Without it, "emit the minimum version" would have two spellings and nothing would say which is right.

- [ ] **Step 2: Write the failing assertions**

Add to `helper/test/anchors/main.swift`, before the final `print`:

```swift
// ── pauses (STC-240) ────────────────────────────────────────────────────────
// Minimum-version emission: a take that was never paused is byte-for-byte the
// document it is today, at whatever version its other blocks demand.
let noPause = anchorsDocument(
    timebase: (125, 3), t0Ns: 0,
    display: DisplayGeometry(id: 1, pointWidth: 100, pointHeight: 50,
                             pixelWidth: 200, pixelHeight: 100, originX: 0, originY: 0),
    capture: CaptureGeometryDoc(width: 200, height: 100, firstFrameNs: 0),
    camera: nil, requested: false, mic: nil, micRequested: false,
    scope: .display, pauses: [], stopReason: "user", stopTNs: 1_000)
check("no pauses stays v2", noPause["version"] as? Int, 2)
check("no pauses writes no block", noPause["pauses"] == nil, true)

let paused = anchorsDocument(
    timebase: (125, 3), t0Ns: 0,
    display: DisplayGeometry(id: 1, pointWidth: 100, pointHeight: 50,
                             pixelWidth: 200, pixelHeight: 100, originX: 0, originY: 0),
    capture: CaptureGeometryDoc(width: 200, height: 100, firstFrameNs: 0),
    camera: nil, requested: false, mic: nil, micRequested: false,
    scope: .display,
    pauses: [PauseInterval(startNs: 10, endNs: 20)],
    stopReason: "user", stopTNs: 1_000)
check("a pause raises the floor to v5", paused["version"] as? Int, 5)
check("and writes one interval", (paused["pauses"] as? [[String: Any]])?.count, 1)
check("startNs survives", (paused["pauses"] as? [[String: Any]])?.first?["startNs"] as? Int, 10)
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run helper/test/anchors.test.ts`
Expected: FAIL to compile — `extraneous argument label 'pauses:'`.

- [ ] **Step 4: Implement the emission**

In `helper/src/AnchorsDoc.swift`, add the parameter to `anchorsDocument`'s signature immediately after `scope: CaptureScopeDoc`:

```swift
                       pauses: [PauseInterval],
```

Extend the doc comment above the function:

```swift
/// `pauses` raises the floor to version 5 (STC-240) when non-empty, the same
/// way `micRequested` raises it to 4 and `scope` to 3. A take that was never
/// paused writes no `pauses` key and keeps whatever version its other blocks
/// demand — so nothing about an ordinary take changes, and an older build can
/// still read it.
```

Replace the version computation (currently `var version = scope.kind == .display ? 2 : 3` followed by the mic line) with:

```swift
    var version = scope.kind == .display ? 2 : 3
    if micRequested { version = max(version, 4) }
    if !pauses.isEmpty { version = max(version, 5) }
```

And after the existing `if let micBlock { ... }` block, add:

```swift
    if !pauses.isEmpty {
        doc["pauses"] = pauses.map { $0.json }
    }
```

- [ ] **Step 5: Update the one existing caller so it compiles**

In `helper/src/Capture.swift`, `writeSidecars`, add `pauses: []` to the `anchorsDocument(...)` call immediately after `scope: captureScope,`. Task 3 replaces the empty literal with the real gate's intervals; passing `[]` here keeps the tree compiling and every existing test's expectations unchanged.

- [ ] **Step 6: Add schema validation**

In `helper/test/anchors.test.ts`, extend the existing schema-validation test to also compile `schema/anchors-5.schema.json` and assert a paused document validates against it. Follow the file's existing Ajv setup; do not introduce a second Ajv instance.

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run helper/test/anchors.test.ts helper/test/pauses.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add schema/anchors-5.schema.json helper/src/AnchorsDoc.swift helper/src/Capture.swift helper/test/anchors
git commit -m "STC-240: anchors-5 carries the pause intervals, and only when there are any

Minimum-version emission, the third time this file has done it (scope at v3,
mic at v4): a take that was never paused writes no pauses key and keeps its
current version, so nothing about an ordinary take changes.

minItems: 1 on the array is deliberate — an empty pauses list is not a valid
v5 document, because that take is a v4 document. Otherwise 'emit the minimum
version' would have two spellings and nothing would say which was right."
```

---

### Task 3: the display, tap and cursor gates

**Files:**
- Modify: `helper/src/Capture.swift` — properties (~line 95), `stream(_:didOutputSampleBuffer:)` (~720), `handleTapEvent` (~913), `recordCursorShape` (~948), `stats()` (~957), `writeSidecars` (~1140)

**Interfaces:**
- Consumes: `PauseGate`, `PauseInterval` from Task 1; `anchorsDocument(pauses:)` from Task 2.
- Produces on `CaptureSession`:
  - `let pauseGate = PauseGate()`
  - `func pause() -> Bool` / `func resume() -> Bool` — stamp from `Clock.nowNs() - t0Ns`, return whether the call changed anything
  - `var isPaused: Bool`
  - `stats()` gains `framesPaused: Int` and `paused: Bool`

- [ ] **Step 1: Add the gate and the two verbs**

Add beside the other `CaptureSession` counters (after `private var framesDropped = 0`):

```swift
    /// Frames the stream delivered while paused. Counted APART from
    /// `framesDropped`, which means "the writer would not take it" — folding
    /// paused frames in would make every paused take look as though it had
    /// dropped frames, and a diagnostic that lies is worse than none. Same
    /// reasoning as `tapDisablesAfterStop` sitting apart from `tapReenables`.
    private var framesPaused = 0

    /// Owns this take's pause intervals (STC-240). Handed to the camera and
    /// mic captures too, so all four writers answer one question.
    let pauseGate = PauseGate()

    /// Buttons this take has RECORDED a `down` for and not yet an `up`.
    ///
    /// Not a query of the OS: what must stay consistent is `events.json`
    /// itself, because `cursor.ts` derives "pressed" as a PREFIX SUM over the
    /// file's own down(+1)/up(-1) events. Only events this take actually wrote
    /// may count toward it.
    private var heldButtons: Set<Int> = []
```

Add these methods next to `stats()`:

**Corrected during final review, before merge — the snippet below is what was
ORIGINALLY planned and is now WRONG.** `pause()` as written here calls
`recordHeldButtonReleases` BEFORE opening the gate. Between the clock read and
the gate opening there are two lock round-trips and a `CGEvent(source:)`
allocation in the release path — not microseconds — so a tap event evaluated
in that window with `t >= tNs` would be appended with a timestamp already
inside the span the next line was about to open, breaking the invariant this
whole feature exists to hold. The shipped code opens the gate FIRST:

```swift
    @discardableResult
    func pause() -> Bool {
        let tNs = Int64(Clock.nowNs() - t0Ns)
        guard pauseGate.pause(atNs: tNs) else { return false }
        recordHeldButtonReleases(atNs: tNs)
        return true
    }
```

This also means a REDUNDANT pause (one already open) returns before ever
calling `recordHeldButtonReleases`, closing a second, related hazard the
original order carried: a redundant pause used to still run the release,
which could write a synthetic `up` at `tNs2 - 1` — INSIDE the already-open
span from the first pause. See `docs/STC-240-DESIGN.md`'s "The synthetic
held-button release" for the full account. The as-planned snippet, kept for
the historical record of what this task originally specified:

```swift
    var isPaused: Bool { pauseGate.isPaused }

    /// Session-relative, from the helper's own clock — the same instant the
    /// four gates then test every sample against, which is what makes the
    /// sidecar and the disk agree by construction rather than by inspection.
    @discardableResult
    func pause() -> Bool {
        let tNs = Int64(Clock.nowNs() - t0Ns)
        recordHeldButtonReleases(atNs: tNs)
        return pauseGate.pause(atNs: tNs)
    }

    /// Release anything still held, immediately BEFORE the span opens.
    ///
    /// The mirror of `recordResumeAnchor`: one synthetic event at each end of
    /// a pause. Without it, holding a button, pausing, letting go while
    /// paused, then resuming records the `down` and DROPS the `up` — and since
    /// `cursor.ts` computes pressed as a prefix sum, the depth never returns
    /// to zero. The cursor then renders pressed for the entire rest of the
    /// export, and `zoom.ts`, which treats a move while a button is held as a
    /// DRAG, opens a zoom window on every later move. One dropped event and
    /// the take is wrong from that instant to its end — while reading as a
    /// transform bug rather than a helper one.
    ///
    /// `tNs - 1`, not `tNs`, so the invariant stays absolute: no sample on
    /// disk has a pts inside a pause interval, with no carve-out for our own
    /// synthetics. At nanosecond resolution the offset is not physical.
    ///
    /// A button still physically held at resume produces no new `down` (the
    /// press happened before the pause), so the pointer reads as un-pressed
    /// for the remainder of that drag. A known, bounded inaccuracy, and
    /// strictly better than a take stuck pressed to its end.
    private func recordHeldButtonReleases(atNs tNs: Int64) {
        guard tNs > 0 else { return }          // the schema requires t >= 0
        lock.lock()
        let held = heldButtons
        heldButtons.removeAll()
        lock.unlock()
        guard !held.isEmpty else { return }
        // If the allocation fails the coordinates are lost, but the RELEASE
        // matters far more than where it happened: x/y on an `up` only satisfy
        // the schema — cursor.ts takes position from moves — while a missing
        // `up` sticks the pressed state for the whole export.
        let loc = CGEvent(source: nil)?.location ?? .zero
        lock.lock()
        for b in held.sorted() {
            events.append(["t": Int(tNs - 1), "kind": "up",
                           "x": loc.x, "y": loc.y, "button": b])
        }
        lock.unlock()
    }

    @discardableResult
    func resume() -> Bool {
        let tNs = Int64(Clock.nowNs() - t0Ns)
        let changed = pauseGate.resume(atNs: tNs)
        if changed { recordResumeAnchor(atNs: tNs) }
        return changed
    }

    /// One synthetic move at the resume instant, carrying where the pointer
    /// actually is (STC-240), in the tap's own coordinate space.
    ///
    /// Without it the cursor sim — which eases toward the pointer at 120 Hz —
    /// holds at its pre-pause position and then visibly GLIDES across the cut
    /// to wherever the mouse ended up, because every real move in between was
    /// discarded. With it, the first frame after the seam is already correct.
    ///
    /// Deliberately indistinguishable from a real move: a `synthetic: true`
    /// field would be a fact about the helper rather than about the take, and
    /// nothing downstream would branch on it.
    private func recordResumeAnchor(atNs tNs: Int64) {
        // CGEvent, NOT NSEvent.mouseLocation — the two are in different
        // coordinate spaces and only one of them matches this array.
        //
        // Every move in `events` carries the tap's `event.location`:
        // CoreGraphics global points, origin TOP-left, y down.
        // `NSEvent.mouseLocation` is a Cocoa global point: origin BOTTOM-left,
        // y up, flipped against the MAIN display's height whatever display the
        // pointer is actually over. `StillDecisions.swift`'s `localizeCursor`
        // is where that flip is owned, and it is the ONE flip in the system
        // precisely so everything downstream of events.json can assume
        // top-left.
        //
        // Writing an unconverted Cocoa point into this array would put the
        // synthetic anchor at a mirrored y — a cursor that jumps across the
        // seam and snaps back one frame later. Since the anchor exists to make
        // the seam land cleanly, that bug would defeat the feature while
        // looking implemented.
        //
        // A nil event (the allocation failing) costs the anchor, not the take:
        // the seam degrades to the glide this function exists to remove, which
        // is the old behaviour rather than a new fault.
        guard let loc = CGEvent(source: nil)?.location else { return }
        lock.lock()
        events.append(["t": Int(tNs), "kind": "move", "x": loc.x, "y": loc.y])
        lock.unlock()
    }
```

- [ ] **Step 2: Gate the display frame append**

In `stream(_:didOutputSampleBuffer:)`, inside the existing `switch decision`, replace the `.accept` case body with:

```swift
            case .accept(let pts):
                // Paused: the frame is real and correctly timed, and must not
                // reach the writer, advance `lastPtsNs`, or become
                // `firstFramePtsNs` — a take paused from its very first
                // instant has no first frame until it resumes.
                if pauseGate.isPaused(atNs: pts) {
                    framesPaused += 1; lock.unlock(); return
                }
                ptsNs = pts
                lastPtsNs = pts
                if firstFramePtsNs < 0 { firstFramePtsNs = pts }
```

- [ ] **Step 3: Gate the tap and the cursor sampler**

In `handleTapEvent`, in the `.event(let t, let kind, let button)` case, insert before building `e`:

```swift
            // Nothing is recorded while paused (STC-240). The tap stays LIVE —
            // tearing it down and re-creating it would re-enter the Input
            // Monitoring path STC-315 mapped, and `tapCreate` fails
            // synchronously, so a resume could fail in a way a pause cannot
            // report. Dropping the event is the cheap, reversible half.
            if pauseGate.isPaused(atNs: Int64(t)) { return }
```

In the SAME `.event` case, the recorded event must also maintain
`heldButtons`. Find the existing `lock.lock(); events.append(e); lock.unlock()`
and add the tracking inside that same lock:

```swift
            lock.lock()
            events.append(e)
            // Track what is held so a pause can release it (see
            // recordHeldButtonReleases). Updated only for events this take
            // actually RECORDS, which is what keeps it in step with the prefix
            // sum cursor.ts computes over the same file. It sits after the
            // paused check by construction, so nothing dropped can reach it.
            if let button {
                if kind == "down" { heldButtons.insert(button) }
                else if kind == "up" { heldButtons.remove(button) }
            }
            lock.unlock()
```

This also disposes of a concern the spec raised: it warned that disabling and
re-enabling the tap around a pause would land in `decideCursorEvent`'s
`tapDisabledByUserInput` branch and make `stats().tapDisabled` count our own
pauses as starvation, needing the same `stoppingBegan`-style bookkeeping
`stop()` has. By never disabling the tap, none of that is needed — the
accounting problem is avoided rather than solved.

In `recordCursorShape`, insert after the existing `guard observedNs >= t0Ns` line:

```swift
        if pauseGate.isPaused(atNs: Int64(observedNs - t0Ns)) { return }
```

- [ ] **Step 4: Report it**

In `stats()`, add to the returned dictionary alongside `framesDropped`:

```swift
         "framesPaused": framesPaused,
         "paused": pauseGate.isPaused,
```

- [ ] **Step 5: Write the intervals out**

In `writeSidecars`, before the `lock.unlock()` that follows the local copies, close any open pause at the stop instant and read the result:

```swift
        // Stop while paused: the open span closes at the stop instant, so the
        // sidecar describes the whole take rather than trailing off.
        let stopTNs = Int64(Clock.nowNs() - t0Ns)
        pauseGate.close(atNs: stopTNs)
        let pauses = pauseGate.intervals
```

Replace `pauses: []` (added in Task 2 step 5) with `pauses: pauses`, and replace the `stopTNs:` argument with `stopTNs: Int(stopTNs)` so the stop instant and the pause-close instant are the same read of the clock rather than two.

**This one edit covers every other "while paused" edge case the spec lists.**
A display reconfiguration, a stream death, a window resize, `quit`, a closed
stdin and a signal all end a take through `stop(reason:)` and therefore through
`writeSidecars`, so all of them close the open span at their own stop instant
without a branch of their own. There is deliberately no per-reason handling to
write, and nothing to test per reason — only this line to get right.

- [ ] **Step 6: Build and run the existing suite**

Run: `helper/build.sh && echo BUILD_OK`
Expected: `BUILD_OK`. A non-zero exit leaves the old binary in place — do not proceed on a stale binary.

Run: `npx vitest run helper/test/`
Expected: PASS, with no change to any existing assertion. Nothing can pause yet, so every existing test must behave exactly as before; a failure here means a gate fired when nothing was paused.

- [ ] **Step 7: Commit**

```bash
git add helper/src/Capture.swift
git commit -m "STC-240: the display, tap and cursor-shape gates

Paused frames are counted apart from dropped ones — folding them together
would make every paused take look as though the writer had rejected frames.
A paused frame also may not become firstFramePtsNs: a take paused from its
first instant has no first frame until it resumes.

The tap stays live and its events are discarded, rather than the tap being
disabled: tapCreate fails synchronously (STC-315), so a resume could fail in
a way a pause has no way to report.

One synthetic move at the resume instant, because the cursor sim eases at
120 Hz and would otherwise glide across the seam from its pre-pause position."
```

---

### Task 4: the camera and mic gates

**Files:**
- Modify: `helper/src/CameraCapture.swift` — `init` (line ~98), `captureOutput` (line ~251)
- Modify: `helper/src/MicCapture.swift` — `init` (line ~89), `captureOutput` (line ~237)
- Modify: `helper/src/Capture.swift` — `startCameraAsync` (line ~565), the mic equivalent (line ~620)

**Interfaces:**
- Consumes: `PauseGate` from Task 1, `CaptureSession.pauseGate` from Task 3.
- Produces: `CameraCapture(dir:t0Ns:pauseGate:)` and `MicCapture(dir:t0Ns:deviceUid:pauseGate:)`.

- [ ] **Step 1: Thread the gate into the camera**

In `CameraCapture.swift`, add a stored property beside the existing ones:

```swift
    /// The take's pause gate (STC-240) — not a copy of its state. A camera
    /// frame written during a pause would be carried into the cut: the first
    /// frame after a resume selects the newest camera frame at or before it,
    /// which would be one from inside the paused span.
    private let pauseGate: PauseGate
```

Change the initializer signature to `init(dir: URL, t0Ns: UInt64, pauseGate: PauseGate)` and assign `self.pauseGate = pauseGate` alongside the existing assignments.

In `captureOutput`, immediately before the `let outcome = gate.append(pb, ...)` line:

```swift
            if pauseGate.isPaused(atNs: rel) { return }
```

- [ ] **Step 2: Thread the gate into the mic**

In `MicCapture.swift`, add the same stored property with this comment instead:

```swift
    /// The take's pause gate (STC-240). This one is the privacy property
    /// rather than symmetry: a pause that left mic.m4a recording would capture
    /// audio the user believes is off. The samples must never reach the file,
    /// not merely be cut from the export.
    private let pauseGate: PauseGate
```

Change the initializer to `init(dir: URL, t0Ns: UInt64, deviceUid: String, pauseGate: PauseGate)` and assign it.

In `captureOutput`, before the `guard let retimed = Self.retimed(sb, toNs: rel)` line:

```swift
            if pauseGate.isPaused(atNs: rel) { return }
```

Gating before `retimed()` rather than after skips the sample-buffer copy for a sample that is going nowhere.

- [ ] **Step 3: Pass it at both construction sites**

In `Capture.swift`, `startCameraAsync`: change `CameraCapture(dir: dir, t0Ns: t0Ns)` to `CameraCapture(dir: dir, t0Ns: t0Ns, pauseGate: pauseGate)`.

In the mic equivalent: change `MicCapture(dir: dir, t0Ns: t0Ns, deviceUid: deviceUid)` to `MicCapture(dir: dir, t0Ns: t0Ns, deviceUid: deviceUid, pauseGate: pauseGate)`.

- [ ] **Step 4: Confirm there is no fourth construction site**

Run: `grep -rn 'CameraCapture(\|MicCapture(' helper/ app/ --include=*.swift --include=*.ts`
Expected: exactly the two call sites changed above, plus their declarations. Anything else is a caller this task missed — the "fourth caller" failure this repo has recorded for `loadSession`.

- [ ] **Step 5: Build and test**

Run: `helper/build.sh && echo BUILD_OK && npx vitest run helper/test/`
Expected: `BUILD_OK` and PASS.

- [ ] **Step 6: Commit**

```bash
git add helper/src/CameraCapture.swift helper/src/MicCapture.swift helper/src/Capture.swift
git commit -m "STC-240: the camera and mic gates — pause means nothing is written, anywhere

Both take the take's gate rather than a copy of its state: display frames
arrive on ScreenCaptureKit's queue and these two on their own AVFoundation
queues, and four copies of 'am I paused' is four chances to disagree.

The mic gate is the privacy property, not symmetry. A pause that left
mic.m4a recording captures audio the user believes is off — cutting it from
the export later is not the same thing as never writing it."
```

---

### Task 5: the `pause` and `resume` commands

**Files:**
- Modify: `helper/src/main.swift` — `handle` dispatch (line ~131), `startHeartbeat` (line ~391)
- Modify: `helper/test/capture.test.ts`

**Interfaces:**
- Consumes: `CaptureSession.pause()`, `.resume()`, `.isPaused` from Task 3.
- Produces: IPC replies `{"type": "paused", "paused": true, "changed": bool}` and `{"type": "resumed", "paused": false, "changed": bool}`; heartbeat field `paused: bool` while recording.

- [ ] **Step 1: Write the failing IPC tests**

Add to `helper/test/capture.test.ts`, following the file's existing spawn-and-drive helpers:

```ts
  test("pause and resume are refused when nothing is recording", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));

    h.send({ cmd: "pause", seq: 1 });
    const p = await waitFor(() => h.fd3.find((l) => l.seq === 1), 15_000, "pause reply");
    expect(p.ev).toBe("error");
    expect(p.code).toBe("bad-state");

    h.send({ cmd: "resume", seq: 2 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 2), 15_000, "resume reply");
    expect(r.ev).toBe("error");
    expect(r.code).toBe("bad-state");
  }, 30_000);

  test("an unknown command is still unknown — the new cases did not widen the switch", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "paws", seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 15_000, "unknown reply");
    expect(r.ev).toBe("error");
    expect(r.code).toBe("unknown-command");
  }, 30_000);
```

Three things about this file's idiom, each of which a from-memory guess gets
wrong: a reply's event name is **`ev`**, not `type`; replies are matched by
**`seq`** off the `fd3` sink, not awaited from `send`; and there is no `close()`
— the file's `afterEach` SIGKILLs every spawned helper.

The second test is the control. Without it, a dispatch that answered *every*
unrecognised verb with `bad-state` would satisfy the first test while having
broken the protocol.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run helper/test/capture.test.ts`
Expected: FAIL — `pause` currently answers `unknown-command`, so the first test's `code` assertion fails.

- [ ] **Step 3: Implement the dispatch**

In `helper/src/main.swift`, add to the `switch` in `handle`, immediately after `case "stop":`:

```swift
        case "pause":
            setPaused(true, seq: seq)
        case "resume":
            setPaused(false, seq: seq)
```

Add the method beside `stop`:

```swift
    /// Pause and resume (STC-240).
    ///
    /// Deliberately NOT a new `State` case: a paused take is still
    /// `.recording`. Adding `.paused` would mean auditing every
    /// `state == .recording` site in this file, and that is precisely the
    /// mistake STC-376 cost a take its moov atom for — `shutdown()`'s guard
    /// read `.recording || .starting` and fell through neither once the state
    /// had reached `.stopping`.
    ///
    /// Idempotent. `changed` reports whether this call did anything, so a
    /// caller that cares can tell; the pill does not, because a double-click
    /// on a pause button is not an error worth a dialog.
    private func setPaused(_ want: Bool, seq: Int?) {
        guard state == .recording, let capture else {
            IO.send("error", seq: seq,
                    ["code": "bad-state",
                     "detail": "cannot \(want ? "pause" : "resume") while \(state.rawValue)"])
            return
        }
        let changed = want ? capture.pause() : capture.resume()
        IO.send(want ? "paused" : "resumed", seq: seq,
                ["paused": capture.isPaused, "changed": changed])
    }
```

In `startHeartbeat`, inside the existing `if self.state == .recording {` block, add:

```swift
                o["paused"] = self.capture?.isPaused ?? false
```

- [ ] **Step 4: Run to verify it passes**

Run: `helper/build.sh && echo BUILD_OK && npx vitest run helper/test/capture.test.ts`
Expected: `BUILD_OK` and PASS.

- [ ] **Step 5: Typecheck and run the whole no-grant suite**

Run: `npm run typecheck`
Expected: clean, all three passes.

Run: `npm test`
Expected: PASS. This is the gate on PR A being genuinely invisible — nothing user-facing can pause, so every existing test must be unchanged.

- [ ] **Step 6: Commit**

```bash
git add helper/src/main.swift helper/test/capture.test.ts
git commit -m "STC-240: pause and resume commands, and no sixth App.State case

A paused take stays .recording, with paused-ness riding as a boolean on the
heartbeat. Adding .paused would mean auditing every state == .recording site
in this file, which is exactly what STC-376 cost a take its moov atom for.

Idempotent, and the reply says whether the call changed anything. A
double-click on a pause button is not an error worth reporting.

The unknown-command test is the control: without it, a dispatch answering
every unrecognised verb with bad-state would pass the pause test while
having broken the protocol."
```

---

### Task 6: the grant test — the real round trip and the disk invariant

**Files:**
- Modify: `helper/test/capture.grant.test.ts` — add a `describe` block at the end

**Why not a new file:** `spawnHelper`/`collect`/`waitFor` are file-local in both
`capture.test.ts` and `capture.grant.test.ts` — two copies already. A new
`pause-resume.grant.test.ts` needs them too, and would make three. Lifting them
into a shared module is the right fix and is **not** this PR's job; pause is
capture behaviour, so its granted tests belong in the capture suite that already
has the helpers. Note the duplication for whoever does lift them.

**Interfaces:**
- Consumes: everything above. Needs a Screen Recording **and** Input Monitoring grant (STC-315 made cursor telemetry a hard requirement), so it lives in a `*.grant.test.ts` run by `npm run test:capture`, never on CI.

- [ ] **Step 1: Write the test**

Append to `helper/test/capture.grant.test.ts`:

```ts
describe("capture — pause and resume on a live take (STC-240)", () => {
  test("the display gate fires, and nothing on disk sits inside a pause", async () => {
    const probe = await tryOneRecording();
    if (probe.ev !== "started") throw explainFailedStart(probe, "pause/resume");

    const dir = session();
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir, seq: 1 });
    expect((await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "started")).ev)
      .toBe("started");

    await sleep(1000);
    h.send({ cmd: "pause", seq: 2 });
    const paused = await waitFor(() => h.fd3.find((l) => l.seq === 2), 10_000, "paused");
    expect(paused.ev).toBe("paused");
    expect(paused.paused).toBe(true);
    expect(paused.changed).toBe(true);

    // 2 s, not 200 ms: a short pause is indistinguishable from a momentarily
    // idle screen, which VFR legitimately emits no frames for. At 60 fps this
    // span would carry ~120 frames if the gate did nothing.
    await sleep(2000);

    // Idempotence on the real helper, not only in the pure tests.
    h.send({ cmd: "pause", seq: 3 });
    const again = await waitFor(() => h.fd3.find((l) => l.seq === 3), 10_000, "pause again");
    expect(again.ev).toBe("paused");
    expect(again.changed).toBe(false);

    h.send({ cmd: "resume", seq: 4 });
    const resumed = await waitFor(() => h.fd3.find((l) => l.seq === 4), 10_000, "resumed");
    expect(resumed.ev).toBe("resumed");
    expect(resumed.paused).toBe(false);
    expect(resumed.changed).toBe(true);

    await sleep(1000);
    h.send({ cmd: "stop", seq: 5 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 5), 30_000, "stopped");
    expect(stopped.ev).toBe("stopped");

    // The display gate fired. Read from the stop reply's own stats rather than
    // polled mid-take: heartbeat stats land on the LOSSY stdout channel at a
    // 2 s default interval, so a test timing itself against them would be
    // racing a channel designed to drop messages.
    expect(stopped.framesPaused as number,
      "frames arrived during the pause and were gated").toBeGreaterThan(0);
    expect(stopped.frames as number, "the take still recorded").toBeGreaterThan(0);

    const load = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
    const anchors = load("anchors.json");
    expect(anchors.version).toBe(5);
    expect(anchors.pauses).toHaveLength(1);
    const [span] = anchors.pauses;
    expect(span.endNs).toBeGreaterThan(span.startNs);

    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(JSON.parse(
      readFileSync(join(root, "schema/anchors-5.schema.json"), "utf8")));
    expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);

    // THE INVARIANT — for events.json ONLY (display.mp4 carries a one-frame
    // tolerance the display gate cannot avoid, since it tests `displayTime`,
    // a scheduled-ahead-of-delivery time; see docs/STC-240-DESIGN.md). The
    // helper's drop rule and the transform's cut rule are the same predicate
    // over the same intervals, so a survivor means they have drifted — and
    // PR B would then cut a real sample out of the export, which looks like
    // correct video. Half-open, so the synthetic re-anchor AT endNs is
    // outside the span and needs no exception carved for it.
    const events = load("events.json");
    const inside = events.events.filter(
      (e: { t: number }) => e.t >= span.startNs && e.t < span.endNs);
    expect(inside, `events recorded inside the pause: ${JSON.stringify(inside)}`).toEqual([]);

    // And the one thing that must exist at the seam.
    const anchor = events.events.find(
      (e: { t: number; kind: string }) => e.kind === "move" && e.t === span.endNs);
    expect(anchor, "a resume must leave one synthetic move at its own instant").toBeTruthy();
  }, 90_000);
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:capture -- helper/test/capture.grant.test.ts`
Expected: PASS. A `SKIP-GRANT` outcome means the terminal lacks a grant — the helper is spawned directly and inherits the launching process's TCC identity, so granting `STCTestHost` says nothing about it. Grant the terminal in both System Settings panes and re-run.

- [ ] **Step 3: Watch the invariant fail**

Temporarily remove the `if pauseGate.isPaused(atNs: Int64(t)) { return }` line from `handleTapEvent`, rebuild, and re-run.
Expected: FAIL on `no event may be recorded inside a pause`.

Restore the line, rebuild, re-run, and confirm PASS. The invariant is the whole point of PR A; a version of it that has never been watched failing is indistinguishable from one that cannot fail.

- [ ] **Step 4: Commit**

```bash
git add helper/test/capture.grant.test.ts
git commit -m "STC-240: the disk invariant, on real hardware

No event on disk may have a pts inside a recorded pause interval — checked
for events.json, where the tap fires synchronously so the guarantee is
genuinely absolute. display.mp4 carries a one-frame tolerance the display
gate cannot avoid (it tests displayTime, a scheduled-ahead-of-delivery time,
not a capture time) and is not asserted here; PR B's cut must tolerate it.
The helper's drop rule and the transform's cut rule are the same predicate
over the same intervals, so a survivor means they have drifted — and PR B
would then cut a real frame out of the export, which looks like correct
video.

The 2 s pause is not arbitrary: a short one is indistinguishable from a
momentarily idle screen, which VFR legitimately produces no frames for."
```

---

## Done means

- [ ] `npm test` green, with no existing assertion changed
- [ ] `npm run typecheck` clean on all three passes
- [ ] `npm run test:capture` green on a Mac with both grants
- [ ] The invariant watched failing and then passing (Task 6 Step 3)
- [ ] The boundary mutation watched failing and then passing (Task 1 Step 5)
- [ ] A take that is never paused writes a byte-identical `anchors.json` to today's

## What PR A deliberately does not do

Nothing user-facing can pause. There is no UI, no hotkey, and the transform does not act on `pauses` yet.

**Correction (final review, before PR A merged):** this section originally claimed `session.ts` "will ignore the key it cannot parse" — that is FALSE. `session.ts` gates on the anchors *version*, not on individual keys, and a v5 document would have been refused outright (`anchors.json version 5 is not supported`) had `SUPPORTED_ANCHORS_VERSIONS` (app/src/library-items.ts) and `session.ts`'s own version guard not both been widened to accept 5 as part of landing this PR. With that fix in, a v5 document loads and its `pauses` array is accepted-and-IGNORED — `render()` never consults it — so a take paused via a hand-driven `echo '{"cmd":"pause"}'` **freezes** on export rather than cutting, which is the graceful degradation the spec's §"key question" describes, not a bug to fix here. PR B makes it cut. See `app/test/take-list.test.ts`'s "the accepted anchors versions cover every anchors schema on disk" for the guard that now prevents a schema being minted without both gates being wired.

## Next

PR B (`transform/src/timeline.ts` and the cut) gets its own plan once this lands, because its interfaces depend on the shape of A's `anchors.pauses` parse surface. PR C (the pill split) follows B.
