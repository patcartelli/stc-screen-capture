import Foundation
import AppKit
import ScreenCaptureKit
import ImageIO

/// The desktop wallpaper of one display, as a JPEG in a shot's folder (STC-628).
///
/// A window shot's default look sits the window on the user's own wallpaper,
/// so `capture-still` reads it BESIDE the window capture (same shareable
/// content, its own screenshot) and the `wallpaper` verb reads it on its own
/// for the still editor. Either way the picture is copied into the shot's
/// folder, so the shot renders the same after the wallpaper changes.
///
/// Where the picture comes from, in order:
///  1. **The cache**, for a static picture already read: the same file, mtime,
///     display and Space (`wallpaperCacheKey`). A dynamic or aerial wallpaper
///     never hits it.
///  2. **The wallpaper window**, captured alone through `SCScreenshotManager`
///     at the display's pixel size. This is the frame CURRENTLY showing, which
///     is what a dynamic or aerial wallpaper needs, and it has no icons and no
///     other windows in it. Which window that is, is `chooseWallpaperWindow`
///     (WallpaperDecisions.swift); what its screenshot holds is the runbook's.
///  3. **The desktop picture's file** (`NSWorkspace.desktopImageURL(for:)`),
///     only when it is one still image: scaled to cover the display at most,
///     redrawn in the display's colour space.
/// The reply's `source` says which (`WallpaperSource`).
///
/// Nothing here may fail or wedge the shot it rides with: every wait is
/// bounded, a failure is a sentence (`WallpaperFailure`), and the result is
/// written into the shot's folder only by `place`, on the caller's thread,
/// once the caller has decided to use it — a read that answers late writes
/// only into the cache.
enum WallpaperSource: String {
    case cache
    case window = "wallpaper-window"
    case file = "desktop-image-file"
}

struct WallpaperFailure: Error, CustomStringConvertible {
    let reason: String
    var description: String { reason }
}

/// A read wallpaper, not yet in any shot folder.
struct WallpaperPicture {
    let url: URL
    let source: WallpaperSource
    /// Milliseconds from the read's start to the picture being ready.
    let ms: Double
    /// True for a picture that is not a cache entry (a dynamic wallpaper):
    /// `place` moves it rather than copying, so nothing is left behind.
    let temporary: Bool
}

final class WallpaperRead {
    /// How long `capture-still` waits for the wallpaper after its own frame and
    /// shot.json are written. Past this the shot answers with `wallpaperError`
    /// instead; `still-bounds.test.ts` holds it well inside the still's own
    /// backstop, so a wallpaper can never turn a shot into a `still-timeout`.
    static let joinTimeoutSeconds: Double = 3
    /// The `wallpaper` verb's whole bound: content enumeration, the screenshot,
    /// the encode and the copy. `still-bounds.test.ts` holds it inside the
    /// client's request timeout.
    static let verbTimeoutSeconds: Double = 8
    /// Each ScreenCaptureKit callback the read waits on, so one that is never
    /// answered (STC-470's lost call) ends the read rather than its thread.
    private static let stepTimeoutSeconds: Double = 2.5
    /// Static pictures kept in the cache, newest first. A handful covers every
    /// display and Space someone uses; anything older is a wallpaper since
    /// replaced.
    private static let cacheEntriesKept = 8

    /// `STC_CAPTURE_FAULT=wallpaper-unavailable`: every read fails, as an
    /// unreadable wallpaper would, so the fallback to Clean and its sentence
    /// can be watched without a Mac whose wallpaper cannot be read.
    static let faulted = ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] == "wallpaper-unavailable"

    private let displayId: UInt32
    private let content: SCShareableContent?
    private let startNs = Clock.nowNs()
    private let done = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var result: Result<WallpaperPicture, WallpaperFailure>?

    /// Starts at once, on its own queue. `content` is the shareable content to
    /// find the wallpaper window in — `capture-still`'s own, fetched WITH
    /// desktop windows — or nil to fetch it here.
    init(displayId: UInt32, content: SCShareableContent?) {
        self.displayId = displayId
        self.content = content
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let r = self.read()
            self.lock.lock(); self.result = r; self.lock.unlock()
            self.done.signal()
        }
    }

    /// The picture, or why not. Never longer than `timeoutSeconds`.
    func wait(timeoutSeconds: Double) -> Result<WallpaperPicture, WallpaperFailure> {
        guard done.wait(timeout: .now() + timeoutSeconds) == .success else {
            return .failure(WallpaperFailure(reason:
                "the wallpaper was not read within \(timeoutSeconds) s"))
        }
        lock.lock(); defer { lock.unlock() }
        return result ?? .failure(WallpaperFailure(reason: "the wallpaper read ended without an answer"))
    }

    private func ms() -> Double { Double(Clock.nowNs() &- startNs) / 1e6 }

    private func read() -> Result<WallpaperPicture, WallpaperFailure> {
        if Self.faulted {
            IO.log("STC_CAPTURE_FAULT=wallpaper-unavailable: the wallpaper read is refused")
            return .failure(WallpaperFailure(reason:
                "STC_CAPTURE_FAULT=wallpaper-unavailable: the wallpaper read is refused, as an unreadable wallpaper would be"))
        }
        let cacheDir = Self.cacheDirectory()
        let picture = Self.desktopPicture(displayId: displayId)
        let isStatic = wallpaperIsStatic(imageCount: picture?.imageCount)
        let key = wallpaperCacheKey(displayId: displayId,
                                    imageURL: isStatic ? picture?.url.path : nil,
                                    modified: picture?.modified,
                                    spaceId: Self.currentSpace(displayId: displayId))
        let cached = key == WALLPAPER_UNCACHEABLE ? nil : cacheDir?.appendingPathComponent(key + ".jpg")
        if let cached, FileManager.default.fileExists(atPath: cached.path) {
            return .success(WallpaperPicture(url: cached, source: .cache, ms: ms(), temporary: false))
        }

        let pixels = Self.displayPixelSize(displayId)
        var whyNoWindow: String
        switch windowImage(pixels: pixels) {
        case .success(let image):
            if let out = encode(image, cached: cached, cacheDir: cacheDir) {
                return .success(WallpaperPicture(url: out.url, source: .window, ms: ms(), temporary: out.temporary))
            }
            whyNoWindow = "the wallpaper window's picture could not be encoded"
        case .failure(let f):
            whyNoWindow = f.reason
        }

        guard isStatic, let picture else {
            let what = picture == nil ? "macOS gave no desktop picture for it"
                                      : "the desktop picture is not one still image (dynamic or aerial)"
            return .failure(WallpaperFailure(reason:
                "could not read the wallpaper of display \(displayId): \(whyNoWindow), and \(what)"))
        }
        guard let image = Self.fileImage(picture.url, displayId: displayId, pixels: pixels),
              let out = encode(image, cached: cached, cacheDir: cacheDir) else {
            return .failure(WallpaperFailure(reason:
                "could not read the wallpaper of display \(displayId): \(whyNoWindow), and its picture "
                + "\(picture.url.lastPathComponent) could not be decoded"))
        }
        return .success(WallpaperPicture(url: out.url, source: .file, ms: ms(), temporary: out.temporary))
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
            // Said in full, because which window the wallpaper is was a guess
            // (WallpaperDecisions.swift) and this line is how a Mac corrects it.
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

    // MARK: the desktop picture's file

    private struct DesktopPicture {
        let url: URL
        let modified: Double?
        let imageCount: Int?
    }

    private static func desktopPicture(displayId: UInt32) -> DesktopPicture? {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        guard let screen = NSScreen.screens.first(where: {
                  ($0.deviceDescription[key] as? NSNumber)?.uint32Value == displayId }),
              let url = NSWorkspace.shared.desktopImageURL(for: screen), url.isFileURL else { return nil }
        let modified = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date)?
            .map { $0.timeIntervalSince1970 }
        let count = CGImageSourceCreateWithURL(url as CFURL, nil).map { CGImageSourceGetCount($0) }
        return DesktopPicture(url: url, modified: modified, imageCount: count)
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

    // MARK: encoding, the cache, and the shot folder

    /// JPEG (`WALLPAPER_JPEG_QUALITY`, full resolution) into the cache entry
    /// when the picture is cacheable, otherwise a temporary file beside the
    /// cache. ImageIO embeds the image's own colour space as the file's ICC
    /// profile, so a Display P3 capture stays P3. Written under a temporary
    /// name and renamed, so a reader never sees half a cache entry.
    private func encode(_ image: CGImage, cached: URL?, cacheDir: URL?) -> (url: URL, temporary: Bool)? {
        let dir = cacheDir ?? FileManager.default.temporaryDirectory
        let tmp = dir.appendingPathComponent(".wallpaper-\(UUID().uuidString).jpg")
        guard let dest = CGImageDestinationCreateWithURL(tmp as CFURL, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image,
                                   [kCGImageDestinationLossyCompressionQuality: WALLPAPER_JPEG_QUALITY] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            try? FileManager.default.removeItem(at: tmp)
            return nil
        }
        // Only ever our own cache directory: never the shared temporary one.
        defer { if let cacheDir { Self.pruneCache(cacheDir) } }
        guard let cached else { return (tmp, true) }
        if rename(tmp.path, cached.path) != 0 {
            // Kept as a temporary picture rather than lost: the shot still gets it.
            return (tmp, true)
        }
        return (cached, false)
    }

    /// `~/Library/Caches/<bundle id>/wallpaper/`, made on first use; nil when
    /// it cannot be, which only costs the cache.
    private static func cacheDirectory() -> URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let bundle = Bundle.main.bundleIdentifier ?? "com.studiocartelli.capture"
        let dir = caches.appendingPathComponent(bundle).appendingPathComponent("wallpaper")
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        catch { return nil }
        return dir
    }

    /// Keeps the newest `cacheEntriesKept` entries, and drops any temporary
    /// picture a read left behind more than a minute ago (one whose shot had
    /// stopped waiting for it).
    private static func pruneCache(_ dir: URL) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return }
        let dated = names.filter { $0.pathExtension == "jpg" }
            .map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        let entries = dated.filter { !$0.0.lastPathComponent.hasPrefix(".") }.sorted { $0.1 > $1.1 }
        for (url, _) in entries.dropFirst(cacheEntriesKept) { try? fm.removeItem(at: url) }
        let stale = Date().addingTimeInterval(-60)
        for (url, when) in dated where url.lastPathComponent.hasPrefix(".wallpaper-") && when < stale {
            try? fm.removeItem(at: url)
        }
    }

    /// Puts a read picture into `dir` as `file`, replacing any earlier one.
    /// A cache entry is CLONED (`clonefile(2)`: no bytes copied on APFS) and
    /// copied when the clone is refused (another volume); a temporary picture
    /// is moved. Either way it lands under a temporary name first and is
    /// renamed, so the folder never holds half a wallpaper.
    static func place(_ picture: WallpaperPicture, into dir: URL, file: String) -> WallpaperFailure? {
        let fm = FileManager.default
        let dest = dir.appendingPathComponent(file)
        let partial = dir.appendingPathComponent(".\(file).partial")
        try? fm.removeItem(at: partial)
        var placed = false
        if picture.temporary { placed = rename(picture.url.path, partial.path) == 0 }
        if !placed { placed = clonefile(picture.url.path, partial.path, 0) == 0 }
        if !placed { placed = (try? fm.copyItem(at: picture.url, to: partial)) != nil }
        if picture.temporary { try? fm.removeItem(at: picture.url) }
        guard placed else { return WallpaperFailure(reason: "the wallpaper could not be copied into the shot's folder") }
        guard rename(partial.path, dest.path) == 0 else {
            try? fm.removeItem(at: partial)
            return WallpaperFailure(reason: "the wallpaper could not be written as \(file)")
        }
        return nil
    }

    // MARK: the display

    private static func displayPixelSize(_ id: UInt32) -> (width: Int, height: Int) {
        if let mode = CGDisplayCopyDisplayMode(id) { return (mode.pixelWidth, mode.pixelHeight) }
        let b = CGDisplayBounds(id)
        return (Int(b.width), Int(b.height))
    }

    private typealias MainConnectionFn = @convention(c) () -> Int32
    private typealias DisplaySpaceFn = @convention(c) (Int32, CFString) -> UInt64

    /// The Space a display is showing, through the window server's private
    /// SPI, looked up at run time; nil when it is not there, which only makes
    /// the cache key coarser (the URL already follows the Space's picture).
    private static func currentSpace(displayId: UInt32) -> Int? {
        guard let h = dlopen(nil, RTLD_NOW),
              let conn = dlsym(h, "CGSMainConnectionID"),
              let space = dlsym(h, "CGSManagedDisplayGetCurrentSpace"),
              let uuid = CGDisplayCreateUUIDFromDisplayID(displayId)?.takeRetainedValue(),
              let name = CFUUIDCreateString(nil, uuid) else { return nil }
        let cid = unsafeBitCast(conn, to: MainConnectionFn.self)()
        let sid = unsafeBitCast(space, to: DisplaySpaceFn.self)(cid, name)
        return sid == 0 ? nil : Int(sid)
    }
}

/// `wallpaper` (STC-628): one display's wallpaper into a shot folder, for the
/// still editor's Wallpaper pick on a shot that has none. Bounded by
/// `WallpaperRead.verbTimeoutSeconds`; answers exactly once.
enum WallpaperVerb {
    static func run(_ req: WallpaperRequest,
                    completion: @escaping (Result<[String: Any], WallpaperFailure>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let read = WallpaperRead(displayId: req.displayId, content: nil)
            switch read.wait(timeoutSeconds: WallpaperRead.verbTimeoutSeconds) {
            case .failure(let f):
                completion(.failure(f))
            case .success(let pic):
                let dir = URL(fileURLWithPath: req.dir)
                do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
                catch { completion(.failure(WallpaperFailure(reason: "could not make \(req.dir): \(error)"))); return }
                if let f = WallpaperRead.place(pic, into: dir, file: req.file) { completion(.failure(f)); return }
                completion(.success(["file": req.file, "source": pic.source.rawValue, "ms": pic.ms]))
            }
        }
    }
}
