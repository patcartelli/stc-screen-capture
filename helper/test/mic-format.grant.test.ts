/**
 * STC-485 — a mic whose bytes stop matching their label ends its own track,
 * loudly, instead of writing a whole take of full-scale noise.
 *
 * The real trigger has never been reproduced on demand, so the fault is
 * INJECTED: `STC_CAPTURE_FAULT=mic-format-mismatch` makes the guard expect
 * 3-byte frames (MicCapture.swift's `expectedFormat`), and the first real
 * buffer — float32, 4 bytes, the format `audioSettings` pins — trips it. That
 * exercises the reaction end to end: one warning, no second `mic-no-frames`
 * behind it, the take still recording, a clean stop.
 *
 * The control is the half that bears on the bug itself: a real take with no
 * fault must raise no warning, and its mic.m4a must decode to the length its
 * own anchors say it spans. The bad takes decoded to 4/3 of it.
 *
 * Grant test (`npm run test:capture`, from a terminal holding Screen Recording
 * and Microphone): the bare binary inherits the launching terminal's TCC
 * identity (PHASE-0 §6).
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";

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

async function recordWithMic(env: Record<string, string>, ms: number) {
  const uid = await firstMicUid();
  if (!uid) throw new Error("SKIP-GRANT: no microphone to open on this machine");
  const dir = mkdtempSync(join(tmpdir(), "stc-micfmt-"));
  const h = spawnHelper(env);
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir, seq: 1, micDeviceUid: uid });
  const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (started.ev !== "started") throw explainFailedStart(started as StartOutcome, "STC-485's mic format test");
  const opened = await waitFor(
    () => find(h.fd3, "mic-started") ?? h.fd3.find((l) => l.ev === "warning" && /^mic-(not|device|input|writer)/.test(String(l.code))),
    15_000, "mic-started (or a warning saying why it did not open)");
  if (opened.ev !== "mic-started") {
    throw new Error(`SKIP-GRANT: the mic never opened (${JSON.stringify(opened)}) — most likely no `
      + "Microphone grant for this terminal.");
  }
  await sleep(ms);
  const atStop = h.out.length;
  h.send({ cmd: "stop", seq: 2 });
  await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stop reply");
  return { h, dir, atStop };
}

/** What `afinfo` says the file decodes to, in seconds. macOS-only, as is every grant test. */
function decodedSeconds(path: string): number {
  const m = execFileSync("afinfo", [path], { encoding: "utf8" }).match(/estimated duration: ([\d.]+)/);
  if (!m) throw new Error(`afinfo gave no duration for ${path}`);
  return Number(m[1]);
}

describe("the mic format guard (STC-485)", () => {
  test("a mismatched format: ONE warning, the take keeps recording, a clean stop", async () => {
    const { h, dir } = await recordWithMic({ STC_CAPTURE_FAULT: "mic-format-mismatch" }, 4_500);

    const w = find(h.fd3, "warning", "mic-format-mismatch");
    expect(w, "no mic-format-mismatch warning").toBeDefined();
    expect(String(w!.detail)).toMatch(/32-bit float/);     // names what actually arrived
    expect(String(w!.expected)).toMatch(/3 bytes\/frame/);
    // The watchdog fires at 3 s with zero samples appended; the guard is the
    // reason there are none and must be the only one given.
    expect(find(h.fd3, "warning", "mic-no-frames"), "a second, wrong reason followed the guard").toBeUndefined();
    expect(h.fd3.filter((l) => l.code === "mic-format-mismatch")).toHaveLength(1);
    // The take is not ended by its mic.
    expect(h.fd3.find((l) => l.ev === "stopped" && l.seq === undefined), "the take ended on the mic fault").toBeUndefined();

    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(anchors.mic?.present ?? false, "a track with nothing appended must not claim to be present").toBe(false);
  }, 90_000);

  test("CONTROL: a real take raises no warning and decodes to the span it recorded", async () => {
    const { h, dir } = await recordWithMic({}, 6_000);

    expect(find(h.fd3, "warning", "mic-format-mismatch"), JSON.stringify(find(h.fd3, "warning", "mic-format-mismatch")))
      .toBeUndefined();
    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(anchors.mic?.present).toBe(true);
    const span = (anchors.mic.lastFramePtsNs - anchors.mic.firstFramePtsNs) / 1e9;
    expect(existsSync(join(dir, "mic.m4a"))).toBe(true);
    const decoded = decodedSeconds(join(dir, "mic.m4a"));
    // The span stops at the LAST buffer's start, so the file is one buffer
    // (and an AAC priming frame) longer. The bad takes were 1.33x.
    expect(decoded / span, `decoded ${decoded}s vs recorded span ${span}s`).toBeGreaterThan(0.97);
    expect(decoded / span, `decoded ${decoded}s vs recorded span ${span}s`).toBeLessThan(1.05);
  }, 90_000);
});
