// Pure-function tests for `copy-file`'s request decisions (STC-488), compiled
// together with the production source. No pasteboard is touched: whether
// NSPasteboard accepts the URL is `copy-file.grant.test.ts`.
import Foundation

var failures = 0
func check(_ label: String, _ got: some Equatable, _ want: some Equatable) {
    if String(describing: got) == String(describing: want) {
        print("ok   \(label)")
    } else {
        let line = "FAIL \(label): got \(got), want \(want)"
        print(line)
        FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
        failures += 1
    }
}

let dir = FileManager.default.temporaryDirectory.appendingPathComponent("copy-file-\(getpid())")
try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
let file = dir.appendingPathComponent("take.mp4")
FileManager.default.createFile(atPath: file.path, contents: Data([0]))

func reason(_ r: Result<URL, CopyFileRefusal>) -> String {
    switch r { case .success: return "ok"; case .failure(let e): return e.reason }
}

check("a real file is accepted", reason(parseCopyFileRequest(["path": file.path])), "ok")
check("no path", reason(parseCopyFileRequest([:])), "path is required")
check("an empty path", reason(parseCopyFileRequest(["path": ""])), "path is required")
check("a relative path", reason(parseCopyFileRequest(["path": "take.mp4"])), "path must be absolute")
check("a missing file", reason(parseCopyFileRequest(["path": dir.appendingPathComponent("nope.mp4").path])),
      "no such file")
check("a directory", reason(parseCopyFileRequest(["path": dir.path])), "not a regular file")

try? FileManager.default.removeItem(at: dir)
print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
