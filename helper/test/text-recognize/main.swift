// STC-572: `recognizeText` on a frame with known text in it. Vision needs no
// grant and no display, so this runs on CI: two lines are drawn into a bitmap,
// recognised, and printed as one JSON line for text-recognize.test.ts to read.
// The assertions live on the TypeScript side, next to `ocr-text.ts`, which is
// what turns these lines into the clipboard string.
import Foundation
import AppKit

let width = 900, height = 260
guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpace(name: CGColorSpace.sRGB)!,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    print("FAIL could not make a bitmap"); exit(1)
}
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 56),
    .foregroundColor: NSColor.black,
]
// Drawn bottom-up in CG's coordinates: the FIRST line is the top one.
NSAttributedString(string: "Capture text quickly", attributes: attrs).draw(at: CGPoint(x: 40, y: 150))
NSAttributedString(string: "Second line here", attributes: attrs).draw(at: CGPoint(x: 40, y: 40))
NSGraphicsContext.current = nil

guard let image = ctx.makeImage() else { print("FAIL no image"); exit(1) }

switch recognizeText(in: image) {
case .failure(let e):
    print("FAIL recognizeText: \(e)"); exit(1)
case .success(let lines):
    let data = try! JSONSerialization.data(withJSONObject: lines, options: [.sortedKeys])
    print("lines " + String(data: data, encoding: .utf8)!)
}
