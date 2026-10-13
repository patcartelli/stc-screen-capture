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

/// At most one partial write pending. A window dragged through a window-scope take
/// appends to the window track at 30 Hz (STC-482); without this every append would
/// queue its own write. A value, so "a burst is one write" is a test, not a hope about
/// queue scheduling — the `SettleDebounce` precedent (DisplayChangeDecisions.swift).
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
