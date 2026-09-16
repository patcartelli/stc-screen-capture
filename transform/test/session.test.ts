import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSession, rebaseMicAudio, SessionLoadError } from "../src/session.js";
import type { Anchors } from "../src/types.js";
import type { DemuxedAudio } from "../src/demux-audio.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const mp4 = (p: string) => {
  const b = readFileSync(join(root, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** anchors describing the offset fixture: frames begin 250 ms in */
function offsetAnchors(over: Partial<Anchors> = {}): any {
  return {
    version: 1,
    timebase: { numer: 125, denom: 3 },
    t0Ns: "1000",
    display: { id: 1, pointWidth: 640, pointHeight: 360, pixelWidth: 640, pixelHeight: 360,
               backingScale: 1, originX: 0, originY: 0 },
    capture: { width: 640, height: 360, codec: "h264", firstFrameNs: 250_000_000 },
    files: { display: "display.mp4" },
    ...over,
  };
}

describe("loadSession", () => {
  test("builds a session whose frame grid comes from the file, edit list included", async () => {
    const s = await loadSession({
      anchors: offsetAnchors(),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.frames[0]).toBe(250_000_000);
    expect(s.frames.length).toBeGreaterThan(10);
    expect(s.events.length).toBe(1);
    expect(s.anchors.capture.width).toBe(640);
  });

  test("rejects a schema version it was not written for", async () => {
    // 4 used to be that version; STC-233 made it real (a mic-requested take).
    // 99 is not, and never will be by accident.
    await expect(loadSession({
      anchors: offsetAnchors({ version: 99 as any }),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(SessionLoadError);
  });

  test("rejects an events document of the wrong version", async () => {
    await expect(loadSession({
      anchors: offsetAnchors(),
      events: { version: 99, events: [] } as any,
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(SessionLoadError);
  });

  test("cross-checks the recovered frame offset against what the helper measured", async () => {
    // The file carries the offset only as a timescale-quantised empty edit, so
    // a small disagreement is expected and fine. A large one means the reader
    // and the writer disagree about time — the exact bug that desynced the
    // cursor by 231 ms — and must not be papered over.
    await expect(loadSession({
      anchors: offsetAnchors({ capture: { width: 640, height: 360, codec: "h264",
                                          firstFrameNs: 900_000_000 } as any }),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/offset/i);
  });

  test("tolerates quantisation-sized disagreement without complaint", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({ capture: { width: 640, height: 360, codec: "h264",
                                          firstFrameNs: 250_000_000 + 9_000 } as any }),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.frames[0]).toBe(250_000_000);
  });

  test("events are sorted by time even if the file is not", async () => {
    const s = await loadSession({
      anchors: offsetAnchors(),
      events: { version: 1, events: [
        { t: 500, kind: "move", x: 1, y: 1 },
        { t: 100, kind: "move", x: 2, y: 2 },
      ] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.events.map((e) => e.t)).toEqual([100, 500]);
  });
});

describe("loader accepts v1 through v4 anchors", () => {
  // The helper does not emit v2 until increment 3, does not emit v3 until
  // STC-370 (only for a region/window take), and does not emit v4 until
  // STC-233 (only when a mic was requested). A loader that demanded the
  // latest version would break every grant test in the gap.
  test("a version 1 anchors document still loads", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({ version: 1 }),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s).toBeDefined();
  });

  test("a version 2 anchors document loads", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({ version: 2 }),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s).toBeDefined();
  });

  // STC-370: a region/window-scope take writes v3 with a `scope` block; an
  // absent `scope` (a whole-display v3 document, which the helper never
  // actually writes — display-scope stays v2 — but nothing here should
  // depend on that) means the same thing an absent one always meant.
  test("a version 3 anchors document loads, scope included", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({
        version: 3,
        scope: { kind: "region", region: { x: 10, y: 20, width: 300, height: 200 } },
      } as any),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s).toBeDefined();
    expect((s.anchors as any).scope).toEqual({ kind: "region", region: { x: 10, y: 20, width: 300, height: 200 } });
  });

  // STC-233: a mic-requested take writes v4 with a `mic` block; an absent
  // `mic` (a v4 document with no mic block at all, which the helper never
  // actually writes — a mic-less take stays at whatever version its scope
  // already implies — but nothing here should depend on that) means the
  // same thing an absent one always meant: no mic on this take.
  test("a version 4 anchors document loads, mic included", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({
        version: 4,
        mic: { present: false },
      } as any),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s).toBeDefined();
    expect((s.anchors as any).mic).toEqual({ present: false });
  });

  // STC-240 PR A: a paused take writes v5 with a `pauses` block. `pauses` is
  // ACCEPTED AND IGNORED by loadSession in PR A — nothing here reads it yet,
  // so a v5 document loads exactly like a v4 with the field simply present
  // and unused. PR B is what teaches render()/the timeline to cut it.
  test("a version 5 anchors document loads, pauses included but unread", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({
        version: 5,
        pauses: [{ startNs: 1_000_000_000, endNs: 2_000_000_000 }],
      } as any),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s).toBeDefined();
    expect((s.anchors as any).pauses).toEqual([{ startNs: 1_000_000_000, endNs: 2_000_000_000 }]);
  });

  test("a version 6 anchors document is rejected by name", async () => {
    // Widening must not become "accept anything". Version 6, not 5: STC-240
    // made 5 a real, supported version (a paused take's `pauses` block), so
    // it is no longer a stand-in for "unknown future version" — the same
    // thing already happened to 3 (STC-370) and 4 (STC-233).
    await expect(loadSession({
      anchors: offsetAnchors({ version: 6 as any }),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/version 6 is not supported/);
  });

  test("a version 2 events document loads, cursor events included", async () => {
    const s = await loadSession({
      anchors: offsetAnchors(),
      events: { version: 2, events: [{ t: 0, kind: "move", x: 1, y: 2 }, { t: 5, kind: "cursor", shape: "ibeam" }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.events.length).toBe(2);
  });

  test("a version 3 events document is rejected by name", async () => {
    await expect(loadSession({
      anchors: offsetAnchors(),
      events: { version: 3, events: [] } as any,
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/events\.json version 3 is not supported/);
  });

  // "a version 2 anchors document loads" above already covers a v2 anchors
  // document WITHOUT a camera block loading fine (offsetAnchors carries none).

  test("a v2 anchors document with camera.present:true is refused rather than silently dropping the PiP", async () => {
    // loadSession has no camera input yet (no camera file path, no cameraFrames
    // demux — that's increment 3). Loading this "successfully" would leave
    // render() quietly returning pip: null forever, which is exactly the class
    // of silent failure the offset-drift check above exists to make loud.
    await expect(loadSession({
      anchors: offsetAnchors({
        version: 2,
        camera: {
          present: true,
          device: "Fixture Camera",
          width: 1280,
          height: 720,
          firstFramePtsNs: 0,
          lastFramePtsNs: 1_000_000_000,
          frameIntervalNs: 17_000_000,
        },
      } as any),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/no camera\.mp4 was supplied/i);
  });
});

describe("loading a camera track", () => {
  const camAnchors = (over: any = {}) => offsetAnchors({
    version: 2,
    camera: {
      present: true, device: "Fixture Camera", width: 320, height: 180,
      firstFramePtsNs: 1_035_500_000, lastFramePtsNs: 3_024_500_000,
      frameIntervalNs: 17_000_000,
    },
    files: { display: "display.mp4", camera: "camera.mp4" },
    ...over,
  });

  test("a camera track becomes session.cameraFrames", async () => {
    const s = await loadSession({
      anchors: camAnchors(),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
      cameraMp4: mp4("fixtures/pip/camera.mp4"),
    });
    expect(s.cameraFrames?.length).toBe(118);
    expect(s.cameraFrames?.[0]).toBe(1_035_500_000);
  });

  test("a session claiming a camera but given no camera.mp4 is refused", async () => {
    // Silently loading it as camera-less would leave render() returning
    // pip: null for a take that has one, which looks like a rendering bug.
    await expect(loadSession({
      anchors: camAnchors(),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/no camera\.mp4 was supplied/i);
  });

  // The other direction, which had no test at all. A camera file with no
  // anchors block means the two sources disagree about what was recorded, and
  // guessing which is right is worse than refusing.
  test("a camera.mp4 supplied for a take that claims no camera is refused", async () => {
    await expect(loadSession({
      anchors: offsetAnchors({ version: 2, camera: { present: false } } as any),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
      cameraMp4: mp4("fixtures/pip/camera.mp4"),
    })).rejects.toThrow(/a camera\.mp4 was supplied/i);
  });

  test("a camera whose demuxed start disagrees with the anchors is refused", async () => {
    // Same reasoning as the display track's existing offset check: the helper
    // wrote down what it measured, the file preserves a quantised version, and
    // comparing them turns a silent seconds-long desync into a loud failure.
    await expect(loadSession({
      anchors: camAnchors({ camera: { ...camAnchors().camera, firstFramePtsNs: 5_000_000_000 } }),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
      cameraMp4: mp4("fixtures/pip/camera.mp4"),
    })).rejects.toThrow(/camera.*offset|offset.*camera/i);
  });

  test("a v2 session with no camera still loads", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({ version: 2, camera: { present: false } } as any),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.cameraFrames).toBeUndefined();
  });
});

/**
 * STC-233. Mirrors "loading a camera track" above, except for the one test
 * that needs a real committed track (`fixtures/pip/camera.mp4`) — no
 * `mic.m4a` fixture exists in this checkout, the same gap CLAUDE.md already
 * records for a synthetic `fixtures/pip/camera.mp4`: producing one needs
 * macOS, ffmpeg, and a matching sample-table. Until one exists, only the
 * validation paths that never touch the file itself are testable here; a
 * real demux needs a Mac.
 */
describe("loading a mic track", () => {
  const micAnchors = (over: any = {}) => offsetAnchors({
    version: 4,
    mic: {
      present: true, device: "Fixture Mic", sampleRate: 48000, channels: 1,
      firstFramePtsNs: 1_035_500_000, lastFramePtsNs: 3_024_500_000,
    },
    files: { display: "display.mp4", mic: "mic.m4a" },
    ...over,
  });

  test("a session claiming a mic but given no mic.m4a is refused", async () => {
    // Silently loading it as mic-less would leave the export dropping the
    // audio track for a take that has one, which looks like a rendering bug.
    await expect(loadSession({
      anchors: micAnchors(),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/no mic\.m4a was supplied/i);
  });

  // The other direction: a mic file with no anchors block means the two
  // sources disagree about what was recorded, and guessing which is right is
  // worse than refusing — the same reasoning as the camera's own check.
  test("a mic.m4a supplied for a take that claims no mic is refused", async () => {
    await expect(loadSession({
      anchors: offsetAnchors({ version: 4, mic: { present: false } } as any),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
      micM4a: mp4("fixtures/offset/display.mp4"), // any ArrayBuffer — never demuxed on this path
    })).rejects.toThrow(/a mic\.m4a was supplied/i);
  });

  test("a v4 session with no mic still loads", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({ version: 4, mic: { present: false } } as any),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.micAudio).toBeUndefined();
  });
});

/**
 * STC-233. Pins the actual bug fix (`mic.m4a frame-time offset
 * disagreement`, reported on real hardware 2026-09-16): mic.m4a's own
 * sample table cannot carry the session-start gap the way display.mp4/
 * camera.mp4 do — confirmed by inspecting a real take's mic.m4a, whose
 * `trak.edts` was undefined while the same take's display.mp4 had a real
 * two-entry edit list. `loadSession` no longer checks the demuxed audio's
 * offset against anchors (that always failed); it rebases onto anchors
 * instead. No real mic.m4a fixture exists in this checkout (needs macOS +
 * ffmpeg, same gap as fixtures/pip/camera.mp4), so this exercises the pure
 * rebase function directly against a synthetic DemuxedAudio.
 */
describe("rebaseMicAudio", () => {
  const synthetic = (framesNs: number[]): DemuxedAudio => ({
    framesNs,
    codec: "mp4a.40.2",
    sampleRate: 48000,
    numberOfChannels: 1,
    description: new Uint8Array([0]),
    chunks: framesNs.map((ns) => ({ timestampUs: Math.round(ns / 1000), data: new Uint8Array([0]) })),
  });

  test("shifts every sample so the first lands exactly on the measured origin", () => {
    // The confirmed real shape: the file's own first sample is 0 (no edit
    // list recovers the true gap), while the helper measured a real
    // warm-up delay.
    const raw = synthetic([0, 21_333_333, 42_666_667]);
    const out = rebaseMicAudio(raw, 568_894_376);
    expect(out.framesNs[0]).toBe(568_894_376);
    // relative spacing between samples is preserved, not just the first one
    expect(out.framesNs[1]! - out.framesNs[0]!).toBe(raw.framesNs[1]! - raw.framesNs[0]!);
    expect(out.framesNs[2]! - out.framesNs[0]!).toBe(raw.framesNs[2]! - raw.framesNs[0]!);
  });

  test("chunks[].timestampUs stays exactly Math.round(framesNs / 1000), demux-audio.ts's own invariant since STC-394", () => {
    const raw = synthetic([0, 21_333_333]);
    const out = rebaseMicAudio(raw, 568_894_376);
    expect(out.chunks[0]!.timestampUs).toBe(Math.round(out.framesNs[0]! / 1000));
    expect(out.chunks[1]!.timestampUs).toBe(Math.round(out.framesNs[1]! / 1000));
  });

  test("is a no-op if the file's own first sample already equals the measured origin", () => {
    // Self-correcting property: if a future macOS version starts writing a
    // real edit list for audio, the shift should come out near zero rather
    // than double-counting an offset the file already recovered.
    const raw = synthetic([568_894_376, 590_227_709]);
    const out = rebaseMicAudio(raw, 568_894_376);
    expect(out.framesNs).toEqual(raw.framesNs);
    expect(out.chunks.map((c) => c.timestampUs)).toEqual(raw.chunks.map((c) => c.timestampUs));
  });
});
