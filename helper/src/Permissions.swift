import Foundation
import CoreGraphics
import IOKit.hid


/// The two grants a take cannot be made without (STC-476's MVP slice), read
/// and requested in ONE place — the ticket's "pick one place and keep it
/// there". The app's permissions panel asks through `permissions` and
/// `request-permission`; the helper is the only process that can call
/// the Input Monitoring request, since Electron has no API for it.
///
/// Attribution: this binary is spawned by Capture.app, and tccd charges its
/// calls to Capture.app as the RESPONSIBLE process — seen in a clean VM's TCC
/// log on 2026-10-08 for both services (`responsible=com.studiocartelli.capture,
/// requesting=stc-helper`), and the grants land on the bundle id. What differs
/// is which request API actually asks: see `requestListenEvent`.
enum Permissions {
    /// Input Monitoring as `IOHIDCheckAccess` reports it. A READ: never prompts.
    static func listenEvent() -> ListenEventAccess {
        let raw = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)
        return raw == kIOHIDAccessTypeGranted ? .granted
            : raw == kIOHIDAccessTypeDenied ? .denied : .unknown
    }

    /// The `permissions` reply. Screen Recording is a bool because that is all
    /// `CGPreflightScreenCaptureAccess` says — "never asked" and "denied" are
    /// the same `false` to it.
    ///
    /// NO Accessibility, on purpose (STC-518, clean VM 2026-10-08): on a
    /// never-asked Mac `AXIsProcessTrusted()` writes a denied Accessibility
    /// row for Capture, and tccd then refuses the Input Monitoring request
    /// with no prompt. This read runs at every launch, so it must not touch
    /// it. The event tap still accepts Accessibility, read only after Input
    /// Monitoring has been asked (`CaptureSession.eventTapAccess`).
    static func report() -> [String: Any] {
        let listen: String
        switch listenEvent() {
        case .granted: listen = "granted"
        case .denied:  listen = "denied"
        case .unknown: listen = "unknown"
        }
        return ["screenRecording": CGPreflightScreenCaptureAccess(),
                "inputMonitoring": listen]
    }

    /// Ask macOS for one grant. Each call raises the system prompt only when
    /// the grant has never been asked for; after that it returns at once and
    /// System Settings is the only way back, which the panel links to.
    static func request(_ grant: String) -> Bool {
        switch grant {
        case "screen-recording": _ = CGRequestScreenCaptureAccess(); return true
        case "input-monitoring": requestListenEvent(); return true
        default: return false
        }
    }

    /// Input Monitoring's request, in ONE place for the panel and the event
    /// tap's refusal (STC-518).
    ///
    /// CoreGraphics' call, NOT `IOHIDRequestAccess`. Measured in a clean VM on
    /// 2026-10-08 (tccd's own log, `docs/STC-476-RUNBOOK.md`): from this helper,
    /// `IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)` never reached tccd as
    /// a request at all — only `preflight=yes` reads — so nothing prompted and
    /// Capture was never listed. That is STC-518. In the same run the helper's
    /// `CGEvent.tapCreate` DID send a real (`preflight=no`) ListenEvent request,
    /// charged to Capture.app as the responsible process, so the CoreGraphics
    /// path is the one that works from here.
    static func requestListenEvent() {
        _ = CGRequestListenEventAccess()
    }
}
