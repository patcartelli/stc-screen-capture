// STC-510 diagnostic: what does CoreGraphics say the display's colour space is?
import Foundation
import CoreGraphics
import AppKit

for id in [CGMainDisplayID()] {
    let cs = CGDisplayCopyColorSpace(id)
    print("display \(id) name=\(cs.name.map { $0 as String } ?? "nil") model=\(cs.model.rawValue)")
    print("isWideGamutRGB=\(cs.isWideGamutRGB) supportsOutput=\(cs.supportsOutput)")
    for d in CGGetActiveDisplayList_ids() { print("active display \(d) builtin=\(CGDisplayIsBuiltin(d) != 0) \(CGDisplayPixelsWide(d))x\(CGDisplayPixelsHigh(d)) wide=\(CGDisplayCopyColorSpace(d).isWideGamutRGB)") }
    if let data = cs.copyICCData() { print("icc bytes=\(CFDataGetLength(data))") }
    print("localizedName=\(cs.copyICCData().flatMap { _ in NSColorSpace(cgColorSpace: cs)?.localizedName } ?? "nil")")
}
if let s = NSScreen.main {
    print("NSScreen colorSpace=\(s.colorSpace?.localizedName ?? "nil")")
    print("canRepresent P3 = \(s.colorSpace?.cgColorSpace.map { _ in true } ?? false)")
}

func CGGetActiveDisplayList_ids() -> [CGDirectDisplayID] {
    var n: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &n)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(n))
    CGGetActiveDisplayList(n, &ids, &n)
    return ids
}
