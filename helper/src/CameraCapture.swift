import Foundation
import AVFoundation

enum CameraError: Error, CustomStringConvertible {
    case noDevice
    case notAuthorized(AVAuthorizationStatus)
    /// STC-414: the app already showed the user a `uniqueID` in a picker and
    /// this one is gone — the camera's own version of `MicError.deviceNotFound`.
    /// Only reachable when a `deviceUid` was actually passed to `start()`;
    /// with none, `pickCamera`'s ranking is used unchanged and this case never
    /// fires.
    case deviceNotFound(uid: String, available: [String])
    case deviceInputFailed(Error)
    case sessionRefusedInput
    case writerFailed(Error?)

    var description: String {
        switch self {
        case .noDevice: return "no camera device is available"
        case .notAuthorized(let s): return "camera access is \(s.rawValue), not authorized"
        case .deviceNotFound(let uid, let available):
            let list = available.isEmpty ? "(none)" : available.joined(separator: ", ")
            return "no camera with uid \(uid) — available: \(list)"
        case .deviceInputFailed(let e): return "failed to create a capture input for the camera device: \(e)"
        case .sessionRefusedInput: return "the capture session refused the camera input"
        case .writerFailed(let e): return "camera writer failed: \(String(describing: e))"
        }
    }

    var code: String {
        switch self {
        case .noDevice: return "camera-no-device"
        case .notAuthorized: return "camera-not-authorized"
        case .deviceNotFound: return "camera-not-found"
        case .deviceInputFailed: return "camera-device-input-failed"
        case .sessionRefusedInput: return "camera-input-refused"
        case .writerFailed: return "camera-writer-failed"
        }
    }
}

/// Camera capture for one session, writing camera.mp4 beside display.mp4.
///
/// PTS is used AS-IS. CMSampleBufferGetPresentationTimeStamp is already mach
/// host time and already latency-compensated (phase 0 measured 91.5 ms and
/// 115.8 ms on two runs of the same hardware). Session-relative time is
/// `pts_ns - t0Ns`, with no *timebase* conversion — the same rule as
/// CGEvent.timestamp. Converting the display-track's mach-tick timebase here
/// would desync the PiP silently. The PTS's own `CMTime` still needs its
/// scale normalized to nanoseconds before `.value` means nanoseconds; that is
/// done with `CMTimeConvertScale`, which is exact integer rescaling, not a
/// unit conversion — no `Double` involved (see `ptsNs(_:)` below).
final class CameraCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let dir: URL
    private let t0Ns: UInt64
    private let queue = DispatchQueue(label: "stc.capture.camera")

    /// The take's pause gate (STC-240) — not a copy of its state. A camera
    /// frame written during a pause would be carried into the cut: the first
    /// frame after a resume selects the newest camera frame at or before it,
    /// which would be one from inside the paused span.
    private let pauseGate: PauseGate

    private var session: AVCaptureSession?
    private var writer: AVAssetWriter?
    private let gate = WriterGate()
    private var deviceName = ""
    /// The uid of the device actually opened — distinct from `deviceUid`
    /// above, which is nil for the common "automatic" pick via `pickCamera`'s
    /// ranking (STC-414) and so cannot itself tell a live disconnect which
    /// physical device is running. Set once, alongside `deviceName`, under
    /// the same lock; `currentDeviceUid()` is `Capture.swift`'s only way to
    /// match a disconnect notification against the device this session
    /// actually resolved to rather than the request that opened it.
    private var resolvedDeviceUid = ""
    /// `start()`'s phase timings and the first frame's arrival, for `timings()`.
    /// Guarded by `lock`.
    private var openTimings: [String: Any] = [:]
    private var firstArrivalNs: Int64 = -1

    private let lock = NSLock()
    /// Last pts that passed the monotonic-ordering check, appended or not.
    /// Kept separate from `lastPtsNs` below: the writer must never be handed
    /// a non-increasing timestamp regardless of what the gate ends up doing
    /// with it, so this guards the ordering of everything offered to
    /// `gate.append`, not just what anchors.camera ends up describing.
    private var monotonicGuardPtsNs: Int64 = -1
    /// first/last/deltas describe only frames the gate actually APPENDED
    /// (see `captureOutput` below) — anchors.camera must not claim a track
    /// wider than camera.mp4 actually contains, which it would if the gate
    /// dropped the first or last received frame (e.g. during teardown).
    private var firstPtsNs: Int64 = -1
    private var lastPtsNs: Int64 = -1
    private var deltas: [Int64] = []
    private var appended = 0
    /// STC-530: called once, off the lock, when the first sample lands in the file —
    /// the moment this track's start time exists for `anchors.partial.json`. Set before
    /// `start()`; never changed after.
    var onFirstAppend: (() -> Void)?
    /// STC-562: called once, off the lock, when camera.mp4's writer goes `.failed`.
    /// Nothing else reads the writer's status, so without this a failed camera writer
    /// was silent: every later frame was refused and the take carried on. Set before
    /// `start()`; never changed after.
    var onWriterFailed: ((Error?) -> Void)?
    private var writerFailureReported = false

    /// STC-562: writes the last camera frame again while no new one arrives
    /// (`HoldFrameDecisions.swift`, the display's STC-561 rule). This input's
    /// timescale is 1 ns too, so a camera gap over 2^31 ns (a stall, or any pause,
    /// since `PauseGate` drops paused frames) failed this writer on the next frame.
    /// On `queue`, the queue every camera frame arrives on, so a hold and a real
    /// frame never reach the writer out of PTS order. Guarded by `lock`.
    private var holdTimer: DispatchSourceTimer?
    /// The newest frame in camera.mp4, real or held, and its PTS. NOT `lastPtsNs`:
    /// a held frame must not move `anchors.camera.lastFramePtsNs`, which ends the
    /// PiP (render.ts), or a camera that dies without a disconnect would show a
    /// frozen face to the end of the take. Guarded by `lock`. One buffer kept out
    /// of the output's pool, released at stop.
    private var lastWrittenBuffer: CVPixelBuffer?
    private var lastWrittenPtsNs: Int64 = -1
    private var framesHeld = 0
    /// `STC_CAPTURE_FAULT=camera-gap` (STC-562), read once. `camera-gap-unheld` is
    /// the same gap with the hold timer off: the grant test's control, and the bug.
    private let cameraGapFault = ["camera-gap", "camera-gap-unheld"]
        .contains(ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] ?? "")
    private let holdFramesOff = ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] == "camera-gap-unheld"

    /// STC-553: when the camera stalls after its first frame (`CameraStallDecisions.swift`).
    /// Fed every frame that ARRIVES, and checked every `CameraStall.checkIntervalSeconds`
    /// on `queue`. Guarded by `lock`.
    private var stall = CameraStallTracker()
    private var stallTimer: DispatchSourceTimer?
    /// Called off the lock when a stall begins or ends, so `anchors.partial.json` says
    /// it even if the helper dies mid-stall. Set before `start()`; never changed after.
    var onStallChanged: (() -> Void)?
    /// `STC_CAPTURE_FAULT=camera-stall` / `=camera-stall-end` (STC-553), read once.
    private let cameraStallFault = ["camera-stall", "camera-stall-end"]
        .contains(ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] ?? "")
    private let cameraStallForever = ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] == "camera-stall-end"

    /// Set by `stop()` so the liveness watchdog below cannot warn about a take
    /// that has already ended.
    private var stopped = false

    /// How long a camera may be RUNNING with zero frames before the user is
    /// told (STC-286).
    ///
    /// A camera that opens and then delivers nothing is the failure that looked
    /// exactly like success: `startRunning()` returns, the device reports itself
    /// started with a name, `camera.mp4` is created — and `captureOutput` is
    /// never called. Confirmed on real hardware 2026-08-31 with the laptop in
    /// clamshell: `camera-started device: "FaceTime HD Camera"`, a 0-byte
    /// camera.mp4, and `anchors.camera.present: false`. Not a failed open, and
    /// not the wrong device: `pickCamera` correctly chose the built-in over a
    /// virtual device and a Continuity camera.
    ///
    /// It is not only clamshell. A covered lens, a device grabbed by another
    /// app, or a Continuity camera that wanders off all look identical.
    ///
    /// Three seconds because frames follow `startRunning()` almost immediately
    /// — the ~1.4 s a viewer sees before the PiP appears is the OPEN, which has
    /// already happened by the time this is armed. Long enough not to race a
    /// slow first frame, short enough that the user learns during the take
    /// rather than after it.
    static let noFramesWarningSeconds: Double = 3

    static let width = 1280
    static let height = 720

    /// STC-414: a `uniqueID` the app already showed the user in a picker, or
    /// nil for "let `pickCamera` rank candidates" (unchanged behaviour). See
    /// `Settings.cameraDeviceUid`'s own doc comment (app/src/settings.ts) for
    /// why this nil means automatic where `MicCapture`'s nil means off.
    private let deviceUid: String?

    init(dir: URL, t0Ns: UInt64, pauseGate: PauseGate, deviceUid: String? = nil) {
        self.dir = dir
        self.t0Ns = t0Ns
        self.pauseGate = pauseGate
        self.deviceUid = deviceUid
    }

    /// Opens the device and builds a session around it (discovery, input,
    /// output, `commitConfiguration`), optionally running it. No delegate and no
    /// writer: those belong to a take, so the same open serves a warm-up
    /// (`CameraWarm.swift`) and a cold start alike.
    ///
    /// This is where the camera's lag behind the screen lives. Every phase is
    /// timed, because the lag was only ever seen as one number (the first frame
    /// 1.1 to 1.6 s after the display's) and nothing said which phase it was.
    static func openSession(deviceUid: String?, startRunning: Bool) -> Result<OpenedCamera, Error> {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        guard status == .authorized else { return .failure(CameraError.notAuthorized(status)) }

        let tStart = Clock.nowNs()
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .externalUnknown],
            mediaType: .video, position: .unspecified)
        let device: AVCaptureDevice
        if let deviceUid {
            // Exact uid match ONLY, the same rule MicCapture follows once a
            // device has been explicitly named: no ranking, no "first" —
            // the app already asked, and this is where that answer either
            // matches something real or is refused (STC-414).
            guard let d = discovery.devices.first(where: { $0.uniqueID == deviceUid }) else {
                let available = discovery.devices.map { $0.uniqueID }
                return .failure(CameraError.deviceNotFound(uid: deviceUid, available: available))
            }
            device = d
        } else {
            // NOT `.devices.first` — that is not a choice, it is whatever
            // AVFoundation returned first, and on 2026-08-29 that was
            // "Elgato Virtual Camera": ~1 fps with nothing behind it, so three
            // takes recorded 12 frames in 11 s beside a good display track and the
            // app reported success (STC-286). pickCamera ranks by transportType.
            let candidates = discovery.devices.map { (name: $0.localizedName, transportType: $0.transportType) }
            guard let choice = pickCamera(candidates),
                  let picked = discovery.devices.first(where: { $0.localizedName == choice.name })
            else { return .failure(CameraError.noDevice) }
            device = picked
            if choice.isVirtual {
                // Every candidate was virtual. Recording it beats refusing, but the
                // user must not discover a 1 fps PiP after the fact.
                // IO.send, not IO.stat: this must not be droppable. The lossy
                // channel exists so stats cannot back-pressure capture, and a
                // warning the user needs before they trust a take is not a stat.
                IO.send("warning", ["code": "virtual-camera-only",
                                    "device": choice.name,
                                    "detail": "the only camera available is a virtual device, which "
                                            + "may deliver very few frames; connect a physical camera "
                                            + "for a usable picture-in-picture"])
            }
        }
        let tDiscovered = Clock.nowNs()

        let s = AVCaptureSession()
        s.beginConfiguration()
        s.sessionPreset = .hd1280x720
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            s.commitConfiguration()
            return .failure(CameraError.deviceInputFailed(error))
        }
        guard s.canAddInput(input) else {
            s.commitConfiguration()
            return .failure(CameraError.sessionRefusedInput)
        }
        s.addInput(input)

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String:
                                kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        // Dropping a late camera frame is correct: the PiP holds the previous
        // one, exactly as the display track does across a VFR stall.
        output.alwaysDiscardsLateVideoFrames = true
        guard s.canAddOutput(output) else {
            s.commitConfiguration()
            return .failure(CameraError.sessionRefusedInput)
        }
        s.addOutput(output)
        s.commitConfiguration()
        let tConfigured = Clock.nowNs()

        var tRunning = tConfigured
        if startRunning {
            s.startRunning()
            tRunning = Clock.nowNs()
        }
        return .success(OpenedCamera(
            session: s, output: output, name: device.localizedName, uid: device.uniqueID,
            automatic: deviceUid == nil, running: startRunning,
            discoverMs: Int((tDiscovered - tStart) / 1_000_000),
            configureMs: Int((tConfigured - tDiscovered) / 1_000_000),
            startRunningMs: Int((tRunning - tConfigured) / 1_000_000)))
    }

    /// Starts the take's camera. `warm` is a session `CameraWarm.swift` opened
    /// before Record: adopted when it is the device this take would have picked
    /// (`decideWarmAdoption`), so its first frame is one frame interval away
    /// rather than a cold open. Anything else is stopped and opened fresh.
    func start(warm: OpenedCamera? = nil) -> Result<String, Error> {
        let tBegan = Clock.nowNs()
        let opened: OpenedCamera
        var adopted = false
        if let warm, decideWarmAdoption(requestedUid: deviceUid, warmUid: warm.uid, warmAutomatic: warm.automatic) {
            opened = warm
            adopted = true
        } else {
            warm?.session.stopRunning()
            switch Self.openSession(deviceUid: deviceUid, startRunning: false) {
            case .failure(let e): return .failure(e)
            case .success(let o): opened = o
            }
        }
        // Guarded by `lock`, same as the frame counters below: this runs on
        // the open queue (CaptureSession.startCameraAsync's background
        // queue) while `track()` reads it from the stop path, which can run
        // concurrently on a different queue.
        lock.lock(); deviceName = opened.name; resolvedDeviceUid = opened.uid; lock.unlock()

        // The writer BEFORE the delegate: a warm session is already producing
        // frames, and the first one to reach `captureOutput` needs somewhere to go.
        let tWriter0 = Clock.nowNs()
        do { try setupWriter() } catch {
            if adopted { opened.session.stopRunning() }
            return .failure(error)
        }
        let writerMs = Int((Clock.nowNs() - tWriter0) / 1_000_000)
        opened.output.setSampleBufferDelegate(self, queue: queue)

        session = opened.session
        var startRunningMs = opened.startRunningMs
        if !opened.running {
            let t = Clock.nowNs()
            opened.session.startRunning()
            startRunningMs = Int((Clock.nowNs() - t) / 1_000_000)
        }
        lock.lock()
        openTimings = ["warm": adopted,
                       "discoverMs": opened.discoverMs, "configureMs": opened.configureMs,
                       "startRunningMs": startRunningMs, "writerMs": writerMs,
                       "startMs": Int((Clock.nowNs() - tBegan) / 1_000_000)]
        lock.unlock()
        armNoFramesWatchdog()
        startHoldTimer()
        startStallTimer()
        return .success(deviceName)
    }

    /// Where the open's time went (`start()`), plus, once the first frame lands,
    /// when it ARRIVED (`Clock.nowNs() - t0Ns`) next to the PTS it carries.
    /// Arrival minus PTS is the device's pipeline latency; PTS is what anchors.json
    /// records, so the two together say whether the lag is the open or the pipeline.
    func timings() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var t = openTimings
        if firstArrivalNs >= 0 { t["firstFrameArrivalNs"] = Int(firstArrivalNs) }
        if firstPtsNs >= 0 { t["firstFramePtsNs"] = Int(firstPtsNs) }
        return t
    }

    /// The device this session actually resolved to, once `start()` has run —
    /// empty before then. See `resolvedDeviceUid`'s own comment for why this
    /// exists separately from the request.
    func currentDeviceUid() -> String {
        lock.lock(); defer { lock.unlock() }
        return resolvedDeviceUid
    }

    /// Warns if the camera is running but has delivered nothing (STC-286).
    ///
    /// A one-shot timer on a background queue: it must not sit on the open
    /// queue, and it must never touch the capture callback's path. It reads the
    /// same `appended` counter the frames increment, under the same lock.
    ///
    /// IO.send, not IO.stat. The lossy channel exists so stats cannot
    /// back-pressure capture; a warning that decides whether the user trusts a
    /// take is not a stat and must not be droppable — the same reasoning as
    /// `virtual-camera-only` above.
    private func armNoFramesWatchdog() {
        let device = { self.lock.lock(); defer { self.lock.unlock() }; return self.deviceName }()
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.noFramesWarningSeconds) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let seen = self.appended
            let ended = self.stopped
            self.lock.unlock()
            // Nothing to say about a take that already stopped, or one whose
            // camera is working.
            guard !ended, seen == 0 else { return }
            IO.send("warning", ["code": "camera-no-frames",
                                "device": device,
                                "detail": "the camera opened but has not delivered a frame after "
                                        + "\(Int(Self.noFramesWarningSeconds))s; this take will "
                                        + "have no picture-in-picture. A closed laptop lid, a "
                                        + "covered lens, or another app holding the camera all "
                                        + "look like this"])
        }
    }

    // MARK: STC-553 stall

    /// A timer on `queue`, like the hold timer, so a check and a frame's arrival never
    /// race. Runs whatever the hold timer does (`camera-gap-unheld` turns holds off,
    /// never this).
    private func startStallTimer() {
        if cameraStallFault {
            let ms = CAMERA_STALL_FAULT_AFTER_NS / 1_000_000
            let until = cameraStallForever ? "the end of the take" : "\((CAMERA_STALL_FAULT_AFTER_NS + CAMERA_STALL_FAULT_DURATION_NS) / 1_000_000) ms"
            IO.log("STC_CAPTURE_FAULT=\(cameraStallForever ? "camera-stall-end" : "camera-stall"): camera frames from \(ms) ms after the first to \(until) never arrive, as a stalled camera sends none")
        }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + CameraStall.checkIntervalSeconds, repeating: CameraStall.checkIntervalSeconds)
        t.setEventHandler { [weak self] in self?.checkStall() }
        lock.lock()
        if stopped { lock.unlock(); t.cancel(); return }
        stallTimer = t
        lock.unlock()
        t.resume()
    }

    private func checkStall() {
        let nowNs = Int64(Clock.nowNs()) - Int64(t0Ns)
        let pause = pauseGate.state()
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        let change = stall.check(nowNs: nowNs, pause: pause)
        let device = deviceName
        lock.unlock()
        report(change, device: device)
    }

    /// Says a stall that began (once per stall, rule 4) and records any change in the partial.
    private func report(_ change: CameraStallChange?, device: String) {
        guard let change else { return }
        if case .began(let span) = change {
            // IO.send, not IO.stat: like `camera-no-frames`, this decides whether the user
            // trusts the take. The app shows it on the pill, never as a toast (stop-copy.ts).
            IO.send("warning", ["code": "camera-stalled",
                                "device": device,
                                "tNs": Int(span.startNs),
                                "detail": "the camera has delivered no frame for "
                                        + "\(CameraStall.thresholdNs / 1_000_000_000)s; the take is "
                                        + "still recording and the picture-in-picture is hidden "
                                        + "until the camera comes back"])
        }
        onStallChanged?()
    }

    // MARK: STC-562 hold frames

    private func startHoldTimer() {
        if cameraGapFault {
            IO.log("STC_CAPTURE_FAULT=camera-gap\(holdFramesOff ? "-unheld" : ""): camera frames \(CAMERA_GAP_FAULT_AFTER_NS / 1_000_000)-\((CAMERA_GAP_FAULT_AFTER_NS + CAMERA_GAP_FAULT_DURATION_NS) / 1_000_000) ms after the first are withheld, as a stalled camera withholds them")
        }
        if holdFramesOff {
            IO.log("STC_CAPTURE_FAULT=camera-gap-unheld: no camera hold frames this take")
            return
        }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + HOLD_FRAME_CHECK_INTERVAL_SECONDS, repeating: HOLD_FRAME_CHECK_INTERVAL_SECONDS)
        t.setEventHandler { [weak self] in self?.holdIfStill() }
        lock.lock()
        if stopped { lock.unlock(); t.cancel(); return }
        holdTimer = t
        lock.unlock()
        t.resume()
    }

    /// On `queue`. Writes the newest camera frame again once it is too old for the
    /// writer (`decideHoldFrame`), paused or not. Through the same monotonic guard
    /// and `WriterGate` as a real frame, so ordering, teardown and a failed writer
    /// behave exactly as they do for one.
    private func holdIfStill() {
        let nowNs = Int64(Clock.nowNs()) - Int64(t0Ns)
        lock.lock()
        guard !stopped, !writerFailureReported, let pb = lastWrittenBuffer,
              let pts = decideHoldFrame(lastWrittenPtsNs: lastWrittenPtsNs,
                                        lastAcceptedPtsNs: monotonicGuardPtsNs, nowNs: nowNs)
        else { lock.unlock(); return }
        monotonicGuardPtsNs = pts
        lock.unlock()
        let outcome = gate.append(pb, at: CMTime(value: pts, timescale: 1_000_000_000))
        lock.lock()
        if outcome == .appended {
            framesHeld += 1
            lastWrittenPtsNs = pts
        }
        lock.unlock()
        if outcome != .appended { noteRefused() }
    }

    /// A frame the gate did not take. If that is because the writer has failed,
    /// say so, once (STC-562). A refusal during teardown or from a writer that is
    /// only busy is not a failure and says nothing.
    private func noteRefused() {
        guard let w = writer, w.status == .failed else { return }
        lock.lock()
        let first = !writerFailureReported && !stopped
        writerFailureReported = true
        lock.unlock()
        if first { onWriterFailed?(w.error) }
    }

    /// Held frames written so far (STC-562), for the stats heartbeat and the stop reply.
    func heldFrames() -> Int {
        lock.lock(); defer { lock.unlock() }
        return framesHeld
    }

    private func setupWriter() throws {
        let url = dir.appendingPathComponent("camera.mp4")
        try? FileManager.default.removeItem(at: url)
        let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
        w.movieTimeScale = 90_000
        // STC-394: matches display.mp4's own writer — see
        // `movieFragmentIntervalSec`'s comment (CaptureDecisions.swift).
        w.movieFragmentInterval = CMTime(seconds: movieFragmentIntervalSec, preferredTimescale: 1)
        let inp = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Self.width,
            AVVideoHeightKey: Self.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 8_000_000,
                AVVideoMaxKeyFrameIntervalKey: 60,
                AVVideoExpectedSourceFrameRateKey: 60,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any],
        ])
        inp.expectsMediaDataInRealTime = true
        inp.mediaTimeScale = 1_000_000_000
        let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp,
                                                      sourcePixelBufferAttributes: nil)
        guard w.canAdd(inp) else { throw CameraError.writerFailed(nil) }
        w.add(inp)
        guard w.startWriting() else { throw CameraError.writerFailed(w.error) }
        w.startSession(atSourceTime: .zero)
        writer = w
        gate.install(input: inp, adaptor: ad)
    }

    /// Exact PTS in nanoseconds, as pure integer arithmetic — no `Double`.
    /// SPACE: `CMTime` → session ns (`- t0Ns` at the call site). No timebase
    /// is involved — see `transform/src/spaces.ts` for the whole vocabulary.
    ///
    /// `CMTimeConvertScale` rescales the `CMTime`'s existing timescale to
    /// 1_000_000_000 (often a no-op: capture buffers commonly already carry
    /// a nanosecond timescale), and the result's `.value` IS the nanosecond
    /// count. `.roundHalfAwayFromZero` only matters on the rare timescale
    /// that doesn't divide evenly into 1e9.
    static func ptsNs(_ pts: CMTime) -> Int64 {
        CMTimeConvertScale(pts, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        autoreleasepool {
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
            // Already mach host time, already latency-compensated. Do not convert
            // the timebase — only rescale the CMTime to a nanosecond timescale,
            // exactly, in integer arithmetic (see Self.ptsNs).
            let ptsNs = Self.ptsNs(CMSampleBufferGetPresentationTimeStamp(sb))
            let rel = ptsNs - Int64(t0Ns)
            guard rel >= 0 else { return }          // arrived before the session began

            lock.lock()
            // STC-562's fault: the frames a stalled camera would not have sent.
            // Upstream of everything, as a camera's silence is.
            // STC-553's are the same, for a stall that is said.
            let withheld = cameraGapFault && cameraGapFaultCovers(ptsNs: rel, firstFramePtsNs: firstPtsNs)
                || cameraStallFault && cameraStallFaultCovers(ptsNs: rel, firstFramePtsNs: firstPtsNs,
                                                              forever: cameraStallForever)
            lock.unlock()
            if withheld { return }
            // STC-553: the camera is alive. Stamped on ARRIVAL, before the pause gate, the
            // ordering guard and the writer, none of which says anything about the camera.
            let pause = pauseGate.state()
            lock.lock()
            let stallChange = stall.frameArrived(nowNs: Int64(Clock.nowNs()) - Int64(t0Ns), ptsNs: rel, pause: pause)
            let stallDevice = deviceName
            lock.unlock()
            report(stallChange, device: stallDevice)
            // Paused BEFORE the ordering guard (STC-562): the guard is the newest
            // PTS offered to the writer, which a hold must come after. A paused
            // frame is never offered, and counting it there would push every hold
            // past `decideHoldFrame`'s safety margin, so a pause would write none
            // and the first frame after it would fail the writer. Outside `lock`,
            // as it always was: PauseGate has its own.
            if pauseGate.isPaused(atNs: rel) { return }

            lock.lock()
            if monotonicGuardPtsNs >= 0, rel <= monotonicGuardPtsNs {
                lock.unlock(); return               // non-monotonic: drop, never offered to the gate
            }
            monotonicGuardPtsNs = rel
            lock.unlock()

            let outcome = gate.append(pb, at: CMTime(value: rel, timescale: 1_000_000_000))
            guard outcome == .appended else { noteRefused(); return }

            // Only record what actually landed in camera.mp4 — a frame the
            // gate dropped (teardown racing the last append) must not widen
            // anchors.camera past the real track.
            lock.lock()
            if lastPtsNs >= 0 { deltas.append(rel - lastPtsNs) }
            let first = firstPtsNs < 0
            if first { firstPtsNs = rel; firstArrivalNs = Int64(Clock.nowNs()) - Int64(t0Ns) }
            lastPtsNs = rel
            appended += 1
            // STC-562: what a hold repeats, and when from.
            lastWrittenPtsNs = rel
            lastWrittenBuffer = pb
            lock.unlock()
            if first { onFirstAppend?() }
        }
    }

    /// Stops and reports what was captured. Answers exactly once, and is bounded:
    /// neither stopRunning nor finishWriting promises to call back.
    /// How long the camera teardown gets before `stop` answers anyway.
    ///
    /// Strictly SHORTER than `CaptureSession.stopTimeoutSeconds`, and that
    /// ordering is load-bearing rather than incidental: CaptureSession.stop()
    /// waits on a DispatchGroup this teardown is entered into, so if this
    /// backstop were the later one the display side would give up first and
    /// answer `<reason>-timeout` with a stopWarning for a camera that was about
    /// to report normally. Asserted in helper/test/stop-bounds.test.ts.
    static let stopTimeoutSeconds: Double = 10

    func stop(completion: @escaping (CameraTrack?) -> Void) {
        lock.lock()
        stopped = true
        let hold = holdTimer
        holdTimer = nil
        let stallCheck = stallTimer
        stallTimer = nil
        lastWrittenBuffer = nil
        lock.unlock()
        hold?.cancel()
        stallCheck?.cancel()
        let answered = NSLock()
        var done = false
        let finish: (CameraTrack?) -> Void = { track in
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

    /// Frames that landed in camera.mp4 so far, for the stats heartbeat (STC-539).
    /// `anchors.partial.json` is rewritten at the camera's FIRST frame and not
    /// after, so it cannot say whether frames kept arriving; this can.
    func appendedFrames() -> Int {
        lock.lock(); defer { lock.unlock() }
        return appended
    }

    /// Also read live by CaptureSession for anchors.partial.json (STC-530); takes the lock.
    func track() -> CameraTrack? {
        lock.lock(); defer { lock.unlock() }
        guard appended > 0, firstPtsNs >= 0, lastPtsNs >= firstPtsNs else { return nil }
        return CameraTrack(present: true, device: deviceName,
                           width: Self.width, height: Self.height,
                           firstFramePtsNs: Int(firstPtsNs),
                           lastFramePtsNs: Int(lastPtsNs),
                           frameIntervalNs: Int(medianDelta()),
                           stalledSpans: stall.spansSoFar())
    }

    /// Median, not mean: a single long stall would drag a mean upward and
    /// stretch the PiP's track end past where frames actually stopped.
    private func medianDelta() -> Int64 {
        if deltas.isEmpty { return 16_666_667 }
        let s = deltas.sorted()
        return s[s.count / 2]
    }
}
