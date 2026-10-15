import Foundation
var failures = 0
func expect(_ label: String, _ ok: Bool) { print(ok ? "ok   \(label)" : "FAIL \(label)"); if !ok { failures += 1 } }

let buf: Int64 = 10_666_667            // 512 frames at 48 kHz
let s: Int64 = 1_000_000_000
let loud: Float = 0.2
let quiet: Float = 0                   // a muted mic: exact zeros

/// The first buffer boundary at or after `ns`.
func boundary(_ ns: Int64) -> Int64 { (ns + buf - 1) / buf * buf }

/// Feeds buffers from `fromNs` up to (not including) `toNs` at one peak; returns every reading.
@discardableResult
func run(_ t: inout MicSignalTracker, from fromNs: Int64, to toNs: Int64, peak: Float,
         paused: Bool = false) -> [MicLevelReading] {
    var out: [MicLevelReading] = []
    var p = fromNs
    while p < toNs {
        if let r = t.feed(ptsNs: p, endNs: p + buf, peak: peak, paused: paused) { out.append(r) }
        p += buf
    }
    return out
}

// The threshold itself.
expect("-60 dBFS is 0.001 linear", abs(MicSignal.silenceFloor - 0.001) < 1e-7)
let samples: [Float] = [0.01, -0.5, 0.2, .nan]
expect("peak is the largest |sample|, NaN ignored", samples.withUnsafeBufferPointer { MicSignal.peak($0) } == 0.5)
expect("peak of nothing is zero", [Float]().withUnsafeBufferPointer { MicSignal.peak($0) } == 0)

// A live mic: no spans, never silent, and the meter moves at ~15 Hz.
var live = MicSignalTracker()
let readings = run(&live, from: 0, to: 10 * s, peak: loud)
expect("live mic: no spans", live.spansSoFar().isEmpty)
expect("live mic: never silent", readings.allSatisfy { !$0.silent })
expect("live mic: readings carry the peak", readings.allSatisfy { $0.peak == loud })
// 512-frame buffers land a reading every 7th buffer (74.7 ms): ~13 Hz, never more than 15.
expect("about 15 readings a second at most (got \(readings.count) in 10 s)", (120...150).contains(readings.count))

// A breath: 3 s of silence between speech is not a span and never sets the marker.
var breath = MicSignalTracker()
run(&breath, from: 0, to: 5 * s, peak: loud)
let br = run(&breath, from: boundary(5 * s), to: 8 * s, peak: quiet)
run(&breath, from: boundary(8 * s), to: 12 * s, peak: loud)
expect("a 3 s pause is no span", breath.spansSoFar().isEmpty)
expect("...and never reads as silent", br.allSatisfy { !$0.silent })

// Just under the floor is silence; just over is signal.
var edge = MicSignalTracker()
run(&edge, from: 0, to: 11 * s, peak: MicSignal.silenceFloor * 0.99)
expect("a peak just under -60 dBFS is silence", edge.silent)
var over = MicSignalTracker()
run(&over, from: 0, to: 11 * s, peak: MicSignal.silenceFloor * 1.01)
expect("a peak just over -60 dBFS is signal", !over.silent && over.spansSoFar().isEmpty)

// 12 s of silence mid-take: one span, starting where the silence did.
var gap = MicSignalTracker()
run(&gap, from: 0, to: 2 * s, peak: loud)
let silentStart = boundary(2 * s)
let early = run(&gap, from: silentStart, to: silentStart + 9 * s, peak: quiet)
expect("not silent before 10 s have passed", !early.contains { $0.silent } && !gap.silent)
let gr = run(&gap, from: silentStart + 9 * s, to: 14 * s, peak: quiet)
expect("silent once 10 s have passed", gr.last?.silent == true)
expect("...and the meter reads zero", gr.last?.peak == 0)
expect("an open qualifying span is reported so far", gap.spansSoFar().count == 1 && gap.spans.isEmpty)
let resume = boundary(14 * s)
let rr = run(&gap, from: resume, to: 16 * s, peak: loud)
expect("signal clears the marker", rr.allSatisfy { !$0.silent } && !gap.silent)
expect("one span", gap.spans.count == 1)
expect("...starting where the silence started", gap.spans.first?.startNs == silentStart)
expect("...ending at the first buffer with signal", gap.spans.first?.endNs == resume)

// Silence to the end of the take: the span closes at the last buffer's end.
var tail = MicSignalTracker()
run(&tail, from: 0, to: 1 * s, peak: loud)
run(&tail, from: boundary(1 * s), to: 20 * s, peak: quiet)
let tailSpans = tail.spansSoFar()
let tailEnd = tailSpans.first?.endNs ?? 0
expect("a take that ends silent has its span", tailSpans.count == 1)
expect("...closed at the last buffer's end", tailEnd >= 20 * s && tailEnd <= 20 * s + buf)
expect("spansSoFar does not change the tracker", tail.spans.isEmpty && tail.silent)

// A pause: 8 s silent, pause 30 s, 8 s silent. Neither half is 10 s, and the pause is not silence.
var pause = MicSignalTracker()
run(&pause, from: 0, to: 8 * s, peak: quiet)
let pr = run(&pause, from: boundary(8 * s), to: 38 * s, peak: loud, paused: true)
run(&pause, from: boundary(38 * s), to: 46 * s, peak: quiet)
expect("a pause splits silence, so no span", pause.spansSoFar().isEmpty)
expect("paused audio reads as zero on the meter", pr.allSatisfy { $0.peak == 0 && !$0.silent })
var pauseLong = MicSignalTracker()
run(&pauseLong, from: 0, to: 12 * s, peak: quiet)
let pauseAt = boundary(12 * s)
run(&pauseLong, from: pauseAt, to: 40 * s, peak: quiet, paused: true)
expect("a span closes at the pause's start", pauseLong.spans == [SilentSpan(startNs: 0, endNs: pauseAt)])
expect("...and silence while paused opens nothing", pauseLong.spansSoFar().count == 1 && !pauseLong.silent)

// The track ended early (STC-237): an open span closes at the last buffer, nothing after counts.
var ended = MicSignalTracker()
run(&ended, from: 0, to: 15 * s, peak: quiet)
ended.end()
let afterEnd = ended.feed(ptsNs: 16 * s, endNs: 16 * s + buf, peak: loud, paused: false)
expect("an ended track closes its span", ended.spans.count == 1 && ended.spans[0].startNs == 0)
expect("...and ignores anything after", afterEnd == nil && ended.spans.count == 1)
var shortEnd = MicSignalTracker()
run(&shortEnd, from: 0, to: 4 * s, peak: quiet)
shortEnd.end()
expect("an ended track's short silence is no span", shortEnd.spansSoFar().isEmpty)

// Several spans, in order.
var many = MicSignalTracker()
var at: Int64 = 0
for _ in 0..<3 {
    run(&many, from: at, to: at + 11 * s, peak: quiet); at = boundary(at + 11 * s)
    run(&many, from: at, to: at + 1 * s, peak: loud); at = boundary(at + 1 * s)
}
expect("three spans, in order", many.spans.count == 3
       && zip(many.spans, many.spans.dropFirst()).allSatisfy { $0.endNs < $1.startNs })

// A peak above full scale is clamped for the meter.
var hot = MicSignalTracker()
expect("a reading never exceeds 1", hot.feed(ptsNs: 0, endNs: buf, peak: 3, paused: false)?.peak == 1)

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
