import Foundation
import AVFoundation

/// `WriterGate`'s twin for an audio `AVAssetWriterInput` (STC-233).
///
/// Not the same type: `WriterGate.append` takes a `CVPixelBuffer` plus an
/// explicit `CMTime` and goes through an `AVAssetWriterInputPixelBufferAdaptor`,
/// which has no audio equivalent — an audio input is appended a `CMSampleBuffer`
/// directly, with its timing already baked in. The rule the two share is the
/// one that matters: STC-254 fixed a crash by holding a lock ACROSS the append,
/// not just around the nil checks, because the window that kills the process is
/// the append's own duration. That rule is duplicated here on purpose, the same
/// way `CameraCapture` and `CaptureSession` each own a separate `AVAssetWriter`
/// rather than sharing one — two independent optional subsystems, not one value
/// copied twice.
final class AudioWriterGate {
    enum Outcome {
        case appended
        case dropped
    }

    private let lock = NSLock()
    private var input: AVAssetWriterInput?
    private var finishing = false

    func install(input: AVAssetWriterInput) {
        lock.lock(); defer { lock.unlock() }
        self.input = input
    }

    /// Appends one sample buffer, or reports why it could not.
    func append(_ sampleBuffer: CMSampleBuffer) -> Outcome {
        lock.lock(); defer { lock.unlock() }
        guard !finishing, let input, input.isReadyForMoreMediaData else {
            return .dropped
        }
        return input.append(sampleBuffer) ? .appended : .dropped
    }

    /// Closes the gate and marks the input finished. Returns false if the gate
    /// was already closed, so a second stop cannot mark a finished input again.
    @discardableResult
    func closeAndMarkFinished() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if finishing { return false }
        finishing = true
        input?.markAsFinished()
        return true
    }
}
