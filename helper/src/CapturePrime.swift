import Foundation
import CoreGraphics
import CoreMedia
import ScreenCaptureKit

/// `prime-capture` (STC-522): one throwaway ScreenCaptureKit stream, so that
/// macOS's "Capture is requesting to bypass the system private window picker"
/// consent comes up at launch rather than inside the first take.
///
/// It is the STREAM that raises it. The window list does not: the Record flow
/// already calls `windows` before its overlay opens, and in a clean VM's TCC
/// log `replayd` made the ScreenCapture request only at stream start. So this
/// starts a real one, tiny (16x16 of the main display, 10 fps, no cursor, no
/// audio), holds it for `holdMs`, and stops it. Nothing is written anywhere.
///
/// It answers once the stream has STOPPED, not once the dialog is answered:
/// nothing reports the dialog, and it stays up on its own after the stream
/// ends. The hold exists only so the stream is alive long enough for
/// `replayd` to ask; whether it is long enough is runbook §2's question.
///
/// When to run it, and how often, is the app's decision (`permissions.ts`
/// rule 8). The helper only refuses to run it during a take or twice at once.
final class CapturePrime: NSObject, SCStreamOutput, SCStreamDelegate {
    static let defaultHoldMs = 1000
    /// Past this, answer `prime-timeout` rather than leave the app waiting.
    /// The same 10 s a still allows for its own ScreenCaptureKit round trip.
    static let timeoutSeconds: Double = 10

    /// The one run in flight. Holding it here is also what keeps the stream
    /// and its output alive: SCStream does not retain its delegate.
    private static var active: CapturePrime?
    static var running: Bool { active != nil }

    private let holdMs: Int
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "stc.prime.screen")
    private var stream: SCStream?
    private var frames = 0
    private var completion: ((Result<[String: Any], PrimeError>) -> Void)?

    private init(holdMs: Int, completion: @escaping (Result<[String: Any], PrimeError>) -> Void) {
        self.holdMs = holdMs
        self.completion = completion
    }

    /// Main thread only, like every command in `main.swift`. `completion` runs
    /// on the main thread, exactly once.
    static func run(holdMs: Int, completion: @escaping (Result<[String: Any], PrimeError>) -> Void) {
        let p = CapturePrime(holdMs: max(0, holdMs), completion: completion)
        active = p
        p.begin()
    }

    private func begin() {
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeoutSeconds) { [weak self] in
            self?.finish(.failure(.timedOut))
        }
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, err in
            guard let self else { return }
            let main = CGMainDisplayID()
            guard let displays = content?.displays, !displays.isEmpty else {
                self.finish(.failure(.noDisplays(err))); return
            }
            let display = displays.first { $0.displayID == main } ?? displays[0]
            let cfg = SCStreamConfiguration()
            cfg.width = 16
            cfg.height = 16
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 10)
            cfg.queueDepth = 3
            cfg.showsCursor = false
            cfg.capturesAudio = false
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let s = SCStream(filter: filter, configuration: cfg, delegate: self)
            do {
                try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
            } catch {
                self.finish(.failure(.streamFailed(error))); return
            }
            self.lock.lock(); self.stream = s; self.lock.unlock()
            s.startCapture { [weak self] err in
                guard let self else { return }
                if let err { self.finish(.failure(.streamFailed(err))); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(self.holdMs)) { [weak self] in
                    self?.stopAndAnswer()
                }
            }
        }
    }

    private func stopAndAnswer() {
        lock.lock(); let s = stream; stream = nil; lock.unlock()
        guard let s else { return }
        s.stopCapture { [weak self] _ in
            guard let self else { return }
            self.lock.lock(); let n = self.frames; self.lock.unlock()
            self.finish(.success(["frames": n, "heldMs": self.holdMs]))
        }
    }

    /// Exactly once, from whichever of answer, failure or timeout comes first.
    /// A stream still running at that point is stopped and not waited for.
    private func finish(_ r: Result<[String: Any], PrimeError>) {
        DispatchQueue.main.async { [self] in
            guard let c = completion else { return }
            completion = nil
            lock.lock(); let s = stream; stream = nil; lock.unlock()
            s?.stopCapture { _ in }
            if Self.active === self { Self.active = nil }
            c(r)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        lock.lock(); frames += 1; lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        finish(.failure(.streamFailed(error)))
    }
}

enum PrimeError: Error {
    case noDisplays(Error?)
    case streamFailed(Error)
    case timedOut

    var code: String {
        switch self {
        case .noDisplays:   return "no-displays"
        case .streamFailed: return "prime-failed"
        case .timedOut:     return "prime-timeout"
        }
    }

    var detail: String {
        switch self {
        case .noDisplays(let e):   return "no shareable display" + (e.map { ": \($0.localizedDescription)" } ?? "")
        case .streamFailed(let e): return e.localizedDescription
        case .timedOut:            return "prime did not finish within \(Int(CapturePrime.timeoutSeconds)) s"
        }
    }
}
