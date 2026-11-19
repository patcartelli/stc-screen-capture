// `copy-file` and `pasteboard-files` (STC-488): a rendered recording on the
// pasteboard (`Pasteboard.current`) as a FILE REFERENCE, the representation Finder, Slack,
// Mail and Messages read for a pasted file. Writing an NSURL object (rather
// than a raw public.file-url string on an item, as a still's extra fileURL
// does) is what makes AppKit add the legacy filename types those apps still
// look for.
import AppKit

enum CopyFile {
    static func copy(_ cmd: [String: Any]) -> Result<[String: Any], CopyFileRefusal> {
        switch parseCopyFileRequest(cmd) {
        case .failure(let e): return .failure(e)
        case .success(let url):
            let pb = Pasteboard.current
            pb.clearContents()
            guard pb.writeObjects([url as NSURL]) else {
                return .failure(CopyFileRefusal(reason: "NSPasteboard refused the file"))
            }
            return .success(["changeCount": pb.changeCount])
        }
    }

    /// The pasteboard's change count: lets the app tell, after a long
    /// render, whether the person copied something else in the meantime.
    static func changeCount() -> Int { Pasteboard.current.changeCount }

    /// Absolute paths of every file URL on the pasteboard. Read-only;
    /// the purge's one check (no polling).
    static func files() -> [String] {
        let urls = Pasteboard.current.readObjects(forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.map(\.path)
    }
}
