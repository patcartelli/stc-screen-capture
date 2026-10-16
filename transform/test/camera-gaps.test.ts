/**
 * STC-553 (folding in STC-557): the PiP hides across a camera stall instead of holding a
 * frozen frame. `cameraGaps` on synthetic grids for every case the ticket names (a stall
 * that recovers, a pause, a slow camera, a healthy one, a stall under 5 s), then render()
 * itself on fixtures/pip with its camera grid swapped for a stalled one.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cameraGaps, inCameraGap, CAMERA_STALL_NS } from "../src/camera-gaps.js";
import { loadSession } from "../src/session.js";
import { memorySource } from "../src/chunk-reader.js";
import { render } from "../src/render.js";
import { defaultProject } from "../src/trim.js";
import type { Session } from "../src/types.js";

const S = 1_000_000_000;
const FI = 33_333_333;

/** A frame every `step` ns over [from, to). */
function grid(from: number, to: number, step = FI): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += step) out.push(Math.round(t));
  return out;
}

function session(frames: number[], extra: { stalledSpans?: { startNs: number; endNs: number }[];
  pauses?: { startNs: number; endNs: number }[]; frameIntervalNs?: number } = {}): Session {
  return {
    anchors: {
      version: 16, timebase: { numer: 1, denom: 1 }, t0Ns: "0",
      display: { id: 1, pointWidth: 640, pointHeight: 360, pixelWidth: 640, pixelHeight: 360, backingScale: 1, originX: 0, originY: 0 },
      capture: { width: 640, height: 360, codec: "h264" },
      camera: { present: true, device: "Cam", width: 1280, height: 720,
                firstFramePtsNs: frames[0]!, lastFramePtsNs: frames[frames.length - 1]!,
                frameIntervalNs: extra.frameIntervalNs ?? FI,
                ...(extra.stalledSpans ? { stalledSpans: extra.stalledSpans } : {}) },
      ...(extra.pauses ? { pauses: extra.pauses } : {}),
      files: { display: "display.mp4", camera: "camera.mp4" },
    },
    events: [], frames: [0], cameraFrames: frames,
  } as Session;
}

describe("cameraGaps (STC-553)", () => {
  test("a healthy camera has none", () => {
    expect(cameraGaps(session(grid(0, 60 * S)))).toEqual([]);
  });

  test("a slow but alive camera keeps its PiP (12 frames in 11 s, camera-capture.grant.test.ts)", () => {
    expect(cameraGaps(session(grid(0, 11 * S, 11 * S / 12), { frameIntervalNs: 11 * S / 12 }))).toEqual([]);
  });

  test("an old take's 15 s stall that recovers hides the PiP for exactly that stretch", () => {
    const before = grid(0, 10 * S);
    const last = before[before.length - 1]!;
    const s = session([...before, ...grid(25 * S, 40 * S)]);
    expect(cameraGaps(s)).toEqual([{ startNs: last + FI, endNs: 25 * S }]);
    expect(inCameraGap(s, last), "the last good frame shows for its own interval").toBe(false);
    expect(inCameraGap(s, 15 * S)).toBe(true);
    expect(inCameraGap(s, 25 * S), "back with the first frame after").toBe(false);
  });

  test("a stall just under 5 s (what the Mac check could not see) still hides; one just under N does not", () => {
    const four = session([...grid(0, 10 * S), ...grid(14.5 * S, 20 * S)]);
    expect(cameraGaps(four)).toHaveLength(1);
    const short = session([...grid(0, 10 * S), ...grid(10 * S + CAMERA_STALL_NS - FI, 20 * S)]);
    expect(cameraGaps(short)).toEqual([]);
  });

  test("a pause is not a stall: a 20 s pause's gap hides nothing, so a pause exports unchanged", () => {
    const s = session([...grid(0, 10 * S), ...grid(30 * S, 40 * S)],
                      { pauses: [{ startNs: 10 * S, endNs: 30 * S }] });
    expect(cameraGaps(s)).toEqual([]);
  });

  test("a stall on both sides of a pause counts only recording time, and never hides inside the pause", () => {
    // 2 s stalled before the pause, 2 s after: 4 s of recording with no camera.
    const s = session([...grid(0, 8 * S), ...grid(32 * S, 40 * S)],
                      { pauses: [{ startNs: 10 * S, endNs: 30 * S }] });
    const gaps = cameraGaps(s);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]!.endNs).toBe(10 * S);
    expect(gaps[1]).toEqual({ startNs: 30 * S, endNs: 32 * S });
    expect(inCameraGap(s, 20 * S)).toBe(false);
  });

  test("a new take's stalledSpans hide the PiP through STC-562's held frames", () => {
    // Holds land a second apart through the stall, so the grid alone shows no gap.
    const frames = [...grid(0, 10 * S), ...grid(11 * S, 25 * S, S), ...grid(25 * S, 40 * S)];
    const lastReal = grid(0, 10 * S).at(-1)!;
    expect(cameraGaps(session(frames)), "the control: the grid alone sees nothing").toEqual([]);
    const s = session(frames, { stalledSpans: [{ startNs: lastReal, endNs: 25 * S }] });
    expect(cameraGaps(s)).toEqual([{ startNs: lastReal + FI, endNs: 25 * S }]);
  });

  test("a span and a grid gap over the same stall merge into one", () => {
    const before = grid(0, 10 * S);
    const last = before.at(-1)!;
    const s = session([...before, ...grid(25 * S, 40 * S)], { stalledSpans: [{ startNs: last, endNs: 25 * S }] });
    expect(cameraGaps(s)).toEqual([{ startNs: last + FI, endNs: 25 * S }]);
  });
});

describe("render() across a stall (STC-557)", () => {
  const root = join(__dirname, "..", "..");
  const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
  const mp4 = (p: string) => {
    const b = readFileSync(join(root, p));
    return memorySource(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, p);
  };

  test("the PiP is gone during a recovered stall and back after it; a healthy grid draws it throughout", async () => {
    const real = await loadSession({
      anchors: load("fixtures/pip/anchors.json"), events: load("fixtures/pip/events.json"),
      displayMp4: mp4("fixtures/pip/display.mp4"), cameraMp4: mp4("fixtures/pip/camera.mp4"),
    });
    const project = defaultProject(640, 360, undefined, true);
    const healthy = grid(0.5 * S, 4.9 * S);
    // A 3.6 s stall: 0.5-1.0 s, then nothing until 4.6 s.
    const stalled = [...grid(0.5 * S, 1.0 * S), ...grid(4.6 * S, 4.9 * S)];
    const withGrid = (g: number[]): Session => ({
      ...real, cameraFrames: g,
      anchors: { ...real.anchors, camera: { ...real.anchors.camera!, firstFramePtsNs: g[0]!, lastFramePtsNs: g.at(-1)!, frameIntervalNs: FI } },
    });
    for (const t of [0.8, 2.5, 4.7]) {
      expect(render(project, withGrid(healthy), t * S).pip, `healthy at ${t} s`).not.toBeNull();
    }
    const s = withGrid(stalled);
    expect(render(project, s, 0.8 * S).pip, "before the stall").not.toBeNull();
    expect(render(project, s, 2.5 * S).pip, "inside the stall").toBeNull();
    expect(render(project, s, 4.7 * S).pip, "after it recovers").not.toBeNull();
  });
});
