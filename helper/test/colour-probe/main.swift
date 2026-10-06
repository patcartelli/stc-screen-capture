// STC-510: what colour does a recording CLAIM, and what colour does it hold?
//
// Compiled alone, no production sources. Two answers, on purpose separate:
//   1. the TAGS on the video track's format description (primaries, transfer,
//      matrix) — what a player is told. "none" means untagged, and is reported
//      as such rather than defaulted.
//   2. the decoded colour of two rects, read back in Display P3 — what a viewer
//      would see. The swatch window paints `color(display-p3 0 1 0)` on the
//      left and sRGB #00ff00 on the right; a P3-correct take reads the left as
//      ~(0,1,0) and the right as ~(0.46,0.99,0.30), and a take captured as sRGB
//      reads the two the SAME.
//
// Usage: colour-probe <mp4> <tSeconds> <x1> <y1> <w1> <h1> <x2> <y2> <w2> <h2>
// Prints TAG_*, FRAME_*, RECT1_P3, RECT2_P3 lines. Never asserts.
import Foundation
import AVFoundation
import CoreGraphics
import CoreMedia

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let argv = CommandLine.arguments
guard argv.count == 11, let t = Double(argv[2]) else {
    fail("usage: colour-probe <mp4> <tSeconds> <x1> <y1> <w1> <h1> <x2> <y2> <w2> <h2>")
}
let nums = argv[3...].compactMap { Int($0) }
guard nums.count == 8 else { fail("bad rect argument") }
guard FileManager.default.fileExists(atPath: argv[1]) else { fail("no such file: \(argv[1])") }

let asset = AVURLAsset(url: URL(fileURLWithPath: argv[1]))

// The synchronous track API is deprecated; blocking on the async one keeps this
// a plain script. Nothing here runs on the main actor, so the wait cannot deadlock.
var descs: [CMFormatDescription] = []
let sem = DispatchSemaphore(value: 0)
Task {
    if let track = try? await asset.loadTracks(withMediaType: .video).first {
        descs = (try? await track.load(.formatDescriptions)) ?? []
    }
    sem.signal()
}
sem.wait()
guard let desc = descs.first else { fail("no video track / format description") }

func tag(_ key: CFString) -> String {
    guard let v = CMFormatDescriptionGetExtension(desc, extensionKey: key) else { return "none" }
    return "\(v)"
}
print("TAG_PRIMARIES=\(tag(kCMFormatDescriptionExtension_ColorPrimaries))")
print("TAG_TRANSFER=\(tag(kCMFormatDescriptionExtension_TransferFunction))")
print("TAG_MATRIX=\(tag(kCMFormatDescriptionExtension_YCbCrMatrix))")

let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
// NOT zero tolerance, unlike frame-probe: this asks what colour a frame holds,
// not which frame. A static screen is VFR-sparse (a flat take can be one or two
// frames), and an exact-time request between them fails with -11832.
gen.requestedTimeToleranceBefore = .positiveInfinity
gen.requestedTimeToleranceAfter = .positiveInfinity
var actual = CMTime.zero
let image: CGImage
do { image = try gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: &actual) }
catch { fail("copyCGImage failed at t=\(t)s: \(error)") }
print("FRAME_SPACE=\((image.colorSpace?.name as String?) ?? "unnamed")")
print("FRAME_SIZE=\(image.width)x\(image.height)")

guard let p3 = CGColorSpace(name: CGColorSpace.displayP3),
      let ctx = CGContext(data: nil, width: image.width, height: image.height,
                          bitsPerComponent: 16, bytesPerRow: 0, space: p3,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                            | CGBitmapInfo.byteOrder16Little.rawValue) else { fail("no P3 context") }
ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
guard let base = ctx.data else { fail("no pixel data") }
let stride16 = ctx.bytesPerRow / 2
let px = base.assumingMemoryBound(to: UInt16.self)

/// Mean R,G,B (0...1) of a rect given in video pixels from the top-left, in Display P3.
func mean(_ x: Int, _ y: Int, _ w: Int, _ h: Int) -> (Double, Double, Double) {
    var r = 0.0, g = 0.0, b = 0.0, n = 0.0
    for row in y..<min(y + h, image.height) {
        for col in x..<min(x + w, image.width) {
            let i = row * stride16 + col * 4
            r += Double(px[i]); g += Double(px[i + 1]); b += Double(px[i + 2]); n += 1
        }
    }
    return n == 0 ? (0, 0, 0) : (r / n / 65535, g / n / 65535, b / n / 65535)
}
let a = mean(nums[0], nums[1], nums[2], nums[3])
let b = mean(nums[4], nums[5], nums[6], nums[7])
print(String(format: "RECT1_P3=%.3f,%.3f,%.3f", a.0, a.1, a.2))
print(String(format: "RECT2_P3=%.3f,%.3f,%.3f", b.0, b.1, b.2))

// RAW: the encoded values exactly as the decoder hands them over, with NO colour
// management in between. The RECT*_P3 lines above go through AVAssetImageGenerator
// and a CGContext conversion, and on the first P3 take they read like one extra
// sRGB->P3 conversion — so either the file is wrong or this probe's decode is.
// If the file's pixels are right, RAW1 is ~(0,1,0) and RAW2 ~(0.46,0.99,0.30).
func rawMeans() -> [(Double, Double, Double)]? {
    guard let reader = try? AVAssetReader(asset: asset) else { return nil }
    var vt: AVAssetTrack?
    let s2 = DispatchSemaphore(value: 0)
    Task { vt = try? await asset.loadTracks(withMediaType: .video).first; s2.signal() }
    s2.wait()
    guard let vt else { return nil }
    let out = AVAssetReaderTrackOutput(track: vt, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(out)
    guard reader.startReading() else { return nil }
    // The 30th frame, not the first: the first one a take delivers can precede the
    // swatch reaching the screen and reads as all-zero, which is not a colour.
    var sample: CMSampleBuffer?
    for _ in 0..<30 { guard let s = out.copyNextSampleBuffer() else { break }; sample = s }
    guard let sample, let pb = CMSampleBufferGetImageBuffer(sample) else { return nil }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
    let bpr = CVPixelBufferGetBytesPerRow(pb)
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    let p = base.assumingMemoryBound(to: UInt8.self)
    var res: [(Double, Double, Double)] = []
    for k in [0, 4] {
        var r = 0.0, g = 0.0, b = 0.0, n = 0.0
        for row in nums[k + 1]..<min(nums[k + 1] + nums[k + 3], h) {
            for col in nums[k]..<min(nums[k] + nums[k + 2], w) {
                let i = row * bpr + col * 4
                b += Double(p[i]); g += Double(p[i + 1]); r += Double(p[i + 2]); n += 1
            }
        }
        res.append(n == 0 ? (0, 0, 0) : (r / n / 255, g / n / 255, b / n / 255))
    }
    return res
}
if let raw = rawMeans() {
    print(String(format: "RAW1=%.3f,%.3f,%.3f", raw[0].0, raw[0].1, raw[0].2))
    print(String(format: "RAW2=%.3f,%.3f,%.3f", raw[1].0, raw[1].1, raw[1].2))
} else {
    print("RAW=unavailable")
}
