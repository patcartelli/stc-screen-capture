/**
 * STC-539 — a camera take the helper dies in keeps its camera.
 *
 * On hardware (2026-10-14) a 62 s take with the camera on was SIGKILLed: display.mp4
 * and system.m4a survived through STC-394's fragments, and camera.mp4 was 0 bytes, so
 * STC-530's recovery dropped the PiP. This kills a camera take the same way and holds
 * camera.mp4 to what display.mp4 already does: demuxable up to roughly the last
 * fragment interval, and recovered with the camera present.
 *
 * Two causes leave the same 0-byte file, and only one is this bug: a writer that
 * accepted frames and flushed nothing, or a camera that stopped delivering after its
 * first frame (`anchors.partial.json` is rewritten at the camera's FIRST frame only, so
 * it cannot tell them apart). The heartbeat's `cameraFrames` can: the last one before
 * the kill must show the camera still delivering, or the run says so and proves nothing.
 *
 * Goes through tools/test-host (`--kill-after-ms`), because the camera needs the
 * bundle's Camera grant — the same route camera-capture.grant.test.ts takes. Needs
 * Screen Recording AND Camera for STC Signing Probe: `npm run test:capture`.
 */
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demuxTrack } from "../../transform/src/demux.js";
import { memorySource } from "../../transform/src/chunk-reader.js";
import { recoverTake } from "../../app/src/recover-take.js";

const root = join(__dirname, "..", "..");
const APP = join(root, "tools/test-host/STCTestHost.app");
const HELPER = join(root, "helper/build/stc-helper");

/**
 * Long enough to cross several 2 s fragment boundaries AFTER a slow camera opens:
 * camera-capture.grant.test.ts measured 2.2-4 s to open an Elgato Facecam 4K, and
 * phase 0 ~1 s of warm-up after that.
 */
const KILL_AFTER_MS = 12_000;

/** The fragment interval (`movieFragmentIntervalSec`, 2 s) plus the heartbeat's staleness and slack. */
const FRAGMENT_LOSS_NS = 3_000_000_000;

/** A camera that delivered fewer than this many frames by the kill was not fed; see the header. */
const MIN_CAMERA_FRAMES = 60;

function bufferOf(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe("a camera take the helper dies in keeps its camera (STC-539)", () => {
  test("SIGKILL mid-take leaves a demuxable camera.mp4 and a recovered take with its PiP", async () => {
    if (!existsSync(APP)) throw new Error(`${APP} is missing — run tools/test-host/build.sh first`);
    const dir = mkdtempSync(join(tmpdir(), "stc-crash-camera-"));
    const resultPath = join(dir, "result.json");
    execFileSync("open", ["-W", APP, "--args", "--helper", HELPER, "--dir", dir,
                          "--camera", "--kill-after-ms", String(KILL_AFTER_MS),
                          "--out", resultPath],
                 { timeout: 120_000 });

    if (!existsSync(resultPath)) {
      throw new Error("SKIP-GRANT: the test-host produced nothing — most likely Screen Recording " +
        "and/or Camera is missing for STC Signing Probe. See camera-capture.grant.test.ts for the " +
        "working procedure.");
    }
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    if (result.verdict !== "killed") {
      throw new Error(`the take never started, so nothing was killed (verdict=${result.verdict}): ` +
        JSON.stringify(result.startOutcome));
    }
    const transcript = result.transcript as Array<Record<string, unknown>>;
    const cameraStarted = transcript.find((l) => l.ev === "camera-started");
    if (!cameraStarted) {
      throw new Error("SKIP-GRANT: no camera-started event — the camera never opened, most likely " +
        "no Camera grant for STC Signing Probe. Warnings: " +
        JSON.stringify(transcript.filter((l) => l.ev === "warning")));
    }

    // The discriminator. Without it a 0-byte file below could be a starved camera.
    const cameraFrames = Number(result.lastStats?.cameraFrames ?? 0);
    const killedAtNs = Number(result.lastStats?.elapsedMs ?? 0) * 1e6;
    if (cameraFrames < MIN_CAMERA_FRAMES) {
      throw new Error(`the camera (${cameraStarted.device}) had delivered only ${cameraFrames} frames ` +
        `by the kill, so this run cannot say anything about the writer. A covered lens, a closed ` +
        `lid or another app holding the camera all look like this.`);
    }

    // The partial claims the camera, which is what makes recovery read camera.mp4 at all.
    const partial = JSON.parse(readFileSync(join(dir, "anchors.partial.json"), "utf8"));
    expect(partial.camera?.present).toBe(true);

    // THE BUG: 0 bytes after ~60 s of accepted frames on 2026-10-14.
    const cameraPath = join(dir, "camera.mp4");
    expect(statSync(cameraPath).size,
      `camera.mp4 is empty after ${cameraFrames} appended frames`).toBeGreaterThan(0);
    const cam = await demuxTrack(memorySource(bufferOf(cameraPath), "camera.mp4"), "camera.mp4");
    expect(cam.framesNs.length).toBeGreaterThan(0);
    expect(cam.framesNs.length).toBeLessThanOrEqual(cameraFrames);
    const lastNs = cam.framesNs[cam.framesNs.length - 1]!;
    expect(killedAtNs - lastNs,
      `camera.mp4 ends ${(killedAtNs - lastNs) / 1e9}s before the kill`).toBeLessThan(FRAGMENT_LOSS_NS);

    // And the recovered take keeps its PiP — the ticket's "done when".
    const r = await recoverTake(dir, "recorder-quit");
    expect(r, JSON.stringify(r)).toEqual({ ok: true });
    const a = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(a.camera?.present).toBe(true);
    expect(a.files?.camera).toBe("camera.mp4");
    expect(a.camera.lastFramePtsNs).toBe(lastNs);
  }, 180_000);
});
