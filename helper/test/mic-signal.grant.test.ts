/**
 * STC-528 — the mic's live level and its silent spans, on the real binary.
 *
 * `STC_CAPTURE_FAULT=mic-silent` zeroes the MEASURED level (MicCapture.swift's
 * `noteSignal`) and leaves the audio written to mic.m4a alone, so the reaction is
 * watched end to end without muting a real mic: `level` readings on the LOSSY channel
 * (stdout, never fd3), `silent: true` once 10 s have passed, the take still recording,
 * and anchors.json at v13 with one span from where the silence began. The take is
 * unaffected: mic.m4a is there and decodes to the span it recorded.
 *
 * The CONTROL is the same take without the fault: readings flow, at least one carries
 * a real (non-zero) peak, which is the difference the fault made. It does NOT assert
 * "no span": a quiet room on a quiet mic may really be under -60 dBFS, and whether it
 * is, is the tuning question in `docs/STC-528-RUNBOOK.md`, not a test.
 *
 * Grant test (`npm run test:capture`, from a terminal holding Screen Recording,
 * Input Monitoring and Microphone): the bare binary inherits the launching terminal's
 * TCC identity (PHASE-0 §6).
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
const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);

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
  const dir = mkdtempSync(join(tmpdir(), "stc-micsig-"));
  const h = spawnHelper(env);
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir, seq: 1, micDeviceUid: uid });
  const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (started.ev !== "started") throw explainFailedStart(started as StartOutcome, "STC-528's mic signal test");
  const opened = await waitFor(
    () => find(h.fd3, "mic-started") ?? h.fd3.find((l) => l.ev === "warning" && /^mic-/.test(String(l.code))),
    15_000, "mic-started (or a warning saying why it did not open)");
  if (opened.ev !== "mic-started") {
    throw new Error(`SKIP-GRANT: the mic never opened (${JSON.stringify(opened)}) — most likely no `
      + "Microphone grant for this terminal.");
  }
  await sleep(ms);
  h.send({ cmd: "stop", seq: 2 });
  await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stop reply");
  const levels = h.out.filter((l) => l.ev === "level");
  const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
  return { h, dir, levels, anchors };
}

function decodedSeconds(path: string): number {
  const m = execFileSync("afinfo", [path], { encoding: "utf8" }).match(/estimated duration: ([\d.]+)/);
  if (!m) throw new Error(`afinfo gave no duration for ${path}`);
  return Number(m[1]);
}

describe("the mic's live level and silent spans (STC-528)", () => {
  test("a silent mic: the marker after 10 s, one span from the start, the take unaffected", async () => {
    const { h, dir, levels, anchors } = await recordWithMic({ STC_CAPTURE_FAULT: "mic-silent" }, 13_000);

    expect(levels.length, "no level readings on stdout").toBeGreaterThan(50);
    expect(h.fd3.some((l) => l.ev === "level"), "a level reading went out on the RELIABLE channel").toBe(false);
    expect(levels.every((l) => l.peak === 0), "the fault zeroes every reading").toBe(true);
    const firstSilent = levels.findIndex((l) => l.silent === true);
    expect(firstSilent, "never said silent").toBeGreaterThan(0);
    expect(levels.slice(0, firstSilent).length, "said silent before 10 s of readings").toBeGreaterThan(120);
    // Warn only: nothing on the reliable channel about it, and the take ran to the user's stop.
    expect(h.fd3.filter((l) => l.ev === "warning" && /mic|silen|signal/.test(String(l.code))).map((l) => l.code)).toEqual([]);
    expect(h.fd3.find((l) => l.ev === "stopped" && l.seq === undefined), "the take ended on its own").toBeUndefined();

    expect(anchors.version).toBe(13);
    expect(anchors.mic.present).toBe(true);
    const spans = anchors.mic.silentSpans as { startNs: number; endNs: number }[];
    expect(spans, JSON.stringify(anchors.mic)).toHaveLength(1);
    // The silence began with the first buffer, so the span starts there and runs to the end.
    expect(Math.abs(spans[0]!.startNs - anchors.mic.firstFramePtsNs)).toBeLessThan(50_000_000);
    expect(spans[0]!.endNs).toBeGreaterThanOrEqual(anchors.mic.lastFramePtsNs);
    expect(spans[0]!.endNs - spans[0]!.startNs).toBeGreaterThanOrEqual(10_000_000_000);

    // The audio itself is untouched: the fault is in the meter, not the take.
    expect(existsSync(join(dir, "mic.m4a"))).toBe(true);
    const span = (anchors.mic.lastFramePtsNs - anchors.mic.firstFramePtsNs) / 1e9;
    const decoded = decodedSeconds(join(dir, "mic.m4a"));
    expect(decoded / span, `decoded ${decoded}s vs recorded span ${span}s`).toBeGreaterThan(0.97);
    expect(decoded / span, `decoded ${decoded}s vs recorded span ${span}s`).toBeLessThan(1.05);
  }, 120_000);

  test("CONTROL: the same take with no fault carries real readings", async () => {
    const { h, levels, anchors } = await recordWithMic({}, 4_000);
    expect(levels.length).toBeGreaterThan(20);
    expect(h.fd3.some((l) => l.ev === "level")).toBe(false);
    expect(levels.some((l) => typeof l.peak === "number" && l.peak > 0),
      "every reading was zero with no fault — a real mic always has a noise floor").toBe(true);
    // 4 s cannot reach 10 s, whatever the room.
    expect(levels.some((l) => l.silent === true)).toBe(false);
    expect(anchors.mic.silentSpans).toBeUndefined();
    // v4 for the mic, v9 on a P3 display (STC-510): whatever the other blocks earned, never 13.
    expect(anchors.version).toBeLessThan(13);
  }, 90_000);
});
