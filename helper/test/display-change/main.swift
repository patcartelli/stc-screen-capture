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

// refitNeeded: the no-op short-circuit. CG calls back for EVERY display, so
// most settled changes a take sees are someone else's.
let g0 = DisplayGeometry(id: 1, pointWidth: 1440, pointHeight: 900, pixelWidth: 2880, pixelHeight: 1800,
                         originX: 0, originY: 0)
let full = FitRect(x: 0, y: 0, width: 2880, height: 1800)
let base = RefitShape(geometry: g0, sourcePixelWidth: 2880, sourcePixelHeight: 1800, sourceRect: nil, rect: full)
func moved(_ g: DisplayGeometry, x: Double, y: Double) -> DisplayGeometry {
    DisplayGeometry(id: g.id, pointWidth: g.pointWidth, pointHeight: g.pointHeight,
                    pixelWidth: g.pixelWidth, pixelHeight: g.pixelHeight, originX: x, originY: y)
}
expect("an unrelated display's change is a no-op", refitNeeded(current: base, next: base, followsWindow: false) == .none)
expect("an unrelated display's change is a no-op for a window take too",
       refitNeeded(current: base, next: base, followsWindow: true) == .none)
let shifted = RefitShape(geometry: moved(g0, x: -1920, y: 0), sourcePixelWidth: 2880, sourcePixelHeight: 1800,
                         sourceRect: nil, rect: full)
expect("only the origin moved: record the geometry, leave the stream",
       refitNeeded(current: base, next: shifted, followsWindow: false) == .recordOnly)
let crop = StillRect(x: 100, y: 100, width: 800, height: 600)
let regionAt = { (g: DisplayGeometry) in
    RefitShape(geometry: g, sourcePixelWidth: 1600, sourcePixelHeight: 1200, sourceRect: crop,
               rect: FitRect(x: 0, y: 0, width: 1600, height: 1200))
}
expect("a region's crop is display-local: an origin move alone is record-only",
       refitNeeded(current: regionAt(g0), next: regionAt(moved(g0, x: 0, y: -1080)), followsWindow: false) == .recordOnly)
let otherDisplay = DisplayGeometry(id: 2, pointWidth: 1440, pointHeight: 900, pixelWidth: 2880, pixelHeight: 1800,
                                   originX: 1440, originY: 0)
let windowOn = { (g: DisplayGeometry) in
    RefitShape(geometry: g, sourcePixelWidth: 1600, sourcePixelHeight: 1000, sourceRect: nil,
               rect: FitRect(x: 0, y: 0, width: 1600, height: 1000))
}
expect("a window filter follows the window: a new holding display at the same scale is record-only",
       refitNeeded(current: windowOn(g0), next: windowOn(otherDisplay), followsWindow: true) == .recordOnly)
expect("...but a display take whose display id changed is never record-only",
       refitNeeded(current: base, next: RefitShape(geometry: otherDisplay, sourcePixelWidth: 2880, sourcePixelHeight: 1800,
                                                  sourceRect: nil, rect: full), followsWindow: false) == .reconfigure)
let modeChange = DisplayGeometry(id: 1, pointWidth: 1728, pointHeight: 1117, pixelWidth: 3456, pixelHeight: 2234,
                                 originX: 0, originY: 0)
expect("a mode change (new pixels) reconfigures",
       refitNeeded(current: base, next: RefitShape(geometry: modeChange, sourcePixelWidth: 3456, sourcePixelHeight: 2234,
                                                  sourceRect: nil, rect: FitRect(x: 0, y: 2, width: 2880, height: 1796)),
                   followsWindow: false) == .reconfigure)
expect("same pixels, same rect, but a different fit rect reconfigures (the display-refit fault's pillarbox)",
       refitNeeded(current: base, next: RefitShape(geometry: g0, sourcePixelWidth: 2880, sourcePixelHeight: 1800,
                                                  sourceRect: nil, rect: FitRect(x: 360, y: 0, width: 2160, height: 1800)),
                   followsWindow: false) == .reconfigure)
expect("a changed region crop reconfigures even with equal pixels",
       refitNeeded(current: regionAt(g0),
                   next: RefitShape(geometry: g0, sourcePixelWidth: 1600, sourcePixelHeight: 1200,
                                    sourceRect: StillRect(x: 0, y: 0, width: 800, height: 600),
                                    rect: FitRect(x: 0, y: 0, width: 1600, height: 1200)),
                   followsWindow: false) == .reconfigure)
expect("a window moved to a display of another backing scale reconfigures (its pixel size changed)",
       refitNeeded(current: windowOn(g0),
                   next: RefitShape(geometry: otherDisplay, sourcePixelWidth: 800, sourcePixelHeight: 500, sourceRect: nil,
                                    rect: FitRect(x: 0, y: 0, width: 1600, height: 1000)),
                   followsWindow: true) == .reconfigure)

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
