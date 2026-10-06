import Foundation
import CoreGraphics

/// Display geometry as the anchors document records it — and, since STC-289,
/// as shot.json records it: the two formats share this one block so a still
/// and a recording of the same display cannot disagree about it.
struct DisplayGeometry: Equatable {
    let id: Int, pointWidth: Int, pointHeight: Int
    let pixelWidth: Int, pixelHeight: Int
    let originX: Double, originY: Double

    /// Pixels per point. 1 when the point size is unknown rather than a
    /// division by zero.
    var backingScale: Double {
        pointWidth > 0 ? Double(pixelWidth) / Double(pointWidth) : 1.0
    }
}

/// Measures a display the way both the recording and the still path record
/// it: points from ScreenCaptureKit's `SCDisplay`, pixels from the current
/// display mode, origin from `CGDisplayBounds` (global CG points, top-left).
/// One place, because the two paths used to carry separate copies of these
/// nine lines and a still that measured a display differently from the
/// recording beside it would be the quiet kind of wrong.
func displayGeometry(id: CGDirectDisplayID, pointWidth: Int, pointHeight: Int) -> DisplayGeometry {
    let bounds = CGDisplayBounds(id)
    let pixelW: Int, pixelH: Int
    if let mode = CGDisplayCopyDisplayMode(id) {
        pixelW = mode.pixelWidth
        pixelH = mode.pixelHeight
    } else {
        pixelW = pointWidth; pixelH = pointHeight
    }
    return DisplayGeometry(id: Int(id), pointWidth: pointWidth, pointHeight: pointHeight,
                           pixelWidth: pixelW, pixelHeight: pixelH,
                           originX: Double(bounds.origin.x), originY: Double(bounds.origin.y))
}

/// The display track's captured size plus the helper's own measurement of when
/// its first frame landed.
struct CaptureGeometryDoc {
    let width: Int, height: Int, firstFrameNs: Int
}

/// One entry of the refit timeline (STC-235): which display geometry and
/// where in the fixed capture frame (`FitRect`, CaptureGeometry.swift)
/// applied from `startNs` onward. Entry 0 is always the take's start — the
/// top-level `display` and the full capture frame — so a reader never has to
/// treat "before the first entry" as a separate case.
struct GeometryEntryDoc {
    let startNs: Int
    let display: DisplayGeometry
    let contentRect: FitRect
}

/// The recording's capture scope (STC-370): the whole display (phase-1
/// behaviour), a region of one, or one window. Mirrors `StillKind` /
/// `StillWindowInfo` (StillDecisions.swift) deliberately — a shot and a take
/// of the same window must describe it the same way, not two formats that
/// happen to agree today.
struct CaptureScopeDoc {
    enum Kind: String { case display, region, window }
    let kind: Kind
    /// display-local points, when kind == .region
    let region: StillRect?
    /// when kind == .window
    let window: StillWindowInfo?

    static let display = CaptureScopeDoc(kind: .display, region: nil, window: nil)
}

/// One entry of a window-scope take's window track (STC-482): where the
/// window's top-left sat from `tNs` (the events clock, session-relative)
/// onward, in display-local points like the scope's `bounds`. Only the origin,
/// because a window that changes SIZE ends the take (STC-370, STC-382).
struct WindowTrackEntryDoc: Equatable {
    let tNs: Int
    let x: Double, y: Double
}

/// What the camera track turned out to be. `nil` means no camera on this take.
struct CameraTrack {
    let present: Bool
    let device: String
    let width: Int, height: Int
    let firstFramePtsNs: Int
    let lastFramePtsNs: Int
    /// Median inter-frame delta. The transform bounds the PiP's track end with
    /// this; the measured camera rate varies run to run, so it must be recorded
    /// rather than assumed.
    let frameIntervalNs: Int
}

/// What the mic track turned out to be (STC-233). `nil` means no mic on this
/// take. Mirrors `CameraTrack`'s shape deliberately — `width`/`height` become
/// `sampleRate`/`channels`, and there is no `frameIntervalNs`: audio has no
/// discrete frame the transform holds between, only a continuous track it
/// muxes in unmodified.
struct MicTrack {
    let present: Bool
    let device: String
    let sampleRate: Int, channels: Int
    let firstFramePtsNs: Int
    let lastFramePtsNs: Int
}

/// What the system-audio track turned out to be (STC-418). `nil` means no
/// system audio on this take. `MicTrack` minus `device`: there is one system
/// output, and it is the whole machine's whatever the take's scope
/// (schema/anchors-6.schema.json).
struct SystemAudioTrack {
    let present: Bool
    let sampleRate: Int, channels: Int
    let firstFramePtsNs: Int
    let lastFramePtsNs: Int
}

/// Builds anchors.json.
///
/// Pure on purpose: the shape of this document is a contract with the transform,
/// and a contract that can only be checked by performing a real recording is a
/// contract nothing checks on most runs.
///
/// `requested` decides whether the `camera` block is written at all (STC-303).
/// schema/anchors-2.schema.json says absent means no camera was even
/// attempted and `present:false` means one was requested (or considered) but
/// yielded no track — before this parameter existed, the block was written
/// unconditionally, so every display-only take carried `present:false` and
/// the take library labelled it a camera that recorded nothing. `camera` and
/// `requested` are independent: `requested: true, camera: nil` is exactly the
/// STC-286 case (a camera opened and delivered zero frames), and still
/// produces `present:false` — this fix must not silence that.
///
/// `scope` decides the version emitted: `.display` (phase-1 behaviour) stays
/// version 2 with no `scope` block at all — every existing consumer of a v2
/// document keeps working unchanged, because a whole-display take looks
/// exactly as it always has. `.region`/`.window` write version 3 with a
/// `scope` block. This is the same "emit the minimum version that can
/// express the document" rule `projectForWrite`/`shotForWrite` already use:
/// an untouched shape does not pay for a feature it does not use.
///
/// `micRequested` raises the floor to version 4 (STC-233), the same way scope
/// raises it to 3 — a `mic` block is new to anchors-4 and an older reader
/// (which validates `additionalProperties: false`) must never be handed one
/// it cannot express. A take with no mic requested writes whatever version
/// its scope already implies, unchanged.
///
/// `systemAudioRequested` raises the floor to version 6 (STC-418), exactly
/// the way `micRequested` raises it to 4: the `system` block and
/// `files.system` are new to anchors-6, and a take that never asked for
/// system audio writes neither and keeps whatever version its other blocks
/// demand.
///
/// `pauses` raises the floor to version 5 (STC-240) when non-empty, the same
/// way `micRequested` raises it to 4 and `scope` to 3. A take that was never
/// paused writes no `pauses` key and keeps whatever version its other blocks
/// demand — so nothing about an ordinary take changes, and an older build can
/// still read it.
///
/// `windowTrack` forces version 8 (STC-482) when a window-scope take's window
/// moved (2 or more entries); entry 0 is the start and matches `bounds`.
///
/// `colorSpace` forces version 9 (STC-510) when non-nil: the name of a colour space
/// the take's pixels are in OTHER than sRGB. `nil` writes no key and no bump.
///
/// `geometry` forces version 7 (STC-235) when it has 2 or more entries — a
/// single entry (or none) is written as no `geometry` key at all and no
/// version bump, the same minimum-version rule every other block above
/// follows. `CaptureSession` passes its timeline for EVERY take — entry 0 is
/// recorded by the first frame — so the one-entry case is the ordinary,
/// never-refitted take, and must stay v2–v6 byte for byte.
func anchorsDocument(timebase: (numer: Int, denom: Int),
                     t0Ns: UInt64,
                     display: DisplayGeometry,
                     capture: CaptureGeometryDoc,
                     camera: CameraTrack?,
                     requested: Bool,
                     mic: MicTrack? = nil,
                     micRequested: Bool = false,
                     systemAudio: SystemAudioTrack? = nil,
                     systemAudioRequested: Bool = false,
                     scope: CaptureScopeDoc = .display,
                     geometry: [GeometryEntryDoc] = [],
                     windowTrack: [WindowTrackEntryDoc] = [],
                     pauses: [PauseInterval],
                     colorSpace: String? = nil,
                     stopReason: String,
                     stopTNs: Int) -> [String: Any] {
    var files: [String: Any] = ["display": "display.mp4"]
    var cameraBlock: [String: Any]?
    if requested {
        cameraBlock = ["present": false]
        if let c = camera, c.present {
            files["camera"] = "camera.mp4"
            cameraBlock = [
                "present": true,
                "device": c.device,
                "width": c.width,
                "height": c.height,
                "firstFramePtsNs": c.firstFramePtsNs,
                "lastFramePtsNs": c.lastFramePtsNs,
                "frameIntervalNs": c.frameIntervalNs,
            ]
        }
    }
    var micBlock: [String: Any]?
    if micRequested {
        micBlock = ["present": false]
        if let m = mic, m.present {
            files["mic"] = "mic.m4a"
            micBlock = [
                "present": true,
                "device": m.device,
                "sampleRate": m.sampleRate,
                "channels": m.channels,
                "firstFramePtsNs": m.firstFramePtsNs,
                "lastFramePtsNs": m.lastFramePtsNs,
            ]
        }
    }
    var systemBlock: [String: Any]?
    if systemAudioRequested {
        systemBlock = ["present": false]
        if let a = systemAudio, a.present {
            files["system"] = "system.m4a"
            systemBlock = [
                "present": true,
                "sampleRate": a.sampleRate,
                "channels": a.channels,
                "firstFramePtsNs": a.firstFramePtsNs,
                "lastFramePtsNs": a.lastFramePtsNs,
            ]
        }
    }
    var version = scope.kind == .display ? 2 : 3
    if micRequested { version = max(version, 4) }
    if !pauses.isEmpty { version = max(version, 5) }
    if systemAudioRequested { version = max(version, 6) }
    if geometry.count >= 2 { version = max(version, 7) }
    // STC-482: a window that MOVED. Two or more entries, on a window scope
    // only — one entry is a window that never moved and writes no `track`, so
    // every existing window take stays at whatever version it was.
    let writesTrack = scope.kind == .window && windowTrack.count >= 2
    if writesTrack { version = max(version, 8) }
    // STC-510: a take whose pixels are not sRGB. Written ONLY then, so a take on an
    // sRGB display keeps whatever version its other blocks earned, byte for byte.
    if colorSpace != nil { version = max(version, 9) }
    var capturedBlock: [String: Any] = ["width": capture.width, "height": capture.height, "codec": "h264",
                                         "firstFrameNs": max(0, capture.firstFrameNs)]
    if let colorSpace { capturedBlock["colorSpace"] = colorSpace }
    var doc: [String: Any] = [
        "version": version,
        "timebase": ["numer": timebase.numer, "denom": timebase.denom],
        // String on purpose: boot-relative ns crosses 2^53 at ~104 days of
        // uptime, and a JSON number would round.
        "t0Ns": String(t0Ns),
        "display": displayJSON(display),
        "capture": capturedBlock,
        "files": files,
        "stop": ["t": stopTNs, "reason": stopReason] as [String: Any],
    ]
    if let cameraBlock {
        doc["camera"] = cameraBlock
    }
    if let micBlock {
        doc["mic"] = micBlock
    }
    if let systemBlock {
        doc["system"] = systemBlock
    }
    if !pauses.isEmpty {
        doc["pauses"] = pauses.map { $0.json }
    }
    if geometry.count >= 2 {
        // STC-235: the refit timeline. Written only once there IS a refit, so
        // every take the display never changed under stays v2–v6 byte for byte.
        doc["geometry"] = geometry.map { g in [
            "startNs": g.startNs,
            "display": displayJSON(g.display),
            "contentRect": ["x": g.contentRect.x, "y": g.contentRect.y,
                            "width": g.contentRect.width, "height": g.contentRect.height],
        ] as [String: Any] }
    }
    if scope.kind != .display {
        var scopeBlock: [String: Any] = ["kind": scope.kind.rawValue]
        if let r = scope.region { scopeBlock["region"] = r.json }
        if let w = scope.window {
            var wb: [String: Any] = ["id": w.id, "bounds": w.bounds.json]
            if let app = w.app, !app.isEmpty { wb["app"] = app }
            if let title = w.title, !title.isEmpty { wb["title"] = title }
            if writesTrack {
                wb["track"] = windowTrack.map { ["t": $0.tNs, "x": $0.x, "y": $0.y] as [String: Any] }
            }
            scopeBlock["window"] = wb
        }
        doc["scope"] = scopeBlock
    }
    return doc
}

/// The `display` block's JSON, shared by the top-level `display` and every
/// `geometry` entry's own `display` (STC-235) — the loader
/// (transform/src/display-geometry.ts's `checkGeometry`) deep-compares
/// `geometry[0].display` to the top-level one, so the two must be built from
/// exactly one place or they could drift apart under a future edit to either
/// call site.
private func displayJSON(_ d: DisplayGeometry) -> [String: Any] {
    return ["id": d.id,
           "pointWidth": d.pointWidth, "pointHeight": d.pointHeight,
           "pixelWidth": d.pixelWidth, "pixelHeight": d.pixelHeight,
           "backingScale": d.backingScale,
           "originX": d.originX, "originY": d.originY]
}
