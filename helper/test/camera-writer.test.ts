import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * STC-562: camera.mp4 across a gap, on the writer itself.
 *
 * camera.mp4's input has the display's 1 ns `mediaTimeScale`, so it has STC-561's
 * limit too: no sample may be longer than 2^31 ns. A camera gap is a pause (PauseGate
 * drops paused camera frames) or a camera that stalls and comes back. This drives
 * `helper/test/fragmented-writer` in camera.mp4's own shape (1280x720, 30 fps, a key
 * frame every 60, 2 s fragments as `movieFragmentIntervalSec`) through a 5 s gap,
 * twice:
 *
 *   - unheld: the writer fails on the first frame after the gap, and is then finished
 *     the way `CameraCapture.stop` finishes it. What that file holds is what decides
 *     whether `loadSession` keeps the take: it refuses a camera.mp4 it cannot demux
 *     (session.ts, STC-541 only forgives one with no video track). Measured here so it
 *     is not a guess.
 *   - held: `decideHoldFrame`, the rule `CameraCapture`'s hold timer runs, writes the
 *     last frame again through the gap, and every frame goes in.
 *
 * No camera and no grant: an `AVAssetWriter` fed synthetic buffers is the subject.
 * That a REAL camera take gets the holds is `camera-gap.grant.test.ts`'s question.
 */
const FPS = 30;
const FRAMES = 300;            // 10 s
const GAP_AFTER_FRAME = 90;    // 3 s in
const GAP_SEC = 5;
const STEP_NS = Math.trunc(1_000_000_000 / FPS);

function readAb(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

async function writeCamera(hold: boolean): Promise<{ out: string; stdout: string }> {
  const out = join(mkdtempSync(join(tmpdir(), "stc-camwriter-")), "camera.mp4");
  const stdout = await runSwiftHarness({
    label: "camera-writer",
    sources: ["helper/src/HoldFrameDecisions.swift", "helper/test/fragmented-writer/main.swift"],
    env: {
      STC_FRAG_OUT: out,
      STC_FRAG_FRAMES: String(FRAMES),
      STC_FRAG_FPS: String(FPS),
      STC_FRAG_INTERVAL_SEC: "2",
      STC_FRAG_W: "1280", STC_FRAG_H: "720", STC_FRAG_KEYINT: "60",
      STC_FRAG_GAP_AFTER_FRAME: String(GAP_AFTER_FRAME),
      STC_FRAG_GAP_SEC: String(GAP_SEC),
      STC_FRAG_FINISH_ON_FAIL: "1",
      ...(hold ? { STC_FRAG_HOLD: "1" } : {}),
    },
  });
  return { out, stdout };
}

async function demux(path: string) {
  const { demuxTrack } = await import("../../transform/src/demux.js");
  const { memorySource } = await import("../../transform/src/chunk-reader.js");
  return demuxTrack(memorySource(readAb(path), "camera.mp4"), "camera.mp4");
}

describe("camera.mp4 across a 5 s gap (STC-562)", () => {
  test("unheld: the writer fails on the first frame after the gap, and the finished file keeps what came before", async () => {
    const { out, stdout } = await writeCamera(false);
    const m = /FAILED at=(\d+) status=(\d+) error=(.*)/.exec(stdout);
    expect(m, `the writer did not fail across a ${GAP_SEC} s gap:\n${stdout}`).not.toBeNull();
    // Soon after the gap, not at it: appends are accepted until the encoder's output
    // reaches the muxer and the sample it cannot store fails the writer (measured 16
    // frames on, fed faster than real time).
    expect(Number(m![1])).toBeGreaterThanOrEqual(GAP_AFTER_FRAME);
    expect(Number(m![1])).toBeLessThan(GAP_AFTER_FRAME + 2 * FPS);
    expect(m![3], "the writer's own error").toMatch(/-11800|-17771/);
    expect(statSync(out).size).toBeGreaterThan(0);

    // The finished file: a demuxable prefix of the real grid, nothing after the gap.
    // If this ever throws instead, a camera writer failure costs the WHOLE take, since
    // loadSession refuses a camera.mp4 it cannot demux.
    const video = await demux(out);
    expect(video.framesNs.length).toBeGreaterThan(0);
    expect(video.framesNs.length).toBeLessThanOrEqual(GAP_AFTER_FRAME);
    // What is lost is the fragment in flight at the failure (measured: 61 of 90 come
    // back), so anchors.camera.lastFramePtsNs, the last frame APPENDED, can run up to one
    // fragment interval past the file's last frame: the PiP holds that frame meanwhile.
    expect(video.framesNs.length, "no more than one 2 s fragment is lost")
      .toBeGreaterThanOrEqual(GAP_AFTER_FRAME - 2 * FPS);
    video.framesNs.forEach((t, i) => expect(t, `frame ${i}`).toBe(i * STEP_NS));
    process.stderr.write(`[camera-writer] unheld: failed at frame ${m![1]}, finishWriting status ${m![2]}, ` +
      `${video.framesNs.length} of ${GAP_AFTER_FRAME} pre-gap frames demux\n`);
  }, 120_000);

  test("held: every frame goes in, and no sample is near the limit", async () => {
    const { out, stdout } = await writeCamera(true);
    expect(stdout, stdout).not.toMatch(/FAILED/);
    const held = Number(/held=(\d+)/.exec(stdout)?.[1] ?? 0);
    expect(held, "holds written through the gap").toBeGreaterThanOrEqual(3);
    const video = await demux(out);
    expect(video.framesNs.length).toBe(FRAMES + held);
    let longest = 0;
    for (let i = 1; i < video.framesNs.length; i++) {
      longest = Math.max(longest, video.framesNs[i]! - video.framesNs[i - 1]!);
    }
    expect(longest, "HOLD_FRAME_INTERVAL_NS plus the seam").toBeLessThanOrEqual(1_500_000_000);
    expect(video.framesNs[video.framesNs.length - 1]).toBe((FRAMES - 1) * STEP_NS + GAP_SEC * 1_000_000_000);
  }, 120_000);
});
