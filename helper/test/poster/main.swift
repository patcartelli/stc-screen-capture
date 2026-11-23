// Pure-function tests for `make-poster`'s decisions (STC-671), compiled with the
// production source. No video is decoded: that needs a Mac and a real take.
import Foundation

var failures = 0
func check(_ label: String, _ got: some Equatable, _ want: some Equatable) {
    if String(describing: got) == String(describing: want) { print("ok   \(label)") }
    else {
        let line = "FAIL \(label): got \(got), want \(want)"
        print(line)
        FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
        failures += 1
    }
}

check("a long take: 1 s in", posterTimeMs(durationMs: 60_000), 1000)
check("exactly 2 s: still 1 s in", posterTimeMs(durationMs: 2000), 1000)
check("just under 2 s: the middle", posterTimeMs(durationMs: 1999), 999)
check("a 1 s take: the middle", posterTimeMs(durationMs: 1000), 500)
check("a 0 ms take: frame 0", posterTimeMs(durationMs: 0), 0)
check("a negative duration: frame 0", posterTimeMs(durationMs: -5), 0)

let dir = FileManager.default.temporaryDirectory.appendingPathComponent("poster-\(getpid())")
try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
FileManager.default.createFile(atPath: dir.appendingPathComponent("display.mp4").path, contents: Data([0]))

func outcome(_ r: Result<PosterRequest, PosterRefusal>) -> String {
    switch r {
    case .success(let p): return "ok \(p.out.lastPathComponent) \(p.timeMs)"
    case .failure(let e): return e.reason
    }
}
check("a take folder", outcome(parsePosterRequest(["dir": dir.path, "durationMs": 9000])), "ok poster.jpg 1000")
check("no duration: frame 0", outcome(parsePosterRequest(["dir": dir.path])), "ok poster.jpg 0")
check("no dir", outcome(parsePosterRequest([:])), "dir is required")
check("relative dir", outcome(parsePosterRequest(["dir": "take"])), "dir must be absolute")
check("no video", outcome(parsePosterRequest(["dir": dir.appendingPathComponent("x").path])),
      "no display.mp4 in that folder")

try? FileManager.default.removeItem(at: dir)
print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
