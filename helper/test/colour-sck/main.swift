// STC-510: what does ScreenCaptureKit actually DELIVER for the swatch under each
// colour configuration? One frame per variant, read as raw pixel values with no
// colour management, plus the colour attachments SCK stamps on the buffer.
//
// The swatch (colour-swatch) must already be on screen on <displayId>:
// left half `color(display-p3 0 1 0)`, right half sRGB #00ff00. A correct P3
// delivery reads left ~(0,1,0), right ~(0.46,0.99,0.30). Needs a Screen Recording
// grant. Usage: colour-sck <displayId>
import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreGraphics

setvbuf(stdout, nil, _IOLBF, 0)
guard CommandLine.arguments.count == 2, let rawID = UInt32(CommandLine.arguments[1]) else {
    FileHandle.standardError.write("usage: colour-sck <displayId>\n".data(using: .utf8)!); exit(1)
}
let displayID = CGDirectDisplayID(rawID)

final class Grab: NSObject, SCStreamOutput {
    var frames = 0
    var buffer: CVPixelBuffer?
    let done = DispatchSemaphore(value: 0)
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        frames += 1
        if frames == 8, buffer == nil { buffer = pb; done.signal() } // a few frames in: past start-up
    }
}

struct Variant {
    let name: String
    let format: OSType
    let space: CFString?
    let matrix: CFString?
}
let variants = [
    Variant(name: "BGRA   default space ", format: kCVPixelFormatType_32BGRA, space: nil, matrix: nil),
    Variant(name: "BGRA   sRGB          ", format: kCVPixelFormatType_32BGRA, space: CGColorSpace.sRGB, matrix: nil),
    Variant(name: "BGRA   displayP3     ", format: kCVPixelFormatType_32BGRA, space: CGColorSpace.displayP3, matrix: nil),
    Variant(name: "420v   default space ", format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, space: nil, matrix: nil),
    Variant(name: "420v   sRGB   +709   ", format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, space: CGColorSpace.sRGB, matrix: CGDisplayStream.yCbCrMatrix_ITU_R_709_2),
    Variant(name: "420v   displayP3 +709", format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, space: CGColorSpace.displayP3, matrix: CGDisplayStream.yCbCrMatrix_ITU_R_709_2),
]

func attachment(_ pb: CVPixelBuffer, _ key: CFString) -> String {
    guard let v = CVBufferCopyAttachment(pb, key, nil) else { return "none" }
    return "\(v)"
}

/// Mean RGB (0...1) of the left and right swatch rects, in whatever the buffer stores.
func means(_ pb: CVPixelBuffer) -> [(Double, Double, Double)] {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    let rects = [(Int(Double(w) * 0.1), Int(Double(h) * 0.4), Int(Double(w) * 0.3), Int(Double(h) * 0.2)),
                 (Int(Double(w) * 0.6), Int(Double(h) * 0.4), Int(Double(w) * 0.3), Int(Double(h) * 0.2))]
    var out: [(Double, Double, Double)] = []
    if CVPixelBufferGetPlaneCount(pb) == 0 {
        let p = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
        let bpr = CVPixelBufferGetBytesPerRow(pb)
        for (x, y, rw, rh) in rects {
            var r = 0.0, g = 0.0, b = 0.0, n = 0.0
            for row in y..<(y + rh) { for col in x..<(x + rw) {
                let i = row * bpr + col * 4
                b += Double(p[i]); g += Double(p[i + 1]); r += Double(p[i + 2]); n += 1
            } }
            out.append((r / n / 255, g / n / 255, b / n / 255))
        }
    } else {
        let yp = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
        let cp = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
        let yb = CVPixelBufferGetBytesPerRowOfPlane(pb, 0), cb = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
        for (x, y, rw, rh) in rects {
            var sy = 0.0, scb = 0.0, scr = 0.0, ny = 0.0, nc = 0.0
            for row in y..<(y + rh) { for col in x..<(x + rw) {
                sy += Double(yp[row * yb + col]); ny += 1
                if row % 2 == 0 && col % 2 == 0 {
                    scb += Double(cp[(row / 2) * cb + (col / 2) * 2]); scr += Double(cp[(row / 2) * cb + (col / 2) * 2 + 1]); nc += 1
                }
            } }
            let yy = (sy / ny - 16) / 219, u = (scb / nc - 128) / 224, v = (scr / nc - 128) / 224
            let r = yy + 1.5748 * v, b = yy + 1.8556 * u
            out.append((r, (yy - 0.2126 * r - 0.0722 * b) / 0.7152, b))
        }
    }
    return out
}

let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
    print("no such display \(displayID)"); exit(1)
}
guard let mode = CGDisplayCopyDisplayMode(displayID) else { print("no display mode"); exit(1) }

for v in variants {
    let cfg = SCStreamConfiguration()
    cfg.width = mode.pixelWidth; cfg.height = mode.pixelHeight
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    cfg.pixelFormat = v.format
    cfg.showsCursor = false
    if let s = v.space { cfg.colorSpaceName = s }
    if let m = v.matrix { cfg.colorMatrix = m }
    let grab = Grab()
    let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: nil)
    try stream.addStreamOutput(grab, type: .screen, sampleHandlerQueue: DispatchQueue(label: "grab"))
    try await stream.startCapture()
    let ok = grab.done.wait(timeout: .now() + 10) == .success
    try await stream.stopCapture()
    guard ok, let pb = grab.buffer else { print("\(v.name) no frame"); continue }
    let m = means(pb)
    print(String(format: "%@ left=%.3f,%.3f,%.3f right=%.3f,%.3f,%.3f  attach: primaries=%@ transfer=%@ matrix=%@",
                 v.name, m[0].0, m[0].1, m[0].2, m[1].0, m[1].1, m[1].2,
                 attachment(pb, kCVImageBufferColorPrimariesKey),
                 attachment(pb, kCVImageBufferTransferFunctionKey),
                 attachment(pb, kCVImageBufferYCbCrMatrixKey)))
}
