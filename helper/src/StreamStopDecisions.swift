/// Why a live display stream died, as a `stop.reason` (STC-531).
///
/// Turning Screen Recording off for Capture mid-take ends the stream through
/// `didStopWithError`, the same door any other dead stream uses (confirmed on
/// hardware by Patrick, 2026-10-14: the take stops and reaches the panel). Before
/// this, every such stop was `stream-stopped`, so the panel could not say what
/// happened or offer System Settings.
///
/// Two signals, either one enough:
/// - `screenRecordingGranted`: `CGPreflightScreenCaptureAccess()` read at the
///   moment of the death. A revoke is what flips it; any other death leaves it true.
/// - `userDeclined`: the error is ScreenCaptureKit's own `userDeclined` (-3801),
///   the code the ungranted path answers with (PHASE-0 §6).
///
/// Which of the two a real revoke actually produces is the runbook's question
/// (`docs/STC-531-RUNBOOK.md` §1): the `stream-stopped` warning carries the error,
/// and the stop reason says which way it was classified.
///
/// Pure: no ScreenCaptureKit, no CoreGraphics. Tested by helper/test/stream-stop/.
enum StreamStopDecision: Equatable { case stop(String) }

func decideStreamStop(screenRecordingGranted: Bool, userDeclined: Bool) -> StreamStopDecision {
    if !screenRecordingGranted || userDeclined { return .stop("screen-recording-revoked") }
    return .stop("stream-stopped")
}
