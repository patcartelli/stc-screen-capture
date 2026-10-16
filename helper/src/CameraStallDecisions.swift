import Foundation

/// STC-553's pure decisions: when a camera that HAS delivered frames counts as
/// stalled, and which stretches the take's sidecar records. No AVFoundation, no
/// device, no clock — tested by `helper/test/camera-stall/`.
///
/// `camera-no-frames` (STC-286) covers a camera that never delivers. A camera
/// that delivers its first frames and then STOPS said nothing: the partial is
/// rewritten only at the first frame, and the user found a missing or frozen PiP
/// after the take. Patrick's decisions (2026-10-16, on the ticket):
///
/// 1. **Arrival, not appends.** A frame ARRIVING at `captureOutput` is what
///    says the camera is alive. `appended` does not move during a pause, a
///    monotonic-guard drop or a writer refusal (which has its own warning), so
///    it would call all three a stall.
/// 2. **N = 3 s** (`thresholdNs`), measured: an Elgato under a load average of
///    121 never went past ~33 ms between frames, and the slowest live camera
///    seen (12 frames in 11 s, ~0.9 s apart) must not trip it.
/// 3. **Paused time is never a stall.** Nothing is checked while paused; a
///    pause closes an open stall at the pause's own start; after a resume N is
///    measured from the later of the last arrival and the resume. The same rule
///    STC-528's silent spans follow (`MicSignalDecisions.swift`, rule 3).
/// 4. **One warning per stall**, re-armed by the next frame. A camera that
///    recovers keeps contributing: nothing is torn down.
/// 5. **The span is in PTS time**, the clock every anchors time uses: it starts
///    at the last frame recorded before the stall (where the picture froze) or
///    at the resume, and ends at the first frame after it, at the pause that cut
///    it short, or (left open here) at the take's `stop.t` (`anchorsDocument`).
///    A camera's PTS and `Clock.nowNs()` are the same mach host clock, so
///    detection and the span share one timeline, session-relative.
enum CameraStall {
    /// Rule 2.
    static let thresholdNs: Int64 = 3_000_000_000
    /// How often `CameraCapture` asks. A stall is said at most this late.
    static let checkIntervalSeconds: Double = 0.25
}

/// One stall, session-relative ns. `endNs` nil means still going.
struct StallSpan: Equatable {
    let startNs: Int64
    var endNs: Int64?
}

/// What changed, for the caller to say (a warning) and record (the partial).
enum CameraStallChange: Equatable {
    case began(StallSpan)
    case ended(StallSpan)
}

/// Folds frame arrivals and periodic checks into the take's stall spans.
/// A value, touched only under `CameraCapture`'s lock.
struct CameraStallTracker {
    /// Closed spans, in order.
    private(set) var closed: [StallSpan] = []
    /// The stall going on now, if any.
    private(set) var open: StallSpan?
    /// When the newest frame arrived (rule 1). Nil until the first: no stall
    /// before a first frame, which is `camera-no-frames`' case.
    private var lastArrivalNs: Int64?
    /// The newest frame recorded outside a pause: where the picture froze.
    private var lastLivePtsNs: Int64?

    /// A frame arrived at `nowNs` carrying `ptsNs`. Ends an open stall at that
    /// frame (rule 4), unless it arrived inside a pause, which closes it at the
    /// pause instead (rule 3).
    mutating func frameArrived(nowNs: Int64, ptsNs: Int64, pause: PauseState) -> CameraStallChange? {
        lastArrivalNs = nowNs
        let paused = pause.openSinceNs.map { ptsNs >= $0 } ?? false
        if !paused { lastLivePtsNs = ptsNs }
        guard open != nil else { return nil }
        return close(atNs: paused ? pause.openSinceNs! : ptsNs)
    }

    /// The periodic check. Opens a stall once the camera has gone `thresholdNs`
    /// of RECORDING time without a frame; closes an open one at a pause.
    mutating func check(nowNs: Int64, pause: PauseState) -> CameraStallChange? {
        if let pausedAt = pause.openSinceNs {
            return open == nil ? nil : close(atNs: pausedAt)
        }
        guard open == nil, let last = lastArrivalNs else { return nil }
        let resume = pause.lastResumeNs ?? Int64.min
        guard nowNs - max(last, resume) >= CameraStall.thresholdNs else { return nil }
        let froze = max(lastLivePtsNs ?? last, resume)
        let span = StallSpan(startNs: froze, endNs: nil)
        open = span
        return .began(span)
    }

    /// Every span, the open one last and still open. What the sidecar records,
    /// at stop and in `anchors.partial.json` alike.
    func spansSoFar() -> [StallSpan] {
        open.map { closed + [$0] } ?? closed
    }

    private mutating func close(atNs ns: Int64) -> CameraStallChange? {
        guard var s = open else { return nil }
        open = nil
        // A stall that would end where it began (a pause at the same instant)
        // stalled nothing; keep no span the schema would refuse.
        guard ns > s.startNs else { return nil }
        s.endNs = ns
        closed.append(s)
        return .ended(s)
    }
}

/// `STC_CAPTURE_FAULT=camera-stall`: camera frames whose PTS falls in this
/// window never arrive, as a stalled camera sends none, and then the camera
/// recovers. Relative to the camera's first written frame. Four seconds, past
/// N and under the 5 s the Mac check could not see (its counter printed every
/// 5 s), and a different length from STC-562's 5 s `camera-gap`.
/// `camera-stall-end` is the same stall that never recovers.
let CAMERA_STALL_FAULT_AFTER_NS: Int64 = 3_000_000_000
let CAMERA_STALL_FAULT_DURATION_NS: Int64 = 4_000_000_000

func cameraStallFaultCovers(ptsNs: Int64, firstFramePtsNs: Int64, forever: Bool) -> Bool {
    guard firstFramePtsNs >= 0 else { return false }
    let start = firstFramePtsNs + CAMERA_STALL_FAULT_AFTER_NS
    return ptsNs >= start && (forever || ptsNs < start + CAMERA_STALL_FAULT_DURATION_NS)
}
