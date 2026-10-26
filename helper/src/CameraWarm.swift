import Foundation
import AVFoundation

/// A camera session `CameraCapture.openSession` has opened: device chosen,
/// input and output configured, possibly already running. It carries no
/// delegate and no writer, so it belongs to nobody until a take adopts it.
final class OpenedCamera {
    let session: AVCaptureSession
    let output: AVCaptureVideoDataOutput
    let name: String
    let uid: String
    /// Chosen by `pickCamera`'s ranking rather than named by the app. Decides
    /// whether a later automatic request may adopt it (`decideWarmAdoption`).
    let automatic: Bool
    /// `startRunning()` has returned: frames are flowing to nobody yet.
    let running: Bool
    let discoverMs: Int
    let configureMs: Int
    let startRunningMs: Int
    /// The warm output's delegate while no take owns it. An `AVCaptureVideoDataOutput` holds its
    /// delegate WEAKLY, so this is what keeps the sink alive. nil for a cold open.
    let sink: WarmFrameSink?

    init(session: AVCaptureSession, output: AVCaptureVideoDataOutput, name: String, uid: String,
         automatic: Bool, running: Bool, discoverMs: Int, configureMs: Int, startRunningMs: Int,
         sink: WarmFrameSink? = nil) {
        self.session = session; self.output = output; self.name = name; self.uid = uid
        self.automatic = automatic; self.running = running
        self.discoverMs = discoverMs; self.configureMs = configureMs; self.startRunningMs = startRunningMs
        self.sink = sink
    }
}

/// Keeps a warm camera's output PULLING frames, and discards them, until a take adopts the session.
///
/// Measured on hardware 2026-10-26: with the output attached to nothing, a warmed camera's first
/// ~1 s in camera.mp4 was BLACK, although the camera had been running for the whole countdown.
/// The first frame landed at 0.1 s but was not a picture. The working theory is that the output
/// only starts consuming the camera once it has a delegate, so the black stretch moved from before
/// the take into it. A sink makes the output live during the warm-up; the take swaps itself in.
/// `stats()` says what the sink saw, so the next run shows whether that was the cause.
final class WarmFrameSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let queue = DispatchQueue(label: "stc.capture.camera.warm")
    private let lock = NSLock()
    private var frames = 0
    private var lastLuma = -1

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        // Brightness every 10th frame only: this runs for the whole countdown and must stay cheap.
        var luma = -1
        lock.lock(); let n = frames; lock.unlock()
        if n % 10 == 0, let pb = CMSampleBufferGetImageBuffer(sb) { luma = meanLuma(pb) }
        lock.lock()
        frames += 1
        if luma >= 0 { lastLuma = luma }
        lock.unlock()
    }

    /// Frames seen so far and the brightness (0-255, -1 unread) of the latest sampled one.
    func stats() -> (frames: Int, luma: Int) {
        lock.lock(); defer { lock.unlock() }
        return (frames, lastLuma)
    }
}

/// Mean brightness of a frame's luma plane, 0-255, from a coarse grid (about 600 samples), or -1
/// when it is not a planar format. Video-range black is 16, so a black frame reads ~16.
func meanLuma(_ pb: CVPixelBuffer) -> Int {
    guard CVPixelBufferGetPlaneCount(pb) > 0 else { return -1 }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else { return -1 }
    let w = CVPixelBufferGetWidthOfPlane(pb, 0), h = CVPixelBufferGetHeightOfPlane(pb, 0)
    let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
    guard w > 0, h > 0 else { return -1 }
    let p = base.assumingMemoryBound(to: UInt8.self)
    var sum = 0, count = 0
    var y = h / 40
    while y < h {
        var x = w / 40
        while x < w {
            sum += Int(p[y * stride + x]); count += 1
            x += max(1, w / 30)
        }
        y += max(1, h / 20)
    }
    return count == 0 ? -1 : sum / count
}

/// The camera, opened before Record so it is already delivering frames at the
/// take's t0.
///
/// A cold open is most of a second to two (a USB Facecam measured 2.2 s; the
/// FaceTime camera 1.1 to 1.6 s to its first frame), and `startCameraAsync` only
/// begins it after the display stream is up, so every take's camera started
/// about that long after its screen. Nothing about a take can make an unopened
/// camera faster; only opening it earlier can. The app asks for this when the
/// countdown begins (`camera-warm`) and the take adopts it (`take`).
///
/// The camera's LED is on for as long as a session runs, so a warm-up never
/// outlives its purpose: `release` (the app's cancel), a take adopting it, a
/// start that fails, and the hold timer as the backstop for an app that died
/// between asking and releasing.
final class WarmCamera {
    static let shared = WarmCamera()

    /// Longer than the countdown plus the window hide and the start (a few
    /// seconds) by a wide margin, short enough that a forgotten warm camera is
    /// not a camera left lit.
    static let defaultHoldSeconds: Double = 20
    /// The app passes the countdown's length plus a margin (a countdown can run to
    /// a minute); this keeps a bad value from holding a lit camera for long.
    static let maxHoldSeconds: Double = 90
    /// How long `take` waits for an open that is still in flight, rather than
    /// opening the same device a second time beside it.
    static let adoptWaitSeconds: Double = 3

    private let lock = NSLock()
    private var warm: OpenedCamera?
    private var inflight: DispatchGroup?
    /// Bumped by every `release`/`take`, so an open that finishes after either
    /// finds its generation gone and stops what it opened.
    private var generation = 0
    private var expiry: DispatchSourceTimer?

    /// Opens (or confirms) the warm camera off the calling thread. `completion`
    /// gets the device name and uid, or the error. One warm camera at a time: a
    /// different device replaces the old one.
    func warmUp(deviceUid: String?, holdSeconds: Double = WarmCamera.defaultHoldSeconds, completion: @escaping (Result<(name: String, uid: String, openMs: Int), Error>) -> Void) {
        lock.lock()
        if let w = warm, decideWarmAdoption(requestedUid: deviceUid, warmUid: w.uid, warmAutomatic: w.automatic) {
            lock.unlock()
            completion(.success((w.name, w.uid, 0)))
            return
        }
        let stale = warm
        warm = nil
        expiry?.cancel(); expiry = nil
        generation += 1
        let gen = generation
        let group = DispatchGroup()
        group.enter()
        inflight = group
        lock.unlock()
        stale?.session.stopRunning()

        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let t = Clock.nowNs()
            let result = CameraCapture.openSession(deviceUid: deviceUid, startRunning: true)
            lock.lock()
            let out: Result<(name: String, uid: String, openMs: Int), Error>
            switch result {
            case .failure(let e):
                out = .failure(e)
            case .success(let o):
                if gen == generation {
                    warm = o
                    armExpiry(gen, holdSeconds: min(max(holdSeconds, 5), Self.maxHoldSeconds))
                    out = .success((o.name, o.uid, Int((Clock.nowNs() - t) / 1_000_000)))
                } else {
                    // Released or adopted-around while opening: nobody wants it.
                    o.session.stopRunning()
                    out = .failure(CameraWarmError.superseded)
                }
            }
            if inflight === group { inflight = nil }
            lock.unlock()
            group.leave()
            completion(out)
        }
    }

    /// Hands the warm camera to a take, waiting briefly for one still opening.
    /// nil when there is none, or when it has been released. The take decides
    /// whether it is the right device (`decideWarmAdoption`).
    func take() -> OpenedCamera? {
        lock.lock()
        let group = inflight
        lock.unlock()
        _ = group?.wait(timeout: .now() + Self.adoptWaitSeconds)
        lock.lock(); defer { lock.unlock() }
        let w = warm
        warm = nil
        expiry?.cancel(); expiry = nil
        generation += 1
        return w
    }

    /// Stops the warm camera, if any, and cancels an open in flight.
    func release() {
        lock.lock()
        let w = warm
        warm = nil
        expiry?.cancel(); expiry = nil
        generation += 1
        lock.unlock()
        w?.session.stopRunning()
    }

    /// Called with `lock` held.
    private func armExpiry(_ gen: Int, holdSeconds: Double) {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        t.schedule(deadline: .now() + holdSeconds)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let current = self.generation == gen
            self.lock.unlock()
            if current {
                IO.log("camera warm-up unclaimed after \(Int(holdSeconds)) s; releasing it")
                self.release()
            }
        }
        expiry = t
        t.resume()
    }
}

enum CameraWarmError: Error, CustomStringConvertible {
    /// A release (or a newer warm-up) arrived while this one was opening.
    case superseded

    var description: String { "the camera warm-up was released before it finished opening" }
    var code: String { "camera-warm-superseded" }
}
