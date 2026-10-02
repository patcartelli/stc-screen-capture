import Foundation
import CoreAudioTypes
var failures = 0
func expect(_ label: String, _ ok: Bool) { print(ok ? "ok   \(label)" : "FAIL \(label)"); if !ok { failures += 1 } }

let pinned = MicFormat.pinned(sampleRate: 48_000, channels: 1)
// What AVCaptureAudioDataOutput reported back on the Wave:3 when asked for the
// pinned format (2026-10-02): flags 0x9, 4 bytes/frame, 32 bits.
expect("pinned is float32 packed interleaved, as measured", pinned.flags == 0x9 && pinned.bytesPerFrame == 4
       && pinned.bitsPerChannel == 32 && pinned.formatID == kAudioFormatLinearPCM)
expect("stereo doubles bytes per frame", MicFormat.pinned(sampleRate: 48_000, channels: 2).bytesPerFrame == 8)
// The Wave:3's native format, as it reported it: 24-bit packed int, 3 bytes.
let wave3Native = MicFormat(sampleRate: 48_000, formatID: kAudioFormatLinearPCM, flags: 0xc,
                            bytesPerFrame: 3, channels: 1, bitsPerChannel: 24)

let buf = 512
let bufNs: Int64 = 10_666_667       // 512 frames at 48 kHz

/// Feeds `count` buffers of `frames` each, `stepNs` apart, and returns every verdict.
func run(_ g: inout MicFormatGuard, count: Int, frames: Int = buf, stepNs: Int64 = bufNs,
         format: MicFormat? = nil, startNs: Int64 = 0) -> [MicBufferVerdict] {
    let f = format ?? g.expected
    return (0..<count).map { i in
        g.check(format: f, numSamples: frames, dataBytes: frames * Int(f.bytesPerFrame),
                ptsNs: startNs + Int64(i) * stepNs)
    }
}

// A clean take: ten seconds of exact pacing.
var clean = MicFormatGuard(expected: pinned)
expect("a clean take appends every buffer", run(&clean, count: 940).allSatisfy { $0 == .append })

// The STC-485 signature: 4-byte frames read at 3 bytes each -> 4/3 the frames
// per buffer, same PTS spacing. Description and byte count agree, so only the
// clock catches it.
var noisy = MicFormatGuard(expected: pinned)
let v = run(&noisy, count: 400, frames: buf * 4 / 3)
let firstTrip = v.firstIndex { if case .trip = $0 { return true } else { return false } }
expect("4/3 pacing trips", firstTrip != nil)
expect("...within the pacing window (+1 buffer)", (firstTrip ?? .max) <= Int(MicFormatGuard.pacingWindowNs / bufNs) + 2)
if case .trip(.pacing(let r))? = firstTrip.map({ v[$0] }) {
    expect("...and reports the ratio as 4/3", abs(r - 4.0 / 3.0) < 0.01)
} else { expect("...as a pacing fault", false) }
expect("every buffer after a trip is dropped", v[(firstTrip ?? 0) + 1 ..< v.count].allSatisfy { $0 == .drop })

var inverse = MicFormatGuard(expected: pinned)
expect("3/4 pacing (the inverse mislabel) trips too",
       run(&inverse, count: 400, frames: buf * 3 / 4).contains { if case .trip(.pacing) = $0 { return true }; return false })

// A dropout is not a format fault. 300 ms of nothing, mid-take: the gap pair
// is excluded and the take carries on.
var dropout = MicFormatGuard(expected: pinned)
var dv = run(&dropout, count: 300)
dv += run(&dropout, count: 300, startNs: 299 * bufNs + 300_000_000)
expect("a 300 ms dropout does not trip", dv.allSatisfy { $0 == .append })

// Many small late buffers (scheduling jitter) — alternate 8 ms and 13.3 ms.
var jitter = MicFormatGuard(expected: pinned)
var t: Int64 = 0
var jv: [MicBufferVerdict] = []
for i in 0..<600 {
    jv.append(jitter.check(format: pinned, numSamples: buf, dataBytes: buf * 4, ptsNs: t))
    t += i % 2 == 0 ? bufNs - 2_666_667 : bufNs + 2_666_667
}
expect("jitter that averages out does not trip", jv.allSatisfy { $0 == .append })

// A mid-take switch is caught within a window, not diluted by everything before it.
var late = MicFormatGuard(expected: pinned)
var lv = run(&late, count: 2000)
lv += run(&late, count: 400, frames: buf * 4 / 3, startNs: 2000 * bufNs)
let lateTrip = lv.firstIndex { if case .trip = $0 { return true } else { return false } }
expect("a switch 21 s in trips", lateTrip != nil)
expect("...within two windows of the switch", (lateTrip ?? .max) - 2000 <= 2 * Int(MicFormatGuard.pacingWindowNs / bufNs) + 2)

// The description itself.
var changed = MicFormatGuard(expected: pinned)
_ = run(&changed, count: 10)
let cv = changed.check(format: wave3Native, numSamples: buf, dataBytes: buf * 3, ptsNs: 10 * bufNs)
expect("a buffer described as the device's native 24-bit trips at once", cv == .trip(.formatChanged(delivered: wave3Native)))
expect("...and the next pinned buffer is still dropped",
       changed.check(format: pinned, numSamples: buf, dataBytes: buf * 4, ptsNs: 11 * bufNs) == .drop)

var sized = MicFormatGuard(expected: pinned)
expect("a byte count that disagrees with the description trips at once",
       sized.check(format: pinned, numSamples: buf, dataBytes: buf * 3, ptsNs: 0)
       == .trip(.sizeMismatch(numSamples: buf, dataBytes: buf * 3, bytesPerFrame: 4)))

expect("a fault names what arrived", MicFormatFault.formatChanged(delivered: wave3Native).detail.contains("24-bit int"))

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
