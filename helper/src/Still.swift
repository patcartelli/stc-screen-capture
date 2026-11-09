import Foundation
import AppKit
import ScreenCaptureKit
import ImageIO
import ObjectiveC

/// One frame, no stream (STC-289).
///
/// `capture-still` hands back exactly one frame at full display resolution
/// through `SCScreenshotManager`, never through an `SCStream`: no ring buffer,
/// no writer, no telemetry tap, and none of the recording lifecycle — a still
/// that had to allocate a recording would inherit every failure mode of one for
/// no benefit, and a still taken MID-recording (the whole point of grabbing one
/// during a demo) must not touch the running stream. Nothing here reads or
/// writes `App.state`, and the only thing shared with `CaptureSession` is the
/// process.
///
/// Two content filters, not one. A display filter for region and full-screen
/// shots — the v1 "full display is the only primitive" rule, the region being
/// `sourceRect`. A window filter (`SCContentFilter(desktopIndependentWindow:)`)
/// for window shots, which is the only way to get a window's real rounded
/// corners with transparency behind them: a crop out of a display capture is
/// always an opaque rectangle with the desktop baked in.
///

/// Sets a 14+ `SCStreamConfiguration` property the 13.3 headers do not declare.
/// Returns whether the running OS took it, so a caller can say which knobs
/// were actually applied rather than assume.
@discardableResult
private func setIfSupported(_ cfg: SCStreamConfiguration, _ key: String, _ value: Any) -> Bool {
    let setter = "set" + key.prefix(1).uppercased() + key.dropFirst() + ":"
    guard cfg.responds(to: Selector(setter)) else { return false }
    cfg.setValue(value, forKey: key)
    return true
}

enum StillError: Error, CustomStringConvertible {
    case unsupported
    case noDisplays(underlying: Error?)
    case noSuchDisplay(UInt32)
    case noSuchWindow(UInt32)
    case cropOutsideDisplay
    case captureFailed(Error?)
    case writeFailed(String)
    case timedOut(lastStep: String, seconds: Double)
    /// STC-572: Vision refused the frame.
    case recognizeFailed(Error)

    var code: String {
        switch self {
        case .unsupported:        return "still-unsupported"
        case .noDisplays:         return "no-displays"
        case .noSuchDisplay:      return "no-such-display"
        case .noSuchWindow:       return "no-such-window"
        case .cropOutsideDisplay: return "crop-outside-display"
        case .captureFailed:      return "capture-failed"
        case .writeFailed:        return "write-failed"
        case .timedOut:           return "still-timeout"
        case .recognizeFailed:    return "recognize-failed"
        }
    }

    var description: String {
        switch self {
        case .unsupported:
            return "SCScreenshotManager is not available — macOS 14 or newer is required for stills"
        case .noDisplays(let e):
            return "no displays available — Screen Recording permission is the usual cause (\(e.map { "\($0)" } ?? "no error"))"
        case .noSuchDisplay(let id): return "no display with id \(id)"
        case .noSuchWindow(let id): return "no on-screen window with id \(id)"
        case .cropOutsideDisplay: return "the crop does not overlap the display"
        case .captureFailed(let e): return "screenshot failed: \(e.map { "\($0)" } ?? "no image and no error")"
        case .writeFailed(let why): return "could not write the shot: \(why)"
        case .timedOut(let step, let seconds):
            return "still did not complete within \(Int(seconds)) s (last step: \(step))"
        case .recognizeFailed(let e): return "text recognition failed: \(e)"
        }
    }
}

/// Which built-in pointer is showing, through STC-309's classifier
/// (`CursorShape.swift` + `classifyCursor` in CaptureDecisions.swift): the same
/// signatures, references and mapping rule the recording path uses, so a
/// still and a take never disagree about what a pointer was. References are
/// rendered here rather than cached — one still is one sample, and the
/// pointer-size setting or backing scale may have changed since the last one.
///
/// Whether `NSCursor.currentSystem` sees other apps' pointers from a
/// background process is what STC-309's probe measures; until then an unseen
/// pointer classifies as the arrow, and the position — the part a still cannot
/// do without — comes from `NSEvent.mouseLocation` regardless.
enum StillCursor {
    static func currentShape() -> String {
        guard let cur = NSCursor.currentSystem, let sig = CursorShape.signature(of: cur) else {
            return defaultCursorShape
        }
        return classifyCursor(sig, references: CursorShape.references().refs)
    }
}

/// Where a captured frame goes. A shot is written to its directory; text
/// (STC-572) is recognised in memory and the frame is dropped, so nothing of
/// it ever reaches the disk.
enum StillOutput {
    case shot(dir: URL)
    case text
}

/// One `capture-still` (or `recognize-text`) request, start to answer.
final class StillCapture {
    /// How long a still may take before it is answered with `still-timeout`.
    /// Covers the WHOLE request: content enumeration, the screenshot, the PNG
    /// encode and shot.json. Asserted against the client's request timeout in
    /// `helper/test/still-bounds.test.ts`. Ten seconds is fifty times the
    /// ticket's latency target; anything near it is a wedged machine, not a
    /// slow capture, and the answer names the step it was on.
    static let timeoutSeconds: Double = 10

    /// `recognize-text`'s bound (STC-572). Vision's first call by a new binary
    /// took ~40 s on hardware (TextRecognize.swift). `warm-text` pays that at
    /// launch, but a Capture Text pressed while it is still warming pays it
    /// too, so this bound has to clear it rather than answer `still-timeout`.
    static let textTimeoutSeconds: Double = 60

    private var bound: Double {
        if case .text = output { return Self.textTimeoutSeconds }
        return Self.timeoutSeconds
    }

    let request: StillRequest
    let output: StillOutput
    private let startNs: UInt64

    private let lock = NSLock()
    private var completion: ((Result<[String: Any], StillError>) -> Void)?
    private var step = "queued"
    /// Milliseconds since `run`, per checkpoint. Reported in the reply so the
    /// STC-301 latency gate watches a number, and so a slow still says WHERE
    /// it was slow — content enumeration and PNG encoding are both outside
    /// the capture the ticket's 200 ms is about.
    private var timing: [String: Double] = [:]
    /// STC-628: the window's display's wallpaper, read beside the window
    /// capture and joined before the answer. nil unless asked for.
    private var wallpaperRead: WallpaperRead?

    /// A window shot that asked for its wallpaper. Its content is fetched WITH
    /// desktop windows, because the wallpaper window is one; the window it
    /// captures is looked up by id, so nothing else about the shot changes.
    private var wantsWallpaper: Bool { request.kind == .window && request.wallpaper && shotDir != nil }

    private var shotDir: URL? {
        if case .shot(let dir) = output { return dir }
        return nil
    }

    init(request: StillRequest, output: StillOutput) {
        self.request = request
        self.output = output
        self.startNs = Clock.nowNs()
    }

    private func mark(_ name: String) {
        let ms = Double(Clock.nowNs() &- startNs) / 1e6
        lock.lock(); timing[name] = ms; lock.unlock()
    }

    private func at(_ s: String) {
        lock.lock(); step = s; lock.unlock()
    }

    /// Call-once, like `finishStart`. The backstop, the content callback, the
    /// screenshot completion and the writer all answer through here.
    private func finish(_ result: Result<[String: Any], StillError>) {
        lock.lock()
        let c = completion
        completion = nil
        let read = wallpaperRead
        lock.unlock()
        // A failed shot leaves no wallpaper behind (STC-628): its folder must
        // stay one `removeIfNothingWorthKeeping` can recognise as empty.
        if case .failure = result, c != nil { read?.abandon() }
        c?(result)
    }

    func run(completion: @escaping (Result<[String: Any], StillError>) -> Void) {
        lock.lock(); self.completion = completion; lock.unlock()

        // Armed before the first callback API, so it covers the whole request
        // (the STC-258 lesson: a backstop armed after content enumeration
        // bounds only the part after it answers).
        DispatchQueue.global().asyncAfter(deadline: .now() + bound) { [weak self] in
            guard let self else { return }
            self.lock.lock(); let s = self.step; self.lock.unlock()
            self.finish(.failure(.timedOut(lastStep: s, seconds: self.bound)))
        }


        at("content")
        SCShareableContent.getExcludingDesktopWindows(!wantsWallpaper, onScreenWindowsOnly: true) { [weak self] content, err in
            guard let self else { return }
            self.mark("contentMs")
            guard let content, !content.displays.isEmpty else {
                self.finish(.failure(.noDisplays(underlying: err)))
                return
            }
            // Off ScreenCaptureKit's callback queue: a recording may be live
            // and that queue is its, not ours.
            DispatchQueue.global(qos: .userInitiated).async { self.capture(content: content) }
        }
    }

    private func capture(content: SCShareableContent) {
        at("configure")
        let cfg = SCStreamConfiguration()
        let filter: SCContentFilter
        let geometry: DisplayGeometry
        var crop: StillRect? = nil
        var window: StillWindowInfo? = nil
        let pixelSize: (width: Int, height: Int)

        switch request.kind {
        case .displayCrop:
            let display: SCDisplay
            if let id = request.displayId {
                // A wrong display is a wrong answer, not a fallback: `start`
                // falls back to the first display because a recording can be
                // stopped; a still is over before anyone could notice.
                guard let d = content.displays.first(where: { $0.displayID == id }) else {
                    finish(.failure(.noSuchDisplay(id))); return
                }
                display = d
            } else {
                display = content.displays[0]
            }
            geometry = displayGeometry(id: display.displayID,
                                       pointWidth: display.width, pointHeight: display.height)
            guard case .region(let region) = resolveCrop(request.crop, pointWidth: geometry.pointWidth,
                                                         pointHeight: geometry.pointHeight) else {
                finish(.failure(.cropOutsideDisplay)); return
            }
            crop = region
            // STC-290: the caller's overlay must not be in the pixels. Matched
            // against this display's own window list, so an id from another
            // display (or one already closed) simply finds nothing.
            let excluded = request.excludeWindowIds.isEmpty ? [] :
                content.windows.filter { request.excludeWindowIds.contains($0.windowID) }
            filter = SCContentFilter(display: display, excludingWindows: excluded)
            // Display-local points, which is what sourceRect takes for a
            // display filter. The whole display when no crop was asked for.
            cfg.sourceRect = region.cgRect
            pixelSize = framePixelSize(points: region, backingScale: geometry.backingScale)

        case .window:
            guard let id = request.windowId,
                  let win = content.windows.first(where: { $0.windowID == id }) else {
                finish(.failure(.noSuchWindow(request.windowId ?? 0))); return
            }
            // The window's display is the one under its centre; a window
            // straddling two displays is attributed to whichever holds more of
            // its middle, and its bounds are expressed in THAT display's points.
            // `chooseDisplayForWindow` (CaptureDecisions.swift) is shared with
            // the recording path's window scope (STC-370) so a shot and a
            // take of the same window cannot disagree about which display it
            // belongs to.
            let mid = CGPoint(x: win.frame.midX, y: win.frame.midY)
            let displayIds = content.displays.map { ($0.displayID, CGDisplayBounds($0.displayID)) }
            let display = chooseDisplayForWindow(midpoint: mid, displays: displayIds)
                .flatMap { dispId in content.displays.first { $0.displayID == dispId } }
                ?? content.displays[0]
            geometry = displayGeometry(id: display.displayID,
                                       pointWidth: display.width, pointHeight: display.height)
            // Started now, so it runs while the window is captured and encoded.
            if wantsWallpaper, let dir = shotDir {
                let read = WallpaperRead(displayId: display.displayID, content: content,
                                         dir: dir, file: StillRequest.wallpaperFile)
                lock.lock(); wallpaperRead = read; lock.unlock()
            }
            let bounds = StillRect(x: Double(win.frame.minX) - geometry.originX,
                                   y: Double(win.frame.minY) - geometry.originY,
                                   width: Double(win.frame.width), height: Double(win.frame.height))
            window = StillWindowInfo(id: Int(win.windowID),
                                     app: win.owningApplication?.applicationName,
                                     title: win.title, bounds: bounds)
            filter = SCContentFilter(desktopIndependentWindow: win)
            pixelSize = framePixelSize(points: bounds, backingScale: geometry.backingScale)
            // Alpha end to end: no desktop behind the window and no compositor
            // shadow — the shadow is synthesised at render time (STC-291).
            // Both are 14+ knobs; on a 14+ OS they exist, and the reply says
            // whether they were taken.
            let shadows = setIfSupported(cfg, "ignoreShadowsSingleWindow", true)
            let nonOpaque = setIfSupported(cfg, "shouldBeOpaque", false)
            lock.lock()
            timing["ignoreShadows"] = shadows ? 1 : 0
            timing["nonOpaque"] = nonOpaque ? 1 : 0
            lock.unlock()
        }

        cfg.width = pixelSize.width
        cfg.height = pixelSize.height
        cfg.scalesToFit = false
        // The pointer is a sample in shot.json, drawn at render time if at all;
        // the pixels must not already contain one.
        cfg.showsCursor = false
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        // SCCaptureResolutionType.best (1): full backing resolution. Explicit
        // width/height already ask for it; this says so where the API listens.
        setIfSupported(cfg, "captureResolution", 1)

        // As close to the frame as the API allows: sampled on this thread
        // immediately before the screenshot is requested, position first.
        let cursor = sampleCursor(display: geometry)

        at("capture")
        let capturedAtNs = Clock.nowNs()
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { [weak self] image, error in
            guard let self else { return }
            self.mark("captureMs")
            guard let image else { self.finish(.failure(.captureFailed(error))); return }
            DispatchQueue.global(qos: .userInitiated).async {
                switch self.output {
                case .shot(let dir):
                    self.write(image: image, to: dir, capturedAtNs: capturedAtNs, geometry: geometry,
                               crop: crop, window: window, cursor: cursor)
                case .text:
                    self.recognize(image: image)
                }
            }
        }
    }

    private func sampleCursor(display: DisplayGeometry) -> StillCursorSample? {
        let loc = NSEvent.mouseLocation
        let mainHeight = Double(CGDisplayBounds(CGMainDisplayID()).height)
        let bounds = CGRect(x: display.originX, y: display.originY,
                            width: Double(display.pointWidth), height: Double(display.pointHeight))
        guard let p = localizeCursor(mouseX: Double(loc.x), mouseY: Double(loc.y),
                                     mainDisplayHeight: mainHeight, display: bounds) else { return nil }
        return StillCursorSample(x: p.x, y: p.y, shape: StillCursor.currentShape())
    }

    private static func hasAlpha(_ image: CGImage) -> Bool {
        switch image.alphaInfo {
        case CGImageAlphaInfo.none, .noneSkipFirst, .noneSkipLast: return false
        default: return true
        }
    }

    /// STC-572: Vision over the frame, in memory. The frame is released with
    /// this call; the reply carries the lines and nothing else of the image.
    private func recognize(image: CGImage) {
        at("recognize")
        switch recognizeText(in: image) {
        case .failure(let e):
            finish(.failure(.recognizeFailed(e)))
        case .success(let lines):
            mark("recognizeMs")
            lock.lock(); let t = timing; lock.unlock()
            finish(.success(["lines": lines, "width": image.width, "height": image.height, "timing": t]))
        }
    }

    private func write(image: CGImage, to dir: URL, capturedAtNs: UInt64, geometry: DisplayGeometry,
                       crop: StillRect?, window: StillWindowInfo?, cursor: StillCursorSample?) {
        at("write")
        let url = dir.appendingPathComponent(request.file)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            finish(.failure(.writeFailed("could not create \(request.file)"))); return
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            try? FileManager.default.removeItem(at: url)
            finish(.failure(.writeFailed("PNG encode of \(request.file) failed"))); return
        }
        mark("writeMs")

        let alpha = Self.hasAlpha(image)
        let frame = StillFrameInfo(file: request.file, width: image.width, height: image.height,
                                   alpha: request.kind == .window && alpha)
        // STC-478/STC-511: an ICC-based space has no name, so identify it from the profile —
        // its colorants first (the built-in screen's profile is described just "Display").
        let iccData = (image.colorSpace?.copyICCData()).map { $0 as Data }
        let colorSpace = resolveColorSpaceName(
            name: image.colorSpace?.name.map { $0 as String },
            iccDescription: iccData.flatMap { iccDescription($0) },
            iccData: iccData)
        let doc = shotDocument(kind: request.kind, capturedAtNs: capturedAtNs,
                               timebase: (Int(Clock.timebase.numer), Int(Clock.timebase.denom)),
                               display: geometry, colorSpace: colorSpace,
                               crop: crop, window: window, frame: frame, cursor: cursor)
        guard let data = try? JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys, .prettyPrinted]) else {
            finish(.failure(.writeFailed("shot.json could not be encoded"))); return
        }
        do { try data.write(to: dir.appendingPathComponent("shot.json")) }
        catch { finish(.failure(.writeFailed("shot.json: \(error)"))); return }
        let wallpaper = joinWallpaper()
        mark("totalMs")

        lock.lock(); let t = timing; lock.unlock()
        var reply: [String: Any] = ["dir": dir.path, "file": request.file, "shot": doc, "timing": t]
        reply.merge(wallpaper) { _, new in new }
        if request.kind == .window && !alpha {
            // Honest rather than promised: the document says selected-area and
            // the reply says why, instead of a window-only mode over pixels
            // that cannot support it.
            reply["alphaWarning"] = "the window capture came back without an alpha channel; "
                + "decoration is selected-area, not window-only"
        }
        finish(.success(reply))
    }

    /// The wallpaper's half of the reply (STC-628): `wallpaper` with where it
    /// came from, or `wallpaperError` saying why not. Never a failure of the
    /// shot — the frame and shot.json are already written, shot.json says
    /// window-only either way, and the app falls back to Clean on the
    /// sentence. The wait is bounded (`WallpaperRead.joinTimeoutSeconds`).
    private func joinWallpaper() -> [String: Any] {
        lock.lock(); let read = wallpaperRead; lock.unlock()
        guard let read else { return [:] }
        at("wallpaper")
        let out: [String: Any]
        switch read.wait(timeoutSeconds: WallpaperRead.joinTimeoutSeconds) {
        case .failure(let f):
            out = ["wallpaperError": f.description]
        case .success(let pic):
            out = ["wallpaper": ["file": StillRequest.wallpaperFile, "source": pic.source.rawValue, "ms": pic.ms]]
        }
        mark("wallpaperMs")
        return out
    }
}

/// `windows`: the on-screen windows a window shot can name, for the picker
/// (STC-290) and for `still.grant.test.ts`. Layer 0 only — menus, the menu bar,
/// the Dock, and Capture's own overlay and pill all live on other layers and
/// are not what "capture that window" means; desktop icons are excluded by
/// SCShareableContent itself. Each entry carries `visible` (STC-625): the
/// rects, in global points, where a pointer finds it — its frame on the
/// displays, minus every layer-0 window in front of it (`pickableWindows`,
/// StillDecisions.swift). A window with nothing visible is not listed.
/// Bounded like a still; answers exactly once.
enum WindowList {
    static func enumerate(completion: @escaping (Result<[String: Any], StillError>) -> Void) {
        let lock = NSLock()
        var pending: ((Result<[String: Any], StillError>) -> Void)? = completion
        let answer: (Result<[String: Any], StillError>) -> Void = { r in
            lock.lock(); let c = pending; pending = nil; lock.unlock()
            c?(r)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + StillCapture.timeoutSeconds) {
            answer(.failure(.timedOut(lastStep: "windows", seconds: StillCapture.timeoutSeconds)))
        }
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, err in
            guard let content, !content.displays.isEmpty else {
                answer(.failure(.noDisplays(underlying: err))); return
            }
            let displays = content.displays.map { ($0.displayID, CGDisplayBounds($0.displayID)) }
            let displayRects = displays.map { StillRect($0.1) }
            // Layer 0 and non-zero-sized FIRST, in SCShareableContent's own
            // front-to-back order — a window's occluders (STC-380) are exactly
            // the ones that sorted ahead of it in THIS list, not in
            // `content.windows`, which still carries the other layers.
            // STC-481: SCK's array is not z-ordered; CoreGraphics' on-screen list is.
            var zRank: [Int: Int] = [:]
            var invisible = Set<Int>()   // alpha ~0: draws nothing, covers nothing
            let cg = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
            for (rank, info) in cg.enumerated() {
                guard let n = info[kCGWindowNumber as String] as? Int else { continue }
                zRank[n] = rank
                if let a = info[kCGWindowAlpha as String] as? Double, a < 0.01 { invisible.insert(n) }
            }
            let filtered = content.windows.filter { $0.windowLayer == 0 && $0.frame.width > 0 && $0.frame.height > 0 }
            let byID = Dictionary(filtered.map { (Int($0.windowID), $0) }, uniquingKeysWith: { a, _ in a })
            // STC-625: a window CoreGraphics does not list as on-screen (another
            // Space, say) draws no pixels anywhere, so it is not a candidate at
            // all. Sorted to the back instead, it would be hoverable over bare
            // desktop where it is not.
            let onScreen = filtered.map { Int($0.windowID) }.filter { zRank[$0] != nil }
            let ordered = frontToBack(onScreen, zRank: zRank).compactMap { byID[$0] }
            let picks = pickableWindows(ordered.map {
                PickCandidate(id: Int($0.windowID), frame: StillRect($0.frame),
                              covers: !invisible.contains(Int($0.windowID)))
            }, displays: displayRects)
            var out: [[String: Any]] = []
            for p in picks {
                guard let w = byID[p.id] else { continue }
                let mid = CGPoint(x: w.frame.midX, y: w.frame.midY)
                var o: [String: Any] = [
                    "id": p.id,
                    "x": Double(w.frame.minX), "y": Double(w.frame.minY),
                    "width": Double(w.frame.width), "height": Double(w.frame.height),
                    "visible": p.visible.map { $0.json },
                ]
                if let app = w.owningApplication {
                    o["app"] = app.applicationName
                    o["pid"] = Int(app.processID)
                }
                if let t = w.title, !t.isEmpty { o["title"] = t }
                if let d = displays.first(where: { $0.1.contains(mid) }) { o["displayId"] = Int(d.0) }
                out.append(o)
            }
            answer(.success(["windows": out,
                             "displays": content.displays.map { ["id": Int($0.displayID),
                                                                  "pointWidth": $0.width,
                                                                  "pointHeight": $0.height] }]))
        }
    }
}
