// The pasteboard the helper writes to and reads (STC-658). The general one,
// unless the e2e suite named a private one in `STC_PASTEBOARD`, so a test run
// never replaces what the person had copied. `app/src/machine-seams.ts` is the
// app side; a packaged build never carries the variable (`app/src/seams.ts`).
import AppKit

enum Pasteboard {
    static var current: NSPasteboard {
        if let name = ProcessInfo.processInfo.environment["STC_PASTEBOARD"], !name.isEmpty {
            return NSPasteboard(name: NSPasteboard.Name(name))
        }
        return .general
    }
}
