// `pick-color` (STC-627): the system's own eyedropper loupe.
//
// NSColorSampler is the loupe Digital Color Meter and every native color well
// use. It reads the real screen pixels, over any app, wallpaper or video, and
// needs NO Screen Recording grant (the system draws and samples it, the app
// only receives the one color). That is why it was chosen over Chromium's
// EyeDropper, which needs a focused renderer and would put Capture's own
// window in the loupe's way.
//
// The color comes back in the display's space, so it is converted to EXTENDED
// sRGB here: components may fall outside 0...1 for a P3 pixel sRGB cannot
// hold, and the app (`app/src/color-pick.ts`) clamps and says so. Esc, or a
// click-away, calls back with nil: that is "cancelled", not a failure.
//
// State-free, like copy-file and export-still: a pick must not be refused
// because a take is running. Only one loupe at a time, and the caller learns
// so instead of the second request quietly replacing the first.
import AppKit

enum ColorPick {
    private static var sampler: NSColorSampler?

    static func run(_ done: @escaping (Result<[String: Any], ColorPickRefusal>) -> Void) {
        DispatchQueue.main.async {
            guard sampler == nil else {
                return done(.failure(ColorPickRefusal(code: "pick-busy", detail: "a color pick is already open")))
            }
            let s = NSColorSampler()
            sampler = s
            s.show { color in
                sampler = nil
                guard let color else { return done(.success(["cancelled": true])) }
                guard let c = color.usingColorSpace(.extendedSRGB) else {
                    return done(.failure(ColorPickRefusal(code: "pick-failed",
                        detail: "the sampled color could not be converted to sRGB")))
                }
                done(.success(["r": Double(c.redComponent), "g": Double(c.greenComponent), "b": Double(c.blueComponent)]))
            }
        }
    }
}

struct ColorPickRefusal: Error {
    let code: String
    let detail: String
}
