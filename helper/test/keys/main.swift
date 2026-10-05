import Foundation
import CoreGraphics
var failures = 0
func expect(_ label: String, _ ok: Bool) { print(ok ? "ok   \(label)" : "FAIL \(label)"); if !ok { failures += 1 } }

let none = KeyMods()
let cmd = KeyMods(cmd: true)
let ctrl = KeyMods(ctrl: true)
let opt = KeyMods(opt: true)
let shift = KeyMods(shift: true)
let optShift = KeyMods(opt: true, shift: true)
let ctrlCmd = KeyMods(cmd: true, ctrl: true)
let shiftCmd = KeyMods(cmd: true, shift: true)

// Typing is dropped.
expect("plain letter drops", decideKeyEvent(keyCode: 0, mods: none, autorepeat: false, baseCharacter: "a") == .drop)
expect("shift+letter drops", decideKeyEvent(keyCode: 0, mods: shift, autorepeat: false, baseCharacter: "a") == .drop)
expect("opt+letter drops (accented typing)", decideKeyEvent(keyCode: 14, mods: opt, autorepeat: false, baseCharacter: "e") == .drop)
expect("opt+shift+letter drops", decideKeyEvent(keyCode: 14, mods: optShift, autorepeat: false, baseCharacter: "e") == .drop)
expect("space alone drops", decideKeyEvent(keyCode: 49, mods: none, autorepeat: false, baseCharacter: " ") == .drop)
expect("cmd+space drops (not printable ASCII)", decideKeyEvent(keyCode: 49, mods: cmd, autorepeat: false, baseCharacter: " ") == .drop)
expect("digit alone drops", decideKeyEvent(keyCode: 18, mods: none, autorepeat: false, baseCharacter: "1") == .drop)

// Auto-repeat is dropped, even for a named key.
expect("autorepeat arrow drops", decideKeyEvent(keyCode: 125, mods: none, autorepeat: true, baseCharacter: nil) == .drop)

// Named keys are recorded with any mods.
expect("down arrow", decideKeyEvent(keyCode: 125, mods: none, autorepeat: false, baseCharacter: nil) == .record(key: "ArrowDown", mods: []))
expect("return", decideKeyEvent(keyCode: 36, mods: none, autorepeat: false, baseCharacter: nil) == .record(key: "Return", mods: []))
expect("shift+tab", decideKeyEvent(keyCode: 48, mods: shift, autorepeat: false, baseCharacter: nil) == .record(key: "Tab", mods: ["shift"]))
expect("opt+left", decideKeyEvent(keyCode: 123, mods: opt, autorepeat: false, baseCharacter: nil) == .record(key: "ArrowLeft", mods: ["opt"]))
expect("F5", decideKeyEvent(keyCode: 0x60, mods: none, autorepeat: false, baseCharacter: nil) == .record(key: "F5", mods: []))
expect("keypad enter", decideKeyEvent(keyCode: 0x4C, mods: none, autorepeat: false, baseCharacter: nil) == .record(key: "Enter", mods: []))

// Chords.
expect("cmd+k upper-cased", decideKeyEvent(keyCode: 40, mods: cmd, autorepeat: false, baseCharacter: "k") == .record(key: "K", mods: ["cmd"]))
expect("ctrl+cmd+f, mods in ctrl/opt/shift/cmd order", decideKeyEvent(keyCode: 3, mods: ctrlCmd, autorepeat: false, baseCharacter: "f") == .record(key: "F", mods: ["ctrl", "cmd"]))
expect("shift+cmd+4 keeps the keycap digit", decideKeyEvent(keyCode: 21, mods: shiftCmd, autorepeat: false, baseCharacter: "4") == .record(key: "4", mods: ["shift", "cmd"]))
expect("ctrl+letter is a chord", decideKeyEvent(keyCode: 0, mods: ctrl, autorepeat: false, baseCharacter: "a") == .record(key: "A", mods: ["ctrl"]))
expect("chord with nil base char drops (Review Focus 1)", decideKeyEvent(keyCode: 40, mods: cmd, autorepeat: false, baseCharacter: nil) == .drop)
expect("chord with non-ASCII base char drops (Review Focus 1)", decideKeyEvent(keyCode: 40, mods: cmd, autorepeat: false, baseCharacter: "é") == .drop)
expect("chord with a two-char base drops", decideKeyEvent(keyCode: 40, mods: cmd, autorepeat: false, baseCharacter: "ab") == .drop)

// Flags adapter.
let f = keyMods(from: [.maskCommand, .maskShift])
expect("flags: cmd+shift", f == KeyMods(cmd: true, shift: true))
expect("flags: none", keyMods(from: []) == KeyMods())

// The named table is exactly the 26 the schema enumerates.
expect("26 named keys", Set(NAMED_KEY_CODES.values).count == 26 && NAMED_KEY_CODES.count == 26)

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
