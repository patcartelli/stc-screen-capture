import Foundation
import ScreenCaptureKit
import CoreGraphics
// AVFoundation here is AVAssetWriter only — a file writer, no capture devices.
// PHASE-0 §2a's hazard was AVCaptureDevice taking the default audio input;
// phase 1 has no camera or mic, and nothing below opens a device.
import AVFoundation

/// Display + cursor capture for one session.
///
/// VFR by construction (PHASE-0 §4): a complete frame becomes exactly one
/// sample at its own displayTime; idle/blank frames produce nothing. The
/// rejected alternative — repeat-filling to a CFR grid during capture — spent
/// 82% of a loaded encoder on duplicates and dropped 60% of real content.
///
/// Every time written here is session-relative integer nanoseconds, so
/// display.mp4's sample table and events.json share one origin and the
/// transform can consume both without a correction term.
final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    let dir: URL
    let t0Ns: UInt64

    private var stream: SCStream?
    private var writer: AVAssetWriter?
    /// Optional subsystem: nil unless `start` was asked for a camera AND it
    /// actually opened. A missing/denied/busy camera leaves this nil and the
    /// take display-only — see the warning path in `start`.
    ///
    /// Guarded by `lock`, same as `events` and the frame counters below —
    /// NOT a bare `var`. The camera opens on a background queue (see
    /// `startCameraAsync`) while `stop()` can arrive on a different queue at
    /// any time, including before the camera has finished opening. Without a
    /// lock, `stop()` can observe `camera == nil`, skip teardown entirely, and
    /// then have the background open assign into `camera` afterward — nothing
    /// ever stops that instance, so the AVCaptureSession (and its LED) runs
    /// for the rest of the process's life. `stoppingBegan` closes the other
    /// half of the race: it tells a camera that finishes opening AFTER stop()
    /// has already run that it must stop itself immediately rather than be
    /// stored.
    private var camera: CameraCapture?
    private var cameraTrack: CameraTrack?
    /// Set once, in `begin`, from `start`'s own argument. `writeSidecars` reads
    /// it to decide whether anchors.json's `camera` block is written at all
    /// (STC-303) — camera==nil is ambiguous between "never asked" and "asked,
    /// got nothing", and only this flag tells the two apart.
    private var wantCamera = false
    /// STC-414: a uniqueID the app already showed the user, or nil for
    /// `CameraCapture`'s own `pickCamera` ranking (unchanged). Only
    /// meaningful when `wantCamera` is true — set unconditionally regardless,
    /// the same latitude `wantMicUid` already gets independent of anything
    /// else in the request.
    private var wantCameraDeviceUid: String?
    /// The mic subsystem (STC-233) — same optional-subsystem shape as camera,
    /// same HIGH-1 race (an async open racing `stop()`), same reason it is
    /// guarded by `lock` rather than a bare `var`.
    private var mic: MicCapture?
    private var micTrack: MicTrack?
    /// Set once, in `begin`, from `start`'s own request. Non-nil means a
    /// specific device was asked for; nil means no mic at all — never
    /// "whichever mic is default" (the settled decision `MicCapture`'s own
    /// header documents). `writeSidecars` reads whether this is non-nil the
    /// same way it reads `wantCamera`: to tell "never asked" from "asked, got
    /// nothing" in anchors.json's `mic` block.
    private var wantMicUid: String?
    /// The system-audio subsystem (STC-418): its own SCStream, see
    /// `SystemAudioCapture`'s header. Guarded by `lock` for the same HIGH-1
    /// reason as `camera`/`mic` — a `stop()` must see it or it must never
    /// start.
    private var systemAudio: SystemAudioCapture?
    private var systemAudioTrack: SystemAudioTrack?
    /// Set once, in `begin`, from the request. Tells "never asked" from
    /// "asked, got nothing" in anchors.json's `system` block, as
    /// `wantCamera`/`wantMicUid` do for theirs.
    private var wantSystemAudio = false
    private var stoppingBegan = false
    /// Guards RE-ENTRY into `stop()` itself (STC-305). `App.start`'s success
    /// handler can call `stop()` a second time on a session whose teardown is
    /// already in flight — a stray success racing a `stop` that arrived while
    /// `startStream()` had already assigned a real `stream` but before
    /// `startCapture`'s own completion had fired. Both `stream.stopCapture`
    /// and `writer.finishWriting` are only safe to invoke once per session:
    /// `WriterGate.closeAndMarkFinished()` already refuses a second
    /// `markAsFinished`, but its caller never checked that return value, so a
    /// second `stop()` reaching `finishWriting` a second time was the exact
    /// AVAssetWriter teardown race this codebase already fixed once (STC-254),
    /// reachable again through a second call site. `stopStarted` /
    /// `stopCompletions` / `stopStats` make every caller past the first
    /// coalesce onto the ONE real teardown instead of starting another.
    private var stopStarted = false
    private var stopCompletions: [([String: Any]) -> Void] = []
    private var stopStats: [String: Any]?
    /// The input and adaptor live behind the gate, not here: every access to
    /// them is either an append or a teardown, and those two must not overlap
    /// (STC-254). Holding them as plain properties is what allowed the overlap.
    private let gate = WriterGate()

    private var displayID: CGDirectDisplayID = 0
    private var pointW = 0, pointH = 0, pixelW = 0, pixelH = 0
    private var originX = 0.0, originY = 0.0
    private var captureW = 0, captureH = 0
    /// What this take is scoped to (STC-370): the whole display by default,
    /// set from the resolved `CaptureTarget` in `begin()`. Read by
    /// `writeSidecars` to decide anchors.json's version and `scope` block.
    private var captureScope: CaptureScopeDoc = .display
    /// Polls a window-scope take's own window for a resize or a close
    /// (STC-370) — ScreenCaptureKit has no delegate callback for either, the
    /// way it does for the stream dying. Guarded by `lock`, same reason as
    /// `camera`/`cursorRunLoop`: a stop() that arrives before this is stored
    /// must not be outlived by it.
    private var windowWatcher: DispatchSourceTimer?

    private let lock = NSLock()
    private var events: [[String: Any]] = []
    private var framesAppended = 0
    private var framesDropped = 0
    /// Frames the stream delivered while paused. Counted APART from
    /// `framesDropped`, which means "the writer would not take it" — folding
    /// paused frames in would make every paused take look as though it had
    /// dropped frames, and a diagnostic that lies is worse than none. Same
    /// reasoning as `tapDisablesAfterStop` sitting apart from `tapReenables`.
    private var framesPaused = 0

    /// Tap events AND cursor-shape samples dropped by the pause gate.
    /// Counted together because neither has any other automated coverage:
    /// on an idle machine no mouse events occur during a pause, so the
    /// events-invariant assertion in capture.grant.test.ts is vacuous
    /// (proven by mutation — removing the tap gate does not fail it), and
    /// posting synthetic input to get real coverage would need an
    /// Accessibility grant this repo does not ask for. This is a WIRING
    /// WITNESS, not a proof: it moves 0 -> nonzero on the same runs
    /// `framesPaused` does, and it moves too if either gate line is
    /// deleted, which is more evidence than existed before it. It proves
    /// the gate was ASKED, never that dropping was correct.
    private var eventsPaused = 0

    /// Owns this take's pause intervals (STC-240). Handed to the camera and
    /// mic captures too, so all five writers (display frames here, the tap
    /// here, camera frames, mic samples, and the cursor-shape sampler here)
    /// answer one question.
    let pauseGate = PauseGate()

    /// Buttons this take has RECORDED a `down` for and not yet an `up`.
    ///
    /// Not a query of the OS: what must stay consistent is `events.json`
    /// itself, because `cursor.ts` derives "pressed" as a PREFIX SUM over the
    /// file's own down(+1)/up(-1) events. Only events this take actually wrote
    /// may count toward it.
    private var heldButtons: Set<Int> = []
    private var framesNonMonotonic = 0
    private var lastPtsNs: Int64 = -1
    private var firstFramePtsNs: Int64 = -1
    private var tapReenables = 0
    /// Every disable the tap reported, by reason, and separately those that
    /// arrived after stop() had disabled it on purpose (which are expected
    /// and are neither counted as re-enables nor acted on).
    private var tapDisables: [String: Int] = [:]
    private var tapDisablesAfterStop = 0
    private var cursorEvents = 0
    private var cursorSampler: CursorSampler?
    private var cursorRunLoop: CFRunLoop?

    /// How often the system pointer is sampled for shape changes (STC-309).
    ///
    /// MEASURED 2026-09-03 with the `cursor-probe` command on real hardware:
    /// a sample costs 1.04 ms on average and 41 ms at worst (599 samples), so
    /// it is NOT microseconds and does NOT run on the tap's thread — a 41 ms
    /// stall on the run loop that answers WindowServer is how a tap gets
    /// disabled (`tapDisabledByTimeout`). The sampler has its own thread
    /// (`startCursorSampler`); ordering against the moves is restored at
    /// write time by `orderedEvents`. At 30 Hz that is ~3% of one core, and a
    /// hover is seen up to 33 ms late, two output frames at 60 fps. Do not
    /// chase it lower without a measurement showing that lag is visible.
    static let cursorSampleIntervalSeconds: Double = 1.0 / 30

    /// `STC_NO_CURSOR_SAMPLER=1`: see startCursorSampler.
    static let cursorSamplerDisabledForDiagnosis: Bool =
        ProcessInfo.processInfo.environment["STC_NO_CURSOR_SAMPLER"].map { !$0.isEmpty && $0 != "0" } ?? false

    /// A start must be answered exactly once, by whichever path gets there
    /// first. SCStream can fail through `didStopWithError` INSTEAD of through
    /// startCapture's completion (seen as -3805 "application connection being
    /// interrupted"), and with only the completion wired the request hung
    /// forever. A protocol where some requests are never answered is worse than
    /// one that answers with an error.
    private var startCompletion: ((Result<[String: Any], Error>) -> Void)?
    /// Fired when the stream dies AFTER the start was answered (STC-306).
    /// `App` sets it, the way it sets `Watchers.onDisplayChange`, to end the
    /// take: SCK does not resume a stopped stream, so a session left in
    /// `recording` after `didStopWithError` keeps the writer open and the
    /// heartbeat saying `recording` while no frame will ever arrive again, and
    /// nothing ends the take until the user presses Stop. Called on SCK's
    /// delegate queue; the handler dispatches to main itself.
    var onStreamDied: ((Error) -> Void)?
    /// Fired when a window-scope take's own window resizes or closes
    /// mid-take (STC-370) — the window-watch twin of `onStreamDied`, same
    /// reason: a `CaptureSession` must never call its OWN `stop()` directly,
    /// because `App.stop()` is what actually resets `App.state` and sends
    /// the client its `"stopped"` reply. Calling `session.stop()` here
    /// instead would tear the capture down correctly but leave `App`
    /// believing a recording is still live forever. Carries the reason
    /// string ("window-resized"/"window-closed") rather than an `Error`,
    /// since there is nothing to describe beyond which one happened. Called
    /// off main (the watcher's own queue); the handler dispatches to main
    /// itself, same as `onStreamDied`.
    var onWindowChanged: ((String) -> Void)?
    /// How long a `start` may take before it is answered with `start-timeout`.
    /// Covers the WHOLE request — content enumeration included (STC-258).
    /// `helper/test/capture.test.ts` bounds its own waits above this; if this
    /// value grows, those bounds must grow with it or the test races the
    /// backstop instead of observing it.
    static let startTimeoutSeconds: Double = 15

    /// How long teardown gets before `stop` answers anyway.
    ///
    /// STC-259 step 3 asked whether the append needs a bound of its own, the
    /// way the writer-gate harness now bounds its first one. It does not, and
    /// one could not be built there: `WriterGate` holds its lock ACROSS the
    /// append precisely so teardown cannot race it (that is the STC-254 fix),
    /// so abandoning a wedged append would leave that lock held forever and
    /// `closeAndMarkFinished()` below would still never return. The wedge
    /// reaches the lock whatever the append does. THIS is the bound that
    /// contains it — a wedged first append costs a take its finalised mp4 and
    /// answers `<reason>-timeout` with a `stopWarning`, but it cannot leave the
    /// parent holding a recording it is unable to end.
    ///
    /// Read by `helper/test/stop-bounds.test.ts`, which asserts the whole chain
    /// this sits in. Growing it means growing the client's request timeout too.
    static let stopTimeoutSeconds: Double = 20

    private let startLock = NSLock()

    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var tapRunLoop: CFRunLoop?

    init(dir: URL, t0Ns: UInt64) {
        self.dir = dir
        self.t0Ns = t0Ns
    }

    // MARK: - start

    func start(request: StartRequest,
               completion: @escaping (Result<[String: Any], Error>) -> Void) {
        // The backstop is armed HERE, before the first callback API is called,
        // so it covers the whole request rather than only the part after
        // SCShareableContent answers (STC-258).
        //
        // `getExcludingDesktopWindows` is a callback API, and this codebase's
        // rule is to ask what happens when one stays silent: with the backstop
        // armed inside begin() it never ran, so a content enumeration that
        // never called back left `start` unanswered forever. It also meant the
        // request's real bound was "content latency + 15 s" rather than 15 s,
        // which is what made capture.test.ts flaky under load.
        startLock.lock(); startCompletion = completion; startLock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.startTimeoutSeconds) { [weak self] in
            self?.finishStart(.failure(CaptureError.startTimedOut))
        }

        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, err in
            guard let self else { return }
            guard let content, !content.displays.isEmpty else {
                // PHASE-0 §6: this is the ungranted path and it fails in ~10 ms
                // with -3801 rather than hanging. Report it as a permission
                // problem, which is what it almost always is.
                //
                // Answers through finishStart, not the completion directly:
                // the backstop is already armed, so a direct call here would be
                // a second answer to the same request.
                self.finishStart(.failure(CaptureError.noDisplays(underlying: err)))
                return
            }
            // STC-370: what to capture (whole display / region / window) is a
            // decision (resolveCaptureTarget, below), the recording path's
            // twin of Still.swift's `capture(content:)` switch. A requested
            // display or window that is not there is an ERROR, same as
            // STC-247 already made display selection — a picker that offers a
            // choice must not have that choice silently swapped for another.
            switch self.resolveCaptureTarget(request, content: content) {
            case .failure(let e):
                self.finishStart(.failure(e))
            case .success(let target):
                self.begin(target: target, camera: request.camera, micDeviceUid: request.micDeviceUid,
                          cameraDeviceUid: request.cameraDeviceUid, systemAudio: request.systemAudio)
            }
        }
    }

    /// A resolved place to point `SCStream` at, plus everything about it that
    /// anchors.json and the writer need. `sourceRect` is set only for a
    /// region scope — a display filter cropped in place; a window filter's
    /// own bounds already are the region, the way `Still.swift`'s does.
    private struct CaptureTarget {
        let filter: SCContentFilter
        /// The display whose whole-display filter the system-audio stream
        /// uses (STC-418) — the take's own display for every scope, a
        /// window's included, since audio is filtered by app and a window
        /// filter would carry only its owner's.
        let audioDisplay: SCDisplay
        let geometry: DisplayGeometry
        let sourceRect: CGRect?
        let pixelSize: (width: Int, height: Int)
        let scope: CaptureScopeDoc
    }

    /// STC-370: resolves a `StartRequest`'s scope against real
    /// `SCShareableContent` — the async step `parseStartRequest` cannot do,
    /// since it runs before content is fetched. Mirrors `Still.swift`'s
    /// `capture(content:)` switch over `StillKind` deliberately: a display
    /// scope reuses `chooseDisplay` (STC-247) and, for a region, `resolveCrop`
    /// / `framePixelSize` (STC-289); a window scope reuses
    /// `chooseDisplayForWindow` (also shared with `Still.swift`, STC-370).
    private func resolveCaptureTarget(_ request: StartRequest,
                                      content: SCShareableContent) -> Result<CaptureTarget, CaptureError> {
        if let wid = request.windowId {
            guard let win = content.windows.first(where: { $0.windowID == wid }) else {
                return .failure(.windowNotFound(requested: wid))
            }
            let mid = CGPoint(x: win.frame.midX, y: win.frame.midY)
            let displays = content.displays.map { ($0.displayID, CGDisplayBounds($0.displayID)) }
            guard let dispId = chooseDisplayForWindow(midpoint: mid, displays: displays),
                  let display = content.displays.first(where: { $0.displayID == dispId })
            else { return .failure(.noDisplays(underlying: nil)) }
            let geometry = displayGeometry(id: display.displayID, pointWidth: display.width, pointHeight: display.height)
            let bounds = StillRect(x: Double(win.frame.minX) - geometry.originX,
                                   y: Double(win.frame.minY) - geometry.originY,
                                   width: Double(win.frame.width), height: Double(win.frame.height))
            let info = StillWindowInfo(id: Int(win.windowID),
                                       app: win.owningApplication?.applicationName,
                                       title: win.title, bounds: bounds)
            let filter = SCContentFilter(desktopIndependentWindow: win)
            let pixelSize = framePixelSize(points: bounds, backingScale: geometry.backingScale)
            return .success(CaptureTarget(filter: filter, audioDisplay: display, geometry: geometry,
                                          sourceRect: nil, pixelSize: pixelSize,
                                          scope: CaptureScopeDoc(kind: .window, region: nil, window: info)))
        }

        let ids = content.displays.map { $0.displayID }
        switch chooseDisplay(requested: request.displayId, available: ids) {
        case .noDisplays:
            return .failure(.noDisplays(underlying: nil))
        case .notFound(let requested, let available):
            return .failure(.displayNotFound(requested: requested, available: available))
        case .display(let id):
            guard let display = content.displays.first(where: { $0.displayID == id }) else {
                return .failure(.noDisplays(underlying: nil))
            }
            let geometry = displayGeometry(id: display.displayID, pointWidth: display.width, pointHeight: display.height)
            let filter = SCContentFilter(display: display, excludingWindows: [])
            guard let region = request.region else {
                return .success(CaptureTarget(filter: filter, audioDisplay: display, geometry: geometry,
                                              sourceRect: nil,
                                              pixelSize: (geometry.pixelWidth, geometry.pixelHeight),
                                              scope: .display))
            }
            guard case .region(let resolved) = resolveCrop(region, pointWidth: geometry.pointWidth,
                                                            pointHeight: geometry.pointHeight) else {
                return .failure(.cropOutsideDisplay)
            }
            let pixelSize = framePixelSize(points: resolved, backingScale: geometry.backingScale)
            return .success(CaptureTarget(filter: filter, audioDisplay: display, geometry: geometry,
                                          sourceRect: resolved.cgRect, pixelSize: pixelSize,
                                          scope: CaptureScopeDoc(kind: .region, region: resolved, window: nil)))
        }
    }

    /// Takes no completion: `start` owns it and every path below answers through
    /// `finishStart`, which is call-once. Handing this a second reference to the
    /// same completion is how a request gets answered twice.
    private func begin(target: CaptureTarget, camera wantCamera: Bool, micDeviceUid: String?,
                       cameraDeviceUid: String? = nil, systemAudio wantSystemAudio: Bool) {
        // Recorded before anything can fail below: writeSidecars must know
        // whether a camera was ever asked for, independent of whether this
        // particular start succeeds at opening one.
        self.wantCamera = wantCamera
        self.wantCameraDeviceUid = cameraDeviceUid
        self.wantMicUid = micDeviceUid
        self.wantSystemAudio = wantSystemAudio

        // CaptureDecisions.swift hardcodes this so it can be compiled without
        // ScreenCaptureKit. If the framework ever renumbers, refuse to start
        // rather than silently discarding every frame as "not complete".
        //
        // NOT a precondition: this is the capture helper, and the whole protocol
        // rests on it answering every request. Trapping turns a diagnosable
        // "start failed, here is why" into the parent seeing SIGTRAP and having
        // to guess. It cost a CI failure to notice.
        guard SCFrameStatus.complete.rawValue == SCFrameStatusCompleteRaw else {
            finishStart(.failure(CaptureError.frameStatusMismatch(
                actual: SCFrameStatus.complete.rawValue)))
            return
        }
        let g = target.geometry
        displayID = CGDirectDisplayID(g.id)
        pointW = g.pointWidth; pointH = g.pointHeight
        pixelW = g.pixelWidth; pixelH = g.pixelHeight
        originX = g.originX; originY = g.originY
        captureScope = target.scope
        (captureW, captureH) = captureSize(target.pixelSize.width, target.pixelSize.height)

        // No backstop is armed here: start() armed one covering this whole
        // request before it called SCShareableContent (STC-258). Arming a
        // second one would answer the same request twice.

        // STC-315: cursor telemetry is a HARD REQUIREMENT, so the tap is
        // created here — before the writer, before the stream, before
        // anything of this take exists on disk.
        //
        // The pixels carry no cursor by design (`showsCursor` is false; the
        // transform draws the pointer from events.json), so a take recorded
        // without a tap has no cursor ANYWHERE. Until now that take was made
        // anyway, with a warning: a file that looks like every other take and
        // silently breaks the brief's rule 2. Auto-zoom (STC-324) then reads
        // clicks as its `when` signal, which cannot be built on a track that
        // may be empty. So the answer is to refuse, and the refusal has to
        // come before `setupWriter()` — after it there is a display.mp4 with
        // frames in it and `removeIfNothingWorthKeeping` correctly keeps the
        // directory, which is exactly what "no take directory can exist
        // without a cursor track" forbids.
        //
        // Creating it HERE rather than on the tap's own thread is what makes
        // the refusal answerable at all: `CGEvent.tapCreate` returns nil
        // synchronously when Input Monitoring is not granted, and the old
        // arrangement learned that inside a Thread the start had already been
        // answered without. Nothing about the tap needs its creating thread —
        // it is the run loop the source is added to that decides where the
        // callback lands, and that is still the dedicated thread below.
        guard let tap = makeEventTap() else {
            finishStart(.failure(CaptureError.eventTapUnavailable))
            return
        }

        do {
            try setupWriter()
            try startStream(filter: target.filter, sourceRect: target.sourceRect) { [weak self] err in
                guard let self else { return }
                if let err {
                    // The tap outlives nothing: this start is over and no
                    // thread has been given the port yet.
                    CFMachPortInvalidate(tap)
                    self.finishStart(.failure(CaptureError.streamFailed(err)))
                } else {
                    self.runEventTap(tap)
                    self.startCursorSampler()
                    // Optional subsystem: it must not sit on the critical path. PHASE-0
                    // recorded camera/mic setup blocking startup once already, and
                    // `AVCaptureSession.startRunning()` is documented as blocking — a
                    // slow or USB camera would otherwise delay every `started` reply
                    // by however long the device takes to open. So the open itself now
                    // runs on a background queue (`startCameraAsync`) and `finishStart`
                    // below does NOT wait for it. Consequence: the device name cannot
                    // be part of THIS reply, because the reply may go out first — it is
                    // reported later as its own event (`camera-started` / `warning`),
                    // success and failure both, whenever the open actually resolves.
                    if wantCamera {
                        self.startCameraAsync()
                    }
                    // STC-233: same off-critical-path reasoning as the camera
                    // just above — AVCaptureSession.startRunning() blocks, so
                    // a slow mic must not delay `started`.
                    if let uid = self.wantMicUid {
                        self.startMicAsync(deviceUid: uid)
                    }
                    // STC-418: not on the critical path either — its own
                    // stream's start is callback-driven and never waited on.
                    if wantSystemAudio {
                        self.startSystemAudio(display: target.audioDisplay)
                    }
                    // STC-370: a window-scope take polls its own window, since
                    // SCK has no delegate for "this window resized/closed" the
                    // way it has one for the stream dying.
                    if target.scope.kind == .window, let w = target.scope.window {
                        self.startWindowWatcher(windowId: UInt32(w.id),
                                                initialSize: (w.bounds.width, w.bounds.height))
                        self.armWindowFault()
                    }
                    self.finishStart(.success(self.describe()))
                    self.armStreamDeathFault()
                }
            }
        } catch {
            CFMachPortInvalidate(tap)
            finishStart(.failure(error))
        }
    }

    /// How often a window-scope take polls its window's bounds (STC-370).
    /// ScreenCaptureKit has a delegate for the STREAM dying (`didStopWithError`,
    /// used for STC-306) but none for "this window resized" or "this window
    /// closed" — `Watchers.swift`'s display-reconfiguration callback has no
    /// window equivalent either. 1 Hz, the heartbeat's own cadence: a resize
    /// is not time-critical to catch, only to catch at all before the take's
    /// file ends up an unusable mix of sizes.
    static let windowWatchIntervalSeconds: Double = 1.0

    private func startWindowWatcher(windowId: UInt32, initialSize: (width: Double, height: Double)) {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        t.schedule(deadline: .now() + Self.windowWatchIntervalSeconds,
                  repeating: Self.windowWatchIntervalSeconds)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            let current = Self.currentWindowSize(windowId: windowId)
            switch decideWindowWatch(initial: initialSize, current: current) {
            case .unchanged:
                return
            case .resized:
                IO.send("warning", ["code": "window-resized-during-recording",
                                    "detail": "stopping cleanly — a window-scope take cannot change size mid-file"])
                self.onWindowChanged?("window-resized")
            case .gone:
                IO.send("warning", ["code": "window-closed-during-recording",
                                    "detail": "stopping cleanly — the captured window is no longer on screen"])
                self.onWindowChanged?("window-closed")
            }
        }
        // Same race as the cursor sampler and the camera (HIGH 1's shape): a
        // stop() that arrived before this timer was stored must not be
        // outlived by it. Storing under the same lock stop() reads, checking
        // stoppingBegan first, means the race either finds nothing stored (so
        // stop() cancels nothing, fine — nothing is running) or this loses
        // the race and cancels the timer itself before it is ever resumed.
        lock.lock()
        if stoppingBegan {
            lock.unlock()
            t.cancel()
            return
        }
        windowWatcher = t
        lock.unlock()
        t.resume()
    }

    /// `STC_CAPTURE_FAULT=window-resized` / `=window-closed`: shortly after a
    /// successful window-scope start, the watcher's reaction fires as though
    /// a real resize/close had been detected — the same "watched firing, not
    /// reasoned about" idiom as `STC_CAPTURE_FAULT=stream-died`, for a window
    /// change this codebase has no way to script deterministically (there is
    /// no API to resize another app's window on demand the way a fault can
    /// be injected in-process). Driven by
    /// helper/test/region-window-scope.grant.test.ts.
    static let windowFaultDelaySeconds: Double = 0.5
    private func armWindowFault() {
        guard let fault = ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"],
              fault == "window-resized" || fault == "window-closed" else { return }
        IO.log("STC_CAPTURE_FAULT=\(fault): the window watcher will report this in \(Self.windowFaultDelaySeconds) s")
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.windowFaultDelaySeconds) { [weak self] in
            self?.onWindowChanged?(fault)
        }
    }

    /// The window's current bounds, in points, via Quartz Window Services
    /// directly rather than another `SCShareableContent` round trip — this
    /// fires every second for the life of the take, and that API is async.
    /// nil means the window is no longer on screen: closed, minimised, or its
    /// owning app quit.
    private static func currentWindowSize(windowId: UInt32) -> (width: Double, height: Double)? {
        guard let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(windowId)) as? [[String: Any]],
              let info = list.first(where: { ($0[kCGWindowNumber as String] as? Int) == Int(windowId) }),
              let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
              let w = boundsDict["Width"] as? Double, let h = boundsDict["Height"] as? Double
        else { return nil }
        return (w, h)
    }

    /// Call-once. Later callers are no-ops, so a stream that fails after a
    /// successful start reports as a warning rather than a second response.
    /// Returns whether THIS call answered the start — `didStopWithError` uses
    /// that to tell a stream that died on the way up (the start's answer) from
    /// one that died under a live take (the take's end, STC-306).
    @discardableResult
    private func finishStart(_ result: Result<[String: Any], Error>) -> Bool {
        startLock.lock()
        let c = startCompletion
        startCompletion = nil
        startLock.unlock()
        c?(result)
        return c != nil
    }

    /// `STC_CAPTURE_FAULT=stream-died`: shortly after a successful start, the
    /// stream reports itself dead through the same delegate method SCK uses,
    /// so the helper's reaction to a stream death is watched firing rather
    /// than reasoned about — a path nobody has seen taken is indistinguishable
    /// from one that cannot be. The SCStream itself is left running: the
    /// subject is the reaction (warning, unsolicited `stopped`, finalised
    /// sidecars), and `stop()` tears the real stream down either way — on a
    /// genuine death `stopCapture` answers with an error that is ignored, on
    /// the fault it answers cleanly; both reach `finishWriting`.
    /// Driven by helper/test/stream-died.grant.test.ts.
    static let streamDeathFaultDelaySeconds: Double = 0.5
    private func armStreamDeathFault() {
        guard ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] == "stream-died",
              let s = stream else { return }
        IO.log("STC_CAPTURE_FAULT=stream-died: the stream will report itself dead in \(Self.streamDeathFaultDelaySeconds) s")
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.streamDeathFaultDelaySeconds) { [weak self] in
            self?.stream(s, didStopWithError: NSError(
                domain: "stc.fault", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "injected by STC_CAPTURE_FAULT=stream-died"]))
        }
    }

    /// Opens the camera off the critical path (MEDIUM 3): `start` already
    /// answered by the time this runs, so a slow or USB device never delays
    /// `started`. Success and failure are both reported as their own event
    /// once the open actually resolves — never folded into `started`.
    ///
    /// Races `stop()` (HIGH 1): if a stop has already begun by the time this
    /// finishes, the camera must not be stored — nothing would ever stop it.
    /// `stoppingBegan` and the decision of whether to store or immediately
    /// close are made under `lock` so the two paths cannot both believe they
    /// own the camera.
    private func startCameraAsync() {
        let dir = self.dir
        let t0Ns = self.t0Ns
        let deviceUid = self.wantCameraDeviceUid
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }

            // Re-check immediately before opening the device (MINOR, cheap):
            // a stop that arrived during the dispatch latency above must not
            // be followed by opening the camera and lighting its LED after
            // the take has already ended. This narrows the race; it does not
            // close it — stop() can still arrive during cam.start() itself,
            // which is why the post-open check below exists too.
            self.lock.lock()
            let stoppingAlready = self.stoppingBegan
            self.lock.unlock()
            if stoppingAlready { return }

            let cam = CameraCapture(dir: dir, t0Ns: t0Ns, pauseGate: self.pauseGate, deviceUid: deviceUid)
            let result = cam.start()
            let opened: Bool
            if case .success = result { opened = true } else { opened = false }

            // The store-vs-close race (HIGH 1) is decided by a pure function
            // (CaptureDecisions.swift) so it is testable without a live
            // camera — see helper/test/decisions/main.swift.
            self.lock.lock()
            let decision = decideCameraOpen(opened: opened, stoppingBegan: self.stoppingBegan)
            if decision == .store { self.camera = cam }
            self.lock.unlock()

            switch decision {
            case .store:
                if case .success(let name) = result {
                    // Reliable, not lossy (MEDIUM 4): describe() deliberately
                    // omits the camera, so this event is the ONLY signal that
                    // the camera is live. IO.stat is the drop-oldest ring and
                    // discards precisely under the load this most needs to
                    // survive; IO.send never drops.
                    IO.send("camera-started", ["device": name])
                }
            case .closeImmediately:
                // stop() already ran and found no camera to close, because
                // this one had not opened yet. Close it now — this take's
                // sidecars are likely already written, so the track is
                // discarded, but the AVCaptureSession must not be left
                // running for the rest of the process's life.
                cam.stop { _ in }
            case .reportFailure:
                if case .failure(let e) = result {
                    let ce = e as? CameraError
                    IO.send("warning", ["code": ce?.code ?? "camera-failed",
                                        "detail": ce.map { $0.description } ?? "\(e)"])
                }
            }
        }
    }

    /// Opens the mic off the critical path, mirroring `startCameraAsync`
    /// exactly — same HIGH-1 race against `stop()`, same reason
    /// `decideCameraOpen` (a device-agnostic decision despite its name — see
    /// its own doc comment) is reused here rather than copied.
    private func startMicAsync(deviceUid: String) {
        let dir = self.dir
        let t0Ns = self.t0Ns
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }

            self.lock.lock()
            let stoppingAlready = self.stoppingBegan
            self.lock.unlock()
            if stoppingAlready { return }

            let m = MicCapture(dir: dir, t0Ns: t0Ns, deviceUid: deviceUid, pauseGate: self.pauseGate)
            let result = m.start()
            let opened: Bool
            if case .success = result { opened = true } else { opened = false }

            self.lock.lock()
            let decision = decideCameraOpen(opened: opened, stoppingBegan: self.stoppingBegan)
            if decision == .store { self.mic = m }
            self.lock.unlock()

            switch decision {
            case .store:
                if case .success(let name) = result {
                    IO.send("mic-started", ["device": name])
                    self.armMicDisconnectFault(deviceUid: deviceUid)
                }
            case .closeImmediately:
                m.stop { _ in }
            case .reportFailure:
                if case .failure(let e) = result {
                    let me = e as? MicError
                    IO.send("warning", ["code": me?.code ?? "mic-failed",
                                        "detail": me.map { $0.description } ?? "\(e)"])
                }
            }
        }
    }

    /// `STC_CAPTURE_FAULT=mic-disconnected`: shortly after a successful mic
    /// open, this calls the SAME reaction a real `.AVCaptureDeviceWasDisconnected`
    /// notification drives (`handleMicDisconnected`, wired from `Watchers` in
    /// main.swift) — so the fix below is watched firing rather than reasoned
    /// about, the same idiom `armStreamDeathFault` uses for the display side.
    /// The real `AVCaptureSession` is left running; the subject under test is
    /// the reaction (mic torn down cleanly, `mic-disconnected` warning,
    /// `micTrack` finalised with what was captured so far), not the fault
    /// delivery mechanism itself.
    static let micDisconnectFaultDelaySeconds: Double = 0.5
    private func armMicDisconnectFault(deviceUid: String) {
        guard ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] == "mic-disconnected" else { return }
        IO.log("STC_CAPTURE_FAULT=mic-disconnected: the mic will report itself gone in \(Self.micDisconnectFaultDelaySeconds) s")
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.micDisconnectFaultDelaySeconds) { [weak self] in
            self?.handleMicDisconnected(uid: deviceUid)
        }
    }

    /// A mic that disconnects mid-recording used to have no dedicated
    /// teardown at all: `Watchers.onDeviceChange` fired but was never wired
    /// to anything (found 2026-09-25, chasing a report that a mid-take mic
    /// unplug was ending the WHOLE recording, video included — the exact
    /// class of failure `MicCapture.setupWriter`'s own `mediaTimeScale`
    /// comment already documents happening once from an uncaught exception
    /// deep in AVFoundation, though the specific cause there was fixed).
    ///
    /// This tears down ONLY the mic subsystem — the same `m.stop()` call
    /// `stop(reason:)` makes for its own mic branch, just reached from a
    /// live disconnect instead of an end-of-take teardown — and leaves
    /// video (and camera, system audio) running untouched. A DISPLAY
    /// disconnecting mid-take is a full, intentional stop
    /// (`AVAssetWriter` cannot change output dimensions mid-file, wired in
    /// main.swift's `onDisplayChange`); losing an AUDIO-only track has no
    /// such constraint, so ending the whole take over it would be strictly
    /// worse than a take with a shorter mic track.
    ///
    /// `!stoppingBegan` is the same HIGH-1 guard `startMicAsync`/
    /// `startCameraAsync` already use: if the whole-take `stop(reason:)` has
    /// already claimed `mic` (even if its own `m.stop()` hasn't finished
    /// yet), this backs off rather than calling `MicCapture.stop()` a second
    /// time on the same instance — `AVAssetWriter.finishWriting` is
    /// documented as a once-only call.
    func handleMicDisconnected(uid: String) {
        lock.lock()
        guard !stoppingBegan, wantMicUid == uid, let m = mic else { lock.unlock(); return }
        mic = nil
        lock.unlock()
        IO.send("warning", ["code": "mic-disconnected", "uid": uid,
                            "detail": "the microphone disconnected mid-recording; the take continues "
                                    + "with no mic track from this point on"])
        m.stop { [weak self] track in
            self?.lock.lock()
            self?.micTrack = track
            self?.lock.unlock()
        }
    }

    /// Starts the system-audio stream (STC-418). Unlike the mic, nothing here
    /// blocks — `SCStream.startCapture` answers through a callback — so there
    /// is no background hop; but the same race with `stop()` is closed the
    /// other way round: the instance is STORED before it starts, under the
    /// lock that `stop()` sets `stoppingBegan` under, so a stop either
    /// prevents it from existing or finds it and tears it down (including
    /// one whose start is still in flight — `SystemAudioCapture.stop`
    /// handles that). A failed start leaves it stored: its stop then just
    /// finalises an empty writer and reports no track, which is
    /// `present:false` — requested, got nothing.
    private func startSystemAudio(display: SCDisplay) {
        lock.lock()
        if stoppingBegan { lock.unlock(); return }
        let a = SystemAudioCapture(dir: dir, t0Ns: t0Ns, pauseGate: pauseGate)
        systemAudio = a
        lock.unlock()

        a.onStreamDied = { err in
            IO.send("warning", ["code": "system-audio-stopped",
                                "detail": "system audio stopped mid-take (\(err)); the rest of this "
                                        + "take has no system audio"])
        }
        a.start(display: display) { err in
            if let err {
                let e = err as? SystemAudioError
                IO.send("warning", ["code": e?.code ?? "system-audio-failed",
                                    "detail": e.map { $0.description } ?? "\(err)"])
            } else {
                IO.send("system-audio-started", ["sampleRate": SystemAudioCapture.sampleRate,
                                                 "channels": SystemAudioCapture.channelCount])
            }
        }
    }

    private func setupWriter() throws {
        let url = dir.appendingPathComponent("display.mp4")
        try? FileManager.default.removeItem(at: url)
        let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
        // The start-to-first-frame gap becomes an empty edit whose duration is
        // quantised to the MOVIE timescale. At the 600 Hz default that is 1.67 ms
        // of granularity on a value a reader must recover exactly; 90 kHz cuts
        // the worst-case recovery error to ~5.5 us.
        w.movieTimeScale = 90_000
        // STC-394: a crash leaves a playable prefix rather than an unreadable
        // file — see `movieFragmentIntervalSec`'s own comment for what this
        // does and does not change about a normal, clean finish.
        w.movieFragmentInterval = CMTime(seconds: movieFragmentIntervalSec, preferredTimescale: 1)
        // PHASE-0 §8, verified settings. AllowFrameReordering=false matters:
        // no B-frames means decode order equals presentation order, which is
        // what lets a sink map a decoded frame back to an index without a sort.
        let inp = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: captureW,
            AVVideoHeightKey: captureH,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 50_000_000,
                AVVideoMaxKeyFrameIntervalKey: 45,
                AVVideoExpectedSourceFrameRateKey: 60,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any],
        ])
        inp.expectsMediaDataInRealTime = true
        // Sample times survive as exact integer nanoseconds, so the demuxed
        // PTS grid is the transform's frame grid with no rescaling.
        inp.mediaTimeScale = 1_000_000_000
        let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp, sourcePixelBufferAttributes: nil)
        guard w.canAdd(inp) else { throw CaptureError.writerRejectedInput }
        w.add(inp)
        guard w.startWriting() else { throw CaptureError.writerFailed(w.error) }
        w.startSession(atSourceTime: .zero)
        writer = w
        gate.install(input: inp, adaptor: ad)
    }

    /// Never block waiting on startCapture's completion. This runs on
    /// ScreenCaptureKit's own callback queue, and startCapture dispatches its
    /// completion to that same queue — so a semaphore wait here deadlocks
    /// against itself and only unwedges when the timeout fires. That cost a
    /// flat 10 s on every start, which AVAssetWriter then baked into the file
    /// as a 10 s empty edit.
    private func startStream(filter: SCContentFilter, sourceRect: CGRect?,
                             completion: @escaping (Error?) -> Void) throws {
        let cfg = SCStreamConfiguration()
        cfg.width = captureW
        cfg.height = captureH
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        cfg.queueDepth = 8
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        cfg.scalesToFit = false
        // The transform composites the cursor from events.json, so the captured
        // pixels must not already contain one — otherwise every export shows two.
        cfg.showsCursor = false
        // STC-370: a region scope crops a display filter in place, the same
        // knob the still path already uses for a display-crop shot. A window
        // filter's own bounds already are the region, so sourceRect is nil.
        if let sourceRect {
            cfg.sourceRect = sourceRect
        }
        // macOS 14+, absent from the 13.3 SDK headers but present at runtime
        // (PHASE-0 §7). Explicit width/height governs output size regardless.
        cfg.captureResolution = .automatic
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen,
                              sampleHandlerQueue: DispatchQueue(label: "stc.capture.screen"))
        stream = s
        s.startCapture { completion($0) }
    }

    // MARK: - frames

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        autoreleasepool {
            guard type == .screen,
                  let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false)
                            as? [[SCStreamFrameInfo: Any]],
                  let att = arr.first,
                  let statusRaw = att[.status] as? Int,
                  let dtRaw = att[.displayTime] as? UInt64,
                  let pb = CMSampleBufferGetImageBuffer(sb)
            else { return }

            // The decision itself lives in CaptureDecisions.swift so it can be
            // tested without a live stream. displayTime is mach ticks and is
            // converted there; it is the scheduled VBL presentation time, ~7 ms
            // ahead of delivery, which is the right reference for what the user saw.
            lock.lock()
            let decision = decideFrame(statusRaw: statusRaw, displayTimeRaw: dtRaw,
                                       timebase: (Clock.timebase.numer, Clock.timebase.denom),
                                       t0Ns: t0Ns, lastPtsNs: lastPtsNs)
            let ptsNs: Int64
            switch decision {
            case .skip:
                lock.unlock(); return       // idle/blank/suppressed: VFR emits nothing
            case .nonMonotonic:
                framesNonMonotonic += 1; lock.unlock(); return
            case .accept(let pts):
                // Paused: the frame is real and correctly timed, and must not
                // reach the writer, advance `lastPtsNs`, or become
                // `firstFramePtsNs` — a take paused from its very first
                // instant has no first frame until it resumes.
                if pauseGate.isPaused(atNs: pts) {
                    framesPaused += 1; lock.unlock(); return
                }
                ptsNs = pts
                lastPtsNs = pts
                if firstFramePtsNs < 0 { firstFramePtsNs = pts }
            }
            lock.unlock()

            // The gate decides whether this frame may still be written, and
            // holds its own lock across the append so a concurrent stop cannot
            // tear the track down mid-append. A frame that arrives during
            // teardown is dropped, not written into a closing writer.
            let outcome = gate.append(pb, at: CMTime(value: ptsNs, timescale: 1_000_000_000))
            lock.lock()
            if outcome == .appended { framesAppended += 1 } else { framesDropped += 1 }
            lock.unlock()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // If the start is still pending this IS its answer — the stream died on
        // the way up rather than reporting through startCapture's completion.
        let answeredStart = finishStart(.failure(CaptureError.streamFailed(error)))
        IO.send("warning", ["code": "stream-stopped", "detail": "\(error)"])
        // Otherwise the take was live and has just lost its source (STC-306).
        // Nothing here can revive the stream, so the owner ends the take —
        // the same clean stop a display change gets — instead of sitting in
        // `recording` with frames that will never arrive. The take is intact
        // up to the failure, which is what a clean stop preserves.
        if !answeredStart { onStreamDied?(error) }
    }

    // MARK: - event tap

    /// Creates the event tap, or returns nil if the system will not give us
    /// one — which in practice means Input Monitoring is not granted.
    ///
    /// Called from `begin()` on whatever thread got there, deliberately: this
    /// is the only part of the tap that can fail, it fails SYNCHRONOUSLY, and
    /// STC-315 needs its answer before the take is allowed to exist. The
    /// creating thread has no bearing on where events are delivered —
    /// `runEventTap` adds the source to the dedicated thread's run loop, and
    /// that is what decides.
    private func makeEventTap() -> CFMachPort? {
        // `STC_CAPTURE_FAULT=no-event-tap`: refuse as though the grant were
        // missing. A refusal nobody has watched fire is indistinguishable from
        // one that cannot fire, and the honest way to produce the real thing
        // is `tccutil reset ListenEvent`, which costs the machine a grant and
        // a relaunch. Same shape and same reason as `stream-died` above; read
        // here rather than cached, so one process can be the control.
        if ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] == "no-event-tap" {
            IO.log("STC_CAPTURE_FAULT=no-event-tap: refusing to start as if Input Monitoring were denied")
            return nil
        }

        let mask: CGEventMask =
            (1 << CGEventType.mouseMoved.rawValue) |
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.leftMouseUp.rawValue) |
            (1 << CGEventType.leftMouseDragged.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.rightMouseUp.rawValue) |
            (1 << CGEventType.rightMouseDragged.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            guard let userInfo else { return Unmanaged.passUnretained(event) }
            let me = Unmanaged<CaptureSession>.fromOpaque(userInfo).takeUnretainedValue()
            me.handleTapEvent(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }

        return CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap,
            options: .listenOnly, eventsOfInterest: mask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque())
    }

    /// Runs the tap on its own thread and run loop. If the tap's run loop is
    /// starved the system disables it (`tapDisabledByTimeout`), so it must not
    /// share a run loop with anything that can block — including command
    /// dispatch.
    ///
    /// Takes an already-created tap: creation is `makeEventTap`, and the split
    /// is the whole of STC-315. There is no failure path left in here.
    private func runEventTap(_ tap: CFMachPort) {
        let t = Thread { [weak self] in
            guard let self else { return }
            self.tap = tap
            let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            self.tapSource = src
            self.tapRunLoop = CFRunLoopGetCurrent()
            CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            // Runs until stop() calls CFRunLoopStop. Unbounded by design: this
            // is the tap's own thread, and a run loop that returned early would
            // silently stop delivering input for the rest of the recording.
            CFRunLoopRun()
        }
        t.name = "event-tap"
        t.start()
    }

    /// STC-309: samples the pointer's SHAPE on a thread of its own.
    ///
    /// The first draft put the timer on the tap's run loop so one thread would
    /// own the order of everything appended to `events`. The probe then
    /// measured a sample at 1 ms typical and 41 ms worst — enough to hold up
    /// the tap's answer to WindowServer — so the sampler lives here instead,
    /// and `orderedEvents` restores time order when the file is written.
    /// Nothing else runs on this loop, so a slow sample costs nobody but the
    /// sampler. Mirrors the tap thread: a plain Thread, its own CFRunLoop,
    /// stopped by `stop()`.
    ///
    /// The references are measured now, on this machine, at its current
    /// pointer size and scale — never a baked-in table.
    private func startCursorSampler() {
        // DIAGNOSTIC control, not a feature: a take that differs from a normal
        // one ONLY by having no sampler, so a fault seen with it running can
        // be compared against one without. Read once at launch, like
        // --stats-interval-ms. Announced so a take recorded this way can
        // never pass for one where the pointer simply never changed.
        if Self.cursorSamplerDisabledForDiagnosis {
            IO.send("warning", ["code": "cursor-sampler-disabled",
                                "detail": "STC_NO_CURSOR_SAMPLER is set; this take will carry no cursor-shape events"])
            return
        }
        let t = Thread { [weak self] in
            guard let self else { return }
            let (refs, missing) = CursorShape.references()
            if !missing.isEmpty {
                let names = missing.joined(separator: ", ")
                IO.send("warning", ["code": "cursor-references-incomplete",
                                    "detail": "no bitmap for \(names); those shapes will be written as arrow",
                                    "missing": missing])
            }
            let sampler = CursorSampler(references: refs) { [weak self] shape, observedNs in
                self?.recordCursorShape(shape, observedNs: observedNs)
            }
            let rl: CFRunLoop = CFRunLoopGetCurrent()
            sampler.schedule(on: rl, intervalSeconds: Self.cursorSampleIntervalSeconds)
            // Published under `lock` in the same critical section stop() reads
            // it in, with `stoppingBegan` as the tie-break: a stop that lands
            // before this thread gets here would otherwise find no loop to
            // stop, and the sampler would run for the rest of the process's
            // life — the same shape as the camera's HIGH 1 race.
            self.lock.lock()
            if self.stoppingBegan {
                self.lock.unlock()
                sampler.invalidate()
                return
            }
            self.cursorSampler = sampler
            self.cursorRunLoop = rl
            self.lock.unlock()
            // Unbounded by design, like the tap's: stop() ends it.
            CFRunLoopRun()
            // Nothing runs this loop again, so no tick can follow; invalidating
            // here, on the loop's own thread, just releases the timer.
            sampler.invalidate()
        }
        t.name = "cursor-sampler"
        t.start()
    }

    private func handleTapEvent(type: CGEventType, event: CGEvent) {
        // CGEvent.timestamp is ALREADY nanoseconds on the same epoch as the
        // converted displayTime — converting it would be a 41.667x error in the
        // other direction. The mapping lives in CaptureDecisions.swift.
        switch decideCursorEvent(type: type, timestampNs: event.timestamp, t0Ns: t0Ns) {
        case .reenableTap(let reason):
            // stop() disables the tap itself, and CoreGraphics reports that
            // back here as a user-input disable. Re-enabling it would undo the
            // stop, and counting it made every take look as if the tap had
            // been starved once. So: after stop began, note it and do nothing.
            lock.lock()
            let stopping = stoppingBegan
            if stopping {
                tapDisablesAfterStop += 1
            } else {
                tapReenables += 1
                tapDisables[reason.rawValue, default: 0] += 1
            }
            lock.unlock()
            if !stopping, let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        case .ignore, .beforeStart:
            return
        case .event(let t, let kind, let button):
            // Nothing is recorded while paused (STC-240). The tap stays LIVE —
            // tearing it down and re-creating it would re-enter the Input
            // Monitoring path STC-315 mapped, and `tapCreate` fails
            // synchronously, so a resume could fail in a way a pause cannot
            // report. Dropping the event is the cheap, reversible half.
            if pauseGate.isPaused(atNs: Int64(t)) {
                lock.lock(); eventsPaused += 1; lock.unlock()
                return
            }
            let loc = event.location
            var e: [String: Any] = ["t": t, "kind": kind, "x": loc.x, "y": loc.y]
            if let button { e["button"] = button }
            lock.lock()
            events.append(e)
            // Track what is held so a pause can release it (see
            // recordHeldButtonReleases). Updated only for events this take
            // actually RECORDS, which is what keeps it in step with the prefix
            // sum cursor.ts computes over the same file. It sits after the
            // paused check by construction, so nothing dropped can reach it.
            if let button {
                if kind == "down" { heldButtons.insert(button) }
                else if kind == "up" { heldButtons.remove(button) }
            }
            lock.unlock()
        }
    }

    /// A pointer-shape change, from the sampler on the tap thread (STC-309).
    /// `observedNs` is the helper's own clock — the same mach epoch
    /// `CGEvent.timestamp` is on — so `t` shares the moves' origin exactly.
    private func recordCursorShape(_ shape: String, observedNs: UInt64) {
        // Mirrors decideCursorEvent's .beforeStart: the schema requires t >= 0.
        guard observedNs >= t0Ns else { return }
        if pauseGate.isPaused(atNs: Int64(observedNs - t0Ns)) {
            lock.lock(); eventsPaused += 1; lock.unlock()
            return
        }
        lock.lock()
        events.append(["t": Int(observedNs - t0Ns), "kind": "cursor", "shape": shape])
        cursorEvents += 1
        lock.unlock()
    }

    // MARK: - stats and stop

    var isPaused: Bool { pauseGate.isPaused }

    /// Session-relative, from the helper's own clock — the same instant the
    /// five gates then test every sample against, which is what makes the
    /// sidecar and the disk agree by construction rather than by inspection.
    ///
    /// The GATE opens BEFORE `recordHeldButtonReleases` runs, not after.
    /// Between reading `tNs` and opening the span there are two lock
    /// round-trips and a `CGEvent(source:)` allocation in the release path —
    /// not microseconds — and a tap event evaluated in that window with
    /// `t >= tNs` used to be appended with a timestamp already inside the
    /// span the next line was about to open. Gating first closes that: an
    /// event with `t >= tNs` is now dropped by the gate itself (the
    /// invariant holds), and an event with `t < tNs` is still accepted but
    /// lies OUTSIDE the span either way, so nothing regresses. It also
    /// removes a hazard the old order carried: a REDUNDANT pause (one
    /// already open) used to still run `recordHeldButtonReleases`, which
    /// could write a synthetic `up` at `tNs2 - 1` — INSIDE the
    /// already-open span. Guarding first means a redundant pause writes
    /// nothing at all.
    @discardableResult
    func pause() -> Bool {
        let tNs = Int64(Clock.nowNs() - t0Ns)
        guard pauseGate.pause(atNs: tNs) else { return false }
        recordHeldButtonReleases(atNs: tNs)
        return true
    }

    /// Release anything still held, immediately BEFORE the span opens.
    ///
    /// The mirror of `recordResumeAnchor`: one synthetic event at each end of
    /// a pause. Without it, holding a button, pausing, letting go while
    /// paused, then resuming records the `down` and DROPS the `up` — and since
    /// `cursor.ts` computes pressed as a prefix sum, the depth never returns
    /// to zero. The cursor then renders pressed for the entire rest of the
    /// export, and `zoom.ts`, which treats a move while a button is held as a
    /// DRAG, opens a zoom window on every later move. One dropped event and
    /// the take is wrong from that instant to its end — while reading as a
    /// transform bug rather than a helper one.
    ///
    /// `tNs - 1`, not `tNs`, so the invariant stays absolute: no sample on
    /// disk has a pts inside a pause interval, with no carve-out for our own
    /// synthetics. At nanosecond resolution the offset is not physical.
    ///
    /// A button still physically held at resume produces no new `down` (the
    /// press happened before the pause), so the pointer reads as un-pressed
    /// for the remainder of that drag. A known, bounded inaccuracy, and
    /// strictly better than a take stuck pressed to its end.
    private func recordHeldButtonReleases(atNs tNs: Int64) {
        guard tNs > 0 else { return }          // the schema requires t >= 0
        lock.lock()
        let held = heldButtons
        heldButtons.removeAll()
        lock.unlock()
        guard !held.isEmpty else { return }
        // If the allocation fails the coordinates are lost, but the RELEASE
        // matters far more than where it happened: x/y on an `up` only satisfy
        // the schema — cursor.ts takes position from moves — while a missing
        // `up` sticks the pressed state for the whole export.
        let loc = CGEvent(source: nil)?.location ?? .zero
        lock.lock()
        for b in held.sorted() {
            events.append(["t": Int(tNs - 1), "kind": "up",
                           "x": loc.x, "y": loc.y, "button": b])
        }
        lock.unlock()
    }

    @discardableResult
    func resume() -> Bool {
        let tNs = Int64(Clock.nowNs() - t0Ns)
        let changed = pauseGate.resume(atNs: tNs)
        if changed { recordResumeAnchor(atNs: tNs) }
        return changed
    }

    /// One synthetic move at the resume instant, carrying where the pointer
    /// actually is (STC-240), in the tap's own coordinate space.
    ///
    /// Without it the cursor sim — which eases toward the pointer at 120 Hz —
    /// holds at its pre-pause position and then visibly GLIDES across the cut
    /// to wherever the mouse ended up, because every real move in between was
    /// discarded. With it, the first frame after the seam is already correct.
    ///
    /// Deliberately indistinguishable from a real move: a `synthetic: true`
    /// field would be a fact about the helper rather than about the take, and
    /// nothing downstream would branch on it.
    private func recordResumeAnchor(atNs tNs: Int64) {
        // CGEvent, NOT NSEvent.mouseLocation — the two are in different
        // coordinate spaces and only one of them matches this array.
        //
        // Every move in `events` carries the tap's `event.location`:
        // CoreGraphics global points, origin TOP-left, y down.
        // `NSEvent.mouseLocation` is a Cocoa global point: origin BOTTOM-left,
        // y up, flipped against the MAIN display's height whatever display the
        // pointer is actually over. `StillDecisions.swift`'s `localizeCursor`
        // is where that flip is owned, and it is the ONE flip in the system
        // precisely so everything downstream of events.json can assume
        // top-left.
        //
        // Writing an unconverted Cocoa point into this array would put the
        // synthetic anchor at a mirrored y — a cursor that jumps across the
        // seam and snaps back one frame later. Since the anchor exists to make
        // the seam land cleanly, that bug would defeat the feature while
        // looking implemented.
        //
        // A nil event (the allocation failing) costs the anchor, not the take:
        // the seam degrades to the glide this function exists to remove, which
        // is the old behaviour rather than a new fault.
        guard let loc = CGEvent(source: nil)?.location else { return }
        lock.lock()
        events.append(["t": Int(tNs), "kind": "move", "x": loc.x, "y": loc.y])
        lock.unlock()
    }

    func stats() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        // `events` counts everything in the file, cursor events included;
        // `cursorEvents` is the shape changes alone, so the app can show the
        // two side by side and a take with no pointer motion still reads as
        // such.
        return ["frames": framesAppended, "dropped": framesDropped,
                "framesPaused": framesPaused,
                "eventsPaused": eventsPaused,
                "paused": pauseGate.isPaused,
                "nonMonotonic": framesNonMonotonic, "events": events.count,
                "cursorEvents": cursorEvents,
                "tapReenables": tapReenables,
                // Which kind, so a re-enable can be read as starvation or not.
                "tapDisabled": ["timeout": tapDisables["timeout"] ?? 0,
                                "userInput": tapDisables["userInput"] ?? 0,
                                "afterStop": tapDisablesAfterStop]]
    }

    /// No camera field here on purpose: the camera opens asynchronously (see
    /// `startCameraAsync`), so at the moment this is called for the `started`
    /// reply, whether it has resolved yet is not something the caller should
    /// be able to depend on. Its outcome is reported separately, once known.
    func describe() -> [String: Any] {
        ["display": displayID, "capture": ["width": captureW, "height": captureH],
         "source": ["pixelWidth": pixelW, "pixelHeight": pixelH]]
    }

    /// Tears down capture and writes events.json and anchors.json.
    ///
    /// Answers exactly once, by whichever path gets there first. `start` was
    /// given this guarantee in increment 2 and `stop` was not — and it is
    /// arguably more important here: neither `stopCapture` nor `finishWriting`
    /// promises to call back, and when they do not the parent is left holding a
    /// recording it cannot end. Seen on a CI runner as
    /// `request "stop" (seq 2) timed out after 30000ms`.
    ///
    /// On timeout the sidecars are still written. A take whose display.mp4 was
    /// never finalised is worth more with its events and anchors than without:
    /// the video may still be readable, and if it is not, the sidecars say what
    /// was attempted.
    func stop(reason: String, completion: @escaping ([String: Any]) -> Void) {
        // Re-entry (STC-305): a second call while the first is already
        // tearing down is coalesced onto it rather than starting a second
        // teardown of the same stream/writer. A second call that arrives
        // AFTER the first has already finished is answered immediately with
        // what was already recorded — the take is not re-stopped, and its
        // reason is not rewritten by a later, incidental caller.
        lock.lock()
        if let stats = stopStats {
            lock.unlock()
            completion(stats)
            return
        }
        if stopStarted {
            stopCompletions.append(completion)
            lock.unlock()
            return
        }
        stopStarted = true
        // Set BEFORE reading `camera`: this is the other half of the HIGH 1
        // race. A camera that finishes opening after this point checks the
        // flag (in `startCameraAsync`) and closes itself instead of being
        // stored, so it is not simply skipped and left running. The cursor
        // sampler's run loop is read in the same section for the same reason
        // (startCursorSampler) — still under the one lock acquisition the
        // STC-305 re-entry guard above already holds. And it is set BEFORE
        // the tap is disabled below, so the disable CoreGraphics reports back
        // (handleTapEvent) is seen as ours and not re-enabled or counted.
        stoppingBegan = true
        let cam = camera
        let m = mic
        let sysAudio = systemAudio
        let cursorRL = cursorRunLoop
        let winWatcher = windowWatcher
        windowWatcher = nil
        lock.unlock()

        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let tapRunLoop { CFRunLoopStop(tapRunLoop) }
        if let cursorRL { CFRunLoopStop(cursorRL) }
        // A window-resize/close stop() call arrives FROM this timer's own
        // handler; cancelling it here is a no-op for that path (it has
        // already fired) and closes the watcher for every other stop reason.
        winWatcher?.cancel()

        let answerLock = NSLock()
        var answered = false
        let finishUp: (String) -> Void = { [weak self] actualReason in
            answerLock.lock()
            if answered { answerLock.unlock(); return }
            answered = true
            answerLock.unlock()
            guard let self else { return }
            // Read BEFORE writeSidecars closes the open pause span below, so
            // `s["paused"]` reflects the instant of the stop rather than the
            // finished document — a take stopped while paused correctly
            // answers `paused: true` here even though anchors.json will carry
            // a CLOSED interval once writeSidecars has run.
            var s = self.stats()
            if actualReason != reason { s["stopWarning"] = "writer did not finalise in time" }
            self.writeSidecars(reason: actualReason)
            self.lock.lock()
            self.stopStats = s
            let extra = self.stopCompletions
            self.stopCompletions = []
            self.lock.unlock()
            completion(s)
            for c in extra { c(s) }
        }

        // HIGH 2 — bound arithmetic. The client (app/src/helper-client.ts,
        // HelperClient's defaultTimeoutMs) gives every request, `stop`
        // included, a flat 30 s timeout. This backstop bounds the
        // display-teardown path at `stopTimeoutSeconds` (unchanged from before
        // the camera existed): stream.stopCapture -> gate.closeAndMarkFinished
        // -> writer.finishWriting. CameraCapture.stop() carries its own,
        // shorter, backstop around session.stopRunning() ->
        // gate.closeAndMarkFinished -> writer.finishWriting and answers exactly
        // once. Both numbers and the client's are asserted as one chain in
        // helper/test/stop-bounds.test.ts rather than kept in step by comment.
        //
        // Both teardowns are entered into the DispatchGroup below before
        // either is awaited, and `cam.stop` is dispatched onto a background
        // queue rather than called inline — AVCaptureSession.stopRunning()
        // is a DOCUMENTED BLOCKING call, so calling it inline here would
        // execute synchronously on whatever queue reaches this line, which
        // for every real caller is the main queue (App.stop runs commands
        // dispatched by IO.readCommands's DispatchQueue.main.async, and
        // calls session.stop inline). A blocking call on the main queue
        // would (a) delay stream.stopCapture from even starting until the
        // camera had fully released, defeating the concurrency this
        // DispatchGroup exists to provide, and (b) stall `status`, `quit`,
        // and the display-reconfiguration watcher for however long the
        // camera takes to close. Dispatching it means the two teardowns
        // genuinely overlap and neither can block command dispatch, so the
        // worst case stays max(20 s, 10 s) = 20 s, comfortably under the
        // client's 30 s bound — and unlike the two backstops racing on
        // shared main-queue time, they now race on entirely separate queues.
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.stopTimeoutSeconds) {
            finishUp("\(reason)-timeout")
        }

        let group = DispatchGroup()

        if let cam {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                cam.stop { track in
                    self?.lock.lock()
                    self?.cameraTrack = track
                    self?.camera = nil
                    self?.lock.unlock()
                    group.leave()
                }
            }
        }

        if let m {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                m.stop { track in
                    self?.lock.lock()
                    self?.micTrack = track
                    self?.mic = nil
                    self?.lock.unlock()
                    group.leave()
                }
            }
        }

        if let sysAudio {
            group.enter()
            sysAudio.stop { [weak self] track in
                self?.lock.lock()
                self?.systemAudioTrack = track
                self?.systemAudio = nil
                self?.lock.unlock()
                group.leave()
            }
        }

        group.enter()
        if let stream {
            stream.stopCapture { [weak self] _ in
                guard let self else { group.leave(); return }
                // Returns only once any in-flight append has finished, so the
                // finishWriting below cannot race one (STC-254).
                self.gate.closeAndMarkFinished()
                guard let writer = self.writer else { group.leave(); return }
                writer.finishWriting { group.leave() }
            }
        } else {
            group.leave()
        }

        group.notify(queue: .global()) {
            finishUp(reason)
        }
    }

    private func writeSidecars(reason: String) {
        lock.lock()
        let evs = events
        let camTrack = cameraTrack
        let micT = micTrack
        let sysT = systemAudioTrack
        lock.unlock()

        // events-2 since STC-309: v1 plus `{t, kind: "cursor", shape}`. The
        // loader accepts both; fixtures/basic was already v2. Time-ordered on
        // the way out because two clocks feed `events` (see orderedEvents).
        write(["version": 2, "events": orderedEvents(evs)] as [String: Any], to: "events.json")
        // Stop while paused: the open span closes at the stop instant, so the
        // sidecar describes the whole take rather than trailing off.
        let stopTNs = Int64(Clock.nowNs() - t0Ns)
        pauseGate.close(atNs: stopTNs)
        let pauses = pauseGate.intervals
        // Exact, from the helper's own clock. The same offset survives in the
        // file only as a timescale-quantised empty edit, so this is what a
        // reader checks its recovered value against.
        let doc = anchorsDocument(
            timebase: (Int(Clock.timebase.numer), Int(Clock.timebase.denom)),
            t0Ns: t0Ns,
            display: DisplayGeometry(id: Int(displayID), pointWidth: pointW, pointHeight: pointH,
                                     pixelWidth: pixelW, pixelHeight: pixelH,
                                     originX: originX, originY: originY),
            capture: CaptureGeometryDoc(width: captureW, height: captureH,
                                        firstFrameNs: Int(firstFramePtsNs)),
            camera: camTrack,
            requested: wantCamera,
            mic: micT,
            micRequested: wantMicUid != nil,
            systemAudio: sysT,
            systemAudioRequested: wantSystemAudio,
            scope: captureScope,
            pauses: pauses,
            stopReason: reason,
            stopTNs: Int(stopTNs))
        write(doc, to: "anchors.json")
    }

    private func write(_ o: Any, to name: String) {
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else {
            IO.send("error", ["code": "sidecar-encode-failed", "file": name]); return
        }
        try? d.write(to: dir.appendingPathComponent(name))
    }
}

enum CaptureError: Error, CustomStringConvertible {
    case noDisplays(underlying: Error?)
    case writerRejectedInput
    case writerFailed(Error?)
    case streamFailed(Error)
    case startTimedOut
    case frameStatusMismatch(actual: Int)
    /// STC-247: `start` named a display SCK did not list.
    case displayNotFound(requested: CGDirectDisplayID, available: [CGDirectDisplayID])
    /// STC-315: `CGEvent.tapCreate` returned nil, so this take could carry no
    /// cursor track. Refusing is the policy, not a fallback — see `begin()`.
    case eventTapUnavailable
    /// STC-370: `start` named a windowId SCK's on-screen list does not have —
    /// closed, on another space, or never existed.
    case windowNotFound(requested: UInt32)
    /// STC-370: a region scope's rectangle does not overlap the display it
    /// was resolved against at all. Mirrors `StillError.cropOutsideDisplay`.
    case cropOutsideDisplay

    var description: String {
        switch self {
        case .displayNotFound(let requested, let available):
            let list = available.map(String.init).joined(separator: ", ")
            return "display \(requested) is not available; displays: [\(list)] — pick one of those, or omit displayId"
        case .noDisplays(let e):
            return "no displays available — Screen Recording permission is the usual cause (\(e.map { "\($0)" } ?? "no error"))"
        case .writerRejectedInput: return "AVAssetWriter rejected the video input"
        case .writerFailed(let e): return "AVAssetWriter failed to start: \(e.map { "\($0)" } ?? "unknown")"
        case .streamFailed(let e): return "SCStream failed to start: \(e)"
        case .startTimedOut: return "capture did not start within 15s and reported no error"
        case .frameStatusMismatch(let actual):
            return "SCFrameStatus.complete is \(actual), not \(SCFrameStatusCompleteRaw) — "
                 + "CaptureDecisions.swift must be updated or every frame will be discarded"
        case .eventTapUnavailable:
            return "cursor input could not be recorded (CGEvent.tapCreate returned nil) — "
                 + "Input Monitoring is the usual cause. The cursor is never only in the "
                 + "video, so a take with no cursor track is not started at all."
        case .windowNotFound(let id):
            return "no on-screen window with id \(id) — it may have closed, or never existed"
        case .cropOutsideDisplay:
            return "the region does not overlap the display it was resolved against"
        }
    }
    var code: String {
        switch self {
        case .noDisplays: return "no-displays"
        case .writerRejectedInput: return "writer-rejected-input"
        case .writerFailed: return "writer-failed"
        case .streamFailed: return "stream-failed"
        case .startTimedOut: return "start-timeout"
        case .frameStatusMismatch: return "frame-status-mismatch"
        case .displayNotFound: return "display-not-found"
        case .eventTapUnavailable: return "event-tap-unavailable"
        case .windowNotFound: return "window-not-found"
        case .cropOutsideDisplay: return "crop-outside-display"
        }
    }
}
