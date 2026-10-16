/**
 * STC-562 — a camera gap does not cost the take its camera.
 *
 * camera.mp4's input has the display's 1 ns timescale, so it has STC-561's limit:
 * a sample over 2^31 ns (2.147 s) cannot be written, and the first camera frame
 * after a longer gap failed the camera writer. Nothing read the writer's status, so
 * that was SILENT: the take carried on and the PiP ended at the gap. A pause is such
 * a gap (PauseGate drops paused camera frames), and so is a camera that stalls and
 * comes back (STC-553). `CameraCapture` now writes its last frame again once it is
 * 1.5 s old (`decideHoldFrame`, the display's rule), and a camera writer that fails
 * anyway is torn down with a `camera-track-failed` warning and `endedBy:
 * "writer-failed"` (anchors-15).
 *
 * A stall cannot be ordered from a real camera, so it is INJECTED:
 * `STC_CAPTURE_FAULT=camera-gap` throws away every camera frame from 3 s to 8 s
 * after the first, upstream of everything, as a stalled camera sends none. The
 * CONTROL is the load-bearing half: `camera-gap-unheld` is the same five seconds
 * with no hold frames, and it must fail the camera writer. Without it a pass could
 * mean the fault made no gap at all. It also checks the failure path end to end:
 * warning, take still recording, `endedBy`, and a take `loadSession` still opens.
 *
 * Grant test (`npm run test:capture`, from a terminal holding Screen Recording,
 * Input Monitoring and Camera): the bare binary inherits the launching terminal's
 * TCC identity, as device-disconnect.grant.test.ts's camera case does.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

/** HoldFrameDecisions.swift's CAMERA_GAP_FAULT_AFTER_NS + _DURATION_NS, plus room for frames after. */
const PAST_THE_GAP_MS = 3_000 + 5_000 + 3_000;
/** The fault's gap, from the camera's first frame. */
const GAP_START_NS = 3_000_000_000;
const GAP_END_NS = 8_000_000_000;
/** The writer's limit, 2^31 ns. */
const MAX_SAMPLE_NS = 2 ** 31;

interface Line { ev: string; seq?: number; [k: string]: unknown }
const live: ChildProcess[] = [];
afterEach(() => { for (const p of live.splice(0)) p.kill("SIGKILL"); });

function collect(stream: Readable, sink: Line[]): void {
  let buf = "";
  stream.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (l) { try { sink.push(JSON.parse(l)); } catch { /* not JSON */ } }
    }
  });
  stream.resume();
}

function spawnHelper(env: Record<string, string>) {
  const proc = spawn(BIN, ["--stats-interval-ms", "200"], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  proc.stderr!.resume();
  collect(proc.stdio[3] as Readable, fd3);
  return { proc, out, fd3, send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}
const find = (ls: Line[], ev: string, code?: string) =>
  ls.find((l) => l.ev === ev && (code === undefined || l.code === code));
const lastStats = (ls: Line[]) => [...ls].reverse().find((l) => l.ev === "stats");

function bufferOf(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function validateAnchors(anchors: any): void {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(JSON.parse(
    readFileSync(join(root, `schema/anchors-${anchors.version}.schema.json`), "utf8")));
  expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

/** The take as the editor opens it: the loader refuses a camera.mp4 it cannot demux. */
async function loadTake(dir: string) {
  const { loadSession } = await import("../../transform/src/session.js");
  const { memorySource } = await import("../../transform/src/chunk-reader.js");
  return loadSession({
    anchors: JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8")),
    events: JSON.parse(readFileSync(join(dir, "events.json"), "utf8")),
    displayMp4: memorySource(bufferOf(join(dir, "display.mp4")), "display.mp4"),
    cameraMp4: memorySource(bufferOf(join(dir, "camera.mp4")), "camera.mp4"),
  });
}

/** Start a camera take with the fault armed, and wait for its first camera frame. */
async function startCameraTake(fault: string) {
  const dir = mkdtempSync(join(tmpdir(), `stc-${fault || "camera-pause"}-`));
  const h = spawnHelper(fault ? { STC_CAPTURE_FAULT: fault } : {});
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir, seq: 1, camera: true });
  const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (started.ev !== "started") throw explainFailedStart(started as StartOutcome, `STC-562's ${fault || "camera pause"}`);
  const opened = await waitFor(
    () => find(h.fd3, "camera-started") ?? h.fd3.find((l) => l.ev === "warning" && /camera/.test(String(l.code))),
    15_000, "camera-started (or a warning saying why it did not open)");
  if (opened.ev !== "camera-started") {
    throw new Error(`SKIP-GRANT: the camera never opened (${JSON.stringify(opened)}) — most likely no `
      + "Camera grant for this terminal, or no camera.");
  }
  // The fault is timed from the first camera FRAME; a slow camera can take seconds
  // after the open (camera-capture.grant.test.ts measured up to 4 s on an Elgato).
  await waitFor(() => Number(lastStats(h.out)?.cameraFrames ?? 0) > 0, 15_000,
    "the first camera frame (a camera that opened and delivers nothing is STC-286's camera-no-frames)");
  return { h, dir };
}

describe("a camera gap mid-take (STC-562)", () => {
  test("camera-gap: holds carry camera.mp4 through five seconds with no camera frames", async () => {
    const { h, dir } = await startCameraTake("camera-gap");
    await sleep(PAST_THE_GAP_MS);
    expect(find(h.fd3, "warning", "camera-track-failed"), "the camera writer failed").toBeUndefined();
    const stats = lastStats(h.out)!;
    expect(stats.state, "the take is still recording").toBe("recording");
    expect(Number(stats.cameraFramesHeld), "held camera frames through the gap").toBeGreaterThanOrEqual(3);

    h.send({ cmd: "stop", seq: 2 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stopped");
    expect(stopped.reason).toBe("user");
    expect(stopped.stopWarning).toBeUndefined();

    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    validateAnchors(anchors);
    expect(anchors.camera?.present, JSON.stringify(anchors.camera)).toBe(true);
    expect(anchors.camera.endedBy).toBeUndefined();
    // Real frames came back after the gap, and the track says so.
    expect(anchors.camera.lastFramePtsNs - anchors.camera.firstFramePtsNs).toBeGreaterThan(GAP_END_NS);

    const s = await loadTake(dir);
    const frames = s.cameraFrames!;
    let longest = 0;
    for (let i = 1; i < frames.length; i++) longest = Math.max(longest, frames[i]! - frames[i - 1]!);
    expect(longest, "no camera sample anywhere near the writer's limit").toBeLessThan(MAX_SAMPLE_NS * 0.75);
    // Inside the gap there are only holds, about one a second.
    const first = anchors.camera.firstFramePtsNs;
    const inGap = frames.filter((t) => t >= first + GAP_START_NS + 100_000_000 && t < first + GAP_END_NS);
    expect(inGap.length, "held frames inside the gap").toBeGreaterThanOrEqual(3);
    expect(inGap.length, "and only held frames: the fault let real ones through").toBeLessThanOrEqual(6);
  }, 90_000);

  // The ordinary trigger, with no fault at all: PauseGate drops paused camera frames,
  // so a pause is a camera gap. Before STC-562 any pause over 2.15 s failed camera.mp4
  // on resume. 4 s is past the limit with room.
  test("a 4 s pause with the camera on: camera.mp4 carries on after the resume", async () => {
    const { h, dir } = await startCameraTake("");
    await sleep(2_000);
    h.send({ cmd: "pause", seq: 2 });
    expect((await waitFor(() => h.fd3.find((l) => l.seq === 2), 10_000, "paused")).ev).toBe("paused");
    await sleep(4_000);
    h.send({ cmd: "resume", seq: 3 });
    expect((await waitFor(() => h.fd3.find((l) => l.seq === 3), 10_000, "resumed")).ev).toBe("resumed");
    await sleep(3_000);
    expect(find(h.fd3, "warning", "camera-track-failed"), "the camera writer failed on the resume").toBeUndefined();
    expect(Number(lastStats(h.out)?.cameraFramesHeld), "held camera frames through the pause").toBeGreaterThanOrEqual(2);

    h.send({ cmd: "stop", seq: 4 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 4), 30_000, "stopped");
    expect(stopped.reason).toBe("user");
    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    validateAnchors(anchors);
    expect(anchors.camera?.present).toBe(true);
    expect(anchors.camera.endedBy).toBeUndefined();
    const pause = anchors.pauses?.[0];
    expect(pause, "anchors records the pause").toBeDefined();
    expect(anchors.camera.lastFramePtsNs, "real camera frames after the resume").toBeGreaterThan(pause.endNs + 1_000_000_000);
    const s = await loadTake(dir);
    const after = s.cameraFrames!.filter((t) => t > pause.endNs);
    expect(after.length, "camera frames in the file after the resume").toBeGreaterThan(30);
  }, 90_000);

  test("CONTROL, camera-gap-unheld: the same gap with no holds fails the camera writer, and says so", async () => {
    const { h, dir } = await startCameraTake("camera-gap-unheld");
    const warning = await waitFor(() => find(h.fd3, "warning", "camera-track-failed"), PAST_THE_GAP_MS + 5_000,
      "the camera-track-failed warning");
    expect(String(warning.detail), "the writer's own error").toMatch(/-11800|-17771/);
    expect(typeof warning.tNs).toBe("number");

    // The take carries on without the camera.
    const at = h.out.length;
    await sleep(2_000);
    expect(h.fd3.find((l) => l.ev === "stopped"), "the take ended with its camera").toBeUndefined();
    expect(h.out.slice(at).some((l) => l.ev === "stats" && l.state === "recording")).toBe(true);

    h.send({ cmd: "stop", seq: 2 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stopped");
    expect(stopped.reason).toBe("user");
    expect(stopped.stopWarning).toBeUndefined();

    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    validateAnchors(anchors);
    expect(anchors.version).toBe(15);
    expect(anchors.camera?.present).toBe(true);
    expect(anchors.camera.endedBy).toBe("writer-failed");
    // The helper's track end is the last frame APPENDED, and a failed writer keeps
    // accepting a few after the sample that killed it (measured 2026-10-16: 8.0 s, just
    // past the gap). Not the file's end; loadSession corrects that below.
    expect(anchors.camera.lastFramePtsNs - anchors.camera.firstFramePtsNs).toBeLessThan(GAP_END_NS + 1_000_000_000);

    // The take still opens. camera-writer.test.ts measured what a failed writer's
    // finished file holds: the fragments finished before the failure (61 of 90 frames),
    // so most of the camera's first 3 s should come back. Printed as well as asserted:
    // it is the number the runbook asks for.
    const s = await loadTake(dir);
    const kept = s.anchors.camera?.present === true ? s.cameraFrames!.length : 0;
    process.stderr.write(`[camera-gap] unheld: ${kept} camera frames survive the failed writer\n`);
    expect(kept, "the fragments finished before the failure").toBeGreaterThan(0);
    // Nothing after the gap reached the file, and the loaded track ends where the file
    // does, so the PiP does not hold a frozen frame up to the helper's lastFramePtsNs.
    const cam = s.cameraFrames!;
    const first = anchors.camera.firstFramePtsNs;
    expect(cam[cam.length - 1]! - first, "a post-gap frame reached the failed file").toBeLessThan(GAP_START_NS);
    expect(s.anchors.camera!.lastFramePtsNs).toBe(cam[cam.length - 1]);
  }, 90_000);
});
