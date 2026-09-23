import Foundation
import AVFoundation
import CoreVideo

// STC-394 spike/verification harness.
//
// Answers one question empirically rather than by reading Apple's docs:
// does setting `movieFragmentInterval` on the SAME writer configuration
// `Capture.swift` uses (a) leave a killed-mid-write file genuinely playable
// up to close to the kill, and (b) demux identically to a non-fragmented
// file once finished cleanly? `helper/test/fixture-mp4.test.ts` already
// proves `demuxTrack` runs in plain Node with no browser, which is what
// makes checking (b) possible from a vitest test rather than by hand on a
// Mac.
//
// Configured entirely by environment (see `_swift-harness.ts`: the runner
// passes no CLI args, only env), one variable per knob so a test can flip
// exactly the one it's asking about.
//
// STC-408 adds a third question to the same harness: does an ORDINARY,
// uncrashed take that happens to sit idle across one or more fragment
// boundaries (what STC-240's pause does to this writer) still finish and
// demux cleanly? See `STC_FRAG_GAP_AFTER_FRAME`/`STC_FRAG_GAP_SEC` below.

func diag(_ m: String) {
    FileHandle.standardError.write(("[fragmented-writer] " + m + "\n").data(using: .utf8)!)
}

func fail(_ m: String) -> Never {
    diag("FAIL: \(m)")
    fflush(stdout)
    _exit(1)
}

let env = ProcessInfo.processInfo.environment
guard let outPath = env["STC_FRAG_OUT"] else { fail("STC_FRAG_OUT is required") }
let outURL = URL(fileURLWithPath: outPath)
let frameCount = Int(env["STC_FRAG_FRAMES"] ?? "300")!
let fps = Int(env["STC_FRAG_FPS"] ?? "60")!
// 0 (default/absent) = movieFragmentInterval is never set, matching
// Capture.swift as it stands today. Any positive value sets it, in seconds —
// CMTime wants a rational, and a plain Double reads more clearly here than a
// scaled integer for a knob a test picks a handful of round values for.
let fragmentIntervalSec = Double(env["STC_FRAG_INTERVAL_SEC"] ?? "0") ?? 0
// If set, `_exit()` is called the instant this many frames have been
// appended — no finishWriting, no flush, the same shape a SIGKILL leaves
// behind. Absent means "finish normally".
let crashAfter = env["STC_FRAG_CRASH_AFTER"].flatMap(Int.init)

// STC-408: models what a PAUSE (STC-240) does to this exact writer — nothing
// crashes, nothing stops, but a real span of session time goes by with NO
// sample appended, because `PauseGate` drops paused frames outright rather
// than holding or re-timing them (`PauseDecisions.swift`). `Capture.swift`
// stamps every sample with its REAL session-relative pts
// (`displayTimeNs - t0Ns`), never a frame-index counter, so the file this
// produces is exactly what a real pause leaves behind: a normal PTS grid,
// then one large jump where the paused span was, then the grid resumes.
// Gap-after-frame rather than a real `sleep()`, because `movieFragmentInterval`
// is driven by the PTS of samples actually appended, not a wall-clock timer —
// so a jump in the numbers a real pause would produce is the whole test, and
// costs nothing to run.
let gapAfterFrame = env["STC_FRAG_GAP_AFTER_FRAME"].flatMap(Int.init)
let gapSec = Double(env["STC_FRAG_GAP_SEC"] ?? "0") ?? 0
// "1" paces every append to its own PTS on the wall clock, sleeping through
// the gap too — what `Capture.swift` actually does, since ScreenCaptureKit
// hands it frames in real time and `expectsMediaDataInRealTime` is set. Off,
// the harness appends as fast as the writer will take them, which is fine for
// a grid with no gaps and is exactly what a gap run needs a control against.
let realtime = env["STC_FRAG_REALTIME"] == "1"

let W = 320, H = 240

func makeBuffer(_ i: Int) -> CVPixelBuffer {
    var pb: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, W, H,
                        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                        [kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()] as CFDictionary,
                        &pb)
    guard let pb else { fail("CVPixelBufferCreate failed") }
    // Content is irrelevant to what this harness checks (sample count, PTS
    // grid, whether the file parses) — a flat colour that changes per frame
    // is enough to keep the encoder from special-casing an all-identical
    // input, and costs nothing to compute.
    CVPixelBufferLockBaseAddress(pb, [])
    if let y = CVPixelBufferGetBaseAddressOfPlane(pb, 0) {
        memset(y, Int32((i * 7) % 256), CVPixelBufferGetBytesPerRowOfPlane(pb, 0) * H)
    }
    if let uv = CVPixelBufferGetBaseAddressOfPlane(pb, 1) {
        memset(uv, 128, CVPixelBufferGetBytesPerRowOfPlane(pb, 1) * (H / 2))
    }
    CVPixelBufferUnlockBaseAddress(pb, [])
    return pb
}

// Exactly `Capture.swift`'s `setupWriter()` — codec settings, timescales,
// pixel format — plus the one property this ticket adds. Any other
// difference would mean this harness is answering a question about a writer
// nobody ships.
try? FileManager.default.removeItem(at: outURL)
guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else {
    fail("AVAssetWriter(outputURL:) threw")
}
writer.movieTimeScale = 90_000
if fragmentIntervalSec > 0 {
    writer.movieFragmentInterval = CMTime(seconds: fragmentIntervalSec, preferredTimescale: 1)
}
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: W, AVVideoHeightKey: H,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 8_000_000,
        AVVideoMaxKeyFrameIntervalKey: 45,
        AVVideoExpectedSourceFrameRateKey: fps,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoAllowFrameReorderingKey: false,
    ] as [String: Any],
])
input.expectsMediaDataInRealTime = true
input.mediaTimeScale = 1_000_000_000
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
guard writer.canAdd(input) else { fail("writer refused the video input") }
writer.add(input)
guard writer.startWriting() else { fail("startWriting failed: \(String(describing: writer.error))") }
writer.startSession(atSourceTime: .zero)

let ptsStepNs = Int64(1_000_000_000 / fps)
let wallStartNs = DispatchTime.now().uptimeNanoseconds
var appended = 0
let queue = DispatchQueue(label: "stc.fragtest.feed")
let done = DispatchSemaphore(value: 0)

input.requestMediaDataWhenReady(on: queue) {
    while input.isReadyForMoreMediaData {
        if appended >= frameCount {
            input.markAsFinished()
            done.signal()
            return
        }
        let gapNs: Int64 = (gapAfterFrame.map { appended >= $0 } ?? false)
            ? Int64((gapSec * 1_000_000_000).rounded()) : 0
        let ptsNs = Int64(appended) * ptsStepNs + gapNs
        if realtime {
            let dueNs = wallStartNs + UInt64(ptsNs)
            let nowNs = DispatchTime.now().uptimeNanoseconds
            if dueNs > nowNs { usleep(useconds_t((dueNs - nowNs) / 1_000)) }
        }
        let pts = CMTime(value: ptsNs, timescale: 1_000_000_000)
        if !adaptor.append(makeBuffer(appended), withPresentationTime: pts) {
            fail("append failed at frame \(appended): \(String(describing: writer.error))")
        }
        appended += 1
        if let crashAfter, appended >= crashAfter {
            // The whole point: no markAsFinished, no finishWriting, no
            // flush — whatever AVAssetWriter has already committed to disk
            // via its own fragment-interval timer is all this file will
            // ever have. `_exit`, not `exit`: this may run with the
            // writer's internal queues mid-operation, and `exit` running
            // atexit handlers against that is its own hazard.
            diag("crashing after \(appended) frames (simulated)")
            fflush(stdout)
            _exit(9)
        }
    }
}

done.wait()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()

if writer.status != .completed {
    fail("finishWriting ended in status \(writer.status.rawValue): \(String(describing: writer.error))")
}
diag("wrote \(appended) frames to \(outPath), status=completed")
print("DONE frames=\(appended)")
