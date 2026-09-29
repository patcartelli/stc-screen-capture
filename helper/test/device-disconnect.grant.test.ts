/**
 * STC-433 — a mic (or camera) that disconnects MID-TAKE ends only its own
 * track, never the take.
 *
 * Found on the first hardware pass (2026-09-25): unplugging the mic during a
 * recording ended the whole take, video included. `Watchers.onDeviceChange`
 * fired but was wired to nothing; `CaptureSession.handleMicDisconnected` /
 * `handleCameraDisconnected` now tear down only that subsystem and leave the
 * display (and the other devices) recording.
 *
 * A device does not unplug on request, so the disconnect is INJECTED:
 * `STC_CAPTURE_FAULT=mic-disconnected` / `=camera-disconnected` call the same
 * handler a real `AVCaptureDeviceWasDisconnected` drives, 0.5 s after the
 * device opens (Capture.swift, `armMicDisconnectFault`). That exercises the
 * reaction — warning, device torn down, take still recording, a clean stop
 * with the device's track kept — which is the whole of the fix. Whether a
 * REAL unplug reaches this handler (rather than, say, an AVFoundation
 * exception first) is the one thing only a hand on a cable can settle:
 * docs/STC-433-RUNBOOK.md.
 *
 * The third test is the race found while merging this into STC-235's stop
 * path (2026-09-29): a take stopped straight after the unplug, while the
 * disconnect's own `m.stop` is still finishing. `stop()` used to find
 * `mic == nil` and not wait, so anchors.json could say "no mic" beside a
 * mic.m4a holding everything up to the unplug. `midTakeTeardowns` closes it.
 *
 * Grant test (`npm run test:capture`, from a terminal holding Screen Recording
 * and Microphone — and Camera for the camera case): the bare binary inherits
 * the launching terminal's TCC identity (PHASE-0 §6).
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

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
const hasMoov = (path: string) => readFileSync(path).includes(Buffer.from("moov", "ascii"));

function validateAnchors(anchors: any): void {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(JSON.parse(
    readFileSync(join(root, `schema/anchors-${anchors.version}.schema.json`), "utf8")));
  expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);
}

/** The first mic, by uid — the helper never picks a mic by itself (STC-233). */
async function firstMicUid(): Promise<string | null> {
  const h = spawnHelper({});
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "devices", seq: 1 });
  const d = await waitFor(() => h.fd3.find((l) => l.seq === 1), 10_000, "devices");
  h.send({ cmd: "quit", seq: 2 });
  const mics = Array.isArray(d.mics) ? (d.mics as { uid: string }[]) : [];
  return mics[0]?.uid ?? null;
}

/** Start a take with the fault armed; throw a SKIP-GRANT explanation if it cannot record. */
async function startWith(fault: string, extra: object, opened: string) {
  const dir = mkdtempSync(join(tmpdir(), `stc-${fault}-`));
  const h = spawnHelper({ STC_CAPTURE_FAULT: fault });
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir, seq: 1, ...extra });
  const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (started.ev !== "started") throw explainFailedStart(started as StartOutcome, `STC-433's ${fault}`);
  const device = await waitFor(
    () => find(h.fd3, opened) ?? h.fd3.find((l) => l.ev === "warning" && /mic|camera/.test(String(l.code))
                                          && l.code !== fault),
    15_000, `${opened} (or a warning saying why it did not open)`);
  if (device.ev !== opened) {
    throw new Error(`SKIP-GRANT: the device never opened (${JSON.stringify(device)}) — most likely no `
      + `${opened === "mic-started" ? "Microphone" : "Camera"} grant for this terminal, or no such device.`);
  }
  return { h, dir };
}

describe("a device that disconnects mid-take ends only its own track (STC-433)", () => {
  test("mic: warning, the take keeps recording, a clean stop keeps the mic track up to the unplug", async () => {
    const uid = await firstMicUid();
    if (!uid) throw new Error("SKIP-GRANT: no microphone to open on this machine");
    const { h, dir } = await startWith("mic-disconnected", { micDeviceUid: uid }, "mic-started");

    const warning = await waitFor(() => find(h.fd3, "warning", "mic-disconnected"), 5_000, "the mic-disconnected warning");
    expect(warning.uid).toBe(uid);

    // The regression was the take ENDING here. Two full seconds later it must
    // still be recording, with no unsolicited `stopped`.
    const at = h.out.length;
    await sleep(2_000);
    expect(h.fd3.find((l) => l.ev === "stopped"), "the take ended when the mic disconnected").toBeUndefined();
    expect(h.out.slice(at).some((l) => l.ev === "stats" && l.state === "recording"),
      "no `recording` heartbeat after the unplug").toBe(true);

    h.send({ cmd: "stop", seq: 9 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 9), 30_000, "stop");
    expect(stopped.ev).toBe("stopped");
    expect(stopped.stopWarning, "the stop hit its backstop").toBeUndefined();

    expect(hasMoov(join(dir, "display.mp4")), "display.mp4 was not finalised").toBe(true);
    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    validateAnchors(anchors);
    expect(anchors.mic?.present, "the mic's track up to the unplug was lost").toBe(true);
    expect(statSync(join(dir, "mic.m4a")).size).toBeGreaterThan(0);
    // The mic stopped at the unplug, not at the end of the take.
    expect(anchors.mic.lastFramePtsNs).toBeLessThan(anchors.stop.t - 1_000_000_000);
  }, 90_000);

  test("mic: a take stopped straight after the unplug still records the mic track (the stop waits for it)", async () => {
    const uid = await firstMicUid();
    if (!uid) throw new Error("SKIP-GRANT: no microphone to open on this machine");
    const { h, dir } = await startWith("mic-disconnected", { micDeviceUid: uid }, "mic-started");

    await waitFor(() => find(h.fd3, "warning", "mic-disconnected"), 5_000, "the mic-disconnected warning");
    // No pause: the disconnect's own m.stop is very likely still finishing.
    h.send({ cmd: "stop", seq: 9 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 9), 30_000, "stop");
    expect(stopped.ev).toBe("stopped");
    expect(stopped.stopWarning).toBeUndefined();

    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    validateAnchors(anchors);
    expect(anchors.mic?.present, "anchors.json was written before the mic's own teardown finished").toBe(true);
    expect(statSync(join(dir, "mic.m4a")).size).toBeGreaterThan(0);
  }, 90_000);

  test("camera: warning, the take keeps recording, a clean stop keeps the camera track", async () => {
    const { h, dir } = await startWith("camera-disconnected", { camera: true }, "camera-started");

    await waitFor(() => find(h.fd3, "warning", "camera-disconnected"), 5_000, "the camera-disconnected warning");
    const at = h.out.length;
    await sleep(2_000);
    expect(h.fd3.find((l) => l.ev === "stopped"), "the take ended when the camera disconnected").toBeUndefined();
    expect(h.out.slice(at).some((l) => l.ev === "stats" && l.state === "recording")).toBe(true);

    h.send({ cmd: "stop", seq: 9 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 9), 30_000, "stop");
    expect(stopped.ev).toBe("stopped");
    expect(stopped.stopWarning).toBeUndefined();
    expect(hasMoov(join(dir, "display.mp4"))).toBe(true);
    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    validateAnchors(anchors);
    expect(existsSync(join(dir, "camera.mp4")), "camera.mp4 missing").toBe(true);
  }, 90_000);
});
