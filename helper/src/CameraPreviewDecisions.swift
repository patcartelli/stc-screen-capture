import Foundation

/// STC-638's pure decisions: a live camera VIEW for the Record options bar and
/// Settings, never a take. No AVFoundation, no device, no clock; tested by
/// `helper/test/camera-preview/`.
///
/// The rules, from the design review and the spike (2026-11-10):
///
/// 1. **Idle only.** A take owns the camera; a preview is refused while one is
///    starting or running (`previewStartRefusal`), and one already running when a
///    take starts is detached at once (`CameraPreview.detachForTake`).
/// 2. **A preview is a consumer of the WARM session**, not a second opener. The
///    spike measured that a take adopting the warm session replaces the
///    preview's sample-buffer delegate, so the preview stops by itself and the
///    take keeps its first frame on time.
/// 3. **The preview never leaves the light on.** It releases the camera when it
///    stops IF it was the one that opened it (`previewReleasesOnStop`); a camera
///    the countdown already warmed is left for the take.
/// 4. **Frames are telemetry**: ~12 fps, 320 px wide JPEG, on the lossy channel
///    only (`IO.stat`). Losing frames is the design; a frame must never
///    back-pressure anything. Nothing here touches a writer, an anchors
///    document or `render()`.
enum CameraPreviewLimits {
    /// Rule 4. The view is for framing yourself, not for watching video.
    static let maxFps: Int64 = 12
    static let minIntervalNs: Int64 = 1_000_000_000 / maxFps
    /// Output width in pixels; the height follows the camera's aspect.
    static let width = 320
    static let jpegQuality = 0.6
    /// A preview nobody stopped (the app died with a menu open) ends itself.
    /// Under the warm hold the preview asks for (`WarmCamera.maxHoldSeconds`,
    /// 90), so the preview, not the warm timer, is what ends it and says so.
    static let maxSeconds: Double = 60
}

/// Rule 4: is a frame due. The first frame (nothing emitted yet, -1) is always
/// due, so the view fills as soon as the camera delivers.
func decidePreviewEmit(lastEmittedNs: Int64, nowNs: Int64) -> Bool {
    if lastEmittedNs < 0 { return true }
    return nowNs - lastEmittedNs >= CameraPreviewLimits.minIntervalNs
}

/// Rule 1. nil means the preview may start.
func previewStartRefusal(idle: Bool) -> (code: String, detail: String)? {
    idle ? nil : ("bad-state", "camera-preview-start needs an idle helper")
}

/// Rule 3. `wasWarmBefore`: a warm camera existed when the preview asked.
func previewReleasesOnStop(wasWarmBefore: Bool) -> Bool { !wasWarmBefore }

/// Why a preview ended, as the app is told. One list, so a new reason is a
/// decision and not a string typed in two places.
enum PreviewStopReason: String, CaseIterable {
    /// The app asked (`camera-preview-stop`).
    case stopped
    /// A take started; the take adopts or releases the camera.
    case takeStarted = "take-started"
    /// `CameraPreviewLimits.maxSeconds` passed with nobody stopping it.
    case timeout
    /// The camera was unplugged.
    case deviceLost = "device-lost"
}
