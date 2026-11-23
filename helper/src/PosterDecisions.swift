// `make-poster`'s pure half (STC-671): which frame of a recording is its
// Library picture, and is this request one we will act on? No AVFoundation, so
// `helper/test/poster/` checks it without a video.
import Foundation

/// The poster's file, inside the take's folder, so deleting the take deletes it.
let POSTER_FILE = "poster.jpg"
/// About a second in: past the blank frames a take opens on (Patrick, 2026-11-20).
let POSTER_TARGET_MS = 1000
/// Below this a take has no "second in" worth the name; the middle is used.
let POSTER_MIN_LONG_TAKE_MS = 2000

/// The poster's time into the recording. 1 s, or the middle of a take shorter than 2 s.
/// An unknown or empty duration asks for frame 0.
func posterTimeMs(durationMs: Int) -> Int {
    guard durationMs > 0 else { return 0 }
    return durationMs < POSTER_MIN_LONG_TAKE_MS ? durationMs / 2 : POSTER_TARGET_MS
}

struct PosterRequest { let video: URL; let out: URL; let timeMs: Int }
struct PosterRefusal: Error { let reason: String }

/// An absolute take folder that holds a `display.mp4`.
func parsePosterRequest(_ cmd: [String: Any]) -> Result<PosterRequest, PosterRefusal> {
    guard let dir = cmd["dir"] as? String, !dir.isEmpty else {
        return .failure(PosterRefusal(reason: "dir is required"))
    }
    guard dir.hasPrefix("/") else { return .failure(PosterRefusal(reason: "dir must be absolute")) }
    let base = URL(fileURLWithPath: dir, isDirectory: true)
    let video = base.appendingPathComponent("display.mp4")
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: video.path, isDirectory: &isDir), !isDir.boolValue else {
        return .failure(PosterRefusal(reason: "no display.mp4 in that folder"))
    }
    let ms = (cmd["durationMs"] as? NSNumber)?.intValue ?? 0
    return .success(PosterRequest(video: video, out: base.appendingPathComponent(POSTER_FILE),
                                  timeMs: posterTimeMs(durationMs: ms)))
}
