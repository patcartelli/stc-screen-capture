import Foundation
var failures = 0
func expect(_ label: String, _ ok: Bool) { print(ok ? "ok   \(label)" : "FAIL \(label)"); if !ok { failures += 1 } }

expect("a death with the grant intact is stream-stopped",
       decideStreamStop(screenRecordingGranted: true, userDeclined: false) == .stop("stream-stopped"))
expect("the grant gone is screen-recording-revoked",
       decideStreamStop(screenRecordingGranted: false, userDeclined: false) == .stop("screen-recording-revoked"))
expect("userDeclined alone is screen-recording-revoked",
       decideStreamStop(screenRecordingGranted: true, userDeclined: true) == .stop("screen-recording-revoked"))
expect("both signals agree",
       decideStreamStop(screenRecordingGranted: false, userDeclined: true) == .stop("screen-recording-revoked"))

if failures == 0 { print("ALL PASS") } else { print("\(failures) FAILED"); exit(1) }
