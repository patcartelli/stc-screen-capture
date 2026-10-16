/**
 * STC-561 — a still screen does not end the take.
 *
 * Capture is VFR: ScreenCaptureKit sends no complete frame while nothing on
 * screen changes, so a screen saver, a locked screen or a static screen is a
 * gap in display.mp4. The display input's timescale is 1 ns and the movie
 * writer stores a sample's duration in a signed 32-bit field, so a gap past
 * 2^31 ns (2.147 s) cannot be written: the first frame after it failed the
 * writer (-11800 over -17771) and the take stopped as `error`. Two real takes
 * on 2026-10-16 died that way, each the instant a screen saver ended.
 * `Capture.swift`'s hold timer now writes the last frame again once a second
 * of stillness (`HoldFrameDecisions.swift`).
 *
 * A still screen cannot be ordered up on a test machine, so it is INJECTED:
 * `STC_CAPTURE_FAULT=screen-idle` throws away every complete frame from 1 s to
 * 6 s after the first, upstream of everything, as ScreenCaptureKit's silence
 * would. The CONTROL is the load-bearing half: `screen-idle-unheld` is the same
 * five seconds with the hold timer off, and it must still end the take the way
 * the real ones ended. Without it, a pass here could mean the fault never made
 * a gap at all.
 *
 * Needs a live SCStream, so a grant: `npm run test:capture`.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

/** HoldFrameDecisions.swift's SCREEN_IDLE_FAULT_AFTER_NS + _DURATION_NS, plus room. */
const PAST_THE_STILLNESS_MS = 1_000 + 5_000 + 2_500;
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
const session = () => mkdtempSync(join(tmpdir(), "stc-idle-hold-"));
const skipGrant = (started: StartOutcome) => explainFailedStart(started, "STC-561's still-screen take");

async function demuxDisplay(dir: string): Promise<number[]> {
  const { demuxTrack } = await import("../../transform/src/demux.js");
  const { memorySource } = await import("../../transform/src/chunk-reader.js");
  const buf = readFileSync(join(dir, "display.mp4"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return (await demuxTrack(memorySource(ab, "display.mp4"), "display.mp4")).framesNs;
}

describe("a still screen mid-take (STC-561)", () => {
  test("screen-idle: the take records through five still seconds and stops when asked", async () => {
    const dir = session();
    const h = spawnHelper({ STC_CAPTURE_FAULT: "screen-idle" });
    await waitFor(() => h.fd3.find((l) => l.ev === "ready"), 10_000, "ready");
    h.send({ cmd: "start", dir, seq: 1 });
    const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
    if (started.ev !== "started") throw skipGrant(started);

    await sleep(PAST_THE_STILLNESS_MS);
    expect(h.fd3.find((l) => l.ev === "stopped"), "the take stopped itself").toBeUndefined();
    expect(h.fd3.find((l) => l.ev === "warning" && l.code === "writer-failed"),
      "the display writer failed").toBeUndefined();

    h.send({ cmd: "stop", seq: 2 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stopped");
    expect(stopped.reason).toBe("user");
    expect(stopped.stopWarning, "the writer did not finalise in time").toBeUndefined();
    // Five still seconds at one hold a second, the first due 1.5 s in: 4 or 5.
    expect(stopped.framesHeld as number, "held frames written through the stillness")
      .toBeGreaterThanOrEqual(3);

    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(anchors.stop?.reason).toBe("user");

    // The file: every sample short enough to have been written, and the take
    // carries on past the stillness rather than ending at it.
    const frames = await demuxDisplay(dir);
    expect(frames.length).toBe((stopped.frames as number) + (stopped.framesHeld as number));
    let longest = 0;
    for (let i = 1; i < frames.length; i++) longest = Math.max(longest, frames[i]! - frames[i - 1]!);
    expect(longest, "no sample anywhere near the writer's limit").toBeLessThan(MAX_SAMPLE_NS * 0.75);
    expect(frames[frames.length - 1]! - frames[0]!, "the file spans the stillness")
      .toBeGreaterThan(6_000_000_000);
  }, 90_000);

  test("CONTROL, screen-idle-unheld: the same stillness with no hold frames ends the take as error", async () => {
    const dir = session();
    const h = spawnHelper({ STC_CAPTURE_FAULT: "screen-idle-unheld" });
    await waitFor(() => h.fd3.find((l) => l.ev === "ready"), 10_000, "ready");
    h.send({ cmd: "start", dir, seq: 1 });
    const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
    if (started.ev !== "started") throw skipGrant(started);

    // A frame must arrive after the stillness for the writer to fail on it.
    // On a screen with nothing changing that could take a while; a real take
    // has the menu-bar clock at worst. Nobody sends `stop`.
    const stopped = await waitFor(
      () => h.fd3.find((l) => l.ev === "stopped" && typeof l.seq !== "number"),
      60_000, "an unsolicited `stopped` (move the pointer or let something redraw if the screen is fully static)");
    expect(stopped.reason).toBe("error");
    const warning = h.fd3.find((l) => l.ev === "warning" && l.code === "writer-failed");
    expect(String(warning?.detail ?? ""), "the writer's own error").toMatch(/-17771/);
    expect(stopped.framesHeld).toBe(0);
  }, 90_000);
});
