import Foundation

var failures: [String] = []
func check(_ c: Bool, _ what: String) { if !c { failures.append(what) } }

/// Emits a built document as JSON, prefixed by `marker`, so the TS harness
/// (helper/test/anchors.test.ts) can pull it back out of stdout and validate
/// it against schema/anchors-2.schema.json with Ajv. This closes the gap
/// STC-262 already named: the member-by-member `check()`s above can drift
/// from the schema silently, because the only thing that ever validated a
/// built document against anchors-2 was the grant-gated
/// camera-capture.grant.test.ts, which needs a Camera grant and has never
/// run in CI.
func printJSON(_ o: [String: Any], marker: String) {
    guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]),
          let s = String(data: d, encoding: .utf8) else {
        failures.append("\(marker) document did not serialize to JSON")
        return
    }
    print("\(marker)\(s)")
}

let display = DisplayGeometry(id: 1, pointWidth: 1920, pointHeight: 1080,
                              pixelWidth: 3840, pixelHeight: 2160,
                              originX: 0, originY: 0)
let capture = CaptureGeometryDoc(width: 3840, height: 2160, firstFrameNs: 200_000_000)

// 1. Always version 2. No camera requested: the block is ABSENT, not
//    present:false (STC-303) — present:false is a claim that a camera was
//    asked for and yielded nothing, which is untrue for a display-only take.
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: false,
                            pauses: [],
                            stopReason: "user", stopTNs: 20_000_000_000)
    check(d["version"] as? Int == 2, "version must be 2")
    check(d["camera"] == nil, "camera block must be absent when no camera was requested")
    let files = d["files"] as? [String: Any]
    check(files?["camera"] == nil, "files.camera must be absent when there is no camera")
    printJSON(d, marker: "JSON-NO-CAMERA:")
}

// 2. Requested, but no track — STC-286: a camera that opened and delivered
//    zero frames. This is the one case present:false must still say, so
//    fixing check 1 must not silence it.
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: true,
                            pauses: [],
                            stopReason: "user", stopTNs: 20_000_000_000)
    let cam = d["camera"] as? [String: Any]
    check(cam != nil, "a requested camera must always write a camera block")
    check(cam?["present"] as? Bool == false, "a requested camera with no track must record present:false")
    check(cam?["device"] == nil, "a camera with no track must not invent measurements")
    let files = d["files"] as? [String: Any]
    check(files?["camera"] == nil, "files.camera must be absent when the camera produced no track")
    printJSON(d, marker: "JSON-CAMERA-REQUESTED-NO-FRAMES:")
}

// 3. A present camera records its measurements and its file.
do {
    let track = CameraTrack(present: true, device: "Fixture Camera", width: 1280, height: 720,
                            firstFramePtsNs: 1_035_500_000, lastFramePtsNs: 3_024_500_000,
                            frameIntervalNs: 17_000_000)
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: track, requested: true,
                            pauses: [],
                            stopReason: "user", stopTNs: 20_000_000_000)
    let cam = d["camera"] as? [String: Any]
    check(cam?["present"] as? Bool == true, "present camera must record present:true")
    check(cam?["device"] as? String == "Fixture Camera", "device name must be recorded")
    check(cam?["width"] as? Int == 1280 && cam?["height"] as? Int == 720, "camera size")
    check(cam?["firstFramePtsNs"] as? Int == 1_035_500_000, "first frame pts")
    check(cam?["lastFramePtsNs"] as? Int == 3_024_500_000, "last frame pts")
    check(cam?["frameIntervalNs"] as? Int == 17_000_000, "frame interval")
    let files = d["files"] as? [String: Any]
    check(files?["camera"] as? String == "camera.mp4", "files.camera must name the file")
    printJSON(d, marker: "JSON-WITH-CAMERA:")
}

// 4. t0Ns stays a STRING: boot-relative ns crosses 2^53 at ~104 days of uptime
//    and a JSON number would round.
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 18_446_744_073, display: display,
                            capture: capture, camera: nil, requested: false,
                            pauses: [],
                            stopReason: "user", stopTNs: 1)
    check(d["t0Ns"] as? String == "18446744073", "t0Ns must be a string")
}

// 5. A take ended by SHUTDOWN, not by a stop anyone asked for (STC-311).
//    Every case above used stopReason "user", so the only reasons ever run
//    through the schema were the ones that were already in its enum — while
//    App.shutdown writes "quit", "stdin-closed" and "signal-N" (STC-304), and
//    STC-305 writes "stopped-during-start". Those documents are as real as any
//    other and had never been validated. `signal-15` also pins the open-ended
//    family: it is why the schema cannot be a closed enum.
do {
    for reason in ["quit", "stdin-closed", "signal-15", "stopped-during-start"] {
        let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                                capture: capture, camera: nil, requested: false,
                                pauses: [],
                                stopReason: reason, stopTNs: 8_000_000_000)
        let stop = d["stop"] as? [String: Any]
        check(stop?["reason"] as? String == reason, "stop.reason must be written verbatim: \(reason)")
        printJSON(d, marker: "JSON-STOP-\(reason.uppercased()):")
    }
}

// 6. The writer did not finalise in time, on a shutdown reason. The backstop
//    appends "-timeout" to WHATEVER reason it was given (CaptureSession.stop),
//    so the suffix is not a fixed list of five — a wedged writer during a
//    SIGTERM writes "signal-15-timeout".
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: false,
                            pauses: [],
                            stopReason: "signal-15-timeout", stopTNs: 8_000_000_000)
    check((d["stop"] as? [String: Any])?["reason"] as? String == "signal-15-timeout",
          "a timed-out shutdown keeps its suffixed reason")
    printJSON(d, marker: "JSON-STOP-SIGNAL-TIMEOUT:")
}

// 7. STC-370: a region-scope take. `scope.kind != .display` bumps the
//    version to 3 and writes a `scope` block — the "emit the minimum
//    version" rule, same as project/shot: a whole-display take (blocks 1-6
//    above) never sees this and stays version 2.
do {
    let region = StillRect(x: 100, y: 50, width: 800, height: 600)
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: false,
                            scope: CaptureScopeDoc(kind: .region, region: region, window: nil),
                            pauses: [],
                            stopReason: "user", stopTNs: 20_000_000_000)
    check(d["version"] as? Int == 3, "a region-scope take must write version 3")
    let scope = d["scope"] as? [String: Any]
    check(scope?["kind"] as? String == "region", "scope.kind must be region")
    let r = scope?["region"] as? [String: Any]
    check(r?["x"] as? Double == 100 && r?["y"] as? Double == 50
          && r?["width"] as? Double == 800 && r?["height"] as? Double == 600,
          "scope.region must be written verbatim")
    check(scope?["window"] == nil, "a region scope must not carry a window block")
    printJSON(d, marker: "JSON-SCOPE-REGION:")
}

// 8. STC-370: a window-scope take.
do {
    let window = StillWindowInfo(id: 42, app: "Safari", title: "Example — Safari",
                                 bounds: StillRect(x: 10, y: 20, width: 1024, height: 768))
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: false,
                            scope: CaptureScopeDoc(kind: .window, region: nil, window: window),
                            pauses: [],
                            stopReason: "window-closed", stopTNs: 5_000_000_000)
    check(d["version"] as? Int == 3, "a window-scope take must write version 3")
    let scope = d["scope"] as? [String: Any]
    check(scope?["kind"] as? String == "window", "scope.kind must be window")
    let w = scope?["window"] as? [String: Any]
    check(w?["id"] as? Int == 42, "scope.window.id must be written verbatim")
    check(w?["app"] as? String == "Safari", "scope.window.app must be written verbatim")
    check(scope?["region"] == nil, "a window scope must not carry a region block")
    check((d["stop"] as? [String: Any])?["reason"] as? String == "window-closed",
          "window-closed is a real stop reason a window scope can write")
    printJSON(d, marker: "JSON-SCOPE-WINDOW:")
}

// 9. A whole-display take stays version 2 with NO scope block at all — the
//    default `scope: CaptureScopeDoc = .display` parameter, exercised by
//    every earlier block in this file, must not have silently regressed.
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: false,
                            pauses: [],
                            stopReason: "user", stopTNs: 20_000_000_000)
    check(d["version"] as? Int == 2, "a whole-display take must still write version 2")
    check(d["scope"] == nil, "a whole-display take must not carry a scope block at all")
}

// 10. STC-233: a mic requested but yielding no track — the audio twin of
//     block 2, and the same reason: present:false must still say so rather
//     than fabricating measurements. micRequested bumps the version to 4,
//     the same "emit the minimum version" rule scope already follows one
//     version down.
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: false,
                            mic: nil, micRequested: true,
                            pauses: [],
                            stopReason: "user", stopTNs: 20_000_000_000)
    check(d["version"] as? Int == 4, "a mic-requested take must write version 4")
    let mic = d["mic"] as? [String: Any]
    check(mic != nil, "a requested mic must always write a mic block")
    check(mic?["present"] as? Bool == false, "a requested mic with no track must record present:false")
    check(mic?["device"] == nil, "a mic with no track must not invent measurements")
    let files = d["files"] as? [String: Any]
    check(files?["mic"] == nil, "files.mic must be absent when the mic produced no track")
    printJSON(d, marker: "JSON-MIC-REQUESTED-NO-FRAMES:")
}

// 11. A present mic records its measurements and its file.
do {
    let track = MicTrack(present: true, device: "Fixture Mic", sampleRate: 48000, channels: 1,
                         firstFramePtsNs: 12_000_000, lastFramePtsNs: 19_500_000_000)
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: false,
                            mic: track, micRequested: true,
                            pauses: [],
                            stopReason: "user", stopTNs: 20_000_000_000)
    check(d["version"] as? Int == 4, "a take with a real mic track must write version 4")
    let mic = d["mic"] as? [String: Any]
    check(mic?["present"] as? Bool == true, "present mic must record present:true")
    check(mic?["device"] as? String == "Fixture Mic", "device name must be recorded")
    check(mic?["sampleRate"] as? Int == 48000, "sample rate")
    check(mic?["channels"] as? Int == 1, "channels")
    check(mic?["firstFramePtsNs"] as? Int == 12_000_000, "first sample pts")
    check(mic?["lastFramePtsNs"] as? Int == 19_500_000_000, "last sample pts")
    let files = d["files"] as? [String: Any]
    check(files?["mic"] as? String == "mic.m4a", "files.mic must name the file")
    printJSON(d, marker: "JSON-WITH-MIC:")
}

// 12. Camera AND mic together, on a region scope: version must be the MAX
//     of what scope alone implies (3) and what mic alone implies (4) — 4,
//     never a silent narrowing back to 3 because scope was computed first.
do {
    let camTrack = CameraTrack(present: true, device: "Fixture Camera", width: 1280, height: 720,
                               firstFramePtsNs: 1_000_000_000, lastFramePtsNs: 3_000_000_000,
                               frameIntervalNs: 17_000_000)
    let micTrack = MicTrack(present: true, device: "Fixture Mic", sampleRate: 44100, channels: 2,
                            firstFramePtsNs: 5_000_000, lastFramePtsNs: 3_010_000_000)
    let region = StillRect(x: 0, y: 0, width: 640, height: 360)
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: camTrack, requested: true,
                            mic: micTrack, micRequested: true,
                            scope: CaptureScopeDoc(kind: .region, region: region, window: nil),
                            pauses: [],
                            stopReason: "user", stopTNs: 20_000_000_000)
    check(d["version"] as? Int == 4, "camera + mic + region scope together must still write version 4")
    check(d["camera"] != nil, "camera block must still be present alongside mic")
    check(d["mic"] != nil, "mic block must still be present alongside camera")
    check(d["scope"] != nil, "scope block must still be present at version 4")
    printJSON(d, marker: "JSON-VERSION-4-EVERYTHING:")
}

// ── pauses (STC-240) ────────────────────────────────────────────────────────
// Minimum-version emission: a take that was never paused is byte-for-byte the
// document it is today, at whatever version its other blocks demand.
do {
    let noPause = anchorsDocument(
        timebase: (125, 3), t0Ns: 0,
        display: DisplayGeometry(id: 1, pointWidth: 100, pointHeight: 50,
                                 pixelWidth: 200, pixelHeight: 100, originX: 0, originY: 0),
        capture: CaptureGeometryDoc(width: 200, height: 100, firstFrameNs: 0),
        camera: nil, requested: false, mic: nil, micRequested: false,
        scope: .display, pauses: [], stopReason: "user", stopTNs: 1_000)
    check(noPause["version"] as? Int == 2, "no pauses stays v2")
    check(noPause["pauses"] == nil, "no pauses writes no block")

    let paused = anchorsDocument(
        timebase: (125, 3), t0Ns: 0,
        display: DisplayGeometry(id: 1, pointWidth: 100, pointHeight: 50,
                                 pixelWidth: 200, pixelHeight: 100, originX: 0, originY: 0),
        capture: CaptureGeometryDoc(width: 200, height: 100, firstFrameNs: 0),
        camera: nil, requested: false, mic: nil, micRequested: false,
        scope: .display,
        pauses: [PauseInterval(startNs: 10, endNs: 20)],
        stopReason: "user", stopTNs: 1_000)
    check(paused["version"] as? Int == 5, "a pause raises the floor to v5")
    check((paused["pauses"] as? [[String: Any]])?.count == 1, "and writes one interval")
    check((paused["pauses"] as? [[String: Any]])?.first?["startNs"] as? Int == 10, "startNs survives")
    printJSON(noPause, marker: "JSON-NO-PAUSE:")
    printJSON(paused, marker: "JSON-WITH-PAUSE:")
}

if failures.isEmpty { print("ALL PASS") }
else { for f in failures { print("FAIL: \(f)") }; exit(1) }
