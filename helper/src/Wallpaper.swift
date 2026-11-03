import Foundation
import AppKit
import ScreenCaptureKit
import ImageIO

/// The desktop wallpaper of one display, as a JPEG in a shot's folder (STC-628).
///
/// A window shot's default look sits the window on the user's own wallpaper,
/// so `capture-still` reads it BESIDE the window capture (same shareable
/// content, its own screenshot) and the `wallpaper` verb reads it on its own
/// for the still editor. Either way the picture is written into the shot's
/// folder, so the shot renders the same after the wallpaper changes.
///
/// Every read is fresh; there is no cache. One keyed on the picture's file
/// could not see its Fill/Fit/Centre options, the display's size or the
/// appearance, so it could hand back a picture that was not the one showing
/// (STC-628 review), and with the JPEG a fresh read fits gate 3 anyway.
///
/// Where the picture comes from, in order:
///  1. **The wallpaper window**, captured alone through `SCScreenshotManager`
///     at the display's pixel size. This is the frame CURRENTLY showing, as
///     the desktop draws it (its options and appearance included), and it has
///     no icons and no other windows in it. Which window that is, is
///     `chooseWallpaperWindow` (WallpaperDecisions.swift).
///  2. **The desktop picture's file** (`NSWorkspace.desktopImageURL(for:)`),
///     only when the window could not be captured and the file is one still
///     image (`wallpaperIsStatic`): scaled to cover the display at most,
///     redrawn in the display's colour space.
/// The reply's `source` says which (`WallpaperSource`).
///
/// Nothing here may fail or wedge the shot it rides with: every wait is
/// bounded and a failure is a sentence (`WallpaperFailure`). The JPEG is
/// encoded under a hidden `.partial` name in the shot's folder and renamed to
/// its real name only by `wait`, on the caller's thread, once the caller has
/// decided to use it. A read that answers after its caller gave up removes its
/// own partial, so the folder never holds a wallpaper the reply did not name.
enum WallpaperSource: String {
    case window = "wallpaper-window"
    case file = "desktop-image-file"
}

struct WallpaperFailure: Error, CustomStringConvertible {
    let reason: String
    var description: String { reason }
}

/// A wallpaper in place in the shot's folder.
struct WallpaperPicture {
    let source: WallpaperSource
    /// Milliseconds from the read's start to the picture being encoded.
    let ms: Double
}

final class WallpaperRead {
    /// How long `capture-still` waits for the wallpaper after its own frame and
    /// shot.json are written. Past this the shot answers with `wallpaperError`
    /// instead; `still-bounds.test.ts` holds it well inside the still's own
    /// backstop, so a wallpaper can never turn a shot into a `still-timeout`.
    static let joinTimeoutSeconds: Double = 3
    /// The `wallpaper` verb's whole bound: content enumeration, the screenshot
    /// and the encode. `still-bounds.test.ts` holds it inside the client's
    /// request timeout.
    static let verbTimeoutSeconds: Double = 8
    /// Each ScreenCaptureKit callback the read waits on, so one that is never
    /// answered (STC-470's lost call) ends the read rather than its thread.
    private static let stepTimeoutSeconds: Double = 2.5

    /// `STC_CAPTURE_FAULT=wallpaper-unavailable`: every read fails, as an
    /// unreadable wallpaper would, so the fallback to Clean and its sentence
    /// can be watched without a Mac whose wallpaper cannot be read.
    static let faulted = ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] == "wallpaper-unavailable"

    private let displayId: UInt32
    private let content: SCShareableContent?
    private let dir: URL
    private let file: String
    private let startNs = Clock.nowNs()
    private let done = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    /// The encoded partial and where it came from, or why not.
    private var result: Result<(partial: URL, picture: WallpaperPicture), WallpaperFailure>?
    /// Set once the caller stops waiting; a result that lands after removes itself.
    private var abandoned = false

    /// Starts at once, on its own queue, and writes `file` into `dir` (made if
    /// missing). `content` is the shareable content to find the wallpaper
    /// window in — `capture-still`'s own, fetched WITH desktop windows — or nil
    /// to fetch it here.
    init(displayId: UInt32, content: SCShareableContent?, dir: URL, file: String) {
        self.displayId = displayId
        self.content = content
        self.dir = dir
        self.file = file
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let r = self.read()
            self.lock.lock()
            if self.abandoned, case .success(let done) = r {
                try? FileManager.default.removeItem(at: done.partial)
            } else {
                self.result = r
            }
            self.lock.unlock()
            self.done.signal()
        }
    }

    /// The picture, in place as `dir/file`, or why not. Never longer than
    /// `timeoutSeconds` (plus a rename).
    func wait(timeoutSeconds: Double) -> Result<WallpaperPicture, WallpaperFailure> {
        _ = done.wait(timeout: .now() + timeoutSeconds)
        lock.lock()
        abandoned = true
        let r = result
        lock.unlock()
        guard let r else {
            return .failure(WallpaperFailure(reason: "the wallpaper was not read within \(timeoutSeconds) s"))
        }
        switch r {
        case .failure(let f):
            return .failure(f)
        case .success(let done):
            guard rename(done.partial.path, dir.appendingPathComponent(file).path) == 0 else {
                try? FileManager.default.removeItem(at: done.partial)
                return .failure(WallpaperFailure(reason: "the wallpaper could not be written as \(file)"))
            }
            return .success(done.picture)
        }
    }

    /// The caller will not use this read (its shot failed): whatever it has
    /// written, or writes later, is removed, so a failed shot's folder is left
    /// as the failure left it.
    func abandon() {
        lock.lock()
        abandoned = true
        let r = result
        result = nil
        lock.unlock()
        if case .success(let done) = r { try? FileManager.default.removeItem(at: done.partial) }
    }

    private func ms() -> Double { Double(Clock.nowNs() &- startNs) / 1e6 }

    private func read() -> Result<(partial: URL, picture: WallpaperPicture), WallpaperFailure> {
        if Self.faulted {
            IO.log("STC_CAPTURE_FAULT=wallpaper-unavailable: the wallpaper read is refused")
            return .failure(WallpaperFailure(reason:
                "STC_CAPTURE_FAULT=wallpaper-unavailable: the wallpaper read is refused, as an unreadable wallpaper would be"))
        }
        let pixels = Self.displayPixelSize(displayId)
        var whyNoWindow: String
        switch windowImage(pixels: pixels) {
        case .success(let image):
            if let partial = encode(image) {
                return .success((partial, WallpaperPicture(source: .window, ms: ms())))
            }
            whyNoWindow = "the wallpaper window's picture could not be written"
        case .failure(let f):
            whyNoWindow = f.reason
        }

        let picture = Self.desktopPicture(displayId: displayId)
        guard let picture, wallpaperIsStatic(imageCount: picture.imageCount) else {
            let what = picture == nil ? "macOS gave no desktop picture for it"
                                      : "the desktop picture is not one still image (dynamic, aerial or a folder)"
            return .failure(WallpaperFailure(reason:
                "could not read the wallpaper of display \(displayId): \(whyNoWindow), and \(what)"))
        }
        guard let image = Self.fileImage(picture.url, displayId: displayId, pixels: pixels),
              let partial = encode(image) else {
            return .failure(WallpaperFailure(reason:
                "could not read the wallpaper of display \(displayId): \(whyNoWindow), and its picture "
                + "\(picture.url.lastPathComponent) could not be decoded or written"))
        }
        return .success((partial, WallpaperPicture(source: .file, ms: ms())))
    }

    // MARK: the wallpaper window

    private func windowImage(pixels: (width: Int, height: Int)) -> Result<CGImage, WallpaperFailure> {
        guard let content = content ?? Self.fetchContent() else {
            return .failure(WallpaperFailure(reason:
                "the window list was not available (Screen Recording is the usual cause)"))
        }
        let bounds = CGDisplayBounds(displayId)
        let candidates = content.windows.map {
            WallpaperWindowCandidate(id: $0.windowID,
                                     bundleId: $0.owningApplication?.bundleIdentifier,
                                     app: $0.owningApplication?.applicationName,
                                     title: $0.title,
                                     layer: $0.windowLayer, frame: StillRect($0.frame))
        }
        let iconLayer = Int(CGWindowLevelForKey(.desktopIconWindow))
        guard let id = chooseWallpaperWindow(candidates, display: StillRect(bounds), desktopIconLayer: iconLayer),
              let win = content.windows.first(where: { $0.windowID == id }) else {
            // Said in full, because which window the wallpaper is was partly a
            // guess (WallpaperDecisions.swift) and this line is how a Mac corrects it.
            let below = candidates.filter { $0.layer < 0 }.map {
                "\($0.id) \($0.bundleId ?? $0.app ?? "?") \"\($0.title ?? "")\" layer \($0.layer) \(Int($0.frame.width))x\(Int($0.frame.height))@\(Int($0.frame.x)),\(Int($0.frame.y))"
            }
            IO.log("wallpaper: no wallpaper window for display \(displayId) (icon layer \(iconLayer)); "
                   + "below-normal windows: \(below.isEmpty ? "none" : below.joined(separator: "; "))")
            return .failure(WallpaperFailure(reason: "no wallpaper window was found for it"))
        }

        let cfg = SCStreamConfiguration()
        cfg.width = pixels.width
        cfg.height = pixels.height
        cfg.scalesToFit = false
        cfg.showsCursor = false
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.captureResolution = .best
        let filter = SCContentFilter(desktopIndependentWindow: win)

        let sem = DispatchSemaphore(value: 0)
        let box = NSLock()
        var image: CGImage?
        var error: Error?
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { i, e in
            box.lock(); image = i; error = e; box.unlock()
            sem.signal()
        }
        guard sem.wait(timeout: .now() + Self.stepTimeoutSeconds) == .success else {
            return .failure(WallpaperFailure(reason: "the wallpaper window's screenshot did not answer"))
        }
        box.lock(); defer { box.unlock() }
        guard let image else {
            return .failure(WallpaperFailure(reason:
                "the wallpaper window's screenshot failed (\(error.map { "\($0)" } ?? "no image"))"))
        }
        return .success(image)
    }

    /// The `wallpaper` verb's own content, WITH desktop windows (the wallpaper
    /// is one). Waited on here, on this read's own queue — never on
    /// ScreenCaptureKit's callback queue.
    private static func fetchContent() -> SCShareableContent? {
        let sem = DispatchSemaphore(value: 0)
        let box = NSLock()
        var out: SCShareableContent?
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { c, _ in
            box.lock(); out = c; box.unlock()
            sem.signal()
        }
        guard sem.wait(timeout: .now() + stepTimeoutSeconds) == .success else { return nil }
        box.lock(); defer { box.unlock() }
        return out
    }

    // MARK: the desktop picture's file (the fallback)

    private struct DesktopPicture {
        let url: URL
        let imageCount: Int?
    }

    private static func desktopPicture(displayId: UInt32) -> DesktopPicture? {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        guard let screen = NSScreen.screens.first(where: {
                  ($0.deviceDescription[key] as? NSNumber)?.uint32Value == displayId }),
              let url = NSWorkspace.shared.desktopImageURL(for: screen), url.isFileURL else { return nil }
        let count = CGImageSourceCreateWithURL(url as CFURL, nil).map { CGImageSourceGetCount($0) }
        return DesktopPicture(url: url, imageCount: count)
    }

    /// The file's one image, no larger than covering the display needs
    /// (`wallpaperPixelSize`), redrawn in the display's own colour space so the
    /// picture means what the screen shows.
    private static func fileImage(_ url: URL, displayId: UInt32,
                                  pixels: (width: Int, height: Int)) -> CGImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        let size = wallpaperPixelSize(imageWidth: image.width, imageHeight: image.height,
                                      displayWidth: pixels.width, displayHeight: pixels.height)
        let space = CGDisplayCopyColorSpace(displayId)
        guard let ctx = CGContext(data: nil, width: size.width, height: size.height, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
        return ctx.makeImage()
    }

    // MARK: encoding

    /// JPEG (`WALLPAPER_JPEG_QUALITY`, full resolution) to a hidden partial in
    /// the shot's folder, beside where it will be renamed to (same volume, so
    /// the rename is atomic). ImageIO embeds the image's own colour space as
    /// the file's ICC profile, so a Display P3 capture stays P3.
    private func encode(_ image: CGImage) -> URL? {
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        catch { return nil }
        let partial = dir.appendingPathComponent(".\(file).\(UUID().uuidString).partial")
        guard let dest = CGImageDestinationCreateWithURL(partial as CFURL, "public.jpeg" as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(dest, image,
                                   [kCGImageDestinationLossyCompressionQuality: WALLPAPER_JPEG_QUALITY] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            try? FileManager.default.removeItem(at: partial)
            return nil
        }
        return partial
    }

    // MARK: the display

    private static func displayPixelSize(_ id: UInt32) -> (width: Int, height: Int) {
        if let mode = CGDisplayCopyDisplayMode(id) { return (mode.pixelWidth, mode.pixelHeight) }
        let b = CGDisplayBounds(id)
        return (Int(b.width), Int(b.height))
    }
}

/// `wallpaper` (STC-628): one display's wallpaper into a shot folder, for the
/// still editor's Wallpaper pick on a shot that has none. Bounded by
/// `WallpaperRead.verbTimeoutSeconds`; answers exactly once.
enum WallpaperVerb {
    static func run(_ req: WallpaperRequest,
                    completion: @escaping (Result<[String: Any], WallpaperFailure>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let read = WallpaperRead(displayId: req.displayId, content: nil,
                                     dir: URL(fileURLWithPath: req.dir), file: req.file)
            switch read.wait(timeoutSeconds: WallpaperRead.verbTimeoutSeconds) {
            case .failure(let f):
                completion(.failure(f))
            case .success(let pic):
                completion(.success(["file": req.file, "source": pic.source.rawValue, "ms": pic.ms]))
            }
        }
    }
}
