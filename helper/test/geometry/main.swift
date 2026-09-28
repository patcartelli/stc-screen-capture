// Pure-function tests for capture geometry, compiled together with the
// production source. No XCTest here: there is no Xcode and SwiftPM cannot
// resolve, so the "framework" is assertions + a non-zero exit code.
import Foundation

var failures = 0

func check(_ label: String, _ got: (w: Int, h: Int), _ want: (w: Int, h: Int)) {
    if got == want {
        print("ok   \(label): \(got.w)x\(got.h)")
    } else {
        print("FAIL \(label): got \(got.w)x\(got.h), want \(want.w)x\(want.h)")
        failures += 1
    }
}

// The case that forced the cap to exist: this machine's own built-in display.
check("6016x3384 built-in caps to 4K", captureSize(6016, 3384), (3840, 2160))
check("5120x2880 5K caps to 4K",       captureSize(5120, 2880), (3840, 2160))
check("3840x2160 exactly at cap",      captureSize(3840, 2160), (3840, 2160))
check("2560x1440 under cap",           captureSize(2560, 1440), (2560, 1440))
check("5120x2160 ultrawide, width-bound", captureSize(5120, 2160), (3840, 1620))
check("2160x3840 portrait, height-bound", captureSize(2160, 3840), (1214, 2160))
check("odd dimensions floor to even",  captureSize(1919, 1081), (1918, 1080))

// Invariants that must hold for any display, including ones nobody anticipated.
for (w, h) in [(6016, 3384), (5120, 2160), (2160, 3840), (1919, 1081), (801, 601),
               (7680, 4320), (1280, 800), (3841, 2161), (2, 2)] {
    let s = captureSize(w, h)
    if s.w % 2 != 0 || s.h % 2 != 0 {
        print("FAIL \(w)x\(h): odd output \(s.w)x\(s.h) — H.264 4:2:0 needs even dimensions")
        failures += 1
    }
    if s.w > 3840 || s.h > 2160 {
        print("FAIL \(w)x\(h): \(s.w)x\(s.h) exceeds the hardware-encode cliff")
        failures += 1
    }
    if s.w < 2 || s.h < 2 {
        print("FAIL \(w)x\(h): degenerate output \(s.w)x\(s.h)")
        failures += 1
    }
    // aspect ratio preserved within a pixel of rounding slack
    let srcAR = Double(w) / Double(h), outAR = Double(s.w) / Double(s.h)
    if abs(srcAR - outAR) / srcAR > 0.01 {
        print("FAIL \(w)x\(h): aspect drifted \(srcAR) -> \(outAR)")
        failures += 1
    }
}

func checkFit(_ label: String, _ got: FitRect, _ want: FitRect) {
    if got == want { print("ok   \(label)") }
    else { print("FAIL \(label): got \(got), want \(want)"); failures += 1 }
}
checkFit("same aspect is the full frame",
         fitRect(sourceWidth: 2880, sourceHeight: 1800, intoWidth: 3456, intoHeight: 2160),
         FitRect(x: 0, y: 0, width: 3456, height: 2160))
checkFit("4:3 into 16:9 pillarboxes, centred",
         fitRect(sourceWidth: 1600, sourceHeight: 1200, intoWidth: 3840, intoHeight: 2160),
         FitRect(x: 480, y: 0, width: 2880, height: 2160))
checkFit("21:9 into 16:9 letterboxes, centred",
         fitRect(sourceWidth: 3440, sourceHeight: 1440, intoWidth: 3840, intoHeight: 2160),
         FitRect(x: 0, y: 276, width: 3840, height: 1608))
for (sw, sh, iw, ih) in [(1919, 1081, 3840, 2160), (1000, 3000, 3840, 2160), (7, 5, 640, 360), (3456, 2234, 3340, 2160)] {
    let r = fitRect(sourceWidth: sw, sourceHeight: sh, intoWidth: iw, intoHeight: ih)
    if [r.x, r.y, r.width, r.height].contains(where: { $0 % 2 != 0 }) { print("FAIL \(sw)x\(sh): odd edge \(r)"); failures += 1 }
    if r.x < 0 || r.y < 0 || r.x + r.width > iw || r.y + r.height > ih { print("FAIL \(sw)x\(sh): outside \(r)"); failures += 1 }
    if abs((iw - r.width) - 2 * r.x) > 2 || abs((ih - r.height) - 2 * r.y) > 2 { print("FAIL \(sw)x\(sh): not centred \(r)"); failures += 1 }
    if r.width != iw && r.height != ih { print("FAIL \(sw)x\(sh): touches neither axis \(r)"); failures += 1 }
}

print(failures == 0 ? "ALL PASS" : "\(failures) FAILURES")
exit(failures == 0 ? 0 : 1)
