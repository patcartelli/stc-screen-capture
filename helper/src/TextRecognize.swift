// `recognize-text` (STC-572): Apple's Vision over one captured frame.
//
// On-device, no network and no grant beyond the Screen Recording the capture
// already needs. `.accurate` with language correction, and Vision's automatic
// language detection rather than a fixed list (Patrick, 2026-11-02).
//
// This half only reports what Vision saw: one entry per recognised line, in
// the order Vision returns them, with its confidence and its box. Turning
// that into the clipboard string and the toast is `app/src/ocr-text.ts`, a
// pure function with unit tests, so nothing here decides what gets pasted.
//
// The box is in the frame's own UV with y DOWN (Vision's is y up), the
// convention every other normalised rect in this repo uses. Nothing reads it
// yet; it is kept because the ticket names auto-redaction as its next use.
import Foundation
import CoreText
import Vision

/// `warm-text`: one recognition over a drawn line of text, so the first real
/// Capture Text is fast.
///
/// Measured 2026-11-03 (runbook §1): the first Vision call by a new binary
/// took ~40-45 s of wall time (5 s of CPU, the rest the ANE compiler), and
/// every later call 0.1-0.6 s, in the same process or a fresh one. A rebuilt
/// helper paid it again, so every app update would. The frame is the one the
/// measurement paid the cost on (a 1200x100 sentence); whether a blank or a
/// smaller one would also pay it was not established, so it is not relied on.
/// Main sends this whenever a helper comes up (Patrick, 2026-11-03: warm at
/// launch), not the helper on its own, so the black-box tests that spawn it
/// dozens of times never pay for Vision. Utility QoS: a take may be starting.
enum TextWarm {
    private static let lock = NSLock()
    private static var running = false

    static func run(_ done: @escaping (Result<[String: Any], Error>) -> Void) {
        lock.lock()
        if running { lock.unlock(); return done(.success(["already": true])) }
        running = true
        lock.unlock()
        DispatchQueue.global(qos: .utility).async {
            let start = DispatchTime.now().uptimeNanoseconds
            let result = wordFrame().map { recognizeText(in: $0) }
                ?? .failure(NSError(domain: "TextWarm", code: 1,
                                    userInfo: [NSLocalizedDescriptionKey: "could not draw the warm-up frame"]))
            lock.lock(); running = false; lock.unlock()
            done(result.map { lines in
                ["ms": Double(DispatchTime.now().uptimeNanoseconds &- start) / 1e6, "lines": lines.count]
            })
        }
    }

    /// Black text on white, 1200x100: the frame the cold cost was measured on.
    private static func wordFrame() -> CGImage? {
        let width = 1200, height = 100
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let font = CTFontCreateUIFontForLanguage(.system, 44, nil)
        let attrs = [kCTFontAttributeName: font as Any,
                     kCTForegroundColorAttributeName: CGColor(red: 0, green: 0, blue: 0, alpha: 1)] as CFDictionary
        guard let s = CFAttributedStringCreate(nil, "Select an area and copy its text" as CFString, attrs)
        else { return nil }
        ctx.textPosition = CGPoint(x: 20, y: 30)
        CTLineDraw(CTLineCreateWithAttributedString(s), ctx)
        return ctx.makeImage()
    }
}

func recognizeText(in image: CGImage) -> Result<[[String: Any]], Error> {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    } catch {
        return .failure(error)
    }
    let lines: [[String: Any]] = (request.results ?? []).compactMap { obs in
        guard let top = obs.topCandidates(1).first else { return nil }
        let b = obs.boundingBox
        return [
            "text": top.string,
            "confidence": Double(top.confidence),
            "box": ["x": Double(b.minX), "y": Double(1 - b.maxY),
                    "width": Double(b.width), "height": Double(b.height)],
        ]
    }
    return .success(lines)
}
