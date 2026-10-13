import Foundation

/// STC-530. anchors.json is written only at a clean stop (`writeSidecars`), so a helper
/// that dies mid-take used to leave a playable fragmented display.mp4 (STC-394) and nothing
/// that described it. `anchors.partial.json` is that description, kept current while
/// recording: the stop-time document minus `stop`, built by the SAME `anchorsDocument`
/// so the two cannot drift. The app finishes it (`transform/src/recover-anchors.ts`).
///
/// File-only on purpose: no ScreenCaptureKit, no clock, so CI tests every rule here
/// (helper/test/partial-anchors.test.ts) without a grant.
let PARTIAL_ANCHORS_FILE = "anchors.partial.json"

/// The stop-time document with its `stop` block removed — the one difference.
func partialAnchors(_ stopTimeDoc: [String: Any]) -> [String: Any] {
    var d = stopTimeDoc
    d.removeValue(forKey: "stop")
    return d
}

/// Atomic: `.atomic` writes a temporary file and renames it over the target, so a crash
/// mid-write leaves the previous complete partial or none — never a torn one.
func writePartialAnchors(_ doc: [String: Any], in dir: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys])
    try data.write(to: dir.appendingPathComponent(PARTIAL_ANCHORS_FILE), options: .atomic)
}

/// After the stop-time sidecars. Removes the partial ONLY when anchors.json exists: when
/// that write failed (STC-527's full disk), the partial is all the app has to recover from.
func retirePartialAnchors(in dir: URL) {
    let fm = FileManager.default
    guard fm.fileExists(atPath: dir.appendingPathComponent("anchors.json").path) else { return }
    try? fm.removeItem(at: dir.appendingPathComponent(PARTIAL_ANCHORS_FILE))
}

/// The shortest gap between two partial writes. The coalescer bounds how many writes can be
/// PENDING (one), not how often they run: a window dragged through a window-scope take with a
/// camera would otherwise keep the partial's queue building documents back to back, and each
/// build sorts the camera's deltas under the camera's own lock (`CameraCapture.track()` ->
/// `medianDelta()`), contending with its capture callback. Half a second still keeps the partial
/// far fresher than anything a crash could ask of it.
let PARTIAL_MIN_INTERVAL_SECONDS: Double = 0.5

/// How long a partial write must wait so it starts no sooner than `PARTIAL_MIN_INTERVAL_SECONDS`
/// after the previous one STARTED. `lastWriteNs == nil` (no write yet this take — the first
/// display frame's) is never delayed. A `nowNs` before `lastWriteNs` cannot happen on a
/// monotonic clock; it waits the whole interval rather than trusting the arithmetic.
func partialWriteDelay(lastWriteNs: UInt64?, nowNs: UInt64) -> Double {
    guard let last = lastWriteNs else { return 0 }
    let minNs = UInt64(PARTIAL_MIN_INTERVAL_SECONDS * 1_000_000_000)
    let elapsed = nowNs >= last ? nowNs - last : 0
    return elapsed >= minNs ? 0 : Double(minNs - elapsed) / 1_000_000_000
}

/// At most one partial write pending. A window dragged through a window-scope take
/// appends to the window track at 30 Hz (STC-482); without this every append would
/// queue its own write. A value, so "a burst is one write" is a test, not a hope about
/// queue scheduling — the `SettleDebounce` precedent (DisplayChangeDecisions.swift).
/// Not thread-safe: the caller serialises it (CaptureSession holds its `lock` around both calls).
struct PartialWriteCoalescer {
    private var pending = false
    /// A change happened. True = schedule a write; false = one is already pending and will see it.
    mutating func request() -> Bool {
        if pending { return false }
        pending = true
        return true
    }
    /// The pending write has started building its document: a change from here on needs another.
    mutating func began() { pending = false }
}
