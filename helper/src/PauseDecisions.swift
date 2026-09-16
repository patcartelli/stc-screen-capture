import Foundation

/// Pause semantics (STC-240), as pure decisions plus one thread-safe holder.
///
/// The whole feature rests on ONE predicate being asked by everybody. The
/// helper drops a sample when it is inside a paused span; the transform cuts
/// exactly those spans out of the exported timeline. If those two ever
/// disagree, the export contains a frame from a period the user believes was
/// not recorded, or loses one that was — and both look like correct video.
/// So the predicate lives here once, the intervals it reads are the same
/// intervals written to `anchors.json`, and every writer asks through a
/// `PauseGate`.

/// One paused span, session-relative integer nanoseconds, HALF-OPEN
/// `[startNs, endNs)`. The sample at `startNs` is paused; the sample at
/// `endNs` is live again.
struct PauseInterval: Equatable {
    let startNs: Int64
    let endNs: Int64

    var json: [String: Any] { ["startNs": Int(startNs), "endNs": Int(endNs)] }
}

/// THE predicate. `openSinceNs` is a pause that has begun and not yet ended —
/// the live case, which no closed interval can express yet.
///
/// A linear scan, deliberately: a take has a handful of pauses, never
/// thousands, and a sorted bisect here would answer WRONG rather than merely
/// slowly if intervals were ever non-disjoint. `zoom.ts` and
/// `zoom-override.ts` both had to make exactly this move (STC-331).
func isPausedNs(_ tNs: Int64, closed: [PauseInterval], openSinceNs: Int64?) -> Bool {
    if let open = openSinceNs, tNs >= open { return true }
    for i in closed where tNs >= i.startNs && tNs < i.endNs { return true }
    return false
}

/// Owns a take's pause intervals and answers the predicate under a lock.
///
/// Handed to every writer rather than each keeping its own copy of the state:
/// display frames arrive on ScreenCaptureKit's queue, camera and mic frames on
/// their own AVFoundation queues, and tap events on the tap's run loop. Four
/// copies of "am I paused" is four chances to disagree.
final class PauseGate {
    private let lock = NSLock()
    private var closed: [PauseInterval] = []
    private var openSinceNs: Int64?

    /// For the heartbeat — is a pause open right now.
    var isPaused: Bool {
        lock.lock(); defer { lock.unlock() }
        return openSinceNs != nil
    }

    /// For the four writer gates — was this sample's instant inside a pause.
    func isPaused(atNs tNs: Int64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return isPausedNs(tNs, closed: closed, openSinceNs: openSinceNs)
    }

    /// True if this call actually began a pause; false if one was already open.
    @discardableResult
    func pause(atNs tNs: Int64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard openSinceNs == nil else { return false }
        openSinceNs = tNs
        return true
    }

    /// True if this call ended a pause that had real duration. A resume in the
    /// same nanosecond as its pause (or, impossibly, before it) paused nothing
    /// and writes no interval — anchors-5 requires `endNs > startNs`, and an
    /// interval that fails its own schema the moment it is written is worse
    /// than no interval at all.
    @discardableResult
    func resume(atNs tNs: Int64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let start = openSinceNs else { return false }
        openSinceNs = nil
        guard tNs > start else { return false }
        closed.append(PauseInterval(startNs: start, endNs: tNs))
        return true
    }

    /// Stop arrived while paused: close the open span at the stop instant so
    /// the sidecar describes the whole take. Same zero-length rule as resume.
    func close(atNs tNs: Int64) {
        _ = resume(atNs: tNs)
    }

    var intervals: [PauseInterval] {
        lock.lock(); defer { lock.unlock() }
        return closed
    }
}
