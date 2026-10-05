// `copy-file`'s pure half (STC-488): is this request a file we will put on the
// pasteboard? No AppKit, so `helper/test/copy-file/` checks it without one.
import Foundation

struct CopyFileRefusal: Error { let reason: String }

/// A non-empty, absolute path to an existing regular file. Anything else is
/// refused with a sentence, never silently copied as something it isn't.
func parseCopyFileRequest(_ cmd: [String: Any]) -> Result<URL, CopyFileRefusal> {
    guard let path = cmd["path"] as? String, !path.isEmpty else {
        return .failure(CopyFileRefusal(reason: "path is required"))
    }
    guard path.hasPrefix("/") else { return .failure(CopyFileRefusal(reason: "path must be absolute")) }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else {
        return .failure(CopyFileRefusal(reason: "no such file"))
    }
    guard !isDir.boolValue else { return .failure(CopyFileRefusal(reason: "not a regular file")) }
    return .success(URL(fileURLWithPath: path))
}
