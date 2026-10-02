import Foundation
import CoreAudioTypes

/// STC-485's pure decisions: what format the mic's capture output is pinned to,
/// and the guard that refuses to write audio whose bytes do not match the
/// format they are described as. No AVFoundation, no device — tested by
/// `helper/test/mic-format/`.
///
/// The bug: a take's `mic.m4a` intermittently held full-scale white noise for
/// the whole take, decoding to exactly 4/3 of the recorded span. Measured on
/// the Elgato Wave:3 (2026-10-02): its native format is 24-bit integer PACKED,
/// 3 bytes per frame, and that format was what `AVCaptureAudioDataOutput`
/// delivered when left to choose. A buffer whose bytes are really 4 per frame
/// (float32, or 24-in-32) but described as 3 is read as 4/3 as many frames of
/// misaligned bytes — exactly the length ratio and exactly white noise. The
/// trigger was never reproduced (16 opens alone and against a second client on
/// the device, all clean), so two separate things are done here:
///
/// 1. `pinned(...)`: the capture output is ASKED for float32 interleaved at the
///    device's own rate and channel count, so the format the writer encodes is
///    one this app chose rather than whatever the device's driver exposes.
///    Measured on the Wave:3: 512 frames, 2048 bytes, pacing exact.
/// 2. `MicFormatGuard`: whatever arrives is checked, and the first buffer that
///    is not what was asked for ends the mic track with a warning — a shorter
///    mic track the user is told about, never a silent file of noise.
struct MicFormat: Equatable, CustomStringConvertible {
    let sampleRate: Double
    let formatID: UInt32
    let flags: UInt32
    let bytesPerFrame: UInt32
    let channels: UInt32
    let bitsPerChannel: UInt32

    init(sampleRate: Double, formatID: UInt32, flags: UInt32, bytesPerFrame: UInt32,
         channels: UInt32, bitsPerChannel: UInt32) {
        self.sampleRate = sampleRate
        self.formatID = formatID
        self.flags = flags
        self.bytesPerFrame = bytesPerFrame
        self.channels = channels
        self.bitsPerChannel = bitsPerChannel
    }

    init(_ a: AudioStreamBasicDescription) {
        self.init(sampleRate: a.mSampleRate, formatID: a.mFormatID, flags: a.mFormatFlags,
                  bytesPerFrame: a.mBytesPerFrame, channels: a.mChannelsPerFrame,
                  bitsPerChannel: a.mBitsPerChannel)
    }

    /// float32, native-endian, packed, interleaved. The flags are exactly what
    /// `AVCaptureAudioDataOutput` reports back when asked for this (0x9 on
    /// the Wave:3 and the built-in mic alike) — an `audioSettings` request with
    /// no `AVLinearPCMIsNonInterleaved: true` is interleaved, and interleaved
    /// is the absence of the non-interleaved flag, not a flag of its own.
    static func pinned(sampleRate: Double, channels: Int) -> MicFormat {
        MicFormat(sampleRate: sampleRate, formatID: kAudioFormatLinearPCM,
                  flags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                  bytesPerFrame: UInt32(4 * channels), channels: UInt32(channels),
                  bitsPerChannel: 32)
    }

    var description: String {
        let kind = flags & kAudioFormatFlagIsFloat != 0 ? "float" : "int"
        return "\(Int(sampleRate)) Hz, \(channels) ch, \(bitsPerChannel)-bit \(kind), "
             + "\(bytesPerFrame) bytes/frame, flags 0x\(String(flags, radix: 16))"
    }
}

/// Why the guard ended the mic track.
enum MicFormatFault: Equatable {
    /// A buffer's own description is not the pinned one.
    case formatChanged(delivered: MicFormat)
    /// The description is the pinned one but the byte count disagrees with it.
    case sizeMismatch(numSamples: Int, dataBytes: Int, bytesPerFrame: Int)
    /// Description and byte count agree with each other, but the buffers carry
    /// more or fewer frames than the time between them allows. THIS is the
    /// STC-485 signature as the bad takes recorded it: the description and the
    /// byte count are consistent by construction when the frame count was
    /// itself derived from the wrong bytes-per-frame, so only the clock can
    /// tell. `ratio` is frames-implied duration over elapsed PTS.
    case pacing(ratio: Double)

    var detail: String {
        switch self {
        case .formatChanged(let d):
            return "the microphone delivered \(d), not the format the recording was set up for"
        case .sizeMismatch(let n, let b, let bpf):
            return "a microphone buffer of \(n) frames held \(b) bytes, not \(n * bpf)"
        case .pacing(let r):
            return "the microphone delivered \(String(format: "%.2f", r))x as much audio as time passed — "
                 + "its bytes are not in the format they are labelled as"
        }
    }
}

enum MicBufferVerdict: Equatable {
    case append
    /// Not written. Every buffer after a trip is a drop.
    case drop
    /// This buffer is the first bad one: not written, and the caller warns.
    case trip(MicFormatFault)
}

struct MicFormatGuard {
    let expected: MicFormat

    /// How much contiguous delivery a pacing verdict is taken over. Long enough
    /// that one late buffer's jitter is noise (a buffer is ~10.7 ms on the
    /// Wave:3), short enough that a format switch mid-take is caught within
    /// seconds — and the noise ahead of the verdict is bounded by it.
    static let pacingWindowNs: Int64 = 2_000_000_000
    /// The bad takes measured 1.33; clean ones 1.00. Anything a real clock can
    /// do sits far inside this, and 4/3 and 3/4 sit far outside it.
    static let pacingTolerance = 0.1
    /// A gap between two buffers longer than this many times the first
    /// buffer's own duration is a DROPOUT, not a mislabelled format, and is
    /// left out of the pacing sums — otherwise a real hiccup in delivery would
    /// read as "too few frames" and end a healthy mic track. A mislabelled
    /// width moves the ratio by 4/3 or 3/4, well under this.
    static let gapFactor = 2.0

    private(set) var tripped: MicFormatFault?
    private var prevPtsNs: Int64 = -1
    private var prevSamples = 0
    /// Duration the window's frames claim, and the PTS time they actually spanned.
    private var claimedNs: Double = 0
    private var elapsedNs: Double = 0

    init(expected: MicFormat) { self.expected = expected }

    mutating func check(format: MicFormat, numSamples: Int, dataBytes: Int, ptsNs: Int64) -> MicBufferVerdict {
        if tripped != nil { return .drop }
        if format != expected { return trip(.formatChanged(delivered: format)) }
        if dataBytes != numSamples * Int(expected.bytesPerFrame) {
            return trip(.sizeMismatch(numSamples: numSamples, dataBytes: dataBytes,
                                      bytesPerFrame: Int(expected.bytesPerFrame)))
        }

        if prevPtsNs >= 0 {
            let claimed = Double(prevSamples) / expected.sampleRate * 1e9
            let elapsed = Double(ptsNs - prevPtsNs)
            if elapsed > 0, elapsed <= claimed * Self.gapFactor {
                claimedNs += claimed
                elapsedNs += elapsed
            }
            if elapsedNs >= Double(Self.pacingWindowNs) {
                let ratio = claimedNs / elapsedNs
                claimedNs = 0
                elapsedNs = 0
                if abs(ratio - 1) > Self.pacingTolerance {
                    prevPtsNs = ptsNs
                    prevSamples = numSamples
                    return trip(.pacing(ratio: ratio))
                }
            }
        }
        prevPtsNs = ptsNs
        prevSamples = numSamples
        return .append
    }

    private mutating func trip(_ f: MicFormatFault) -> MicBufferVerdict {
        tripped = f
        return .trip(f)
    }
}
