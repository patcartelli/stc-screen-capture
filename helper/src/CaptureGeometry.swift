import Foundation

/// The hardware-encode ceiling (PHASE-0 §3). Above this, H.264 encode falls off
/// a cliff in one step — 0.81 -> 0.25 Gpx/s as it drops to software — and
/// Chrome's decoder shares the limit, so it caps both ends of the pipeline.
let MAX_CAPTURE_WIDTH = 3840
let MAX_CAPTURE_HEIGHT = 2160

/// Capture dimensions for a display of the given pixel size.
///
/// SPACE: display pixels → capture pixels. `transform/src/spaces.ts` names
/// every space and owns every conversion the transform can reach; this clamp
/// cannot move there because only the helper knows the encode ceiling applies.
///
/// Not hypothetical rounding: this machine's built-in display is 6016x3384, so
/// capturing native would silently land on the software path and never reach
/// 60 fps. Aspect ratio is preserved; both dimensions are floored to even
/// numbers because H.264 4:2:0 requires them.
func captureSize(_ pixelWidth: Int, _ pixelHeight: Int) -> (w: Int, h: Int) {
    guard pixelWidth > 0, pixelHeight > 0 else { return (2, 2) }

    let scale = min(1.0,
                    Double(MAX_CAPTURE_WIDTH) / Double(pixelWidth),
                    Double(MAX_CAPTURE_HEIGHT) / Double(pixelHeight))

    // Round rather than truncate: 6016 * (3840/6016) lands on 3839.9999... in
    // binary floating point, and truncating there would silently shave a pixel
    // off an exact fit. Flooring to even afterwards keeps us under the cap even
    // if rounding nudged a dimension one over it.
    func evenFloor(_ v: Double) -> Int { max(2, Int(v.rounded()) / 2 * 2) }

    return (evenFloor(Double(pixelWidth) * scale),
            evenFloor(Double(pixelHeight) * scale))
}

/// Where a refitted source lands inside the take's FIXED capture frame
/// (STC-235). SPACE: source pixels → capture pixels; the transform's name for
/// the result is `contentRect` (`transform/src/spaces.ts`).
///
/// The capture size never changes mid-take — AVAssetWriter cannot — so a
/// display whose aspect changed is fitted, letterboxed or pillarboxed, never
/// stretched. Every edge is even (H.264 4:2:0), the rect is centred, and a
/// same-aspect source is exactly the full frame so an ordinary resolution
/// change records no letterbox at all. The `1e-3` aspect tolerance absorbs the
/// capture cap's own even-rounding (e.g. a 3456x2234 display vs its own
/// 3340x2160 capture, where captureSize's even-floor has already nudged the
/// aspect ratio slightly off the source's).
struct FitRect: Equatable { let x: Int, y: Int, width: Int, height: Int }

func fitRect(sourceWidth: Int, sourceHeight: Int, intoWidth: Int, intoHeight: Int) -> FitRect {
    guard sourceWidth > 0, sourceHeight > 0 else { return FitRect(x: 0, y: 0, width: intoWidth, height: intoHeight) }
    // Round to the NEAREST even integer (round v/2, then double) — not round-
    // then-floor-to-even, which would round 1607.44 down to 1606 when the
    // nearest even integer is 1608 (3840 × 1440/3440, the letterbox case
    // below).
    func even(_ v: Double) -> Int { max(2, Int((v / 2).rounded()) * 2) }
    let sa = Double(sourceWidth) / Double(sourceHeight), ia = Double(intoWidth) / Double(intoHeight)
    if abs(sa - ia) < 1e-3 { return FitRect(x: 0, y: 0, width: intoWidth, height: intoHeight) }
    if sa > ia {
        let h = min(intoHeight, even(Double(intoWidth) / sa))
        return FitRect(x: 0, y: (intoHeight - h) / 4 * 2, width: intoWidth, height: h)
    } else {
        let w = min(intoWidth, even(Double(intoHeight) * sa))
        return FitRect(x: (intoWidth - w) / 4 * 2, y: 0, width: w, height: intoHeight)
    }
}
