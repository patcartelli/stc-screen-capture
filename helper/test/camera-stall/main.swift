import Foundation
var failures = 0
func expect(_ label: String, _ ok: Bool) { print(ok ? "ok   \(label)" : "FAIL \(label)"); if !ok { failures += 1 } }

let s: Int64 = 1_000_000_000
let ms: Int64 = 1_000_000
let fps30: Int64 = 33_350_000          // the real camera's interval, measured 2026-10-15
let latency: Int64 = 100 * ms          // a camera's PTS is ~0.1 s behind its arrival
let tick: Int64 = 250 * ms             // CameraStall.checkIntervalSeconds

/// One simulated stretch: frames ARRIVE every `step` while `delivering(t)` says so, the
/// check runs every 250 ms, and `pause(t)` is the take's pause state at `t`. Returns
/// every change, in order, with the time it was decided.
@discardableResult
func run(_ tr: inout CameraStallTracker, from: Int64, to: Int64, step: Int64 = fps30,
         delivering: (Int64) -> Bool = { _ in true },
         pause: (Int64) -> PauseState = { _ in .none }) -> [(Int64, CameraStallChange)] {
    var out: [(Int64, CameraStallChange)] = []
    var nextFrame = from, nextCheck = from + tick
    while min(nextFrame, nextCheck) < to {
        if nextFrame <= nextCheck {
            if delivering(nextFrame),
               let c = tr.frameArrived(nowNs: nextFrame, ptsNs: nextFrame - latency, pause: pause(nextFrame)) {
                out.append((nextFrame, c))
            }
            nextFrame += step
        } else {
            if let c = tr.check(nowNs: nextCheck, pause: pause(nextCheck)) { out.append((nextCheck, c)) }
            nextCheck += tick
        }
    }
    return out
}
func began(_ c: [(Int64, CameraStallChange)]) -> [(Int64, StallSpan)] {
    c.compactMap { if case .began(let sp) = $0.1 { return ($0.0, sp) }; return nil }
}

expect("N is 3 s (measured, STC-553)", CameraStall.thresholdNs == 3 * s)

// A healthy camera says nothing, ever.
var healthy = CameraStallTracker()
expect("healthy: no change in 5 min", run(&healthy, from: s, to: 300 * s).isEmpty)
expect("healthy: no spans", healthy.spansSoFar().isEmpty)

// A slow but alive camera (12 frames in 11 s) says nothing.
var slow = CameraStallTracker()
expect("slow (0.92 s between frames): no change", run(&slow, from: s, to: 60 * s, step: 11 * s / 12).isEmpty)
// Nor does one a little under N.
var nearly = CameraStallTracker()
expect("2.9 s between frames: no change", run(&nearly, from: s, to: 60 * s, step: 2_900 * ms).isEmpty)

// No frame yet: nothing to stall (camera-no-frames' case).
var never = CameraStallTracker()
expect("no first frame: never a stall", run(&never, from: 0, to: 30 * s, delivering: { _ in false }).isEmpty)

// A camera that stops at 10 s and comes back at 25 s.
var rec = CameraStallTracker()
let changes = run(&rec, from: s, to: 40 * s, delivering: { $0 < 10 * s || $0 >= 25 * s })
let b = began(changes)
expect("recovered: one warning for one stall", b.count == 1)
let lastArrival = (10 * s - s) / fps30 * fps30 + s   // the last frame before 10 s
if let (when, span) = b.first {
    expect("said within N + one check of the last frame (\(when - lastArrival) ns)",
           when - lastArrival >= CameraStall.thresholdNs && when - lastArrival <= CameraStall.thresholdNs + tick)
    expect("the span starts at the last frame's PTS, where the picture froze", span.startNs == lastArrival - latency)
}
expect("recovered: the span closes at the first frame back", rec.spansSoFar().count == 1
       && rec.spansSoFar()[0].endNs.map { $0 >= 25 * s - latency && $0 < 25 * s - latency + fps30 } == true)
expect("recovered: nothing open", rec.open == nil)

// Re-armed: a second stall after recovery warns again (one per stall).
var twice = CameraStallTracker()
let two = run(&twice, from: s, to: 60 * s, delivering: { !($0 >= 10 * s && $0 < 20 * s) && !($0 >= 30 * s && $0 < 34 * s) })
expect("two stalls, two warnings", began(two).count == 2)
expect("two stalls, two closed spans", twice.spansSoFar().count == 2 && twice.spansSoFar().allSatisfy { $0.endNs != nil })

// A stall under 5 s (what the Mac check could not see) is still caught: 4 s.
var four = CameraStallTracker()
expect("a 4 s stall warns", began(run(&four, from: s, to: 20 * s, delivering: { !($0 >= 10 * s && $0 < 14 * s) })).count == 1)
// A 2.5 s gap is not a stall.
var short = CameraStallTracker()
expect("a 2.5 s gap does not", run(&short, from: s, to: 20 * s, delivering: { !($0 >= 10 * s && $0 < 12_500 * ms) }).isEmpty)

// A camera that never comes back: the span stays open (the stop closes it).
var dead = CameraStallTracker()
expect("never recovers: one warning", began(run(&dead, from: s, to: 60 * s, delivering: { $0 < 10 * s })).count == 1)
expect("never recovers: one span, still open", dead.spansSoFar().count == 1 && dead.spansSoFar()[0].endNs == nil)

// Frames dropped by a pause are not a stall: a 20 s pause with the camera running is
// nothing, and neither is a 20 s pause with the camera off (frames stop for the pause).
let pause20: (Int64) -> PauseState = { t in
    t >= 10 * s && t < 30 * s ? PauseState(openSinceNs: 10 * s, lastResumeNs: nil)
        : t >= 30 * s ? PauseState(openSinceNs: nil, lastResumeNs: 30 * s) : .none
}
var paused = CameraStallTracker()
expect("paused, camera delivering: nothing", run(&paused, from: s, to: 40 * s, pause: pause20).isEmpty)
var pausedQuiet = CameraStallTracker()
expect("paused, camera silent only during the pause: nothing",
       run(&pausedQuiet, from: s, to: 40 * s, delivering: { $0 < 10 * s || $0 >= 30 * s }, pause: pause20).isEmpty)

// After a resume, N runs from the resume, not from the last frame before the pause.
var afterResume = CameraStallTracker()
let ar = run(&afterResume, from: s, to: 40 * s, delivering: { $0 < 10 * s }, pause: pause20)
if let (when, span) = began(ar).first {
    expect("silent across the pause and after: said N after the RESUME (\(when))",
           when >= 30 * s + CameraStall.thresholdNs && when <= 30 * s + CameraStall.thresholdNs + tick)
    expect("...and the span starts at the resume, not inside the pause", span.startNs == 30 * s)
} else { expect("silent after a resume: a stall is said", false) }

// A pause closes an open stall at the pause's own start, and the pause is not in it.
let pauseAt20: (Int64) -> PauseState = { t in
    t >= 20 * s && t < 30 * s ? PauseState(openSinceNs: 20 * s, lastResumeNs: nil)
        : t >= 30 * s ? PauseState(openSinceNs: nil, lastResumeNs: 30 * s) : .none
}
var cut = CameraStallTracker()
let cc = run(&cut, from: s, to: 32 * s, delivering: { $0 < 10 * s || $0 >= 31 * s }, pause: pauseAt20)
expect("a pause mid-stall: one warning", began(cc).count == 1)
expect("a pause mid-stall: the span ends at the pause", cut.spansSoFar().count == 1 && cut.spansSoFar()[0].endNs == 20 * s)

// A frame arriving inside a pause closes an open stall at the pause, not at the frame.
var inPause = CameraStallTracker()
_ = inPause.frameArrived(nowNs: s, ptsNs: s - latency, pause: .none)
_ = inPause.check(nowNs: 5 * s, pause: .none)
let c = inPause.frameArrived(nowNs: 7 * s, ptsNs: 7 * s - latency, pause: PauseState(openSinceNs: 6 * s, lastResumeNs: nil))
expect("a frame inside a pause ends the stall at the pause", c == .ended(StallSpan(startNs: s - latency, endNs: 6 * s)))

// The fault's window: 3 s after the first frame, 4 s long, or to the end.
expect("fault: nothing before the first frame", !cameraStallFaultCovers(ptsNs: 5 * s, firstFramePtsNs: -1, forever: false))
expect("fault: 3 s in is withheld", cameraStallFaultCovers(ptsNs: 4 * s, firstFramePtsNs: s, forever: false))
expect("fault: 7 s in is back", !cameraStallFaultCovers(ptsNs: 8 * s, firstFramePtsNs: s, forever: false))
expect("fault (-end): 7 s in is still withheld", cameraStallFaultCovers(ptsNs: 8 * s, firstFramePtsNs: s, forever: true))

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
