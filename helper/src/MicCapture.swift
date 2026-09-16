import Foundation
import AVFoundation

enum MicError: Error, CustomStringConvertible {
    case notAuthorized(AVAuthorizationStatus)
    case deviceNotFound(uid: String, available: [String])
    case formatUnavailable
    case deviceInputFailed(Error)
    case sessionRefusedInput
    case writerFailed(Error?)

    var description: String {
        switch self {
        case .notAuthorized(let s): return "microphone access is \(s.rawValue), not authorized"
        case .deviceNotFound(let uid, let available):
            let list = available.isEmpty ? "(none)" : available.joined(separator: ", ")
            return "no microphone with uid \(uid) — available: \(list)"
        case .formatUnavailable: return "the chosen microphone reports no active audio format"
        case .deviceInputFailed(let e): return "failed to create a capture input for the microphone: \(e)"
        case .sessionRefusedInput: return "the capture session refused the microphone input"
        case .writerFailed(let e): return "mic writer failed: \(String(describing: e))"
        }
    }

    var code: String {
        switch self {
        case .notAuthorized: return "mic-not-authorized"
        case .deviceNotFound: return "mic-not-found"
        case .formatUnavailable: return "mic-format-unavailable"
        case .deviceInputFailed: return "mic-device-input-failed"
        case .sessionRefusedInput: return "mic-input-refused"
        case .writerFailed: return "mic-writer-failed"
        }
    }
}

/// Microphone capture for one session, writing mic.m4a beside display.mp4
/// (STC-233).
///
/// PTS is used AS-IS, the same rule `CameraCapture` follows and for the same
/// reason: `CMSampleBufferGetPresentationTimeStamp` is already mach host time.
/// A recording session-relative time is `pts_ns - t0Ns`, with no timebase
/// conversion. Measured camera<->mic offset on real hardware: +1.8 ms median —
/// small enough that no correction term belongs here; introducing one would be
/// fitting noise.
///
/// UNLIKE the camera, there is no "pick the best device" ranking
/// (`pickCamera`). The settled decision (phase 0) is that this app must never
/// take the default audio input, or any input, without the user having named
/// it explicitly — auto-grabbing a Bluetooth mic once stalled capture and
/// wedged CoreAudio system-wide. So `start()` takes the device's `uniqueID`
/// and looks it up exactly; an id that does not match anything currently
/// enumerable is a refusal (`mic-not-found`), never a fallback to whatever
/// AVFoundation would otherwise pick.
final class MicCapture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let dir: URL
    private let t0Ns: UInt64
    private let deviceUid: String
    private let queue = DispatchQueue(label: "stc.capture.mic")

    private var session: AVCaptureSession?
    private var writer: AVAssetWriter?
    private let gate = AudioWriterGate()
    private var deviceName = ""
    private var sampleRate: Double = 0
    private var channels = 0

    private let lock = NSLock()
    /// Mirrors `CameraCapture`'s own guard: never hand the writer a
    /// non-increasing timestamp, independent of what the gate does with it.
    private var monotonicGuardPtsNs: Int64 = -1
    /// first/last describe only samples the gate actually APPENDED — the same
    /// reason `CameraCapture` tracks its own counters instead of trusting what
    /// was merely offered.
    private var firstPtsNs: Int64 = -1
    private var lastPtsNs: Int64 = -1
    private var appended = 0

    /// Set by `stop()` so the liveness watchdog below cannot warn about a take
    /// that has already ended.
    private var stopped = false

    /// How long a mic may be RUNNING with zero samples before the user is told
    /// — the audio analogue of `CameraCapture.noFramesWarningSeconds` and the
    /// same STC-286 class of failure: a device that opens and reports its own
    /// name while silently delivering nothing looks exactly like success.
    static let noSamplesWarningSeconds: Double = 3

    init(dir: URL, t0Ns: UInt64, deviceUid: String) {
        self.dir = dir
        self.t0Ns = t0Ns
        self.deviceUid = deviceUid
    }

    func start() -> Result<String, Error> {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        guard status == .authorized else { return .failure(MicError.notAuthorized(status)) }

        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .externalUnknown],
            mediaType: .audio, position: .unspecified)
        // Exact uid match ONLY — see this type's header. No "first", no
        // ranking: the app already asked the user which mic, and this is
        // where that answer either matches something real or is refused.
        guard let device = discovery.devices.first(where: { $0.uniqueID == deviceUid }) else {
            let available = discovery.devices.map { $0.uniqueID }
            return .failure(MicError.deviceNotFound(uid: deviceUid, available: available))
        }
        guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(
            device.activeFormat.formatDescription)?.pointee else {
            return .failure(MicError.formatUnavailable)
        }
        lock.lock()
        deviceName = device.localizedName
        sampleRate = asbd.mSampleRate
        channels = Int(asbd.mChannelsPerFrame)
        lock.unlock()

        let s = AVCaptureSession()
        s.beginConfiguration()
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            s.commitConfiguration()
            return .failure(MicError.deviceInputFailed(error))
        }
        guard s.canAddInput(input) else {
            s.commitConfiguration()
            return .failure(MicError.sessionRefusedInput)
        }
        s.addInput(input)

        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: queue)
        guard s.canAddOutput(output) else {
            s.commitConfiguration()
            return .failure(MicError.sessionRefusedInput)
        }
        s.addOutput(output)
        s.commitConfiguration()

        do { try setupWriter() } catch { return .failure(error) }

        session = s
        s.startRunning()
        armNoSamplesWatchdog()
        return .success(deviceName)
    }

    /// Warns if the mic is running but has delivered nothing — the audio
    /// twin of `CameraCapture.armNoFramesWatchdog`, same reasoning: a device
    /// grabbed by another app, or one that vanished mid-open, looks identical
    /// to a healthy one until this fires.
    private func armNoSamplesWatchdog() {
        let device = { self.lock.lock(); defer { self.lock.unlock() }; return self.deviceName }()
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.noSamplesWarningSeconds) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let seen = self.appended
            let ended = self.stopped
            self.lock.unlock()
            guard !ended, seen == 0 else { return }
            IO.send("warning", ["code": "mic-no-frames",
                                "device": device,
                                "detail": "the microphone opened but has not delivered audio after "
                                        + "\(Int(Self.noSamplesWarningSeconds))s; this take will have "
                                        + "no mic track. Another app holding the device is the usual cause"])
        }
    }

    private func setupWriter() throws {
        let url = dir.appendingPathComponent("mic.m4a")
        try? FileManager.default.removeItem(at: url)
        let w = try AVAssetWriter(outputURL: url, fileType: .m4a)
        w.movieTimeScale = 90_000
        let inp = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: 128_000,
        ])
        inp.expectsMediaDataInRealTime = true
        // NOT `inp.mediaTimeScale = 1_000_000_000`, unlike Capture.swift's video
        // input. This line was copied from there verbatim and crashed the whole
        // helper on real hardware (2026-09-16): `mediaTimeScale` is a VIDEO-only
        // property — Apple documents it as applicable only to inputs whose media
        // type is video, since an audio input infers its own time scale from the
        // samples appended to it. Setting it on this audio input left the writer
        // unable to resolve a real backing helper for it
        // (`AVAssetWriterInputUnknownHelper`), and the very next property access
        // threw an uncaught NSException -> abort(), taking down the whole
        // process (camera+display included) rather than just failing the mic.
        // `retimed()` already stamps each sample buffer with an exact
        // nanosecond PTS before it reaches the gate, so the file's own sample
        // table is still exact regardless of the input's inferred time scale —
        // this property was never needed for audio the way it is for video.
        guard w.canAdd(inp) else { throw MicError.writerFailed(nil) }
        w.add(inp)
        guard w.startWriting() else { throw MicError.writerFailed(w.error) }
        w.startSession(atSourceTime: .zero)
        writer = w
        gate.install(input: inp)
    }

    /// Exact PTS in nanoseconds — identical rule to `CameraCapture.ptsNs`.
    static func ptsNs(_ pts: CMTime) -> Int64 {
        CMTimeConvertScale(pts, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value
    }

    /// A copy of `sb`, retimed to session-relative ns. An audio
    /// `AVAssetWriterInput` is appended a whole `CMSampleBuffer` with its own
    /// embedded timing — there is no separate `(buffer, time)` append the way
    /// the pixel-buffer adaptor takes, so making the file's own sample table
    /// session-relative (the same convention `display.mp4`/`camera.mp4` use)
    /// means retiming the buffer itself before it reaches the gate. A single
    /// `CMSampleTimingInfo` entry applied to a multi-sample buffer is the
    /// standard way to shift a whole buffer's timeline by a constant amount:
    /// CoreMedia derives every later sample's presentation time from the
    /// first one plus its duration.
    private static func retimed(_ sb: CMSampleBuffer, toNs relNs: Int64) -> CMSampleBuffer? {
        var timing = CMSampleTimingInfo(duration: CMSampleBufferGetDuration(sb),
                                        presentationTimeStamp: CMTime(value: relNs, timescale: 1_000_000_000),
                                        decodeTimeStamp: .invalid)
        var out: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: nil, sampleBuffer: sb, sampleTimingEntryCount: 1,
            sampleTimingArray: &timing, sampleBufferOut: &out)
        return status == noErr ? out : nil
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        autoreleasepool {
            let ptsNs = Self.ptsNs(CMSampleBufferGetPresentationTimeStamp(sb))
            let rel = ptsNs - Int64(t0Ns)
            guard rel >= 0 else { return }          // arrived before the session began

            lock.lock()
            if monotonicGuardPtsNs >= 0, rel <= monotonicGuardPtsNs {
                lock.unlock(); return               // non-monotonic: drop, never offered to the gate
            }
            monotonicGuardPtsNs = rel
            lock.unlock()

            guard let retimed = Self.retimed(sb, toNs: rel) else { return }
            let outcome = gate.append(retimed)
            guard outcome == .appended else { return }

            lock.lock()
            if firstPtsNs < 0 { firstPtsNs = rel }
            lastPtsNs = rel
            appended += 1
            lock.unlock()
        }
    }

    /// Stops and reports what was captured. Answers exactly once, and is
    /// bounded, the same shape as `CameraCapture.stop` and for the same
    /// reason: neither `stopRunning` nor `finishWriting` promises to call
    /// back.
    ///
    /// Strictly SHORTER than `CaptureSession.stopTimeoutSeconds`, mirroring
    /// `CameraCapture`'s own ordering rule — both optional subsystems tear
    /// down concurrently, entered into the SAME `DispatchGroup` as the
    /// display, and if either ran past the display's own backstop the display
    /// side would give up first and report `<reason>-timeout` for a
    /// subsystem that was about to answer cleanly. Asserted in
    /// helper/test/stop-bounds.test.ts alongside the camera's.
    static let stopTimeoutSeconds: Double = 10

    func stop(completion: @escaping (MicTrack?) -> Void) {
        lock.lock(); stopped = true; lock.unlock()
        let answered = NSLock()
        var done = false
        let finish: (MicTrack?) -> Void = { track in
            answered.lock()
            if done { answered.unlock(); return }
            done = true
            answered.unlock()
            completion(track)
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + Self.stopTimeoutSeconds) {
            finish(self.track())
        }

        session?.stopRunning()
        gate.closeAndMarkFinished()
        guard let w = writer else { finish(track()); return }
        w.finishWriting { finish(self.track()) }
    }

    private func track() -> MicTrack? {
        lock.lock(); defer { lock.unlock() }
        guard appended > 0, firstPtsNs >= 0, lastPtsNs >= firstPtsNs else { return nil }
        return MicTrack(present: true, device: deviceName,
                        sampleRate: Int(sampleRate.rounded()), channels: channels,
                        firstFramePtsNs: Int(firstPtsNs), lastFramePtsNs: Int(lastPtsNs))
    }
}
