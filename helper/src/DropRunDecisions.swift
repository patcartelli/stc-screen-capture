import Foundation

/// STC-238: frames the writer would not take, reported as RUNS on the reliable
/// channel rather than only as a count on the lossy one.
///
/// Before this, a frame `WriterGate` refused (the writer not ready: an encoder
/// that has fallen behind) moved `framesDropped` and nothing else. That count
/// rides the stats line, which is lossy by design, and it says how many but not
/// WHEN — so a take with a 1.5 s hole in it looked, afterwards, exactly like one
/// without. A run is one warning per hole, however many frames it swallowed:
///
///     {"ev":"warning","code":"frames-dropped","startNs":…,"endNs":…,"count":…}
///
/// `startNs`/`endNs` are the session-relative PTS of the first and last frame
/// that did not go in, the same clock `display-refit`'s `startNs` uses. A run is
/// closed by the next frame that DOES go in, or by the take's stop.
///
/// Only the writer's refusals count. Frames dropped while paused, and those
/// refused because teardown has begun, are not holes in what was recorded and
/// never reach this — `close()` is called before the gate is closed, and a
/// closed tracker ignores everything after it.
struct DropRun: Equatable {
    let startNs: Int64
    let endNs: Int64
    let count: Int

    var warning: [String: Any] {
        ["code": "frames-dropped", "startNs": Int(startNs), "endNs": Int(endNs), "count": count]
    }
}

struct DropRunTracker {
    private var startNs: Int64?
    private var lastNs: Int64 = 0
    private var count = 0
    private var closed = false

    /// One frame's fate. Returns the run this frame ENDED, if it ended one.
    mutating func record(appended: Bool, ptsNs: Int64) -> DropRun? {
        if closed { return nil }
        if appended { return takeRun() }
        if startNs == nil { startNs = ptsNs }
        lastNs = ptsNs
        count += 1
        return nil
    }

    /// The take is stopping. A run still open is reported now, ending at its
    /// last dropped frame, and nothing recorded after this counts.
    mutating func close() -> DropRun? {
        if closed { return nil }
        closed = true
        return takeRun()
    }

    private mutating func takeRun() -> DropRun? {
        guard let s = startNs else { return nil }
        let run = DropRun(startNs: s, endNs: lastNs, count: count)
        startNs = nil
        count = 0
        return run
    }
}

/// `STC_CAPTURE_FAULT=encoder-stall` (STC-238): the display frames whose PTS
/// falls in this window are treated as the writer refusing them, exactly as an
/// encoder that has fallen behind refuses them (`isReadyForMoreMediaData`
/// false). Relative to the take's first written frame, so the stall always
/// lands inside the take however long the stream takes to start.
let ENCODER_STALL_FAULT_AFTER_NS: Int64 = 500_000_000
let ENCODER_STALL_FAULT_DURATION_NS: Int64 = 1_500_000_000

func encoderStallFaultCovers(ptsNs: Int64, firstFramePtsNs: Int64) -> Bool {
    guard firstFramePtsNs >= 0 else { return false }
    let start = firstFramePtsNs + ENCODER_STALL_FAULT_AFTER_NS
    return ptsNs >= start && ptsNs < start + ENCODER_STALL_FAULT_DURATION_NS
}
