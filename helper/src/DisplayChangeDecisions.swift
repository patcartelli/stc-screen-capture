import Foundation

/// STC-235: what a take does when the display changes under it. Pure — no
/// ScreenCaptureKit, no clock — so every row of the spec's outcome table is
/// tested without a display (helper/test/display-change/).
///
/// CG calls back once per affected display, often several times for one
/// physical change; the decision runs ONCE, after `DISPLAY_CHANGE_SETTLE_MS`
/// of quiet.
let DISPLAY_CHANGE_SETTLE_MS = 250
/// A refit that never produces a frame is a take whose geometry is unknown.
let REFIT_FRAME_TIMEOUT_MS = 3000

enum DisplayChangeDecision: Equatable { case refit; case stop(String) }

/// `region` is the take's region in display-local points (nil for display and
/// window scopes). It must lie ENTIRELY inside the display's new point bounds:
/// clamping it would silently record a different area than the one picked.
func decideDisplayChange(capturedDisplayPresent: Bool, region: StillRect?,
                         newPointWidth: Int, newPointHeight: Int) -> DisplayChangeDecision {
    guard capturedDisplayPresent else { return .stop("display-reconfigured") }
    if let r = region {
        let fits = r.x >= 0 && r.y >= 0 &&
            r.x + r.width <= Double(newPointWidth) && r.y + r.height <= Double(newPointHeight)
        if !fits { return .stop("region-out-of-bounds") }
    }
    return .refit
}

/// The debounce as a value, so "a burst collapses to one decision" is a test
/// rather than a hope about timer scheduling.
struct SettleDebounce {
    private(set) var deadlineMs: Int?
    mutating func poke(nowMs: Int) { deadlineMs = nowMs + DISPLAY_CHANGE_SETTLE_MS }
    func due(nowMs: Int) -> Bool { deadlineMs.map { nowMs >= $0 } ?? false }
    mutating func fire() { deadlineMs = nil }
}

/// What the live display stream is configured FOR, as far as a refit can
/// change it: the display it reports, the source it reads, and where that
/// source lands in the fixed capture frame. `sourceRect` is a region take's
/// crop in DISPLAY-LOCAL points (nil for display and window scopes);
/// `sourcePixelWidth/Height` is what the filter delivers before scaling.
struct RefitShape: Equatable {
    let geometry: DisplayGeometry
    let sourcePixelWidth: Int, sourcePixelHeight: Int
    let sourceRect: StillRect?
    let rect: FitRect
}

/// What a settled display change actually asks of the take.
/// - `none`: nothing the take depends on moved. CG calls back for EVERY
///   display, so plugging in an unrelated monitor lands here — and must
///   touch neither ScreenCaptureKit nor the anchors version.
/// - `recordOnly`: the display's DESCRIPTION moved (its origin in the global
///   space, most often, when a neighbour is added or removed) but nothing
///   the stream reads or writes did. The cursor needs the new origin, so a
///   geometry entry is still recorded, through the normal landing path; the
///   stream is left alone.
/// - `reconfigure`: the source's pixels, its crop, or its place in the
///   capture frame changed — the stream must be updated (or restarted).
enum RefitKind: Equatable { case none, recordOnly, reconfigure }

/// Why `recordOnly` never needs an SCK update, per scope:
/// - display: the filter names the display by id, and a refit is pinned to
///   the SAME id (`StartRequest(copying:displayId:)`), so an equal pixel size
///   and fit rect is the same configuration.
/// - region: `sourceRect` is display-LOCAL, so moving the display in the
///   global space does not move the crop; an equal `sourceRect` is compared
///   here explicitly anyway, so a crop that did change reconfigures.
/// - window: `SCContentFilter(desktopIndependentWindow:)` follows the WINDOW
///   wherever it is, so which display holds it (id, origin) is description,
///   not configuration — as long as its pixel size (points x the holding
///   display's backing scale) did not change, which is compared.
/// A different display id for a display or region take cannot happen (the
/// refit is pinned), but if it did the pixel size or rect comparison is not
/// what would catch it — so it is refused as `reconfigure` explicitly.
func refitNeeded(current: RefitShape, next: RefitShape, followsWindow: Bool) -> RefitKind {
    if current == next { return .none }
    if current.sourcePixelWidth != next.sourcePixelWidth || current.sourcePixelHeight != next.sourcePixelHeight ||
        current.sourceRect != next.sourceRect || current.rect != next.rect {
        return .reconfigure
    }
    if !followsWindow && current.geometry.id != next.geometry.id { return .reconfigure }
    return .recordOnly
}
