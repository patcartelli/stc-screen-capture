import Foundation
import AVFoundation
import ScreenCaptureKit

enum SystemAudioError: Error, CustomStringConvertible {
    case writerFailed(Error?)
    case outputRefused(Error)
    case streamFailed(Error)

    var description: String {
        switch self {
        case .writerFailed(let e): return "system audio writer failed: \(String(describing: e))"
        case .outputRefused(let e): return "the audio stream refused an output: \(e)"
        case .streamFailed(let e): return "the audio stream failed to start: \(e)"
        }
    }

    var code: String {
        switch self {
        case .writerFailed: return "system-audio-writer-failed"
        case .outputRefused: return "system-audio-output-refused"
        case .streamFailed: return "system-audio-stream-failed"
        }
    }
}

/// What the machine is PLAYING, written to system.m4a beside display.mp4 and
/// mic.m4a (STC-418). A second audio track, independent of the mic, never
/// mixed into it here — mixing is export's job, weighted by the project's
/// `systemAudioLevel` (project-9).
///
/// ## Its own SCStream, not the video stream's
///
/// ScreenCaptureKit filters audio by APPLICATION, the same way it filters
/// pixels: a window-scope take's `SCContentFilter(desktopIndependentWindow:)`
/// would carry only the audio of the app that owns that window. Patrick's
/// decision (2026-09-24) is that system audio means the whole machine
/// whatever the take's scope, so this is a dedicated stream with a
/// whole-display filter excluding nothing, for every scope — one code path,
/// one behaviour. Its video is the smallest SCK will produce (2x2 at 1 fps)
/// and is discarded; the `.screen` output is still ADDED so SCK does not log
/// a dropped frame for every one it produces with nowhere to send it.
///
/// ## Everything else is `MicCapture`'s rule, unchanged
///
/// Session-relative PTS (`pts_ns - t0Ns`), a monotonic guard ahead of the
/// gate, the pause gate honoured before the writer (a paused take must not
/// record what the machine was playing either — the same privacy property
/// the mic's own comment names), `MicCapture.retimed` so the file's own
/// sample table is session-relative, first/last from APPENDED samples only,
/// and a bounded stop that answers exactly once.
///
/// No "no samples" watchdog, unlike `MicCapture.noSamplesWarningSeconds` —
/// deliberately (Patrick, 2026-09-25): SCK may deliver no audio buffers at
/// all while nothing is playing, and a 3 s warning would then fire on every
/// quiet take. `docs/STC-418-RUNBOOK.md` asks the Mac run to settle whether
/// silence arrives as buffers or as nothing.
final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    /// 48 kHz stereo — asked of SCK explicitly rather than taken from its
    /// default, so the AAC writer below is configured for exactly what will
    /// be delivered and `anchors.system` records a value this code chose.
    static let sampleRate = 48_000
    static let channelCount = 2

    private let dir: URL
    private let t0Ns: UInt64
    private let pauseGate: PauseGate
    private let audioQueue = DispatchQueue(label: "stc.capture.system-audio")
    private let screenQueue = DispatchQueue(label: "stc.capture.system-audio.screen")

    private let gate = AudioWriterGate()

    private let lock = NSLock()
    /// Written once, in `start` under `lock`; read by `stop` under it.
    private var writer: AVAssetWriter?
    private var stream: SCStream?
    /// True once `startCapture` has answered success AND no stop had begun by
    /// then. `stop()` reads it to decide whether there is a running stream to
    /// stop at all — `stopCapture` on a stream that never started need not
    /// call back, and this path's backstop would then be the only answer.
    private var running = false
    private var stopped = false
    private var monotonicGuardPtsNs: Int64 = -1
    private var firstPtsNs: Int64 = -1
    private var lastPtsNs: Int64 = -1
    private var appended = 0

    /// Called if the stream dies mid-take (`didStopWithError`). The take goes
    /// on without system audio from that point — this is an optional
    /// subsystem, and the VIDEO stream's own death is what ends a take.
    var onStreamDied: ((Error) -> Void)?

    init(dir: URL, t0Ns: UInt64, pauseGate: PauseGate) {
        self.dir = dir
        self.t0Ns = t0Ns
        self.pauseGate = pauseGate
    }

    /// Answers at most once: nil once the stream is capturing, or why it is
    /// not — and not at all if `stop()` got in first, since there is then
    /// nothing to report. Never waits on `startCapture`'s completion
    /// (CORRECTNESS-TRAPS: it dispatches to ScreenCaptureKit's own queue, and
    /// a wait there deadlocks against itself).
    ///
    /// The writer and the stream are built UNDER `lock`, the lock `stop()`
    /// sets `stopped` under. Without that, a stop landing mid-setup reads
    /// `writer` as nil, answers, and leaves a started writer nothing will ever
    /// finish. Setup is a file create and two object inits — nothing else is
    /// waiting on this lock yet, and a `stop()` that has to wait for it waits
    /// milliseconds.
    func start(display: SCDisplay, completion: @escaping (Error?) -> Void) {
        lock.lock()
        if stopped { lock.unlock(); return }
        do { try setupWriter() } catch { lock.unlock(); completion(error); return }

        let cfg = SCStreamConfiguration()
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.showsCursor = false
        cfg.capturesAudio = true
        cfg.sampleRate = Self.sampleRate
        cfg.channelCount = Self.channelCount
        // The helper plays nothing, so this changes nothing today — it is the
        // honest statement that this file is what OTHER processes played.
        cfg.excludesCurrentProcessAudio = true

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        do {
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: screenQueue)
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        } catch {
            lock.unlock()
            completion(SystemAudioError.outputRefused(error))
            return
        }
        stream = s
        lock.unlock()

        s.startCapture { [weak self] err in
            guard let self else { return }
            if let err {
                completion(SystemAudioError.streamFailed(err))
                return
            }
            self.lock.lock()
            let stopAlready = self.stopped
            self.running = !stopAlready
            self.lock.unlock()
            // A stop() that arrived while this start was in flight found
            // nothing running and closed the writer itself; the stream that
            // has only now come up is this path's to stop — and there is
            // nothing to announce.
            if stopAlready { s.stopCapture { _ in }; return }
            completion(nil)
        }
    }

    private func setupWriter() throws {
        let url = dir.appendingPathComponent("system.m4a")
        try? FileManager.default.removeItem(at: url)
        let w = try AVAssetWriter(outputURL: url, fileType: .m4a)
        w.movieTimeScale = 90_000
        // STC-394, same as mic.m4a and display.mp4 — see
        // `movieFragmentIntervalSec` (CaptureDecisions.swift).
        w.movieFragmentInterval = CMTime(seconds: movieFragmentIntervalSec, preferredTimescale: 1)
        let inp = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: Self.sampleRate,
            AVNumberOfChannelsKey: Self.channelCount,
            AVEncoderBitRateKey: 192_000,
        ])
        inp.expectsMediaDataInRealTime = true
        // NO `mediaTimeScale` — it is video-only, and setting it on an audio
        // input crashed the whole helper once (see MicCapture.setupWriter).
        guard w.canAdd(inp) else { throw SystemAudioError.writerFailed(nil) }
        w.add(inp)
        guard w.startWriting() else { throw SystemAudioError.writerFailed(w.error) }
        w.startSession(atSourceTime: .zero)
        writer = w
        gate.install(input: inp)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        // The 2x2 video exists only because SCK produces it; it is dropped
        // here, unexamined.
        guard type == .audio else { return }
        autoreleasepool {
            guard CMSampleBufferIsValid(sb), CMSampleBufferGetNumSamples(sb) > 0 else { return }
            let ptsNs = MicCapture.ptsNs(CMSampleBufferGetPresentationTimeStamp(sb))
            let rel = ptsNs - Int64(t0Ns)
            guard rel >= 0 else { return }          // arrived before the session began

            lock.lock()
            if monotonicGuardPtsNs >= 0, rel <= monotonicGuardPtsNs {
                lock.unlock(); return               // non-monotonic: drop, never offered to the gate
            }
            monotonicGuardPtsNs = rel
            lock.unlock()

            if pauseGate.isPaused(atNs: rel) { return }

            guard let retimed = MicCapture.retimed(sb, toNs: rel) else { return }
            guard gate.append(retimed) == .appended else { return }

            lock.lock()
            if firstPtsNs < 0 { firstPtsNs = rel }
            lastPtsNs = rel
            appended += 1
            lock.unlock()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        let wasRunning = running
        running = false
        let ended = stopped
        lock.unlock()
        // A stop we asked for is not a death.
        guard wasRunning, !ended else { return }
        onStreamDied?(error)
    }

    /// Strictly SHORTER than `CaptureSession.stopTimeoutSeconds`, for the
    /// reason `MicCapture.stopTimeoutSeconds` gives: this teardown is entered
    /// into the same DispatchGroup as the display's, and a longer one would
    /// make the display side report `<reason>-timeout` for a subsystem that
    /// was about to answer cleanly. Asserted in helper/test/stop-bounds.test.ts.
    static let stopTimeoutSeconds: Double = 10

    func stop(completion: @escaping (SystemAudioTrack?) -> Void) {
        lock.lock()
        stopped = true
        let s = running ? stream : nil
        running = false
        let w = writer
        lock.unlock()

        let answered = NSLock()
        var done = false
        let finish: (SystemAudioTrack?) -> Void = { track in
            answered.lock()
            if done { answered.unlock(); return }
            done = true
            answered.unlock()
            completion(track)
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + Self.stopTimeoutSeconds) {
            finish(self.track())
        }

        // Stop the stream FIRST, then close the gate: `closeAndMarkFinished`
        // waits out any in-flight append (STC-254), and finishWriting must not
        // race one.
        let closeWriter: () -> Void = { [self] in
            gate.closeAndMarkFinished()
            guard let w else { finish(track()); return }
            w.finishWriting { finish(self.track()) }
        }
        if let s {
            s.stopCapture { _ in closeWriter() }
        } else {
            closeWriter()
        }
    }

    private func track() -> SystemAudioTrack? {
        lock.lock(); defer { lock.unlock() }
        guard appended > 0, firstPtsNs >= 0, lastPtsNs >= firstPtsNs else { return nil }
        return SystemAudioTrack(present: true,
                                sampleRate: Self.sampleRate, channels: Self.channelCount,
                                firstFramePtsNs: Int(firstPtsNs), lastFramePtsNs: Int(lastPtsNs))
    }
}
