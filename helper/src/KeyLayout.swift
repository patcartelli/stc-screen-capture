import Carbon
import Foundation

/// STC-419: what a key prints with NO modifiers, on the layout that was current
/// when the take started — what is on the keycap, so AZERTY's ⌘A reads ⌘A.
///
/// The Text Input Source APIs must be called on the MAIN thread, and the tap
/// callback is not on it. So the layout's `uchr` bytes and the keyboard type
/// are copied ONCE, at start, on main; `UCKeyTranslate` over that copy is safe
/// from any thread. A layout switched mid-take is not seen — stated, not fixed
/// (docs/STC-419-RUNBOOK.md).
///
/// Taken in main.swift's `start`, which runs on main (IO.readCommands hands
/// every command over with `DispatchQueue.main.async`), and passed down —
/// never from `begin()`, which runs on ScreenCaptureKit's callback queue. A
/// `main.sync` from there would not deadlock today, but main CAN be parked
/// (`Watchers.enumerateDevices` waits up to 6 s on a semaphore for a `devices`
/// request), and that wait would land inside the start's 15 s backstop. So
/// off main this refuses rather than hops: nil, and chords are dropped.
final class KeyLayoutSnapshot {
    private let layout: Data
    private let keyboardType: UInt32

    init?() {
        guard Thread.isMainThread else {
            IO.log("STC-419: KeyLayoutSnapshot taken off the main thread; refusing")
            return nil
        }
        guard let src = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let ptr = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        layout = Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data
        keyboardType = UInt32(LMGetKbdType())
    }

    func baseCharacter(keyCode: Int) -> String? {
        var dead: UInt32 = 0
        var length = 0
        var chars = [UniChar](repeating: 0, count: 4)
        let status = layout.withUnsafeBytes { raw -> OSStatus in
            guard let base = raw.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return -1 }
            // The MASK, not `kUCKeyTranslateNoDeadKeysBit`: that is the bit's
            // INDEX (0), so passing it as options would leave dead keys on and
            // a dead keycap (French `^`) would translate to nothing.
            return UCKeyTranslate(base, UInt16(keyCode), UInt16(kUCKeyActionDown), 0, keyboardType,
                                  OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
        }
        guard status == noErr, length > 0 else { return nil }
        return String(utf16CodeUnits: chars, count: length)
    }
}
