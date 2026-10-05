import CoreGraphics

/// STC-419: which keystrokes a take may record. Pure — no tap, no layout, no
/// clock — so every row of the spec's "what counts as a command" table is a
/// test (helper/test/keys/) rather than a hope. The privacy guarantee lives
/// HERE: anything this returns `.drop` for is counted and forgotten, never
/// written. `docs/superpowers/specs/2026-10-01-stc-419-keycast-design.md`.

struct KeyMods: Equatable {
    var cmd = false, ctrl = false, opt = false, shift = false
    /// The recorded form: unique, in macOS menu order (⌃⌥⇧⌘).
    var names: [String] {
        var out: [String] = []
        if ctrl { out.append("ctrl") }
        if opt { out.append("opt") }
        if shift { out.append("shift") }
        if cmd { out.append("cmd") }
        return out
    }
}

func keyMods(from flags: CGEventFlags) -> KeyMods {
    KeyMods(cmd: flags.contains(.maskCommand), ctrl: flags.contains(.maskControl),
            opt: flags.contains(.maskAlternate), shift: flags.contains(.maskShift))
}

/// Non-printing keys by virtual keycode (kVK_*), so they are layout-independent.
/// The names must equal schema/events-3.schema.json's enum and keycast.ts's
/// NAMED_KEYS (a TS test holds those two equal; this table's count is held here).
let NAMED_KEY_CODES: [Int: String] = [
    0x7E: "ArrowUp", 0x7D: "ArrowDown", 0x7B: "ArrowLeft", 0x7C: "ArrowRight",
    0x24: "Return", 0x4C: "Enter", 0x30: "Tab", 0x35: "Escape",
    0x33: "Delete", 0x75: "ForwardDelete", 0x73: "Home", 0x77: "End",
    0x74: "PageUp", 0x79: "PageDown",
    0x7A: "F1", 0x78: "F2", 0x63: "F3", 0x76: "F4", 0x60: "F5", 0x61: "F6",
    0x62: "F7", 0x64: "F8", 0x65: "F9", 0x6D: "F10", 0x67: "F11", 0x6F: "F12",
]

enum KeyDecision: Equatable {
    case record(key: String, mods: [String])
    case drop
}

/// `baseCharacter` is what the key prints with NO modifiers on the current
/// layout (KeyLayout.swift), or nil if unknown. It is consulted only for a
/// chord; a caller may pass nil for anything else.
func decideKeyEvent(keyCode: Int, mods: KeyMods, autorepeat: Bool, baseCharacter: String?) -> KeyDecision {
    if autorepeat { return .drop }
    if let named = NAMED_KEY_CODES[keyCode] { return .record(key: named, mods: mods.names) }
    // A printable key is a command only under ⌘ or ⌃. ⌥ alone is how macOS
    // TYPES accented characters, so it is typing.
    guard mods.cmd || mods.ctrl else { return .drop }
    guard let c = baseCharacter, c.unicodeScalars.count == 1,
          let s = c.unicodeScalars.first, s.value >= 0x21, s.value <= 0x7E else { return .drop }
    return .record(key: c.uppercased(), mods: mods.names)
}
