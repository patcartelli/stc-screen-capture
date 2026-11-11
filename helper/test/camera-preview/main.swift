import Foundation

// STC-638: CameraPreviewDecisions.swift's rules, asserted directly.

var failures: [String] = []
func check(_ ok: Bool, _ label: String) { if !ok { failures.append(label) } }

let ms: Int64 = 1_000_000
let s: Int64 = 1_000_000_000

// The cap: 12 fps is 83.33 ms between frames, and the constants agree.
check(CameraPreviewLimits.maxFps == 12, "12 fps")
check(CameraPreviewLimits.minIntervalNs == s / 12, "interval is 1/12 s")

// The first frame is always due, so the view fills at once.
check(decidePreviewEmit(lastEmittedNs: -1, nowNs: 0), "first frame due at t = 0")
check(decidePreviewEmit(lastEmittedNs: -1, nowNs: 5 * s), "first frame due whenever it arrives")

// A 60 fps camera (16.7 ms apart): over 3 s no more than 12 per second get through.
do {
    var last: Int64 = -1
    var emitted = 0
    var t: Int64 = 1 * s
    let end = t + 3 * s
    while t < end {
        if decidePreviewEmit(lastEmittedNs: last, nowNs: t) { last = t; emitted += 1 }
        t += 16_667_000
    }
    // 60 fps lands on 16.7 ms steps, so the 83.3 ms gate passes every 6th frame (100 ms): 30 in 3 s.
    check(emitted <= 3 * 12, "a 60 fps camera is throttled to at most 12/s (got \(emitted) in 3 s)")
    check(emitted >= 3 * 9, "and still delivers a usable rate (got \(emitted) in 3 s)")
}

// A 30 fps camera (33.3 ms apart): every third frame is due (100 ms), 10/s.
do {
    var last: Int64 = -1
    var emitted = 0
    var t: Int64 = 0
    while t < 3 * s {
        if decidePreviewEmit(lastEmittedNs: last, nowNs: t) { last = t; emitted += 1 }
        t += 33_333_000
    }
    check(emitted >= 25 && emitted <= 36, "a 30 fps camera gives ~10 to 12 per second (got \(emitted) in 3 s)")
}

// A slow camera (~1 fps, the virtual-camera case, STC-286) is never throttled further.
check(decidePreviewEmit(lastEmittedNs: 10 * s, nowNs: 11 * s), "a 1 fps camera passes every frame")

// Not one ms early.
check(!decidePreviewEmit(lastEmittedNs: 10 * s, nowNs: 10 * s + CameraPreviewLimits.minIntervalNs - 1),
      "not due one ns early")
check(decidePreviewEmit(lastEmittedNs: 10 * s, nowNs: 10 * s + CameraPreviewLimits.minIntervalNs),
      "due exactly at the interval")

// Rule 1: idle only.
check(previewStartRefusal(idle: true) == nil, "an idle helper may preview")
let refused = previewStartRefusal(idle: false)
check(refused?.code == "bad-state", "a busy helper refuses with bad-state")
check(refused?.detail.contains("idle") == true, "and says why")

// Rule 3: release only what the preview opened.
check(previewReleasesOnStop(wasWarmBefore: false), "a camera the preview opened is released on stop")
check(!previewReleasesOnStop(wasWarmBefore: true), "a camera the countdown warmed is left for the take")

// The timeout stays under the warm hold the preview asks for (90 s), or the warm
// timer, not the preview, would end it silently.
check(CameraPreviewLimits.maxSeconds < 90, "the preview ends itself before the warm hold would")

// Every stop reason has a wire name the app can key on.
check(PreviewStopReason.allCases.count == 4, "four stop reasons: add a row here when adding one")
check(PreviewStopReason.takeStarted.rawValue == "take-started", "take-started")
check(PreviewStopReason.deviceLost.rawValue == "device-lost", "device-lost")
check(Set(PreviewStopReason.allCases.map { $0.rawValue }).count == 4, "wire names are distinct")

if failures.isEmpty { print("ALL PASS") } else { for f in failures { print("FAIL: \(f)") } ; exit(1) }
