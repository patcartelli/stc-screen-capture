import Foundation

// STC-561: HoldFrameDecisions.swift's rules, asserted directly.

var failures: [String] = []
func check(_ ok: Bool, _ label: String) { if !ok { failures.append(label) } }

let ms: Int64 = 1_000_000
let s: Int64 = 1_000_000_000

// The constants the fix rests on.
check(WRITER_MAX_SAMPLE_DURATION_NS == 2_147_483_648, "the limit is 2^31 ns")
check(HOLD_FRAME_INTERVAL_NS < HOLD_FRAME_DUE_NS, "a hold is due only after the PTS it will carry")
// The longest sample a held take can contain: a hold due at DUE, written up to
// one check late, then a real frame resuming just after it at most one
// interval on. Every term must fit under the writer's limit with room.
let worstSample = HOLD_FRAME_INTERVAL_NS + Int64(HOLD_FRAME_CHECK_INTERVAL_SECONDS * 1e9)
check(worstSample < WRITER_MAX_SAMPLE_DURATION_NS / 2 + 500 * ms,
      "a held take's longest sample (\(worstSample) ns) stays far under the limit")

// Nothing before the first frame: no pixels, and the start gap is an edit.
check(decideHoldFrame(lastWrittenPtsNs: -1, lastAcceptedPtsNs: -1, nowNs: 60 * s) == nil,
      "no hold before the first frame")

// A moving screen: frames keep coming, no hold.
check(decideHoldFrame(lastWrittenPtsNs: 10 * s, lastAcceptedPtsNs: 10 * s, nowNs: 10 * s + 17 * ms) == nil,
      "a fresh frame needs no hold")
check(decideHoldFrame(lastWrittenPtsNs: 10 * s, lastAcceptedPtsNs: 10 * s, nowNs: 10 * s + 1_499 * ms) == nil,
      "not due one ms early")

// A still screen: due at 1.5 s, written at +1 s.
check(decideHoldFrame(lastWrittenPtsNs: 10 * s, lastAcceptedPtsNs: 10 * s, nowNs: 11 * s + 500 * ms) == 11 * s,
      "due at 1.5 s, held at last + 1 s")
check(decideHoldFrame(lastWrittenPtsNs: 10 * s, lastAcceptedPtsNs: 10 * s, nowNs: 11 * s + 700 * ms) == 11 * s,
      "a late check holds at the same PTS")

// A long stillness chains: each hold is the next one's "last written".
do {
    var last: Int64 = 10 * s
    var now: Int64 = 10 * s
    var held: [Int64] = []
    while now < 10 * s + 165 * s {           // take 2's screen saver: 165 s
        now += 250 * ms
        if let pts = decideHoldFrame(lastWrittenPtsNs: last, lastAcceptedPtsNs: last, nowNs: now) {
            check(pts > last, "a hold moves forward")
            check(pts - last <= HOLD_FRAME_INTERVAL_NS, "no sample longer than the interval (\(pts - last))")
            held.append(pts); last = pts
        }
    }
    check(held.count >= 160, "a 165 s stillness is about one hold a second (got \(held.count))")
    // The real frame after the screen saver: its gap to the last hold.
    let resume = now + 7 * ms
    check(resume - last < WRITER_MAX_SAMPLE_DURATION_NS, "the frame after the stillness fits (\(resume - last) ns)")
}

// Frames the writer refused since the last written one: the hold must come
// after them, and only once that is safe from frames still arriving.
check(decideHoldFrame(lastWrittenPtsNs: 10 * s, lastAcceptedPtsNs: 11 * s + 400 * ms, nowNs: 11 * s + 600 * ms) == nil,
      "refused frames just behind now: wait")
check(decideHoldFrame(lastWrittenPtsNs: 10 * s, lastAcceptedPtsNs: 11 * s + 400 * ms, nowNs: 12 * s) == 11 * s + 400 * ms + 1,
      "then hold just after the newest refused PTS, never at or before it")
check(decideHoldFrame(lastWrittenPtsNs: 10 * s, lastAcceptedPtsNs: 10 * s + 200 * ms, nowNs: 11 * s + 500 * ms) == 11 * s,
      "refused frames well before last + 1 s do not move the hold")

// STC-562: the camera's gap fault, the camera's half of the same rule.
check(!cameraGapFaultCovers(ptsNs: 5 * s, firstFramePtsNs: -1), "no camera gap before the first frame")
check(!cameraGapFaultCovers(ptsNs: 12 * s + 999 * ms, firstFramePtsNs: 10 * s), "the gap starts 3 s in, not before")
check(cameraGapFaultCovers(ptsNs: 13 * s, firstFramePtsNs: 10 * s), "the gap starts 3 s in")
check(cameraGapFaultCovers(ptsNs: 17 * s + 999 * ms, firstFramePtsNs: 10 * s), "the gap runs 5 s")
check(!cameraGapFaultCovers(ptsNs: 18 * s, firstFramePtsNs: 10 * s), "the camera is back 8 s in")
check(CAMERA_GAP_FAULT_DURATION_NS > WRITER_MAX_SAMPLE_DURATION_NS * 2, "the fault's gap is well past the limit")

// The camera's PTS trails delivery by ~0.1 s (latency compensation). A camera
// frame arriving now carries a PTS about 0.1 s ago; the hold decided at the same
// moment must sit before it, or the ordering guard drops the real frame.
do {
    let latency: Int64 = 116 * ms              // phase 0's worse measurement
    let last: Int64 = 10 * s
    var now: Int64 = last
    var hold: Int64?
    while hold == nil { now += 250 * ms; hold = decideHoldFrame(lastWrittenPtsNs: last, lastAcceptedPtsNs: last, nowNs: now) }
    check(hold! < now - latency, "a camera hold is behind a camera frame delivered at the same moment")
    check(now - latency - hold! >= 300 * ms, "with room: \(now - latency - hold!) ns")
}

// A pause: no frame is offered to the writer while paused, so the newest offered
// PTS stays the last written one and holds keep coming. CameraCapture checks the
// pause BEFORE its ordering guard for exactly this: a guard that also counted the
// paused frames, delivered ~0.1 s ago, would leave no hold ever safe.
do {
    var last: Int64 = 10 * s
    var now: Int64 = 10 * s
    var held = 0
    while now < 10 * s + 30 * s {
        now += 250 * ms
        if let pts = decideHoldFrame(lastWrittenPtsNs: last, lastAcceptedPtsNs: last, nowNs: now) { last = pts; held += 1 }
    }
    check(held >= 28, "a 30 s pause is held about once a second (got \(held))")
    // Paused frames keep arriving, so such a guard is always ~0.1 s behind now,
    // whenever the timer looks.
    for later in stride(from: now, to: now + 5 * s, by: Int64.Stride(250 * ms)) {
        check(decideHoldFrame(lastWrittenPtsNs: last, lastAcceptedPtsNs: later - 100 * ms, nowNs: later) == nil,
              "a guard counting paused frames would block every hold: why the pause check comes first")
    }
}

if failures.isEmpty { print("ALL PASS") } else { for f in failures { print("FAIL: \(f)") } ; exit(1) }
