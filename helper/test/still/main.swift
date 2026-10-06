// Pure-function tests for the one-frame path's decisions (STC-289). Compiled
// together with the production source, same as the geometry and decisions
// harnesses: no XCTest, so the "framework" is assertions plus a non-zero exit.
//
// Every shot.json this prints (`shot-json ` lines) is validated by
// still-decisions.test.ts against schema/shot-1.schema.json AND parseShot —
// the writer half of STC-301 gate 5, checked without a display or a grant.
import Foundation
import CoreGraphics

var failures = 0
// Compares descriptions, so `got` must be unwrapped (`?? sentinel`) — an
// Optional describes as `Optional("x")` and never equals `"x"`. CI's first
// run of this file failed 8 checks that way while the code was right.
func check(_ label: String, _ got: some Equatable, _ want: some Equatable) {
    if String(describing: got) == String(describing: want) {
        print("ok   \(label)")
    } else {
        let line = "FAIL \(label): got \(got), want \(want)"
        print(line)
        // Also to stderr: on a failure the runner reports only the TAIL of
        // each stream, and sixty `ok` lines push the one FAIL out of stdout's.
        // CI run 33909995248 said "1 FAILURES" and could not say which.
        FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
        failures += 1
    }
}

// ── request parsing ─────────────────────────────────────────────────────────
func parse(_ cmd: [String: Any]) -> String {
    switch parseStillRequest(cmd) {
    case .success(let r): return "ok:\(r.kind.rawValue):\(r.file)"
    case .failure(let e): return "err:\(e.code)"
    }
}

check("dir is required", parse(["cmd": "capture-still"]), "err:missing-dir")
check("an empty dir is missing", parse(["dir": ""]), "err:missing-dir")
check("kind defaults to display-crop, file to frame.png",
      parse(["dir": "/tmp/x"]), "ok:display-crop:frame.png")
check("an unknown kind is refused, not defaulted", parse(["dir": "/tmp/x", "kind": "region"]), "err:bad-kind")
check("a window shot needs a windowId", parse(["dir": "/tmp/x", "kind": "window"]), "err:missing-window-id")
check("a negative windowId is no windowId",
      parse(["dir": "/tmp/x", "kind": "window", "windowId": -1]), "err:missing-window-id")
check("a window shot with a crop is two claims about the region",
      parse(["dir": "/tmp/x", "kind": "window", "windowId": 12,
             "crop": ["x": 0, "y": 0, "width": 10, "height": 10]]), "err:crop-on-window")
check("a window shot parses", parse(["dir": "/tmp/x", "kind": "window", "windowId": 12]), "ok:window:frame.png")
check("a crop written as integers parses (a Swift Int in Any is not an NSNumber)",
      parse(["dir": "/tmp/x", "crop": ["x": 0, "y": 0, "width": 10, "height": 10]]), "ok:display-crop:frame.png")
check("a crop with zero height is refused",
      parse(["dir": "/tmp/x", "crop": ["x": 0, "y": 0, "width": 10, "height": 0]]), "err:bad-crop")
check("a crop missing a side is refused",
      parse(["dir": "/tmp/x", "crop": ["x": 0, "y": 0, "width": 10]]), "err:bad-crop")
check("a crop that is not an object is refused", parse(["dir": "/tmp/x", "crop": "all"]), "err:bad-crop")
check("file is a name beside shot.json, never a path",
      parse(["dir": "/tmp/x", "file": "../elsewhere.png"]), "err:bad-file")
check("file cannot be empty", parse(["dir": "/tmp/x", "file": ""]), "err:bad-file")
check("file can be renamed", parse(["dir": "/tmp/x", "file": "grab.png"]), "ok:display-crop:grab.png")

if case .success(let r) = parseStillRequest(["dir": "/tmp/x", "displayId": 3,
                                              "crop": ["x": 10, "y": 20.5, "width": 300, "height": 200]]) {
    check("displayId is carried", r.displayId ?? 0, UInt32(3))
    check("integral and fractional coordinates both parse",
          r.crop ?? StillRect(x: 0, y: 0, width: 0, height: 0), StillRect(x: 10, y: 20.5, width: 300, height: 200))
} else {
    print("FAIL a full display-crop request did not parse"); failures += 1
}
if case .success(let r) = parseStillRequest(["dir": "/tmp/x"]) {
    check("no displayId means the first display", r.displayId, nil as UInt32?)
    check("no crop means the whole display", r.crop, nil as StillRect?)
}

// ── the overlay's exclusion list (STC-290) ──────────────────────────────────
if case .success(let r) = parseStillRequest(["dir": "/tmp/x", "excludeWindowIds": [7, 9]]) {
    check("excludeWindowIds are carried", r.excludeWindowIds, [UInt32(7), UInt32(9)])
} else { print("FAIL an exclusion list did not parse"); failures += 1 }
if case .success(let r) = parseStillRequest(["dir": "/tmp/x"]) {
    check("no exclusion list is an empty one, never nil", r.excludeWindowIds.isEmpty, true)
}
if case .success(let r) = parseStillRequest(["dir": "/tmp/x", "excludeWindowIds": [7, "nonsense", -1]]) {
    // A closed overlay window is exactly an unreadable id, and excluding one
    // that is already gone is a no-op — so the request stands, minus the junk.
    check("an unreadable id is dropped, not refused", r.excludeWindowIds, [UInt32(7)])
}
if case .success(let r) = parseStillRequest(["dir": "/tmp/x", "kind": "window", "windowId": 3,
                                              "excludeWindowIds": [7]]) {
    check("a window shot carries the list too (it is simply unused there)",
          r.excludeWindowIds, [UInt32(7)])
}

// ── crop resolution ─────────────────────────────────────────────────────────
check("no crop is the whole display",
      resolveCrop(nil, pointWidth: 1920, pointHeight: 1080),
      CropDecision.region(StillRect(x: 0, y: 0, width: 1920, height: 1080)))
check("a crop inside the display is itself",
      resolveCrop(StillRect(x: 100, y: 80, width: 640, height: 360), pointWidth: 1920, pointHeight: 1080),
      CropDecision.region(StillRect(x: 100, y: 80, width: 640, height: 360)))
check("a crop that overshoots the edge is clamped, not refused",
      resolveCrop(StillRect(x: 1800, y: 1000, width: 400, height: 400), pointWidth: 1920, pointHeight: 1080),
      CropDecision.region(StillRect(x: 1800, y: 1000, width: 120, height: 80)))
check("a crop starting off the top-left is clamped to the origin",
      resolveCrop(StillRect(x: -50, y: -50, width: 100, height: 100), pointWidth: 1920, pointHeight: 1080),
      CropDecision.region(StillRect(x: 0, y: 0, width: 50, height: 50)))
check("a crop entirely off the display is refused",
      resolveCrop(StillRect(x: 2000, y: 0, width: 100, height: 100), pointWidth: 1920, pointHeight: 1080),
      CropDecision.outside)
check("a crop touching only the edge is refused (zero overlap)",
      resolveCrop(StillRect(x: 1920, y: 0, width: 100, height: 100), pointWidth: 1920, pointHeight: 1080),
      CropDecision.outside)

// ── pixel size ──────────────────────────────────────────────────────────────
check("2x: 640x360 points is 1280x720 pixels",
      framePixelSize(points: StillRect(x: 0, y: 0, width: 640, height: 360), backingScale: 2).width, 1280)
check("rounds rather than truncates (1279.9999 points at 1x)",
      framePixelSize(points: StillRect(x: 0, y: 0, width: 1279.9999, height: 1), backingScale: 1).width, 1280)
check("never below one pixel",
      framePixelSize(points: StillRect(x: 0, y: 0, width: 0.1, height: 0.1), backingScale: 1).height, 1)
check("fractional scale (a scaled external display) rounds",
      framePixelSize(points: StillRect(x: 0, y: 0, width: 1000, height: 1000), backingScale: 1.5).width, 1500)

// ── cursor localisation ─────────────────────────────────────────────────────
// Main display 1920x1080 at the CG origin; a second display to its right; a
// third ABOVE it (negative CG y). Cocoa mouseLocation has its origin at the
// main display's bottom-left with y up.
let main = CGRect(x: 0, y: 0, width: 1920, height: 1080)
let right = CGRect(x: 1920, y: 0, width: 2560, height: 1440)
let above = CGRect(x: 0, y: -900, width: 1440, height: 900)
let mainH = 1080.0

func loc(_ x: Double, _ y: Double, on d: CGRect) -> String {
    guard let p = localizeCursor(mouseX: x, mouseY: y, mainDisplayHeight: mainH, display: d) else { return "absent" }
    return "\(p.x),\(p.y)"
}
check("main display: Cocoa y flips against the main height", loc(100, 1000, on: main), "100.0,80.0")
check("main display: bottom-left corner is local (0, 1079)", loc(0, 1, on: main), "0.0,1079.0")
check("pointer on the right display is ABSENT for the main one", loc(2000, 100, on: main), "absent")
check("right display: local to its own origin, still flipped against MAIN height",
      loc(2000, 100, on: right), "80.0,980.0")
check("right display is taller than main: Cocoa y can be negative there",
      loc(2000, -300, on: right), "80.0,1380.0")
check("display above main: negative CG y localises to positive local y",
      loc(700, 1500, on: above), "700.0,480.0")
check("display above main: a pointer on main is absent for it", loc(700, 500, on: above), "absent")
check("exactly on the far edge is outside (half-open, like CGRect.contains)",
      loc(1920, 500, on: main), "absent")

// ── window visibility (STC-380) ─────────────────────────────────────────────
let d0 = StillRect(x: 0, y: 0, width: 1920, height: 1080)
let full = StillRect(x: 100, y: 100, width: 400, height: 300)
check("a window well inside one display, nothing in front, is fully visible",
      isFullyVisible(full, displays: [d0], occluders: []), true)
check("a window entirely off every display is not",
      isFullyVisible(StillRect(x: 5000, y: 5000, width: 400, height: 300), displays: [d0], occluders: []),
      false)
check("a window mostly off the display edge is not",
      isFullyVisible(StillRect(x: 1800, y: 100, width: 400, height: 300), displays: [d0], occluders: []),
      false)
check("a window flush against the far edge, exactly on it, is fully visible (no slack needed)",
      isFullyVisible(StillRect(x: 1520, y: 100, width: 400, height: 300), displays: [d0], occluders: []), true)
check("a window spanning two displays, fully covered by their union, is fully visible",
      isFullyVisible(StillRect(x: 1800, y: 100, width: 400, height: 300),
                     displays: [d0, StillRect(x: 1920, y: 0, width: 1920, height: 1080)], occluders: []), true)
check("a window entirely covered by one window in front is not",
      isFullyVisible(full, displays: [d0], occluders: [StillRect(x: 0, y: 0, width: 1920, height: 1080)]), false)
check("a window covered by TWO windows together, neither alone covering it, is not",
      isFullyVisible(full, displays: [d0],
                     occluders: [StillRect(x: 100, y: 100, width: 200, height: 300),
                                 StillRect(x: 300, y: 100, width: 200, height: 300)]),
      false)
check("a window with an occluder that misses it entirely is unaffected",
      isFullyVisible(full, displays: [d0], occluders: [StillRect(x: 900, y: 900, width: 100, height: 100)]), true)
check("a sliver poking out from under an occluder is not enough to count as fully visible",
      isFullyVisible(full, displays: [d0],
                     occluders: [StillRect(x: 100, y: 100, width: 395, height: 300)]), false)
check("STC-481: a window 30% under another is still selectable",
      isFullyVisible(full, displays: [d0], occluders: [StillRect(x: 100, y: 100, width: 120, height: 300)]), true)
check("STC-481: a window 60% under another is not",
      isFullyVisible(full, displays: [d0], occluders: [StillRect(x: 100, y: 100, width: 240, height: 300)]), false)
check("a window behind is not consulted (occluders here empty on purpose)",
      isFullyVisible(full, displays: [d0], occluders: []), true)
check("remainingFraction of an empty rect is 0, not NaN",
      remainingFraction(StillRect(x: 0, y: 0, width: 0, height: 0), subtracting: []), 0.0)
check("subtractRect leaves an untouched rect alone",
      subtractRect([full], StillRect(x: 900, y: 900, width: 10, height: 10)), [full])
check("subtractRect removes a fully-covering cut entirely",
      subtractRect([full], StillRect(x: 0, y: 0, width: 1920, height: 1080)), [] as [StillRect])

// ── shape names ─────────────────────────────────────────────────────────────
// Classification itself is STC-309's (`classifyCursor`, covered by
// decisions/main.swift); a still only needs the list it writes from to be the
// schema's, which still-decisions.test.ts checks against this line.
print("shapes " + cursorShapeNames.joined(separator: ","))
check("the default is in the list", cursorShapeNames.contains(defaultCursorShape), true)

// ── the document ────────────────────────────────────────────────────────────
let display = DisplayGeometry(id: 1, pointWidth: 1920, pointHeight: 1080,
                              pixelWidth: 3840, pixelHeight: 2160, originX: 0, originY: 0)
check("backingScale is pixels per point", display.backingScale, 2.0)
check("backingScale survives an unknown point size",
      DisplayGeometry(id: 1, pointWidth: 0, pointHeight: 0, pixelWidth: 10, pixelHeight: 10,
                      originX: 0, originY: 0).backingScale, 1.0)

func emit(_ label: String, _ doc: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys])
    print("shot-json \(label) " + String(data: data, encoding: .utf8)!)
}

// ── colour space identification (STC-478) ───────────────────────────────────
func be32(_ v: Int) -> [UInt8] { [UInt8(v >> 24 & 255), UInt8(v >> 16 & 255), UInt8(v >> 8 & 255), UInt8(v & 255)] }
/// A minimal profile: 128-byte header, one tag table entry, one `desc` tag.
func profile(tag: [UInt8]) -> Data {
    var d = [UInt8](repeating: 0, count: 128)
    d += be32(1); d += be32(0x64657363); d += be32(144); d += be32(tag.count)
    d += tag
    return Data(d)
}
var v2Tag: [UInt8] = []
v2Tag += be32(0x64657363); v2Tag += be32(0); v2Tag += be32(11)
v2Tag += Array("Display P3".utf8); v2Tag.append(0)
let u16: [UInt8] = "Display P3".utf16.flatMap { [UInt8($0 >> 8), UInt8($0 & 255)] }
var v4Tag: [UInt8] = []
v4Tag += be32(0x6D6C7563); v4Tag += be32(0); v4Tag += be32(1); v4Tag += be32(12)
v4Tag += [0x65, 0x6E, 0x55, 0x53]
v4Tag += be32(u16.count); v4Tag += be32(28); v4Tag += u16
check("v2 desc tag is read", iccDescription(profile(tag: v2Tag)) ?? "nil", "Display P3")
check("v4 mluc tag is read", iccDescription(profile(tag: v4Tag)) ?? "nil", "Display P3")
check("garbage is not a profile", iccDescription(Data([1, 2, 3])) ?? "nil", "nil")
check("a name wins over the profile",
      resolveColorSpaceName(name: "kCGColorSpaceSRGB", iccDescription: "Display P3") ?? "nil", "kCGColorSpaceSRGB")
check("no name, Display P3 profile -> P3",
      resolveColorSpaceName(name: nil, iccDescription: "Display P3") ?? "nil", "kCGColorSpaceDisplayP3")
check("no name, sRGB profile -> sRGB",
      resolveColorSpaceName(name: nil, iccDescription: "sRGB IEC61966-2.1") ?? "nil", "kCGColorSpaceSRGB")
check("no name, unknown profile stays unnamed",
      resolveColorSpaceName(name: nil, iccDescription: "Color LCD") ?? "nil", "nil")
check("no name, no profile stays unnamed", resolveColorSpaceName(name: nil, iccDescription: nil) ?? "nil", "nil")
// The real OS profile, so the parser is checked against what CoreGraphics emits.
if let p3 = CGColorSpace(name: CGColorSpace.displayP3)?.copyICCData() {
    check("the OS's own Display P3 profile resolves to P3",
          resolveColorSpaceName(name: nil, iccDescription: iccDescription(p3 as Data)) ?? "nil", "kCGColorSpaceDisplayP3")
}
if let s = CGColorSpace(name: CGColorSpace.sRGB)?.copyICCData() {
    check("the OS's own sRGB profile resolves to sRGB",
          resolveColorSpaceName(name: nil, iccDescription: iccDescription(s as Data)) ?? "nil", "kCGColorSpaceSRGB")
}

// ── colour space by colorants (STC-511) ─────────────────────────────────────
// STC-478 named a profile by its DESCRIPTION, and the real built-in screen's profile says only
// "Display" (CGColorSpace calls it "Color LCD"), so a real P3 still recorded no colour space at
// all. What a profile IS is its colorants; what it is CALLED is up to whoever made it.
// Every expression below is built in small typed steps: swiftc on CI gives up on a long chain of
// `+` over array literals ("unable to type-check this expression in reasonable time", the same
// trap STC-478's second commit hit), even where a newer local compiler does not.
func s15(_ v: Double) -> [UInt8] {
    let scaled: Double = (v * 65536).rounded()
    let bits: UInt32 = UInt32(bitPattern: Int32(scaled))
    return be32(Int(bits))
}
/// A matrix/TRC-less RGB profile: a `desc` tag and the three colorant tags, D50-adapted XYZ.
func xyzTag(_ v: [Double]) -> [UInt8] {
    var t: [UInt8] = be32(0x58595A20)
    t += be32(0)
    t += s15(v[0])
    t += s15(v[1])
    t += s15(v[2])
    return t
}
func rgbProfile(desc: String, r: [Double], g: [Double], b: [Double]) -> Data {
    var descTag: [UInt8] = be32(0x64657363)
    descTag += be32(0)
    descTag += be32(desc.utf8.count + 1)
    descTag += Array(desc.utf8)
    descTag.append(0)
    let sigs: [Int] = [0x64657363, 0x7258595A, 0x6758595A, 0x6258595A]
    let tags: [[UInt8]] = [descTag, xyzTag(r), xyzTag(g), xyzTag(b)]
    var table: [UInt8] = be32(4)
    var body: [UInt8] = []
    var off = 128 + 4 + 4 * 12
    for i in 0..<4 {
        table += be32(sigs[i])
        table += be32(off)
        table += be32(tags[i].count)
        body += tags[i]
        off += tags[i].count
    }
    var out: [UInt8] = [UInt8](repeating: 0, count: 128)
    out += table
    out += body
    return Data(out)
}
let p3R: [Double] = [0.5151, 0.2412, -0.0011]
let p3G: [Double] = [0.2920, 0.6922, 0.0419]
let p3B: [Double] = [0.1571, 0.0666, 0.7841]
let srgbR: [Double] = [0.4361, 0.2225, 0.0139]
let srgbG: [Double] = [0.3851, 0.7169, 0.0971]
let srgbB: [Double] = [0.1431, 0.0606, 0.7141]
func nudged(_ v: [Double], _ d: Double) -> [Double] {
    var out: [Double] = []
    for x in v { out.append(x + d) }
    return out
}
func rounded4(_ v: [Double]) -> [Double] {
    var out: [Double] = []
    for x in v { out.append((x * 10000).rounded() / 10000) }
    return out
}

let p3All: [Double] = p3R + p3G + p3B
let readBack: [Double] = rounded4(iccColorants(rgbProfile(desc: "x", r: p3R, g: p3G, b: p3B)) ?? [])
check("the colorants are read back", readBack, p3All)
check("a profile with no colorant tags has none", iccColorants(profile(tag: v2Tag)) == nil, true)
check("garbage has no colorants", iccColorants(Data([1, 2, 3])) == nil, true)

let builtIn = rgbProfile(desc: "Display", r: p3R, g: p3G, b: p3B)
check("the built-in screen's profile (described just \"Display\") is P3",
      resolveColorSpaceName(name: nil, iccDescription: iccDescription(builtIn), iccData: builtIn) ?? "nil",
      "kCGColorSpaceDisplayP3")
let monitor = rgbProfile(desc: "HP Z27", r: srgbR, g: srgbG, b: srgbB)
check("an sRGB monitor's profile (described \"HP Z27\") is sRGB",
      resolveColorSpaceName(name: nil, iccDescription: iccDescription(monitor), iccData: monitor) ?? "nil",
      "kCGColorSpaceSRGB")
let adobeR: [Double] = [0.6097, 0.3111, 0.0195]
let adobeG: [Double] = [0.2053, 0.6257, 0.0609]
let adobeB: [Double] = [0.1492, 0.0632, 0.7446]
let wide = rgbProfile(desc: "Display", r: adobeR, g: adobeG, b: adobeB)
check("a space that is neither (Adobe RGB colorants) stays unnamed",
      resolveColorSpaceName(name: nil, iccDescription: "Display", iccData: wide) ?? "nil", "nil")
let nearR: [Double] = nudged(p3R, 0.004)
let nearG: [Double] = nudged(p3G, -0.004)
let nearB: [Double] = nudged(p3B, 0.004)
let drifted = rgbProfile(desc: "d", r: nearR, g: nearG, b: nearB)
check("a small calibration drift still matches P3",
      resolveColorSpaceName(name: nil, iccDescription: nil, iccData: drifted) ?? "nil",
      "kCGColorSpaceDisplayP3")
let farR: [Double] = nudged(p3R, 0.03)
let departed = rgbProfile(desc: "d", r: farR, g: p3G, b: p3B)
check("a large departure does not",
      resolveColorSpaceName(name: nil, iccDescription: nil, iccData: departed) ?? "nil", "nil")
let liar = rgbProfile(desc: "Display P3", r: srgbR, g: srgbG, b: srgbB)
check("the colorants outrank a misleading description",
      resolveColorSpaceName(name: nil, iccDescription: iccDescription(liar), iccData: liar) ?? "nil", "kCGColorSpaceSRGB")
check("no colorants in the data falls back to the description",
      resolveColorSpaceName(name: nil, iccDescription: "Display P3", iccData: Data([1, 2, 3])) ?? "nil", "kCGColorSpaceDisplayP3")
check("a name still wins over colorants",
      resolveColorSpaceName(name: "kCGColorSpaceSRGB", iccDescription: nil, iccData: builtIn) ?? "nil", "kCGColorSpaceSRGB")
if let p3 = CGColorSpace(name: CGColorSpace.displayP3)?.copyICCData() {
    check("the OS's own Display P3 profile resolves to P3 by colorants alone",
          resolveColorSpaceName(name: nil, iccDescription: nil, iccData: p3 as Data) ?? "nil", "kCGColorSpaceDisplayP3")
}
if let s = CGColorSpace(name: CGColorSpace.sRGB)?.copyICCData() {
    check("the OS's own sRGB profile resolves to sRGB by colorants alone",
          resolveColorSpaceName(name: nil, iccDescription: nil, iccData: s as Data) ?? "nil", "kCGColorSpaceSRGB")
}

// (a) a display crop with the pointer on the display
let a = shotDocument(kind: .displayCrop, capturedAtNs: 1_000_000_000, timebase: (numer: 125, denom: 3),
                     display: display, colorSpace: "kCGColorSpaceDisplayP3",
                     crop: StillRect(x: 100, y: 80, width: 640, height: 360), window: nil,
                     frame: StillFrameInfo(file: "frame.png", width: 1280, height: 720, alpha: false),
                     cursor: StillCursorSample(x: 420, y: 300, shape: "arrow"))
check("(a) display-crop carries crop and no window", a["window"] == nil && a["crop"] != nil, true)
check("(a) decoration is selected-area", (a["decoration"] as? [String: Any])?["mode"] as? String ?? "missing", "selected-area")
check("(a) capturedAtNs is a decimal string", a["capturedAtNs"] as? String ?? "missing", "1000000000")
emit("display-crop", a)

// (b) a whole-display shot, pointer elsewhere: no crop asked for, no cursor block
let b = shotDocument(kind: .displayCrop, capturedAtNs: 42, timebase: (numer: 1, denom: 1),
                     display: display, colorSpace: nil, crop: nil, window: nil,
                     frame: StillFrameInfo(file: "frame.png", width: 3840, height: 2160, alpha: false),
                     cursor: nil)
check("(b) no crop means the crop block IS the whole display",
      (b["crop"] as? [String: Any])?["width"] as? Double ?? -1, 1920.0)
check("(b) cursor elsewhere means NO cursor block, not a zeroed one", b["cursor"] == nil, true)
check("(b) no colour space means no key", (b["display"] as? [String: Any])?["colorSpace"] == nil, true)
emit("full-display", b)

// (c) a window with alpha
let c = shotDocument(kind: .window, capturedAtNs: 7, timebase: (numer: 125, denom: 3),
                     display: display, colorSpace: "kCGColorSpaceSRGB", crop: nil,
                     window: StillWindowInfo(id: 4711, app: "Finder", title: "Downloads",
                                             bounds: StillRect(x: 200, y: 120, width: 800, height: 600)),
                     frame: StillFrameInfo(file: "frame.png", width: 1600, height: 1200, alpha: true),
                     cursor: StillCursorSample(x: 500, y: 400, shape: "pointingHand"))
check("(c) window carries window and no crop", c["crop"] == nil && c["window"] != nil, true)
check("(c) decoration is window-only", (c["decoration"] as? [String: Any])?["mode"] as? String ?? "missing", "window-only")
emit("window", c)

// (d) a window whose pixels came back opaque: honest decoration, no title
let d = shotDocument(kind: .window, capturedAtNs: 7, timebase: (numer: 125, denom: 3),
                     display: display, colorSpace: nil, crop: nil,
                     window: StillWindowInfo(id: 9, app: nil, title: "",
                                             bounds: StillRect(x: 0, y: 0, width: 10, height: 10)),
                     frame: StillFrameInfo(file: "frame.png", width: 20, height: 20, alpha: false),
                     cursor: nil)
check("(d) an opaque window frame is selected-area, which parseShot accepts",
      (d["decoration"] as? [String: Any])?["mode"] as? String ?? "missing", "selected-area")
check("(d) an empty title is omitted, not written empty",
      (d["window"] as? [String: Any])?["title"] == nil, true)
emit("window-opaque", d)

// ── z-order (STC-481) ───────────────────────────────────────────────────────
// SCK listed Linear first though CG had it near the back; CG's order must win.
check("frontToBack: CG rank overrides input order",
      frontToBack([128, 119956, 118223], zRank: [118223: 0, 119956: 1, 128: 2]), [118223, 119956, 128])
check("frontToBack: unranked ids go behind ranked ones, keeping input order",
      frontToBack([5, 6, 7], zRank: [7: 0]), [7, 5, 6])

print(failures == 0 ? "ALL PASS" : "\(failures) FAILURES")
exit(failures == 0 ? 0 : 1)
