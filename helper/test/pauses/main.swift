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
