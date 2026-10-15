/**
 * STC-238's driver: one way to run a take into a fault, and ONE acceptance check
 * applied to whatever the fault left behind.
 *
 * The acceptance is the ticket's, made checkable:
 *
 *   1. "the session directory is in a valid, parseable state" — `anchors.json`
 *      exists (after `recoverTake`, for a helper that died) and `loadSession`,
 *      the editor's own loader, accepts the directory.
 *   2. "the exported portion before the fault is watchable" — the take goes
 *      through the REAL export (scripts/export-one.mjs: Chrome, WebCodecs decode,
 *      the composite, an encode), and the encoded file holds every frame the
 *      export says it made, reaching to within `EXPORT_SLACK_FRAMES` of where the
 *      take says it stopped. A take that loads but does not decode fails here.
 *   3. "no silent data loss: each fault is logged with a reason and timestamp" —
 *      per case, in the test file: a stop's `stop.reason` + `stop.t`, or for a
 *      fault the take survives, a reliable-channel warning carrying its time.
 *
 * Each existing `*.grant.test.ts` for a fault keeps its own, narrower
 * assertions; this file does not replace them. What it adds is that every fault
 * is held to the SAME bar, so a new one cannot quietly be held to a lower one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import * as MP4BoxNS from "mp4box";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";
import { fileSource } from "../../app/src/recover-take.js";
import { loadSession, type LoadedSession } from "../../transform/src/session.js";

const MP4Box: any = (MP4BoxNS as any).default ?? MP4BoxNS;

export const root = join(__dirname, "..", "..");
export const BIN = join(root, "helper", "build", "stc-helper");

export interface Line { ev: string; seq?: number; [k: string]: unknown }

const live: ChildProcess[] = [];
/** For an `afterEach`: no helper outlives its test. */
export function killAll(): void { for (const p of live.splice(0)) p.kill("SIGKILL"); }

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

export interface Helper {
  proc: ChildProcess;
  out: Line[];
  fd3: Line[];
  exited: Promise<{ code: number | null; signal: string | null }>;
  send(c: object): void;
}

export function spawnHelper(env: Record<string, string>): Helper {
  const proc = spawn(BIN, ["--stats-interval-ms", "200"], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  proc.stderr!.resume();
  collect(proc.stdio[3] as Readable, fd3);
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (r) => proc.once("exit", (code, signal) => r({ code, signal })));
  return { proc, out, fd3, exited, send: (c) => proc.stdin!.write(JSON.stringify(c) + "\n") };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}

export const sessionDir = () => mkdtempSync(join(tmpdir(), "stc-soak-"));

/** Spawn with `env`, start a whole-display take into a fresh dir, return once it is recording. */
export async function startTake(env: Record<string, string>, params: Record<string, unknown> = {}, what = "the soak") {
  const dir = sessionDir();
  const h = spawnHelper(env);
  await waitFor(() => h.fd3.find((l) => l.ev === "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir, seq: 1, ...params });
  const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (started.ev !== "started") throw explainFailedStart(started as StartOutcome, what);
  return { dir, h };
}

/** A stop the helper decided on: `stopped` with no `seq`. */
export const unsolicitedStop = (h: Helper, ms = 15_000) =>
  waitFor(() => h.fd3.find((l) => l.ev === "stopped" && typeof l.seq !== "number"), ms, "an unsolicited `stopped`");

export const warning = (h: Helper, code: string) =>
  h.fd3.find((l) => l.ev === "warning" && l.code === code);

export function readAnchors(dir: string): any {
  const p = join(dir, "anchors.json");
  if (!existsSync(p)) throw new Error(`${dir}: no anchors.json — the fault left no take description`);
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Acceptance 1: the editor's own loader accepts the directory as it stands. */
export async function loadTakeDir(dir: string): Promise<LoadedSession> {
  const anchors = readAnchors(dir);
  let events: any = { version: 1, events: [] };
  const eventsPath = join(dir, "events.json");
  if (existsSync(eventsPath)) events = JSON.parse(readFileSync(eventsPath, "utf8"));
  const displayMp4 = await fileSource(join(dir, anchors.files.display));
  const cameraMp4 = anchors.files.camera ? await fileSource(join(dir, anchors.files.camera)) : undefined;
  const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const micM4a = anchors.files.mic ? ab(await readFile(join(dir, anchors.files.mic))) : undefined;
  const systemM4a = anchors.files.system ? ab(await readFile(join(dir, anchors.files.system))) : undefined;
  // Closed once loaded: what the soak reads back is the frame grid, already in
  // memory, and the export reads the files itself. Left open, a handle closed by
  // the garbage collector surfaces as an unhandled error in a LATER test.
  try {
    return await loadSession({ anchors, events, displayMp4, cameraMp4, micM4a, systemM4a });
  } finally {
    await displayMp4.close();
    await cameraMp4?.close();
  }
}

/**
 * How far short of the take's stop an export may end and still count as
 * "reaching" it: one second at the 60 fps export grid. A stop's `t` is when the
 * helper DECIDED, and the last frame written can precede it by however long the
 * screen sat still (VFR emits nothing for an idle display) plus the recovery
 * interval for a take the helper died in (STC-530: fragments every ~1-2 s, so a
 * recovered `stop.t` is already the media's own end, not the kill time).
 */
export const EXPORT_SLACK_FRAMES = 60;

export interface ExportResult { frames: number; encodedSamples: number; expectedFrames: number; path: string; log: string }

/** Acceptance 2: the real export, through Chrome, of the whole take. */
export async function exportTake(dir: string): Promise<ExportResult> {
  const anchors = readAnchors(dir);
  // Longer than any soak take: export.ts clamps to what the take holds.
  const SECONDS = 3600;
  const log = await new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, [join(root, "scripts", "export-one.mjs"), dir, String(SECONDS)],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    live.push(p);
    let text = "";
    p.stdout!.on("data", (c: Buffer) => { text += c.toString(); });
    p.stderr!.on("data", (c: Buffer) => { text += c.toString(); });
    p.once("exit", (code) => code === 0 ? resolve(text) : reject(new Error(`export-one exited ${code}:\n${text}`)));
  });
  const m = /\n(\d+) frames in /.exec(log);
  if (!m) throw new Error(`export-one did not report a frame count:\n${log}`);
  const frames = Number(m[1]);
  const path = join(dir, `export-${SECONDS}s-from0s.mp4`);
  const encodedSamples = await videoSampleCount(path);
  const spanNs = Number(anchors.stop.t) - Number(anchors.capture.firstFrameNs);
  const expectedFrames = Math.floor((spanNs * 60) / 1e9);
  return { frames, encodedSamples, expectedFrames, path, log };
}

async function videoSampleCount(path: string): Promise<number> {
  const buf = readFileSync(path);
  const ab: any = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  ab.fileStart = 0;
  const file = MP4Box.createFile();
  let info: any, err: unknown;
  file.onReady = (i: any) => { info = i; };
  file.onError = (e: unknown) => { err = e; };
  file.appendBuffer(ab);
  file.flush();
  if (err || !info) throw new Error(`${path}: not a readable mp4 (${String(err ?? "no moov")})`);
  const v = info.videoTracks?.[0];
  if (!v) throw new Error(`${path}: no video track`);
  return v.nb_samples as number;
}
