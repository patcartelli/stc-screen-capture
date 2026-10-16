import Foundation

/// STC-561: the display writer cannot hold one frame on screen for longer than
/// 2.147 s, so a screen that goes still for longer gets the last frame again.
///
/// The display input's `mediaTimeScale` is 1 ns (Capture.swift `setupWriter`),
/// so that sample times survive as exact integer nanoseconds. A sample's
/// DURATION is the gap to the next one, and the movie format writer stores it
/// in a signed 32-bit field: 2^31 ns = 2.147 s is the longest it can write.
/// One longer and the format writer fails (`FFR_Movie signalled err=-17771`),
/// the writer goes `.failed` with AVFoundation -11800 over -17771, and the take
/// stops as `error` (STC-527's `decideWriterFailure`). Measured on a real
/// encoder with `helper/test/fragmented-writer` (2026-10-16): a 2.137 s sample
/// writes, a 2.157 s one does not, and at a 10 MHz timescale a 165 s gap writes
/// fine. STC-448 saw the same failure on CI and could not say why.
///
/// Capture is VFR (Capture.swift's header): ScreenCaptureKit sends no complete
/// frame while nothing on screen changes, and nothing is written. A screen
/// saver, a locked screen or a truly static screen is therefore a gap, and the
/// first frame after it was the one that killed the take: both real takes
/// that stopped as `error` on 2026-10-16 died the instant a screen saver ended.
///
/// The fix keeps the timescale and never lets a gap grow that long. Once the
/// newest written frame is `HOLD_FRAME_DUE_NS` old, the same pixels are
/// written again at `HOLD_FRAME_INTERVAL_NS` after it. That frame was already
/// on screen for that whole time, so the export (which holds the newest frame
/// at or before `t`, never interpolates) draws the same picture either way.
/// The cost is one more frame per second of stillness, which compresses to
/// almost nothing.
///
/// A hold is written during a pause too (STC-240). A pause dropped frames and
/// left the same gap, so a pause over 2.147 s killed the take on resume in
/// exactly this way. A held frame inside a paused span repeats a frame from
/// BEFORE the pause, never anything recorded during it, and STC-240 PR B's
/// export cut removes the span whatever it holds.

/// The longest sample the display writer can store, in its 1 ns timescale.
let WRITER_MAX_SAMPLE_DURATION_NS: Int64 = 1 << 31

/// A held frame goes this far after the newest written one, so no sample in
/// the file is ever longer than this (plus one frame interval at the seam
/// where real frames resume). Half the limit: room for the timer's own
/// lateness and a loaded queue, and still a frame a second, not sixty.
let HOLD_FRAME_INTERVAL_NS: Int64 = 1_000_000_000

/// How old the newest written frame must be, by the session clock, before a
/// hold is written. Later than `HOLD_FRAME_INTERVAL_NS` on purpose: a real
/// frame's PTS is its display time (~7 ms ahead of delivery), and the hold
/// must sit BEFORE any real frame still on its way, or that frame becomes
/// non-monotonic and is dropped. Half a second is far beyond any delivery
/// delay ScreenCaptureKit has shown, and the hold still lands with 0.6 s of
/// margin under the limit.
let HOLD_FRAME_DUE_NS: Int64 = 1_500_000_000

/// How often the hold timer looks. A quarter of the margin above, so a hold is
/// never more than this late.
let HOLD_FRAME_CHECK_INTERVAL_SECONDS: Double = 0.25

/// When to write the last frame again, if now.
///
/// - `lastWrittenPtsNs`: PTS of the newest frame that went into the file; -1
///   before the first. Nothing is held before the first frame: there are no
///   pixels to hold, and the start gap is an empty edit, not a sample.
/// - `lastAcceptedPtsNs`: the frame path's `lastPtsNs`, the newest PTS handed
///   to the writer, written or not. A hold must be after it, or the writer
///   would get a PTS that goes backwards.
/// - `nowNs`: the session clock, the same clock as both PTS values.
///
/// Returns the hold's PTS, or nil for "not yet".
func decideHoldFrame(lastWrittenPtsNs: Int64, lastAcceptedPtsNs: Int64, nowNs: Int64) -> Int64? {
    guard lastWrittenPtsNs >= 0 else { return nil }
    guard nowNs - lastWrittenPtsNs >= HOLD_FRAME_DUE_NS else { return nil }
    let pts = max(lastWrittenPtsNs + HOLD_FRAME_INTERVAL_NS, lastAcceptedPtsNs + 1)
    // Frames the writer refused since the last written one pushed the next
    // PTS past where a hold is safe from real frames still arriving. Wait;
    // the next pass decides again from whatever has gone in by then.
    guard nowNs - pts >= HOLD_FRAME_DUE_NS - HOLD_FRAME_INTERVAL_NS else { return nil }
    return pts
}

/// `STC_CAPTURE_FAULT=screen-idle`: complete frames whose PTS falls in this
/// window are thrown away before anything sees them, as ScreenCaptureKit sends
/// none while the screen is still. Relative to the take's first written frame,
/// like `encoder-stall`. Five seconds: well past the 2.147 s limit, and past
/// the 3 and 5 s gaps STC-448 recorded failing.
let SCREEN_IDLE_FAULT_AFTER_NS: Int64 = 1_000_000_000
let SCREEN_IDLE_FAULT_DURATION_NS: Int64 = 5_000_000_000

func screenIdleFaultCovers(ptsNs: Int64, firstFramePtsNs: Int64) -> Bool {
    guard firstFramePtsNs >= 0 else { return false }
    let start = firstFramePtsNs + SCREEN_IDLE_FAULT_AFTER_NS
    return ptsNs >= start && ptsNs < start + SCREEN_IDLE_FAULT_DURATION_NS
}
