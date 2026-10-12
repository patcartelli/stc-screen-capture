import Foundation
import AVFoundation
import CoreVideo

// STC-527. Two halves, one binary:
//
// 1. DiskDecisions.swift's pure rules, asserted directly.
// 2. With STC_DISK_FULL_OUT set (a path on a tiny volume the test mounted), a
//    REAL full disk: frames go through the real WriterGate into a writer set up
//    like `Capture.swift`'s `setupWriter()`, until the frame path's own
//    detection condition holds (a frame that did not go in, and the writer
//    `.failed`). Then the real error is classified. That error is the thing no
//    pure test can supply — the classifier was written against what this
//    produced on 2026-10-12, and this is what keeps it honest on the next macOS.

var failures: [String] = []
func check(_ ok: Bool, _ label: String) { if !ok { failures.append(label) } }
func diag(_ m: String) { FileHandle.standardError.write(("[disk-full] " + m + "\n").data(using: .utf8)!) }

// MARK: 1. pure rules

check(decideDiskWatch(freeBytes: nil) == .keepRecording, "an unreadable volume never stops a take")
check(decideDiskWatch(freeBytes: DISK_FREE_FLOOR_BYTES) == .keepRecording, "exactly the floor keeps recording")
check(decideDiskWatch(freeBytes: DISK_FREE_FLOOR_BYTES - 1) == .stop("disk-full"), "one byte under the floor stops")
check(decideDiskWatch(freeBytes: 0) == .stop("disk-full"), "nothing free stops")
check(decideDiskWatch(freeBytes: 500 << 30) == .keepRecording, "a roomy disk keeps recording")

let posix = NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))
let avFull = NSError(domain: "AVFoundationErrorDomain", code: -11807, userInfo: [NSUnderlyingErrorKey: posix])
let avOther = NSError(domain: "AVFoundationErrorDomain", code: -11800)
let cocoaFull = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError)
let buried = NSError(domain: "AVFoundationErrorDomain", code: -11800,
                     userInfo: [NSUnderlyingErrorKey: NSError(domain: "x", code: 1, userInfo: [NSUnderlyingErrorKey: posix])])
let multiple = NSError(domain: "AVFoundationErrorDomain", code: -11800,
                       userInfo: [NSMultipleUnderlyingErrorsKey: [avOther, cocoaFull]])
check(isDiskFullError(avFull), "AVError.diskFull is disk full")
check(isDiskFullError(posix), "bare ENOSPC is disk full")
check(isDiskFullError(cocoaFull), "NSFileWriteOutOfSpaceError is disk full")
check(isDiskFullError(buried), "ENOSPC two levels down is disk full")
check(isDiskFullError(multiple), "ENOSPC among multiple underlying errors is disk full")
check(!isDiskFullError(avOther), "an unknown AVFoundation failure is not disk full")
check(!isDiskFullError(NSError(domain: NSPOSIXErrorDomain, code: Int(EIO))), "EIO is not disk full")

check(decideWriterFailure(avFull, freeBytes: 10 << 30) == .stop("disk-full"), "the error alone says disk full")
check(decideWriterFailure(avOther, freeBytes: 0) == .stop("disk-full"), "the volume alone says disk full")
check(decideWriterFailure(avOther, freeBytes: 10 << 30) == .stop("error"), "neither: the reserved `error`")
check(decideWriterFailure(nil, freeBytes: nil) == .stop("error"), "no error and no reading still stops")

// MARK: 2. a real full disk

if let outPath = ProcessInfo.processInfo.environment["STC_DISK_FULL_OUT"] {
    let url = URL(fileURLWithPath: outPath)
    try? FileManager.default.removeItem(at: url)
    let W = 1280, H = 720
    let writer = try! AVAssetWriter(outputURL: url, fileType: .mp4)
    writer.movieTimeScale = 90_000
    // `movieFragmentIntervalSec` (CaptureDecisions.swift), whose file this
    // harness does not compile: the fragments are what leave a playable prefix.
    writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 1)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: 50_000_000,
            AVVideoMaxKeyFrameIntervalKey: 45,
            AVVideoExpectedSourceFrameRateKey: 60,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoAllowFrameReorderingKey: false,
        ] as [String: Any],
    ])
    input.expectsMediaDataInRealTime = true
    input.mediaTimeScale = 1_000_000_000
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
    writer.add(input)
    guard writer.startWriting() else { diag("startWriting: \(String(describing: writer.error))"); exit(1) }
    writer.startSession(atSourceTime: .zero)
    let gate = WriterGate()
    gate.install(input: input, adaptor: adaptor)

    // Noise, because a flat frame compresses to almost nothing and would take
    // minutes to fill even 16 MB.
    func frame() -> CVPixelBuffer {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(nil, W, H, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                            [kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()] as CFDictionary, &pb)
        let p = pb!
        CVPixelBufferLockBaseAddress(p, [])
        let y = CVPixelBufferGetBaseAddressOfPlane(p, 0)!.assumingMemoryBound(to: UInt64.self)
        var s = UInt64.random(in: 1...UInt64.max)
        for k in 0..<(CVPixelBufferGetBytesPerRowOfPlane(p, 0) * H / 8) {
            s ^= s << 13; s ^= s >> 7; s ^= s << 17; y[k] = s
        }
        memset(CVPixelBufferGetBaseAddressOfPlane(p, 1), 128, CVPixelBufferGetBytesPerRowOfPlane(p, 1) * H / 2)
        CVPixelBufferUnlockBaseAddress(p, [])
        return p
    }

    let deadline = Date().addingTimeInterval(
        Double(ProcessInfo.processInfo.environment["STC_HARNESS_DEADLINE_MS"].flatMap(Int.init) ?? 40_000) / 1000 - 3)
    var appended = 0
    var detected = false
    var pb = frame()
    while Date() < deadline {
        // Exactly the frame path's condition (Capture.swift, after gate.append).
        let outcome = gate.append(pb, at: CMTime(value: Int64(appended) * 16_666_667, timescale: 1_000_000_000))
        if outcome == .appended { appended += 1; pb = frame(); continue }
        if writer.status == .failed { detected = true; break }
        usleep(1000)   // ordinary back-pressure: the same frame again
    }
    check(detected, "the frame path's condition (dropped AND writer failed) must be reached on a full disk")
    let err = writer.error
    var chain: [String] = []
    var e = err as NSError?
    while let n = e { chain.append("\(n.domain) \(n.code)"); e = n.userInfo[NSUnderlyingErrorKey] as? NSError }
    print("ERROR-CHAIN: \(chain.joined(separator: " > "))")
    print("FRAMES: \(appended)")
    check(err.map(isDiskFullError) ?? false, "the real error must classify as disk full: \(chain)")
    check(decideWriterFailure(err, freeBytes: nil) == .stop("disk-full"),
          "the real error alone must decide disk-full, without the volume reading")
    let free = (try? url.deletingLastPathComponent()
        .resourceValues(forKeys: [.volumeAvailableCapacityKey]))?.volumeAvailableCapacity
    print("FREE: \(free.map(String.init) ?? "unreadable")")
    check(decideDiskWatch(freeBytes: free.map(Int64.init)) == .stop("disk-full"),
          "the watch must also call a volume the writer just filled full")
    gate.closeAndMarkFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
}

if failures.isEmpty { print("ALL PASS") }
else { for f in failures { print("FAIL: \(f)") }; exit(1) }
