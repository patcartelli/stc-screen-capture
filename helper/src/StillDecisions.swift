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

    static let defaultFile = "frame.png"
}

enum StillRequestError: Error, Equatable, CustomStringConvertible {
    case missingDir
    case badKind(String)
    case missingWindowId
    case cropOnWindow
    case badCrop(String)
    case badFile(String)

    var code: String {
        switch self {
        case .missingDir:      return "missing-dir"
        case .badKind:         return "bad-kind"
        case .missingWindowId: return "missing-window-id"
        case .cropOnWindow:    return "crop-on-window"
        case .badCrop:         return "bad-crop"
        case .badFile:         return "bad-file"
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
                                     excludeWindowIds: exclude))
    case .window:
        guard crop == nil else { return .failure(.cropOnWindow) }
        guard let wid = id32(cmd["windowId"]) else { return .failure(.missingWindowId) }
        return .success(StillRequest(dir: dir, kind: kind, displayId: nil,
                                     crop: nil, windowId: wid, file: file,
                                     excludeWindowIds: exclude))
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

// ── window visibility (STC-380) ──────────────────────────────────────────────
//
// The `windows` verb (Still.swift) used to list every layer-0 on-screen window
// SCShareableContent reports, with no regard for whether a click could
// actually reach it as the thing it looks like: a window hanging mostly off
// every display, or buried under another window with only a sliver showing,
// still appeared as a full-size, freely selectable entry. `onScreenWindowsOnly`
// only means "not minimized" — it says nothing about occlusion or a frame
// that has drifted off every display, which is exactly what left both open.
//
// `isFullyVisible` answers both with one primitive: how much of a rectangle's
// area survives having a list of other rectangles subtracted from it. Run
// against the display union it finds the off-screen fraction; run against the
// windows strictly in front of this one (SCShareableContent's own front-to-back
// order — a window BEHIND never occludes) it finds the covered fraction. Same
// arithmetic, different occluders, so there is one function to get right
// rather than two.

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

/// The fraction of `rect`'s own area left after removing every overlap with
/// `cutters`, 0...1. Order does not matter: each subtraction only ever shrinks
/// what remains, and an empty `cutters` list leaves the whole rect.
func remainingFraction(_ rect: StillRect, subtracting cutters: [StillRect]) -> Double {
    guard rect.width > 0, rect.height > 0 else { return 0 }
    var remaining = [rect]
    for c in cutters {
        remaining = subtractRect(remaining, c)
        if remaining.isEmpty { return 0 }
    }
    let total = remaining.reduce(0.0) { $0 + $1.width * $1.height }
    return total / (rect.width * rect.height)
}

/// The least fraction of a window's own area that must be on a display AND
/// uncovered for the picker to let it be selected (STC-481). STC-380 shipped a
/// 2% tolerance ("fully visible"), which on a real desktop refused every window
/// with any overlap at all — a window 30% under another was unselectable. Half
/// is enough to recognise a window as the thing it is. The wire flag is still
/// named `fullyVisible`; this is the one dial for what it means.
let MIN_VISIBLE_FRACTION = 0.5

/// Whether at least `MIN_VISIBLE_FRACTION` of `frame` is on a display and not
/// covered by `occluders` (windows strictly in front of it, see `frontToBack`).
/// Off-display and covered fractions are summed, which can only over-count
/// where the two overlap — it errs toward refusing, never toward offering a
/// window that is mostly unseen.
func isFullyVisible(_ frame: StillRect, displays: [StillRect], occluders: [StillRect]) -> Bool {
    let offDisplay = remainingFraction(frame, subtracting: displays)
    let covered = 1 - remainingFraction(frame, subtracting: occluders)
    return 1 - offDisplay - covered >= MIN_VISIBLE_FRACTION
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
