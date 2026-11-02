import Foundation
import CoreGraphics

/// The decisions the wallpaper read makes (STC-628), kept free of
/// ScreenCaptureKit and AppKit so `helper/test/still/main.swift` exercises them
/// without a display or a grant, as `StillDecisions.swift` is for the still.
/// `Wallpaper.swift` calls these; it does not repeat them.
///
/// What is decided here: what a `wallpaper` request means; whether a desktop
/// picture is one still image (and so may be cached) or a dynamic/aerial one
/// (which must be read as it is showing, every time); the cache key; which
/// window in the window server's list IS the wallpaper of a display; and the
/// pixel size the picture is kept at.

struct WallpaperRequest: Equatable {
    /// The shot's own directory; `file` is written inside it.
    let dir: String
    /// The display whose wallpaper is read — a shot's own `display.id`.
    let displayId: UInt32
    /// A bare `.jpg` name beside shot.json. The wallpaper is always JPEG
    /// (`WALLPAPER_JPEG_QUALITY`), so the name says so.
    let file: String

    static let defaultFile = StillRequest.wallpaperFile
}

/// A `.jpg` name and nothing else: no path, no other extension, not even
/// `.jpeg` — one spelling, the one `still:frame` lets through for the
/// wallpaper. Shared by the `wallpaper` verb and by `capture-still`'s own
/// wallpaper, which always uses the default name.
func isJpgName(_ file: String) -> Bool {
    !file.isEmpty && !file.contains("/") && file.lowercased().hasSuffix(".jpg") && file.count > ".jpg".count
}

/// The wallpaper's JPEG quality. JPEG and not PNG because a PNG of a smooth,
/// dithered gradient wallpaper took ~300 ms per 8.4 MP to encode on hardware
/// (2026-11-02; ~590 ms at 5K), which no shot budget can carry, while JPEG
/// took ~33 ms (Patrick's call, 2026-11-02). 0.9 because the wallpaper is a
/// background seen around a window and under a shadow: above it the file
/// grows fast for nothing visible, and below it banding starts to show in
/// exactly the gradients wallpapers are made of. Full resolution, and the
/// display's colour profile is kept.
let WALLPAPER_JPEG_QUALITY = 0.9

/// The `wallpaper` verb's request, or exactly why it cannot be done.
///
/// The display is REQUIRED rather than defaulted to the main one: the still
/// editor asks for the wallpaper of the display the shot was taken on, and a
/// silent fall back to another display's picture would be a wrong answer that
/// looks right.
func parseWallpaperRequest(_ cmd: [String: Any]) -> Result<WallpaperRequest, StillRequestError> {
    guard let dir = cmd["dir"] as? String, !dir.isEmpty else { return .failure(.missingDir) }
    guard let displayId = id32(cmd["displayId"]) else { return .failure(.missingDisplayId) }
    let file = cmd["file"] as? String ?? WallpaperRequest.defaultFile
    guard isJpgName(file) else { return .failure(.notJpg(file)) }
    return .success(WallpaperRequest(dir: dir, displayId: displayId, file: file))
}

/// A desktop picture is one still image only when its file holds exactly one
/// image. A dynamic wallpaper is a HEIC with one image per time of day (or per
/// appearance); an aerial has no file the picture can be read from at all, so
/// it arrives here as nil. Neither may be cached or read from the file — the
/// frame CURRENTLY showing is the one the shot wants.
func wallpaperIsStatic(imageCount: Int?) -> Bool {
    imageCount == 1
}

/// The key that is never looked up and never written: a wallpaper with this
/// key is read afresh for every shot.
let WALLPAPER_UNCACHEABLE = ""

/// The cache entry's name for one display's wallpaper.
///
/// `imageURL` is the desktop picture's path ONLY when `wallpaperIsStatic` said
/// so; a dynamic or aerial wallpaper passes nil and gets
/// `WALLPAPER_UNCACHEABLE`, so it always re-captures. A missing mtime is the
/// same: without it, a picture edited in place under the same name would keep
/// its old pixels. The Space is in the key because each Space can show a
/// different picture; an unknown Space (nil) is a key of its own.
///
/// FNV-1a over the fields rather than the fields themselves, so the key is
/// always a short, safe file name whatever the path holds.
func wallpaperCacheKey(displayId: UInt32, imageURL: String?, modified: Double?, spaceId: Int?) -> String {
    guard let imageURL, let modified else { return WALLPAPER_UNCACHEABLE }
    let fields = "\(displayId)\u{1F}\(imageURL)\u{1F}\(modified)\u{1F}\(spaceId.map { "\($0)" } ?? "-")"
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    for b in fields.utf8 {
        h ^= UInt64(b)
        h = h &* 0x0000_0100_0000_01b3
    }
    return "d\(displayId)-" + String(h, radix: 16)
}

/// One entry of the window server's list, as far as choosing the wallpaper
/// needs to see it. `frame` is in GLOBAL points, top-left origin — the same
/// space as `CGDisplayBounds` — so it is compared with the display directly.
struct WallpaperWindowCandidate {
    let id: UInt32
    let bundleId: String?
    let app: String?
    let title: String?
    let layer: Int
    let frame: StillRect
}

/// WindowManager draws the desktop picture on macOS 27 — SEEN, on Patrick's
/// Mac on 2026-11-02 (two displays, `CGWindowListCopyWindowInfo` and the
/// helper's own `SCShareableContent` list agreeing): one window per display
/// titled "Wallpaper", at layer -2147483624 (the desktop level minus one),
/// framed exactly on its display. The same process also owns an off-screen
/// "Fullscreen Backdrop" at -2147483622 that fills the display too, so its
/// windows count only by that title.
private let WALLPAPER_WINDOW_MANAGER = "com.apple.WindowManager"
private let WALLPAPER_WINDOW_TITLE = "Wallpaper"
/// Older or other macOS releases, NOT seen: the Dock drew the desktop picture
/// before WallpaperAgent existed, and WallpaperAgent may still on some setups.
/// Matched by owner alone, or by app name when there is no bundle id.
private let WALLPAPER_OWNER_BUNDLES: Set<String> = ["com.apple.wallpaper.agent", "com.apple.dock"]
private let WALLPAPER_OWNER_APPS: Set<String> = ["WallpaperAgent", "Wallpaper", "Dock"]

/// How far a window's frame may be from the display's and still be "the whole
/// display": half-point rounding on a scaled display, nothing more.
private let WALLPAPER_FRAME_TOLERANCE_POINTS = 1.0

/// Which window is the desktop wallpaper of `display` (global points), or nil.
///
/// **Partly a guess, isolated here on purpose.** Three rules: drawn by the
/// process that draws the desktop picture (above); BELOW the desktop-icon
/// layer, so Finder's icons and the Dock's own window are never it; and
/// covering exactly this display, so each display gets its own. Of several,
/// the lowest layer wins — the picture itself rather than anything drawn over
/// it. The WindowManager rule matches a window list seen on a Mac; whether a
/// SCREENSHOT of that window is the picture (and the frame showing, for a
/// dynamic or aerial wallpaper) could not be seen where this was written, and
/// is the runbook's first item. If a rule is wrong, this function is the one
/// place to correct; nothing else changes when it is.
func chooseWallpaperWindow(_ candidates: [WallpaperWindowCandidate], display: StillRect,
                           desktopIconLayer: Int) -> UInt32? {
    func owned(_ c: WallpaperWindowCandidate) -> Bool {
        if c.bundleId == WALLPAPER_WINDOW_MANAGER { return c.title == WALLPAPER_WINDOW_TITLE }
        if let b = c.bundleId, WALLPAPER_OWNER_BUNDLES.contains(b) { return true }
        if c.bundleId == nil, let a = c.app, WALLPAPER_OWNER_APPS.contains(a) { return true }
        return false
    }
    func fills(_ f: StillRect) -> Bool {
        abs(f.x - display.x) <= WALLPAPER_FRAME_TOLERANCE_POINTS
            && abs(f.y - display.y) <= WALLPAPER_FRAME_TOLERANCE_POINTS
            && abs(f.width - display.width) <= WALLPAPER_FRAME_TOLERANCE_POINTS
            && abs(f.height - display.height) <= WALLPAPER_FRAME_TOLERANCE_POINTS
    }
    return candidates
        .filter { owned($0) && $0.layer < desktopIconLayer && fills($0.frame) }
        .min { $0.layer < $1.layer }?
        .id
}

/// The size a desktop picture is kept at: no larger than it needs to be to
/// COVER the display at its full pixel size, and never enlarged. The renderer
/// cover-crops it to the canvas, so the aspect is kept and the short side lands
/// on the display's; rounding is UP, so the picture can never fall a pixel
/// short of covering.
func wallpaperPixelSize(imageWidth: Int, imageHeight: Int,
                        displayWidth: Int, displayHeight: Int) -> (width: Int, height: Int) {
    guard imageWidth > 0, imageHeight > 0, displayWidth > 0, displayHeight > 0 else {
        return (imageWidth, imageHeight)
    }
    let scale = max(Double(displayWidth) / Double(imageWidth), Double(displayHeight) / Double(imageHeight))
    guard scale < 1 else { return (imageWidth, imageHeight) }
    return (min(imageWidth, Int((Double(imageWidth) * scale - 1e-6).rounded(.up))),
            min(imageHeight, Int((Double(imageHeight) * scale - 1e-6).rounded(.up))))
}
