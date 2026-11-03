import Foundation

// `discardUnresumedTimer` against real libdispatch. With "bare" this does what
// the helper used to do (cancel only) and is expected to die by SIGTRAP: the
// control that says the passing case passes because of the resume.
let bare = CommandLine.arguments.dropFirst().first == "bare"
var fired = false
do {
    let t = DispatchSource.makeTimerSource(queue: .global())
    t.schedule(deadline: .now(), repeating: 0.001)
    t.setEventHandler { fired = true }
    if bare { t.cancel() } else { discardUnresumedTimer(t) }
}
// Room for a handler that should not run to run anyway.
Thread.sleep(forTimeInterval: 0.1)
if fired { print("FAIL: a discarded timer fired"); exit(1) }
print("ALL PASS")
