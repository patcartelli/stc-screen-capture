import Foundation
var failures = 0
func expect(_ label: String, _ ok: Bool) { print(ok ? "ok   \(label)" : "FAIL \(label)"); if !ok { failures += 1 } }

let r = StillRect(x: 100, y: 100, width: 800, height: 600)
expect("captured display gone stops", decideDisplayChange(capturedDisplayPresent: false, region: nil, newPointWidth: 1440, newPointHeight: 900) == .stop("display-reconfigured"))
expect("display scope refits", decideDisplayChange(capturedDisplayPresent: true, region: nil, newPointWidth: 1440, newPointHeight: 900) == .refit)
expect("region exactly touching the new edge refits", decideDisplayChange(capturedDisplayPresent: true, region: r, newPointWidth: 900, newPointHeight: 700) == .refit)
expect("region one point over stops", decideDisplayChange(capturedDisplayPresent: true, region: r, newPointWidth: 899, newPointHeight: 700) == .stop("region-out-of-bounds"))
expect("display gone beats region", decideDisplayChange(capturedDisplayPresent: false, region: r, newPointWidth: 0, newPointHeight: 0) == .stop("display-reconfigured"))

var d = SettleDebounce()
expect("idle debounce is never due", !d.due(nowMs: 10_000))
d.poke(nowMs: 0); d.poke(nowMs: 100); d.poke(nowMs: 200)       // a CG burst
expect("not due inside the settle window after the LAST poke", !d.due(nowMs: 449))
expect("due once settled", d.due(nowMs: 450))
d.fire()
expect("one burst fires exactly once", !d.due(nowMs: 10_000))

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
