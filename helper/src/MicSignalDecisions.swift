import Foundation

/// STC-528's pure decisions: how loud the mic is, when it counts as silent,
/// and which silent stretches are kept for the take's sidecar. No AVFoundation,
/// no device, no clock — tested by `helper/test/mic-signal/`.
///
/// Three rules, all from STC-505's spec (`docs/superpowers/specs/2026-10-12-
/// stc-505-failure-states-design.md`, state 4) and Patrick's approval of the
/// design on 2026-10-15:
///
/// 1. **A buffer is silent when its PEAK is under `silenceFloorDbfs`.** Peak, not
///    RMS: the question is "is anything arriving at all", and a single word in an
///    otherwise quiet buffer is signal. -60 dBFS is a guess, to be tuned on a
///    real narration take (`docs/STC-528-RUNBOOK.md`). A mic whose input volume
///    is zero, or that is muted, delivers exact zeros and is far under it.
/// 2. **A span is kept only once it has lasted `silentSpanMinNs` (10 s).** It
///    STARTS where the silence started, not where the threshold was crossed, so
///    the library can say "No mic signal from 1:10 to 4:30" and mean 1:10. A
///    shorter quiet stretch (a breath, a pause to think) is not a span at all.
/// 3. **Paused time is never silence.** A pause closes an open span at the
///    pause's own start, and nothing delivered while paused can open one. A
///    take paused for a minute with the mic live would otherwise read as a
///    minute with no signal, which is wrong in the one way that matters: the
///    user turned it off on purpose.
///
/// The live reading (`MicLevelReading`) is throttled here too, by PTS rather
/// than by wall clock, so the rate is a test rather than a hope about timer
/// scheduling. It is sent on the LOSSY channel only (`IO.stat`), never `IO.send`:
/// a meter that drops a reading is a meter; a capture callback that blocks on a
/// stalled consumer is a lost take.
enum MicSignal {
    /// Rule 1's threshold, in dBFS.
    static let silenceFloorDbfs: Double = -60
    /// The same threshold as a linear peak — what a sample is compared to.
    static let silenceFloor: Float = Float(pow(10.0, silenceFloorDbfs / 20.0))
    /// Rule 2's duration: the pill's marker and the sidecar's span both wait this long.
    static let silentSpanMinNs: Int64 = 10_000_000_000
    /// At most 15 readings a second — a reading goes out on the first buffer at
    /// least this far past the last one, so 512-frame buffers give ~13 Hz. Fast
    /// enough that the bar reads as moving (the 500 ms heartbeat would not),
    /// slow enough to cost nothing.
    static let readingIntervalNs: Int64 = 66_666_667

    /// The largest |sample| in a buffer of float32 samples (the pinned mic
    /// format, STC-485). A NaN is ignored rather than allowed to poison the max.
    static func peak(_ samples: UnsafeBufferPointer<Float>) -> Float {
        var m: Float = 0
        for s in samples { let a = abs(s); if a > m { m = a } }
        return m
    }
}

/// One stretch of no mic signal, in session-relative ns (the timeline every
/// other anchors.json time uses). `endNs` is exclusive: the first moment there
/// was signal again, or the pause, or the end of the track.
struct SilentSpan: Equatable {
    let startNs: Int64
    let endNs: Int64
}

/// What the pill is told: the peak since the last reading (linear, 0...1) and
/// whether the mic has been silent for at least `silentSpanMinNs` right now.
struct MicLevelReading: Equatable {
    let peak: Float
    let silent: Bool
}

/// Folds every delivered mic buffer into the live reading and the take's spans.
/// A value, touched only on the mic's own serial queue.
struct MicSignalTracker {
    /// Closed spans that qualified, in order.
    private(set) var spans: [SilentSpan] = []
    /// Where the current silent stretch began, if one is open.
    private(set) var openStartNs: Int64?
    /// The end of the last buffer seen — where an open span closes if the track ends.
    private var lastEndNs: Int64 = -1
    /// Peak accumulated since the last reading.
    private var pendingPeak: Float = 0
    private var lastReadingNs: Int64?
    /// Once the track has ended, nothing more is recorded.
    private var ended = false

    /// Whether the open stretch has already lasted long enough to be a span —
    /// the pill's marker.
    var silent: Bool {
        guard let s = openStartNs else { return false }
        return lastEndNs - s >= MicSignal.silentSpanMinNs
    }

    /// One buffer. `endNs` is `ptsNs` plus the buffer's duration. Returns a
    /// reading when one is due.
    mutating func feed(ptsNs: Int64, endNs: Int64, peak: Float, paused: Bool) -> MicLevelReading? {
        guard !ended else { return nil }
        if paused {
            close(atNs: ptsNs)
        } else if peak < MicSignal.silenceFloor {
            if openStartNs == nil { openStartNs = ptsNs }
        } else {
            close(atNs: ptsNs)
        }
        lastEndNs = max(lastEndNs, endNs)
        // Paused audio reads as nothing on the meter: the take is not hearing it.
        let p = paused ? 0 : peak
        if !(p <= pendingPeak) { pendingPeak = p }    // also skips a NaN
        guard let last = lastReadingNs else {
            lastReadingNs = ptsNs
            return takeReading()
        }
        guard ptsNs - last >= MicSignal.readingIntervalNs else { return nil }
        lastReadingNs = ptsNs
        return takeReading()
    }

    /// The track ended before the take did (STC-237: disconnected, or STC-485's
    /// guard). An open span closes where the last buffer ended; nothing later counts.
    mutating func end() {
        guard !ended else { return }
        if lastEndNs >= 0 { close(atNs: lastEndNs) }
        ended = true
    }

    /// Every span, with a still-open one closed at the last buffer's end if it
    /// already qualifies. What the sidecar records, at stop and in
    /// `anchors.partial.json` alike — reading it never changes the tracker.
    func spansSoFar() -> [SilentSpan] {
        guard let s = openStartNs, lastEndNs - s >= MicSignal.silentSpanMinNs else { return spans }
        return spans + [SilentSpan(startNs: s, endNs: lastEndNs)]
    }

    private mutating func close(atNs ns: Int64) {
        guard let s = openStartNs else { return }
        openStartNs = nil
        if ns - s >= MicSignal.silentSpanMinNs { spans.append(SilentSpan(startNs: s, endNs: ns)) }
    }

    private mutating func takeReading() -> MicLevelReading {
        let r = MicLevelReading(peak: min(pendingPeak, 1), silent: silent)
        pendingPeak = 0
        return r
    }
}
