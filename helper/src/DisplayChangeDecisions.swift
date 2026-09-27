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
