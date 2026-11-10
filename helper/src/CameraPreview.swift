import Foundation
import AVFoundation
import CoreImage
import ImageIO

/// STC-638: a live camera view, as JPEG frames on the lossy channel.
///
/// A preview is one more consumer of the WARM camera (`CameraWarm.swift`), never
/// a second opener and never a take: it sets itself as the warm output's
/// sample-buffer delegate, and a take that adopts the warm session sets ITS
/// delegate, which ends the preview with no hand-off (spike, 2026-11-10: the
/// preview stopped, the take got 60 fps). Rules in `CameraPreviewDecisions.swift`.
///
/// It opens nothing the user has not already allowed: `openSession` refuses
/// without a Camera grant and never prompts, so a preview on a Mac that has not
/// granted Camera answers `camera-not-authorized` and lights nothing.
final class CameraPreview: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    static let shared = CameraPreview()

    private final class Active {
        let output: AVCaptureVideoDataOutput
        let name: String
        let uid: String
        let automatic: Bool
        let ownsCamera: Bool
        var lastEmittedNs: Int64 = -1
        var frames = 0
        var timer: DispatchSourceTimer?
        var observer: NSObjectProtocol?
        init(output: AVCaptureVideoDataOutput, name: String, uid: String, automatic: Bool, ownsCamera: Bool) {
            self.output = output; self.name = name; self.uid = uid
            self.automatic = automatic; self.ownsCamera = ownsCamera
        }
    }

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "stc.camera-preview")
    private var active: Active?
    /// Bumped by every start/stop so an open that finishes late finds it gone.
    private var generation = 0
    private let ciContext = CIContext()
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    /// Opens (or confirms) the preview. `completion` gets the device and uid once
    /// the session is running; frames follow on the lossy channel. A cold open
    /// can take seconds (an Elgato measured 3.2 s), which is why this replies
    /// when it is RUNNING and the first frame is a separate, later event.
    func start(deviceUid: String?,
               completion: @escaping (Result<(name: String, uid: String, openMs: Int), Error>) -> Void) {
        lock.lock()
        if let a = active, decideWarmAdoption(requestedUid: deviceUid, warmUid: a.uid, warmAutomatic: a.automatic) {
            lock.unlock()
            completion(.success((a.name, a.uid, 0)))
            return
        }
        let stale = active
        active = nil
        generation += 1
        let gen = generation
        lock.unlock()
        if let stale { teardown(stale, release: true) }

        let wasWarm = WarmCamera.shared.isWarm
        let t = Clock.nowNs()
        WarmCamera.shared.warmUp(deviceUid: deviceUid, holdSeconds: WarmCamera.maxHoldSeconds) { [self] result in
            switch result {
            case .failure(let e):
                completion(.failure(e))
            case .success(let w):
                lock.lock()
                guard gen == generation else {
                    lock.unlock()
                    completion(.failure(CameraWarmError.superseded))
                    return
                }
                let attached: Active? = WarmCamera.shared.withWarm { o in
                    let a = Active(output: o.output, name: o.name, uid: o.uid, automatic: o.automatic,
                                   ownsCamera: previewReleasesOnStop(wasWarmBefore: wasWarm))
                    o.output.setSampleBufferDelegate(self, queue: queue)
                    return a
                }
                guard let a = attached else {
                    // Released between the open and now: nothing to show.
                    lock.unlock()
                    completion(.failure(CameraWarmError.superseded))
                    return
                }
                active = a
                lock.unlock()
                armTimeout(a, gen: gen)
                a.observer = NotificationCenter.default.addObserver(
                    forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil
                ) { [weak self] note in
                    guard let d = note.object as? AVCaptureDevice, d.uniqueID == a.uid else { return }
                    self?.stop(reason: .deviceLost, ifGeneration: gen)
                }
                completion(.success((w.name, w.uid, Int((Clock.nowNs() - t) / 1_000_000))))
            }
        }
    }

    /// The app's stop, and every other stop but a take's. True when a preview was
    /// running. Announces the stop (reliably) for every reason but the app's own,
    /// which is answered by the command's reply.
    @discardableResult
    func stop(reason: PreviewStopReason, ifGeneration: Int? = nil) -> Bool {
        lock.lock()
        if let g = ifGeneration, g != generation { lock.unlock(); return false }
        guard let a = active else { lock.unlock(); return false }
        active = nil
        generation += 1
        lock.unlock()
        teardown(a, release: true)
        if reason != .stopped { IO.send("camera-preview-stopped", ["reason": reason.rawValue]) }
        return true
    }

    /// A take is starting (`main.swift`'s `start`, before anything else): let go
    /// of the camera's output WITHOUT releasing the session, because the take
    /// adopts it or releases it itself. Announces `take-started` when a preview
    /// was running.
    func detachForTake() {
        lock.lock()
        guard let a = active else { lock.unlock(); return }
        active = nil
        generation += 1
        lock.unlock()
        teardown(a, release: false)
        IO.send("camera-preview-stopped", ["reason": PreviewStopReason.takeStarted.rawValue])
    }

    var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return active != nil }

    private func armTimeout(_ a: Active, gen: Int) {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        t.schedule(deadline: .now() + CameraPreviewLimits.maxSeconds)
        t.setEventHandler { [weak self] in self?.stop(reason: .timeout, ifGeneration: gen) }
        a.timer = t
        t.resume()
    }

    /// Lets go of the output; releases the camera only when the preview opened it
    /// (rule 3) and the caller says so.
    private func teardown(_ a: Active, release: Bool) {
        a.timer?.cancel(); a.timer = nil
        if let o = a.observer { NotificationCenter.default.removeObserver(o); a.observer = nil }
        // Only clear the delegate while it is still ours: a take that already
        // adopted the session has set its own.
        if let d = a.output.sampleBufferDelegate, d === self {
            a.output.setSampleBufferDelegate(nil, queue: nil)
        }
        if release && a.ownsCamera { WarmCamera.shared.release() }
    }

    // MARK: frames

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        lock.lock()
        guard let a = active, a.output === output else { lock.unlock(); return }
        let now = Int64(Clock.nowNs())
        guard decidePreviewEmit(lastEmittedNs: a.lastEmittedNs, nowNs: now) else { lock.unlock(); return }
        a.lastEmittedNs = now
        a.frames += 1
        let n = a.frames
        lock.unlock()
        guard let pb = CMSampleBufferGetImageBuffer(sb), let f = encode(pb) else { return }
        // IO.stat, never IO.send: the lossy channel exists so a frame can be
        // dropped without ever holding anything up.
        IO.stat("camera-preview-frame", ["n": n, "w": f.w, "h": f.h, "jpeg": f.jpeg.base64EncodedString()])
    }

    private func encode(_ pb: CVPixelBuffer) -> (jpeg: Data, w: Int, h: Int)? {
        let ci = CIImage(cvPixelBuffer: pb)
        let w = ci.extent.width
        guard w > 0 else { return nil }
        let s = CGFloat(CameraPreviewLimits.width) / w
        let scaled = ci.transformed(by: CGAffineTransform(scaleX: s, y: s))
        let opts: [CIImageRepresentationOption: Any] = [
            CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String):
                CameraPreviewLimits.jpegQuality
        ]
        guard let data = ciContext.jpegRepresentation(of: scaled, colorSpace: colorSpace, options: opts) else { return nil }
        return (data, Int(scaled.extent.width.rounded()), Int(scaled.extent.height.rounded()))
    }
}
