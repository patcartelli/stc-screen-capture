import Foundation
import CoreGraphics

/// The decisions the one-frame path makes (STC-289), kept free of
/// ScreenCaptureKit and AppKit so `helper/test/still/main.swift` can compile
/// them into a throwaway binary and exercise them without a display, a grant
/// or a pointer — the same arrangement `CaptureDecisions.swift` has for the
/// recording path (STC-248). `Still.swift` calls these; it does not repeat them.
///
/// What is decided here: what a `capture-still` request means and whether it
/// is well-formed; which region of the display a crop resolves to; where the
/// pointer is in the source display's own coordinates, or that it is elsewhere;
/// and the exact `shot.json` the helper writes (which shape the pointer is comes
/// from STC-309's classifier, shared with the recording path). That last one is the contract with `transform/src/shot.ts`
/// (schema/shot-1.schema.json), and `still-decisions.test.ts` validates every
/// document this produces against both — the writer half of STC-301 gate 5,
/// checked on every `npm test` rather than only on a Mac with a grant.

/// A rectangle in display-local POINTS, top-left origin: the shot-1 `rect`.
struct StillRect: Equatable {
    var x: Double, y: Double, width: Double, height: Double

    var json: [String: Any] { ["x": x, "y": y, "width": width, "height": height] }
    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }

    init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
    init(_ r: CGRect) {
        self.init(x: Double(r.origin.x), y: Double(r.origin.y),
                  width: Double(r.size.width), height: Double(r.size.height))
    }
}

/// The shot-1 `kind` discriminator. A window is NOT a crop (STC-289, changed
/// decision): a crop out of a display capture is always an opaque rectangle
/// with whatever was behind the window baked in.
enum StillKind: String {
    case displayCrop = "display-crop"
    case window
}

struct StillRequest: Equatable {
    /// The shot's own directory; `file` and `shot.json` are written inside it.
    /// Empty for `recognize-text` (STC-572), which writes nothing.
    let dir: String
    let kind: StillKind
    /// display-crop: which display. nil means the first one ScreenCaptureKit
    /// lists, which is the main display — the same fallback `start` uses.
    let displayId: UInt32?
    /// display-crop: the region in display-local points. nil means the whole
    /// display, which is what a full-screen shot is.
    let crop: StillRect?
    /// window: the CGWindowID, from the `windows` verb or the picker (STC-290).
    let windowId: UInt32?
    /// The frame's file name, beside shot.json. A NAME, never a path.
    let file: String
    /// CGWindowIDs to leave OUT of a display capture (STC-290).
    ///
    /// The selection overlay is a window like any other, and a still taken
    /// while it is still composited would capture the dimming and the marquee.
    /// Hiding it first is necessary and not sufficient — the hide and the
    /// capture reach the window server through different paths, with no
    /// ordering between them — so the caller also names the windows it must not
    /// see. Empty for every other caller. Window shots ignore it: their filter
    /// contains exactly one window, so nothing else can appear anyway.
    let excludeWindowIds: [UInt32]
    /// window: also read the desktop wallpaper of the window's display into
    /// `wallpaper.jpg` beside the frame (STC-628). Always false for a
    /// display-crop shot: a crop has the real desktop in its pixels already,
    /// so the flag is ignored there rather than refused.
    let wallpaper: Bool

    static let defaultFile = "frame.png"
    /// What the wallpaper is called in a shot's folder: `background.file` of a
    /// wallpaper shot, and the `wallpaper` verb's default.
    static let wallpaperFile = "wallpaper.jpg"
}

enum StillRequestError: Error, Equatable, CustomStringConvertible {
    case missingDir
    case badKind(String)
    case missingWindowId
    case cropOnWindow
    case badCrop(String)
    case badFile(String)
    /// The `wallpaper` verb (STC-628) only.
    case missingDisplayId
    case notJpg(String)

    var code: String {
        switch self {
        case .missingDir:       return "missing-dir"
        case .badKind:          return "bad-kind"
        case .missingWindowId:  return "missing-window-id"
        case .cropOnWindow:     return "crop-on-window"
        case .badCrop:          return "bad-crop"
        case .badFile:          return "bad-file"
        case .missingDisplayId: return "missing-display-id"
        case .notJpg:           return "bad-file"
        }
    }

    var description: String {
        switch self {
        case .missingDir: return "capture-still requires \"dir\""
        case .badKind(let k): return "kind must be display-crop or window, not \"\(k)\""
        case .missingWindowId: return "a window shot requires \"windowId\" (a CGWindowID; see the windows verb)"
        case .cropOnWindow: return "a window shot must not carry a crop — the window's own bounds are the region"
        case .badCrop(let why): return "crop must be {x, y, width, height} in display-local points with positive size: \(why)"
        case .badFile(let f): return "file must be a bare file name beside shot.json, not \"\(f)\""
        case .missingDisplayId: return "wallpaper requires \"displayId\" (a CGDirectDisplayID; a shot's display.id)"
        case .notJpg(let f): return "file must be a bare .jpg name beside shot.json, not \"\(f)\""
        }
    }
}

/// Numbers arrive from JSONSerialization as NSNumber, and `as? Double` bridges
/// an integral NSNumber too — which is what lets a client send `"x": 100` for
/// a rect. A native Swift `Int` inside `Any` does NOT take that bridge (the
/// harness's dictionary literals are exactly that), so it is accepted by name.
/// CI's first run of the harness found this: `crop-on-window` came back as
/// `bad-crop` for a crop written as integers.
///
/// Not `private`: STC-370's `parseStartRequest` (CaptureDecisions.swift)
/// parses the same shapes for a recording's region/window scope and reuses
/// this rather than keeping a second copy.
func number(_ v: Any?) -> Double? {
    if let d = v as? Double, d.isFinite { return d }
    if let i = v as? Int { return Double(i) }
    return nil
}

/// A display or window id: a non-negative integer that fits the CG types.
/// Shared with `parseStartRequest`, same reason as `number` above.
func id32(_ v: Any?) -> UInt32? {
    guard let i = v as? Int, i >= 0, i <= Int(UInt32.max) else { return nil }
    return UInt32(i)
}

/// Shared with `parseStartRequest`, same reason as `number` above.
func parseRect(_ v: Any) -> Result<StillRect, StillRequestError> {
    guard let o = v as? [String: Any],
          let x = number(o["x"]), let y = number(o["y"]),
          let w = number(o["width"]), let h = number(o["height"])
    else { return .failure(.badCrop("not an object of four finite numbers")) }
    guard w > 0, h > 0 else { return .failure(.badCrop("width \(w) x height \(h)")) }
    return .success(StillRect(x: x, y: y, width: w, height: h))
}

/// What the command line asked for, or exactly why it cannot be done.
///
/// Refuses rather than defaults on anything that changes what gets captured —
/// a crop on a window shot is two claims about the region, and `parseShot`
/// refuses the same pair on the way back in. The two defaults that remain
/// (kind, file) change nothing about the pixels.
func parseStillRequest(_ cmd: [String: Any]) -> Result<StillRequest, StillRequestError> {
    guard let dir = cmd["dir"] as? String, !dir.isEmpty else { return .failure(.missingDir) }

    let kindRaw = cmd["kind"] as? String ?? StillKind.displayCrop.rawValue
    guard let kind = StillKind(rawValue: kindRaw) else { return .failure(.badKind(kindRaw)) }

    let file = cmd["file"] as? String ?? StillRequest.defaultFile
    // A name, not a path: the shot's directory is the request's `dir` and
    // nothing in the request may write outside it.
    guard !file.isEmpty, !file.contains("/"), file != ".", file != ".." else {
        return .failure(.badFile(file))
    }
    return parseScope(cmd, kind: kind, dir: dir, file: file, wallpaper: cmd["wallpaper"] as? Bool ?? false)
}

/// `recognize-text` (STC-572): the scope `capture-still` takes (a display crop
/// or a window, and the windows to leave out) with no directory and no file,
/// because the frame never leaves memory. `dir`, `file` and `wallpaper` are
/// not read: there is nothing for them to name.
func parseTextRequest(_ cmd: [String: Any]) -> Result<StillRequest, StillRequestError> {
    let kindRaw = cmd["kind"] as? String ?? StillKind.displayCrop.rawValue
    guard let kind = StillKind(rawValue: kindRaw) else { return .failure(.badKind(kindRaw)) }
    return parseScope(cmd, kind: kind, dir: "", file: StillRequest.defaultFile, wallpaper: false)
}

/// What gets captured. Shared by `capture-still` and `recognize-text`, so the
/// two cannot disagree about what a region or a window is.
private func parseScope(_ cmd: [String: Any], kind: StillKind, dir: String, file: String,
                        wallpaper: Bool) -> Result<StillRequest, StillRequestError> {
    var crop: StillRect? = nil
    if let c = cmd["crop"] {
        switch parseRect(c) {
        case .success(let r): crop = r
        case .failure(let e): return .failure(e)
        }
    }

    // Anything unreadable is dropped rather than refused: an id the window
    // server no longer knows is exactly what a stale overlay id looks like, and
    // excluding a window that is already gone is a no-op, not an error.
    let exclude = (cmd["excludeWindowIds"] as? [Any] ?? []).compactMap(id32)

    switch kind {
    case .displayCrop:
        return .success(StillRequest(dir: dir, kind: kind, displayId: id32(cmd["displayId"]),
                                     crop: crop, windowId: nil, file: file,
                                     excludeWindowIds: exclude, wallpaper: false))
    case .window:
        guard crop == nil else { return .failure(.cropOnWindow) }
        guard let wid = id32(cmd["windowId"]) else { return .failure(.missingWindowId) }
        // The wallpaper lands beside the frame under its own fixed name; a
        // frame given that name would be overwritten by it.
        if wallpaper && file == StillRequest.wallpaperFile { return .failure(.badFile(file)) }
        return .success(StillRequest(dir: dir, kind: kind, displayId: nil,
                                     crop: nil, windowId: wid, file: file,
                                     excludeWindowIds: exclude, wallpaper: wallpaper))
    }
}

enum CropDecision: Equatable {
    /// The region to capture, in display-local points, inside the display.
    case region(StillRect)
    /// Nothing of the crop lies on the display.
    case outside
}

/// The region a display-crop shot captures.
///
/// A crop that overshoots an edge is clamped, not refused: a drag that runs
/// off the screen is the normal way to mean "to the edge". Only a crop with no
/// overlap at all is refused, because there is nothing honest to return for it.
func resolveCrop(_ crop: StillRect?, pointWidth: Int, pointHeight: Int) -> CropDecision {
    let display = CGRect(x: 0, y: 0, width: pointWidth, height: pointHeight)
    guard let crop else { return .region(StillRect(display)) }
    let r = crop.cgRect.intersection(display)
    guard !r.isNull, r.width > 0, r.height > 0 else { return .outside }
    return .region(StillRect(r))
}

/// The frame's size in pixels for a region in points. Rounded, never
/// truncated — 1279.9999 points at 2x is 2560 pixels, not 2559 — and never
/// below one pixel on either axis.
func framePixelSize(points: StillRect, backingScale: Double) -> (width: Int, height: Int) {
    (max(1, Int((points.width * backingScale).rounded())),
     max(1, Int((points.height * backingScale).rounded())))
}

/// Where the pointer is on the SOURCE display, in that display's own
/// top-left-origin points — or nil when it is on another display.
///
/// SPACE: Cocoa global (bottom-left origin, y up) → global points (top-left
/// origin, y down) → display-local points. The ONE flip in the system, which
/// is why everything downstream of `events.json` and `shot.json` can assume a
/// top-left origin. Vocabulary: `transform/src/spaces.ts`.
///
/// `NSEvent.mouseLocation` is a Cocoa global point: origin at the bottom-left
/// of the MAIN display, y up. Display bounds (`CGDisplayBounds`) are CoreGraphics
/// global: origin at the top-left of the main display, y down. The flip is
/// against the main display's height, whatever display the pointer is over —
/// a flip against the source display's height is right only when that display
/// is the main one, and wrong by a silent constant otherwise.
///
/// Nil is nil: the schema says a cursor block is ABSENT when the pointer was
/// elsewhere, and a zeroed one would be a pointer drawn at the corner.
func localizeCursor(mouseX: Double, mouseY: Double,
                    mainDisplayHeight: Double, display: CGRect) -> (x: Double, y: Double)? {
    let cgY = mainDisplayHeight - mouseY
    let p = CGPoint(x: mouseX, y: cgY)
    guard display.contains(p) else { return nil }
    return (mouseX - Double(display.minX), cgY - Double(display.minY))
}

/// The cursor's `shape` is one of `cursorShapeNames` (CaptureDecisions.swift),
/// classified by STC-309's `classifyCursor`; shot-1's enum is the same set as
/// events-2's, and `still-decisions.test.ts` holds the Swift list to it.

// ── window hit-testing (STC-625, replacing STC-380/481's visibility filter) ──
//
// STC-380 flagged a window as unpickable unless most of it could be seen, and
// STC-481 relaxed "most" to half. In use that was still wrong: a window with
// only a corner showing is often exactly the one wanted, and it was refused.
// What the user can actually point at is the right question, so the picker
// now hit-tests. The window under the pointer is the frontmost one whose
// VISIBLE region contains it, and a click captures the WHOLE window
// (ScreenCaptureKit captures a window regardless of what covers it).
//
// A window's visible region is its frame clipped to the displays, minus every
// window strictly in front of it. A window whose region is empty is fully
// covered or entirely off-screen, so nothing can hover it and it is not
// offered at all. The regions of different windows are disjoint by
// construction, which is what lets the overlay tint one without ever tinting
// the window in front of it.

/// Splits each rect in `rects` around its overlap with `cut`, keeping only the
/// parts that do NOT overlap it — up to four pieces (above/below/left/right of
/// the overlap) per input rect that actually intersects. A rect untouched by
/// `cut` passes through unchanged.
func subtractRect(_ rects: [StillRect], _ cut: StillRect) -> [StillRect] {
    guard cut.width > 0, cut.height > 0 else { return rects }
    var out: [StillRect] = []
    for r in rects {
        guard r.width > 0, r.height > 0 else { continue }
        let ix0 = max(r.x, cut.x), iy0 = max(r.y, cut.y)
        let ix1 = min(r.x + r.width, cut.x + cut.width)
        let iy1 = min(r.y + r.height, cut.y + cut.height)
        guard ix1 > ix0, iy1 > iy0 else { out.append(r); continue }
        let rBottom = r.y + r.height, rRight = r.x + r.width
        if iy0 > r.y { out.append(StillRect(x: r.x, y: r.y, width: r.width, height: iy0 - r.y)) }
        if rBottom > iy1 { out.append(StillRect(x: r.x, y: iy1, width: r.width, height: rBottom - iy1)) }
        if ix0 > r.x { out.append(StillRect(x: r.x, y: iy0, width: ix0 - r.x, height: iy1 - iy0)) }
        if rRight > ix1 { out.append(StillRect(x: ix1, y: iy0, width: rRight - ix1, height: iy1 - iy0)) }
    }
    return out
}

/// The overlap of two rects, or nil when they share no area.
func intersectRect(_ a: StillRect, _ b: StillRect) -> StillRect? {
    let x0 = max(a.x, b.x), y0 = max(a.y, b.y)
    let x1 = min(a.x + a.width, b.x + b.width), y1 = min(a.y + a.height, b.y + b.height)
    guard x1 > x0, y1 > y0 else { return nil }
    return StillRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
}

/// The smallest visible piece worth keeping, in points on each axis. Below
/// one point a piece is arithmetic dust (a frame at a fractional origin
/// against a neighbour's), not something a pointer can land on. "A few
/// pixels at a corner" is the ticket's floor and sits well above this.
let MIN_VISIBLE_POINTS = 1.0

/// The parts of `frame` that are on a display and not covered by any of
/// `occluders` (the windows strictly in front of it), as disjoint rects in the
/// same global points. Empty means nothing of it can be seen. Displays do not
/// overlap, so clipping to each one separately cannot double-count.
func visibleRegion(_ frame: StillRect, displays: [StillRect], occluders: [StillRect]) -> [StillRect] {
    var region = displays.compactMap { intersectRect(frame, $0) }
    for o in occluders {
        region = subtractRect(region, o)
        if region.isEmpty { return [] }
    }
    return region.filter { $0.width >= MIN_VISIBLE_POINTS && $0.height >= MIN_VISIBLE_POINTS }
}

/// One candidate for the picker, front to back. `covers` is false for a window
/// that draws nothing (alpha ~0): it can be neither seen nor picked, and it
/// hides nothing behind it.
struct PickCandidate: Equatable {
    let id: Int
    let frame: StillRect
    var covers: Bool = true
}

/// A window the picker offers, with the region a pointer can find it in.
struct PickableWindow: Equatable {
    let id: Int
    let frame: StillRect
    let visible: [StillRect]
}

/// Every candidate that has something visible, in the input's (front-to-back)
/// order, each with its visible region. A window's occluders are exactly the
/// covering candidates ahead of it. Fully covered and off-screen windows are
/// dropped: hit-testing could never reach them, so listing them would only
/// offer something no gesture can pick.
func pickableWindows(_ frontToBack: [PickCandidate], displays: [StillRect]) -> [PickableWindow] {
    var out: [PickableWindow] = []
    var inFront: [StillRect] = []
    for c in frontToBack {
        guard c.covers else { continue }
        let visible = visibleRegion(c.frame, displays: displays, occluders: inFront)
        if !visible.isEmpty { out.append(PickableWindow(id: c.id, frame: c.frame, visible: visible)) }
        inFront.append(c.frame)
    }
    return out
}

/// The window a pointer at (`x`, `y`) would pick, or nil over bare desktop.
/// Half-open on each rect, like `CGRect.contains`, so a point on the seam
/// between two windows belongs to exactly one. `selection.ts`'s
/// `windowUnderPoint` is the same rule over the same `visible` rects.
func windowAt(x: Double, y: Double, in windows: [PickableWindow]) -> Int? {
    windows.first { w in
        w.visible.contains { r in x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height }
    }?.id
}

/// Front-to-back order for `ids` (STC-481). SCShareableContent's `windows` array
/// is NOT in z-order — measured on hardware, the frontmost app's window sat first
/// and a window under everything sat in the middle, so "everything earlier in the
/// list occludes me" flagged nearly every other window as buried. `zRank` maps a
/// window id to its index in CGWindowListCopyWindowInfo's genuinely front-to-back
/// list; an id it does not know sorts BEHIND every ranked one (it is not on screen
/// as far as CoreGraphics can tell) and ties keep their input order.
func frontToBack(_ ids: [Int], zRank: [Int: Int]) -> [Int] {
    ids.enumerated()
        .sorted { a, b in
            let ra = zRank[a.element] ?? Int.max, rb = zRank[b.element] ?? Int.max
            return ra != rb ? ra < rb : a.offset < b.offset
        }
        .map { $0.element }
}

struct StillWindowInfo: Equatable {
    let id: Int
    let app: String?
    let title: String?
    /// display-local points
    let bounds: StillRect
}

struct StillCursorSample: Equatable {
    let x: Double, y: Double
    let shape: String
}

struct StillFrameInfo: Equatable {
    let file: String
    /// pixels
    let width: Int, height: Int
    /// true only when the capture actually carries an alpha channel
    let alpha: Bool
}

/// The description string of an ICC profile (its `desc` tag), or nil if the
/// bytes are not a profile we can read. Handles both encodings: v2 `desc`
/// (ASCII) and v4 `mluc` (UTF-16BE, first record). Pure, so the rule below is
/// tested without a display (STC-478).
func iccDescription(_ data: Data) -> String? {
    let b = [UInt8](data)
    func u32(_ o: Int) -> Int? {
        guard o >= 0, o + 4 <= b.count else { return nil }
        return Int(b[o]) << 24 | Int(b[o + 1]) << 16 | Int(b[o + 2]) << 8 | Int(b[o + 3])
    }
    guard b.count >= 132, let count = u32(128), count < 1000 else { return nil }
    for i in 0..<count {
        let e = 132 + i * 12
        guard let sig = u32(e), let off = u32(e + 4), let size = u32(e + 8) else { return nil }
        guard sig == 0x64657363 /* 'desc' */, off + size <= b.count, let type = u32(off) else { continue }
        if type == 0x64657363 { // v2 textDescriptionType: u32 ascii count incl. NUL
            guard let n = u32(off + 8), n > 0, off + 12 + n <= b.count else { return nil }
            return String(bytes: b[(off + 12)..<(off + 12 + n - 1)], encoding: .ascii)
        }
        if type == 0x6D6C7563 { // 'mluc': first record's UTF-16BE string
            guard let recs = u32(off + 8), recs > 0,
                  let len = u32(off + 20), let so = u32(off + 24),
                  off + so + len <= b.count else { return nil }
            return String(bytes: b[(off + so)..<(off + so + len)], encoding: .utf16BigEndian)
        }
        return nil
    }
    return nil
}

/// The red, green and blue colorants of an ICC profile as nine numbers
/// (rX rY rZ gX gY gZ bX bY bZ, D50-adapted, as the profile stores them), or nil
/// when the profile has no `rXYZ`/`gXYZ`/`bXYZ` tags (a LUT-based profile) or is
/// not a profile at all (STC-511). Pure, like `iccDescription`.
func iccColorants(_ data: Data) -> [Double]? {
    let b = [UInt8](data)
    func u32(_ o: Int) -> Int? {
        guard o >= 0, o + 4 <= b.count else { return nil }
        return Int(b[o]) << 24 | Int(b[o + 1]) << 16 | Int(b[o + 2]) << 8 | Int(b[o + 3])
    }
    func s15Fixed16(_ o: Int) -> Double? {
        guard let v = u32(o) else { return nil }
        return Double(Int32(truncatingIfNeeded: v)) / 65536.0
    }
    guard b.count >= 132, let count = u32(128), count < 1000 else { return nil }
    var found: [Int: [Double]] = [:]
    for i in 0..<count {
        let e = 132 + i * 12
        guard let sig = u32(e), let off = u32(e + 4), let size = u32(e + 8) else { return nil }
        guard sig == 0x7258595A || sig == 0x6758595A || sig == 0x6258595A else { continue } // rXYZ gXYZ bXYZ
        guard size >= 20, off + 20 <= b.count, u32(off) == 0x58595A20 /* 'XYZ ' */,
              let x = s15Fixed16(off + 8), let y = s15Fixed16(off + 12), let z = s15Fixed16(off + 16)
        else { return nil }
        found[sig] = [x, y, z]
    }
    guard let r = found[0x7258595A], let g = found[0x6758595A], let bl = found[0x6258595A] else { return nil }
    return r + g + bl
}

/// Display P3's and sRGB's colorants, D50-adapted, as the OS's own profiles
/// carry them. The built-in screen's profile matches the first to four decimals
/// and an sRGB monitor's the second (STC-511); the two differ from each other
/// by ~0.08 on the red X, so `COLORANT_TOLERANCE` is nowhere near ambiguous.
private let displayP3Colorants: [Double] = [0.5151, 0.2412, -0.0011, 0.2920, 0.6922, 0.0419, 0.1571, 0.0666, 0.7841]
private let srgbColorants: [Double] = [0.4361, 0.2225, 0.0139, 0.3851, 0.7169, 0.0971, 0.1431, 0.0606, 0.7141]
private let COLORANT_TOLERANCE = 0.01

private func colorantsMatch(_ a: [Double], _ b: [Double]) -> Bool {
    a.count == b.count && zip(a, b).allSatisfy { abs($0 - $1) <= COLORANT_TOLERANCE }
}

/// The `display.colorSpace` string for a captured image (STC-478, STC-511).
///
/// CoreGraphics gives an ICC-based colour space — what a Mac's own display
/// profile arrives as — no name, so `name` is nil for a perfectly good Display
/// P3 capture, and the key used to be dropped, which every consumer reads as
/// sRGB. A name wins when there is one. Otherwise the profile's COLORANTS
/// decide, because what a profile is does not depend on what it is called:
/// STC-478 matched the description alone, and the built-in screen's profile
/// is described just "Display" (CoreGraphics calls it "Color LCD"), so a real
/// P3 still still recorded nothing. The description is the fallback for a
/// profile whose colorants cannot be read. Anything unrecognised stays nil:
/// omitting the key is the honest answer for a space we cannot name, and it
/// is what the loaders already treat as sRGB.
func resolveColorSpaceName(name: String?, iccDescription: String?, iccData: Data? = nil) -> String? {
    if let name, !name.isEmpty { return name }
    if let iccData, let c = iccColorants(iccData) {
        if colorantsMatch(c, displayP3Colorants) { return "kCGColorSpaceDisplayP3" }
        if colorantsMatch(c, srgbColorants) { return "kCGColorSpaceSRGB" }
        return nil
    }
    guard let d = iccDescription?.lowercased() else { return nil }
    if d.contains("display p3") || d.contains("displayp3") { return "kCGColorSpaceDisplayP3" }
    if d.contains("srgb") { return "kCGColorSpaceSRGB" }
    return nil
}

/// Builds shot.json (schema/shot-1.schema.json).
///
/// Pure on purpose, like `anchorsDocument`: the shape of this document is a
/// contract with the transform, and a contract that can only be checked by
/// performing a real capture is a contract nothing checks on most runs.
///
/// The decoration is the honest default for what was captured, and it is
/// decided on the FRAME, not the request: a window shot whose pixels came back
/// without alpha gets `selected-area`, because `window-only` promises
/// transparency outside the window's shape and `parseShot` refuses that
/// promise on an opaque frame. The reply carries a warning for that case.
func shotDocument(kind: StillKind,
                  capturedAtNs: UInt64,
                  timebase: (numer: Int, denom: Int),
                  display: DisplayGeometry,
                  colorSpace: String?,
                  crop: StillRect?,
                  window: StillWindowInfo?,
                  frame: StillFrameInfo,
                  cursor: StillCursorSample?) -> [String: Any] {
    var displayBlock: [String: Any] = [
        "id": display.id,
        "pointWidth": display.pointWidth, "pointHeight": display.pointHeight,
        "pixelWidth": display.pixelWidth, "pixelHeight": display.pixelHeight,
        "backingScale": display.backingScale,
        "originX": display.originX, "originY": display.originY,
    ]
    if let colorSpace { displayBlock["colorSpace"] = colorSpace }

    var doc: [String: Any] = [
        "version": 1,
        "kind": kind.rawValue,
        // String, like anchors.t0Ns: boot-relative ns crosses 2^53 at ~104
        // days of uptime and a JSON number would round.
        "capturedAtNs": String(capturedAtNs),
        "timebase": ["numer": timebase.numer, "denom": timebase.denom],
        "display": displayBlock,
        "frame": ["file": frame.file, "width": frame.width, "height": frame.height,
                  "alpha": frame.alpha] as [String: Any],
        "decoration": [
            "mode": kind == .window && frame.alpha ? "window-only" : "selected-area",
            "canvas": "natural",
            "cursor": false,
            "redactions": [] as [Any],
        ] as [String: Any],
    ]

    switch kind {
    case .displayCrop:
        doc["crop"] = (crop ?? StillRect(x: 0, y: 0, width: Double(display.pointWidth),
                                          height: Double(display.pointHeight))).json
    case .window:
        if let w = window {
            var wb: [String: Any] = ["id": w.id, "bounds": w.bounds.json]
            if let app = w.app, !app.isEmpty { wb["app"] = app }
            if let title = w.title, !title.isEmpty { wb["title"] = title }
            doc["window"] = wb
        }
    }

    if let c = cursor {
        doc["cursor"] = ["x": c.x, "y": c.y, "shape": c.shape]
    }
    return doc
}
