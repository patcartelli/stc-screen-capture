import Dispatch

/// Lets go of a timer source that lost the race to `stop()` before it was ever
/// resumed (STC-305 follow-up).
///
/// A `DispatchSource` is created SUSPENDED, and libdispatch traps when one is
/// released while still suspended, cancelled or not: SIGTRAP. So `cancel()`
/// alone is a crash the moment the local goes out of scope. Cancel first, so
/// the handler can never fire, then resume, so the release is legal. Measured
/// 2026-11-02 on macOS 27.2: a bare cancel exits 133, cancel + resume exits 0.
///
/// A stop landing during a start reached STC-527's disk watcher this way, and
/// the helper died before answering the start, which
/// `stop-during-start.grant.test.ts` read as a 5 s timeout.
/// `helper/test/timer-discard.test.ts` runs both cases and refuses a bare
/// `t.cancel()` anywhere in `helper/src`.
func discardUnresumedTimer(_ t: DispatchSourceTimer) {
    t.cancel()
    t.resume()
}
