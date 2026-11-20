// `make-poster` (STC-671): one frame of a take's display.mp4, as a small JPEG
// beside it, for the Library tile. AVAssetImageGenerator, never WebCodecs: it
// decodes one frame in this process and keeps nothing, which is why a poster can
// be made for every recording where a renderer-side decode could not.
// State-free like `export-still`: a poster must not be refused during a take.
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

enum Poster {
    /// The tile's widest edge. The Library grid draws ~3 columns; 640 stays sharp at 2x.
    static let maxEdge: CGFloat = 640
    static let quality = 0.8

    static func run(_ cmd: [String: Any], done: @escaping (Result<[String: Any], PosterRefusal>) -> Void) {
        switch parsePosterRequest(cmd) {
        case .failure(let e): done(.failure(e))
        case .success(let req):
            let gen = AVAssetImageGenerator(asset: AVURLAsset(url: req.video))
            gen.appliesPreferredTrackTransform = true
            gen.maximumSize = CGSize(width: maxEdge, height: maxEdge)
            // A poster is a picture of the take, not of one exact PTS.
            gen.requestedTimeToleranceBefore = .positiveInfinity
            gen.requestedTimeToleranceAfter = .positiveInfinity
            let t = CMTime(value: CMTimeValue(req.timeMs), timescale: 1000)
            gen.generateCGImagesAsynchronously(forTimes: [NSValue(time: t)]) { _, image, _, result, error in
                guard result == .succeeded, let image else {
                    done(.failure(PosterRefusal(reason: "could not read a frame: \(error?.localizedDescription ?? "unknown")")))
                    return
                }
                done(write(image, to: req.out))
            }
        }
    }

    /// Written to a sibling then renamed, so a reader never sees half a JPEG.
    private static func write(_ image: CGImage, to out: URL) -> Result<[String: Any], PosterRefusal> {
        let tmp = out.deletingLastPathComponent().appendingPathComponent(".poster.jpg.partial")
        guard let dest = CGImageDestinationCreateWithURL(tmp as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            return .failure(PosterRefusal(reason: "could not open the poster for writing"))
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            try? FileManager.default.removeItem(at: tmp)
            return .failure(PosterRefusal(reason: "could not encode the poster"))
        }
        do {
            _ = try FileManager.default.replaceItemAt(out, withItemAt: tmp)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            return .failure(PosterRefusal(reason: "could not save the poster: \(error.localizedDescription)"))
        }
        return .success(["file": POSTER_FILE, "width": image.width, "height": image.height])
    }
}
