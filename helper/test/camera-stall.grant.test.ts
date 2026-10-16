/**
 * STC-553 — a camera that stalls after its first frame is said, recorded and hidden.
 *
 * `camera-no-frames` (STC-286) only covers a camera that never delivers. A camera that
 * delivered and then STOPPED said nothing, and the export held its last frame frozen
 * (STC-557). Now `CameraCapture` notices 3 s with no frame ARRIVING
 * (`CameraStallDecisions.swift`), sends one reliable `camera-stalled` warning per stall,
 * records `camera.stalledSpans` (anchors-16, and in `anchors.partial.json` the moment it
 * begins), and render() hides the PiP across it (camera-gaps.ts).
 *
 * A stall cannot be ordered from a real camera, so it is INJECTED:
 * `STC_CAPTURE_FAULT=camera-stall` throws away every camera frame from 3 s to 7 s after
 * the first, upstream of the arrival stamp, as a stalled camera sends none. 4 s: past N,
 * and under the 5 s the Mac check could not see. `camera-stall-end` never lets them back.
 *
 * The CONTROLS are the load-bearing half: the same take with no fault must say nothing and
 * record no span, and a 5 s pause (which drops camera frames, PauseGate) must say nothing
 * either. Without them a pass could mean the check fires on every take.
 *
 * Grant test (`npm run test:capture`, from a terminal holding Screen Recording, Input
 * Monitoring and Camera): the bare binary inherits the launching terminal's TCC identity,
 * as camera-gap.grant.test.ts does.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

/** CameraStallDecisions.swift's fault window, from the camera's first frame. */
const STALL_START_NS = 3_000_000_000;
const STALL_END_NS = 7_000_000_000;
/** N, plus one 250 ms check, plus a camera's ~0.1 s of latency, plus slack. */
const SAID_WITHIN_MS = 3_000 + 250 + 150 + 500;

interface Line { ev: string; seq?: number; [k: string]: unknown }
const live: ChildProcess[] = [];
afterEach(() => { for (const p of live.splice(0)) p.kill("SIGKILL"); });

function collect(stream: Readable, sink: Line[], stamp = false): void {
  let buf = "";
  stream.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (l) { try { sink.push({ ...JSON.parse(l), ...(stamp ? { _at: Date.now() } : {}) }); } catch { /* not JSON */ } }
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
  collect(proc.stdout!, out, true);
  proc.stderr!.resume();
  collect(proc.stdio[3] as Readable, fd3, true);
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
const all = (ls: Line[], ev: string, code: string) => ls.filter((l) => l.ev === ev && l.code === code);
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

/** Start a camera take with the fault armed; resolve at its first camera frame, with when that was. */
async function startCameraTake(fault: string) {
  const dir = mkdtempSync(join(tmpdir(), `stc-${fault || "camera-healthy"}-`));
  const h = spawnHelper(fault ? { STC_CAPTURE_FAULT: fault } : {});
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir, seq: 1, camera: true });
  const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (started.ev !== "started") throw explainFailedStart(started as StartOutcome, `STC-553's ${fault || "control"}`);
  const opened = await waitFor(
    () => find(h.fd3, "camera-started") ?? h.fd3.find((l) => l.ev === "warning" && /camera/.test(String(l.code))),
    15_000, "camera-started (or a warning saying why it did not open)");
  if (opened.ev !== "camera-started") {
    throw new Error(`SKIP-GRANT: the camera never opened (${JSON.stringify(opened)}) — most likely no `
      + "Camera grant for this terminal, or no camera.");
  }
  await waitFor(() => Number(lastStats(h.out)?.cameraFrames ?? 0) > 0, 15_000,
    "the first camera frame (a camera that opened and delivers nothing is STC-286's camera-no-frames)");
  return { h, dir, firstFrameAt: Date.now() };
}

async function stopTake(h: ReturnType<typeof spawnHelper>, seq: number) {
  h.send({ cmd: "stop", seq });
  const stopped = await waitFor(() => h.fd3.find((l) => l.seq === seq), 30_000, "stopped");
  expect(stopped.reason).toBe("user");
}

describe("a camera that stalls after its first frame (STC-553)", () => {
  test("camera-stall: said within N, one warning, recorded as it happens, the PiP hidden and back", async () => {
    const { h, dir, firstFrameAt } = await startCameraTake("camera-stall");
    const w = await waitFor(() => find(h.fd3, "warning", "camera-stalled"),
      STALL_START_NS / 1e6 + SAID_WITHIN_MS + 2_000, "the camera-stalled warning");
    const saidAfterMs = Number(w._at) - firstFrameAt - STALL_START_NS / 1e6;
    process.stderr.write(`[camera-stall] said ${saidAfterMs} ms after the stall began\n`);
    expect(saidAfterMs, "said within N of the stall").toBeLessThan(SAID_WITHIN_MS);
    expect(saidAfterMs, "and not before N had passed").toBeGreaterThan(2_500);
    expect(typeof w.tNs).toBe("number");
    expect(String(w.device).length).toBeGreaterThan(0);

    // The partial says it now, so a helper killed mid-stall still leaves it on record.
    await sleep(800);
    const partial = JSON.parse(readFileSync(join(dir, "anchors.partial.json"), "utf8"));
    expect(partial.version).toBe(16);
    expect(partial.camera.stalledSpans, "the open stall is in the partial").toEqual([{ startNs: w.tNs }]);

    // The camera comes back at 7 s, the take never stopped, and nothing more is said.
    await sleep(STALL_END_NS / 1e6 - STALL_START_NS / 1e6);
    expect(lastStats(h.out)?.state).toBe("recording");
    expect(all(h.fd3, "warning", "camera-stalled"), "one warning per stall").toHaveLength(1);
    expect(find(h.fd3, "warning", "camera-track-failed"), "holds carried camera.mp4 through it").toBeUndefined();
    await stopTake(h, 2);

    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    validateAnchors(anchors);
    expect(anchors.version).toBe(16);
    expect(anchors.camera.endedBy, "a stall is not an end").toBeUndefined();
    const spans = anchors.camera.stalledSpans;
    expect(spans).toHaveLength(1);
    expect(spans[0].startNs, "the span starts where the warning said").toBe(w.tNs);
    const first = anchors.camera.firstFramePtsNs;
    expect(spans[0].startNs - first).toBeGreaterThan(STALL_START_NS - 200_000_000);
    expect(spans[0].startNs - first).toBeLessThan(STALL_START_NS);
    expect(spans[0].endNs - first, "closed by the first frame back").toBeGreaterThanOrEqual(STALL_END_NS);
    expect(spans[0].endNs - first).toBeLessThan(STALL_END_NS + 200_000_000);
    expect(existsSync(join(dir, "anchors.partial.json")), "the partial is retired at a clean stop").toBe(false);

    // The export: no PiP inside the stall, the PiP back after it.
    const s = await loadTake(dir);
    const { render } = await import("../../transform/src/render.js");
    const { defaultProject } = await import("../../transform/src/trim.js");
    const project = defaultProject(anchors.capture.width, anchors.capture.height, undefined, true);
    const mid = Math.round((spans[0].startNs + spans[0].endNs) / 2);
    expect(render(project, s, first + 1_000_000_000).pip, "before the stall").not.toBeNull();
    expect(render(project, s, mid).pip, "inside the stall").toBeNull();
    expect(render(project, s, spans[0].endNs + 500_000_000).pip, "after it").not.toBeNull();
  }, 90_000);

  test("camera-stall-end: a camera that never comes back is one span that runs to stop.t", async () => {
    const { h, dir } = await startCameraTake("camera-stall-end");
    await waitFor(() => find(h.fd3, "warning", "camera-stalled"),
      STALL_START_NS / 1e6 + SAID_WITHIN_MS + 2_000, "the camera-stalled warning");
    await sleep(3_000);
    await stopTake(h, 2);
    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    validateAnchors(anchors);
    expect(anchors.camera.stalledSpans).toHaveLength(1);
    expect(anchors.camera.stalledSpans[0].endNs, "a stall still going ends at the stop").toBe(anchors.stop.t);
  }, 90_000);

  test("CONTROL, no fault: a healthy camera says nothing and records no span", async () => {
    const { h, dir } = await startCameraTake("");
    await sleep(STALL_END_NS / 1e6 + 2_000);
    expect(find(h.fd3, "warning", "camera-stalled"), "a healthy camera was called stalled").toBeUndefined();
    await stopTake(h, 2);
    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    validateAnchors(anchors);
    expect(anchors.camera.present).toBe(true);
    expect(anchors.camera.stalledSpans).toBeUndefined();
    expect(anchors.version, "a take with no stall keeps the version its blocks earned").not.toBe(16);
  }, 90_000);

  test("CONTROL, a 5 s pause: paused camera frames are not a stall", async () => {
    const { h, dir } = await startCameraTake("");
    await sleep(2_000);
    h.send({ cmd: "pause", seq: 2 });
    expect((await waitFor(() => h.fd3.find((l) => l.seq === 2), 10_000, "paused")).ev).toBe("paused");
    await sleep(5_000);
    h.send({ cmd: "resume", seq: 3 });
    expect((await waitFor(() => h.fd3.find((l) => l.seq === 3), 10_000, "resumed")).ev).toBe("resumed");
    await sleep(4_000);
    expect(find(h.fd3, "warning", "camera-stalled"), "a pause was called a stall").toBeUndefined();
    await stopTake(h, 4);
    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    validateAnchors(anchors);
    expect(anchors.pauses).toHaveLength(1);
    expect(anchors.camera.stalledSpans).toBeUndefined();
  }, 90_000);
});
