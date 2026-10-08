import Foundation
import CoreGraphics
import IOKit.hid
import ApplicationServices

/// The two grants a take cannot be made without (STC-476's MVP slice), read
/// and requested in ONE place — the ticket's "pick one place and keep it
/// there". The app's permissions panel asks through `permissions` and
/// `request-permission`; the helper is the only process that can call
/// `IOHIDRequestAccess`, since Electron has no API for Input Monitoring.
///
/// Attribution: this binary is spawned by Capture.app, so TCC charges both
/// calls to Capture.app — the same arrangement Screen Recording has always
/// relied on (`tools/test-host`). Whether Input Monitoring follows it on a
/// clean, notarized install is what STC-518 asks and only the VM can say
/// (`docs/STC-476-RUNBOOK.md`).
enum Permissions {
    /// Input Monitoring as `IOHIDCheckAccess` reports it. A READ: never prompts.
    static func listenEvent() -> ListenEventAccess {
        let raw = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)
        return raw == kIOHIDAccessTypeGranted ? .granted
            : raw == kIOHIDAccessTypeDenied ? .denied : .unknown
    }

    /// The `permissions` reply. Screen Recording is a bool because that is all
    /// `CGPreflightScreenCaptureAccess` says — "never asked" and "denied" are
    /// the same `false` to it. Accessibility is reported because it also
    /// feeds the event tap (`decideEventTapAccess`), so the panel must not
    /// ask for Input Monitoring on a machine that records through it today.
    static func report() -> [String: Any] {
        let listen: String
        switch listenEvent() {
        case .granted: listen = "granted"
        case .denied:  listen = "denied"
        case .unknown: listen = "unknown"
        }
        return ["screenRecording": CGPreflightScreenCaptureAccess(),
                "inputMonitoring": listen,
                "accessibility": AXIsProcessTrusted()]
    }

    /// Ask macOS for one grant. Each call raises the system prompt only when
    /// the grant has never been asked for; after that it returns at once and
    /// System Settings is the only way back, which the panel links to.
    static func request(_ grant: String) -> Bool {
        switch grant {
        case "screen-recording": _ = CGRequestScreenCaptureAccess(); return true
        case "input-monitoring": _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent); return true
        default: return false
        }
    }
}
