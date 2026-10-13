import Foundation

var failures: [String] = []
func check(_ c: Bool, _ what: String) { if !c { failures.append(what) } }

let display = DisplayGeometry(id: 1, pointWidth: 1920, pointHeight: 1080,
                              pixelWidth: 3840, pixelHeight: 2160, originX: 0, originY: 0)
let capture = CaptureGeometryDoc(width: 3840, height: 2160, firstFrameNs: 200_000_000)
let full = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display, capture: capture,
                           camera: nil, requested: false, pauses: [],
                           stopReason: "user", stopTNs: 20_000_000_000)

// 1. The partial is the stop-time document minus `stop`, and nothing else.
do {
    let p = partialAnchors(full)
    check(p["stop"] == nil, "partial must carry no stop block")
    var expected = full; expected.removeValue(forKey: "stop")
    let a = try! JSONSerialization.data(withJSONObject: p, options: [.sortedKeys])
    let b = try! JSONSerialization.data(withJSONObject: expected, options: [.sortedKeys])
    check(a == b, "partial must equal the stop-time document minus stop, byte for byte")
}

let tmp = FileManager.default.temporaryDirectory
    .appendingPathComponent("stc-partial-\(ProcessInfo.processInfo.processIdentifier)")
try? FileManager.default.removeItem(at: tmp)
try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
let partialURL = tmp.appendingPathComponent(PARTIAL_ANCHORS_FILE)

// 2. Written whole, readable back, and a rewrite replaces it.
do {
    try writePartialAnchors(partialAnchors(full), in: tmp)
    let back = try JSONSerialization.jsonObject(with: Data(contentsOf: partialURL)) as? [String: Any]
    check(back?["version"] as? Int == 2, "partial must read back")
    var v2 = partialAnchors(full); v2["version"] = 5
    try writePartialAnchors(v2, in: tmp)
    let again = try JSONSerialization.jsonObject(with: Data(contentsOf: partialURL)) as? [String: Any]
    check(again?["version"] as? Int == 5, "a rewrite must replace the partial")
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: tmp.path)
    check(leftovers == [PARTIAL_ANCHORS_FILE], "an atomic write must leave no temp file behind: \(leftovers)")
} catch { failures.append("write failed: \(error)") }

// 3. Retire keeps the partial while anchors.json is missing (STC-527's failed write)...
retirePartialAnchors(in: tmp)
check(FileManager.default.fileExists(atPath: partialURL.path),
      "retire must KEEP the partial when anchors.json was not written — it is all recovery has")
// ...and removes it once anchors.json exists.
FileManager.default.createFile(atPath: tmp.appendingPathComponent("anchors.json").path, contents: Data("{}".utf8))
retirePartialAnchors(in: tmp)
check(!FileManager.default.fileExists(atPath: partialURL.path), "retire must remove the partial once anchors.json exists")

// 4. Coalescing (Review Focus 5): a burst of requests schedules ONE write; a request
//    after that write began schedules exactly one more.
do {
    var c = PartialWriteCoalescer()
    check(c.request() == true, "the first request schedules a write")
    for _ in 0..<30 { check(c.request() == false, "a request while one is pending schedules nothing") }
    c.began()
    check(c.request() == true, "a change after the write began needs one more write")
    check(c.request() == false, "and only one")
}

try? FileManager.default.removeItem(at: tmp)
if failures.isEmpty { print("ALL PASS") } else { failures.forEach { print("FAIL: \($0)") }; exit(1) }
