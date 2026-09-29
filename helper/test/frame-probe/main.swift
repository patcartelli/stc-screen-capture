// STC-235 Task 11: a pixel probe for the refit grant test.
//
// Compiled alone (no production sources — this needs none): grabs ONE frame
// from an mp4 at a given time and reports the mean luma inside a rect versus
// outside it. The refit grant test forces a PILLARBOX (armDisplayFault's
// 3/4-width source, `fitRect`-centred into the full capture frame), so a
// frame taken after the refit lands should show real content inside the
// computed contentRect and black bars outside it — that is the one thing an
// anchors.json diff cannot show: that the pixels the helper CLAIMS moved
// actually did.
//
// Usage: frame-probe <mp4> <tSeconds> <x> <y> <w> <h>
// Prints (and only cares about) two lines:
//   LUMA_OUTSIDE=<mean 0-255 luma of every pixel NOT in the rect>
//   LUMA_INSIDE=<mean 0-255 luma of every pixel INSIDE the rect>
// A real frame is asked for with zero tolerance
// (requestedTimeToleranceBefore/After = .zero) — the grant test's whole point
// is the SEAM, and a generator that is allowed to snap to a nearby frame
// could silently paper over exactly the frame that matters.
import Foundation
import AVFoundation
import CoreGraphics

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let argv = CommandLine.arguments
guard argv.count == 7 else {
    fail("usage: frame-probe <mp4> <tSeconds> <x> <y> <w> <h>")
}
let path = argv[1]
guard let tSeconds = Double(argv[2]),
      let rx = Int(argv[3]), let ry = Int(argv[4]),
      let rw = Int(argv[5]), let rh = Int(argv[6]) else {
    fail("bad numeric argument")
}

let url = URL(fileURLWithPath: path)
guard FileManager.default.fileExists(atPath: path) else {
    fail("no such file: \(path)")
}

let asset = AVURLAsset(url: url)
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
// Zero tolerance: the frame at exactly this time, or an explicit failure —
// never a neighbour silently substituted for it.
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero

let time = CMTime(seconds: tSeconds, preferredTimescale: 600)
let cgImage: CGImage
do {
    var actual = CMTime.zero
    cgImage = try gen.copyCGImage(at: time, actualTime: &actual)
} catch {
    fail("copyCGImage failed at t=\(tSeconds)s: \(error)")
}

let width = cgImage.width
let height = cgImage.height
guard rx >= 0, ry >= 0, rw > 0, rh > 0, rx + rw <= width, ry + rh <= height else {
    fail("rect (\(rx),\(ry),\(rw),\(rh)) is not inside the \(width)x\(height) frame")
}

// RGBA8, premultiplied (the only alpha layout CGContext accepts for 8-bit
// RGB). A decoded video frame is always fully opaque (alpha 255), so
// premultiplied and straight read identically here — luma below reads R/G/B
// directly rather than pretending to un-premultiply against an alpha this
// source never varies.
let bytesPerPixel = 4
let bytesPerRow = width * bytesPerPixel
var buffer = [UInt8](repeating: 0, count: bytesPerRow * height)
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: &buffer, width: width, height: height, bitsPerComponent: 8,
                          bytesPerRow: bytesPerRow, space: colorSpace,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fail("could not create a bitmap context")
}
ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

// CGContext's origin is bottom-left for a drawn image with no further
// transform; AVFoundation/CG frame coordinates here are top-left, matching
// `contentRect` in anchors.json, so row `y` (top-left) maps to buffer row
// `height - 1 - y`.
func luma(atX x: Int, y: Int) -> Double {
    let row = height - 1 - y
    let i = row * bytesPerRow + x * bytesPerPixel
    let r = Double(buffer[i]), g = Double(buffer[i + 1]), b = Double(buffer[i + 2])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

var insideSum = 0.0, insideCount = 0
var outsideSum = 0.0, outsideCount = 0
for y in 0..<height {
    for x in 0..<width {
        let inside = x >= rx && x < rx + rw && y >= ry && y < ry + rh
        let l = luma(atX: x, y: y)
        if inside { insideSum += l; insideCount += 1 } else { outsideSum += l; outsideCount += 1 }
    }
}

let insideMean = insideCount > 0 ? insideSum / Double(insideCount) : 0
let outsideMean = outsideCount > 0 ? outsideSum / Double(outsideCount) : 0
print("LUMA_OUTSIDE=\(outsideMean)")
print("LUMA_INSIDE=\(insideMean)")
