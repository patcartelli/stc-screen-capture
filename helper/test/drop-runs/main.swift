import Foundation

// STC-238: DropRunDecisions.swift's rules, asserted directly.

var failures: [String] = []
func check(_ ok: Bool, _ label: String) { if !ok { failures.append(label) } }

let ms: Int64 = 1_000_000

// Nothing dropped: no run, ever.
do {
    var t = DropRunTracker()
    for i in 0..<10 { check(t.record(appended: true, ptsNs: Int64(i) * 16 * ms) == nil, "a frame that went in reports nothing") }
    check(t.close() == nil, "a take with no drops closes with no run")
}

// One hole, closed by the next frame that goes in.
do {
    var t = DropRunTracker()
    _ = t.record(appended: true, ptsNs: 0)
    check(t.record(appended: false, ptsNs: 16 * ms) == nil, "a drop does not report on its own")
    check(t.record(appended: false, ptsNs: 33 * ms) == nil, "nor does the next")
    check(t.record(appended: false, ptsNs: 50 * ms) == nil, "nor the one after")
    let run = t.record(appended: true, ptsNs: 66 * ms)
    check(run == DropRun(startNs: 16 * ms, endNs: 50 * ms, count: 3),
          "the frame after the hole reports it: first and last DROPPED pts, and how many (got \(String(describing: run)))")
    check(t.record(appended: true, ptsNs: 83 * ms) == nil, "the run is reported once")
    check(t.close() == nil, "and not again at stop")
}

// Two holes are two runs, each with its own count.
do {
    var t = DropRunTracker()
    _ = t.record(appended: false, ptsNs: 10 * ms)
    let a = t.record(appended: true, ptsNs: 20 * ms)
    _ = t.record(appended: false, ptsNs: 30 * ms)
    _ = t.record(appended: false, ptsNs: 40 * ms)
    let b = t.record(appended: true, ptsNs: 50 * ms)
    check(a == DropRun(startNs: 10 * ms, endNs: 10 * ms, count: 1), "a single dropped frame is a run of one")
    check(b == DropRun(startNs: 30 * ms, endNs: 40 * ms, count: 2), "the second hole does not inherit the first's count")
}

// A hole still open at stop is reported by close(), and nothing after counts.
do {
    var t = DropRunTracker()
    _ = t.record(appended: true, ptsNs: 0)
    _ = t.record(appended: false, ptsNs: 16 * ms)
    _ = t.record(appended: false, ptsNs: 33 * ms)
    check(t.close() == DropRun(startNs: 16 * ms, endNs: 33 * ms, count: 2), "stop reports the open run")
    check(t.record(appended: false, ptsNs: 50 * ms) == nil, "a teardown drop after close is ignored")
    check(t.record(appended: true, ptsNs: 66 * ms) == nil, "and cannot reopen a run")
    check(t.close() == nil, "a second close reports nothing")
}

// Teardown's refusals alone are not a hole.
do {
    var t = DropRunTracker()
    _ = t.record(appended: true, ptsNs: 0)
    check(t.close() == nil, "closing with no open run reports nothing")
    _ = t.record(appended: false, ptsNs: 16 * ms)
    check(t.close() == nil, "drops after close never surface")
}

// The warning's shape.
do {
    let w = DropRun(startNs: 5, endNs: 9, count: 2).warning
    check(w["code"] as? String == "frames-dropped", "code")
    check(w["startNs"] as? Int == 5 && w["endNs"] as? Int == 9 && w["count"] as? Int == 2, "fields are Ints on the wire")
}

// The fault window, relative to the first written frame.
do {
    let first: Int64 = 7_000 * ms
    check(!encoderStallFaultCovers(ptsNs: first, firstFramePtsNs: first), "the first frame is written")
    check(!encoderStallFaultCovers(ptsNs: first + ENCODER_STALL_FAULT_AFTER_NS - 1, firstFramePtsNs: first), "just before the window is written")
    check(encoderStallFaultCovers(ptsNs: first + ENCODER_STALL_FAULT_AFTER_NS, firstFramePtsNs: first), "the window's start is refused")
    check(encoderStallFaultCovers(ptsNs: first + ENCODER_STALL_FAULT_AFTER_NS + ENCODER_STALL_FAULT_DURATION_NS - 1, firstFramePtsNs: first), "its last ns is refused")
    check(!encoderStallFaultCovers(ptsNs: first + ENCODER_STALL_FAULT_AFTER_NS + ENCODER_STALL_FAULT_DURATION_NS, firstFramePtsNs: first), "its end is written again")
    check(!encoderStallFaultCovers(ptsNs: 600 * ms, firstFramePtsNs: -1), "no first frame yet: nothing is refused")
}

if failures.isEmpty {
    print("ALL PASS")
} else {
    for f in failures { print("FAIL: \(f)") }
    exit(1)
}
