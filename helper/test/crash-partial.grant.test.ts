/**
 * STC-530 — a take the helper dies in keeps its description.
 *
 * The helper keeps `anchors.partial.json` current while recording (the stop-time
 * document minus `stop`). SIGKILL it mid-take and that partial plus the fragmented
 * display.mp4 (STC-394) must be enough for `recoverTake` to make a loadable take.
 * `STC_CAPTURE_FAULT=anchors-write-failed` covers the other door: a CLEAN stop that
 * could not write anchors.json must keep the partial. The control is a clean stop with
 * no fault, which leaves anchors.json and no partial.
 *
 * Needs a Screen Recording grant: `npm run test:capture`, from a terminal that holds it.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";
import { recoverTake } from "../../app/src/recover-take.js";

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
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  return {
    proc, out, fd3, exited,
    send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n"),
  };
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
const session = () => mkdtempSync(join(tmpdir(), "stc-crash-partial-"));

/** Spawn, start a whole-display take into a fresh dir, and return once it is recording. */
async function startTake(env: Record<string, string>) {
  const dir = session();
  const h = spawnHelper(env);
  await waitFor(() => h.fd3.find((l) => l.ev === "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir, seq: 1 });
  const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (started.ev !== "started") throw explainFailedStart(started as StartOutcome, "STC-530's crash partial");
  return { dir, h };
}

describe("a take the helper dies in keeps its description (STC-530)", () => {
  test("SIGKILL mid-take leaves anchors.partial.json that recovers to a loadable take", async () => {
    const { dir, h } = await startTake({});
    await sleep(3_000);
    // The helper's own clock at the last heartbeat before the kill.
    const lastStats = [...h.out].reverse().find((l) => l.ev === "stats" && l.state === "recording");
    expect(lastStats, "no recording heartbeat").toBeDefined();
    const killedAtNs = Number(lastStats!.elapsedMs) * 1e6;
    h.proc.kill("SIGKILL");
    await h.exited;

    const partialPath = join(dir, "anchors.partial.json");
    expect(existsSync(partialPath)).toBe(true);
    expect(existsSync(join(dir, "anchors.json"))).toBe(false);
    const r = await recoverTake(dir, "recorder-quit");
    expect(r, JSON.stringify(r)).toEqual({ ok: true });
    const a = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(a.version).toBe(11);
    expect(a.stop.reason).toBe("recorder-quit");
    // The fragmented interval is ~1-2 s: the recovered end is within 2.5 s of the kill.
    expect(killedAtNs - a.stop.t).toBeLessThan(2_500_000_000);
    expect(existsSync(partialPath)).toBe(false);
  }, 60_000);

  test("anchors-write-failed: a clean stop with no anchors.json keeps the partial", async () => {
    const { dir, h } = await startTake({ STC_CAPTURE_FAULT: "anchors-write-failed" });
    await sleep(2_000);
    h.send({ cmd: "stop", seq: 2 });
    await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stopped");
    expect(existsSync(join(dir, "anchors.json"))).toBe(false);
    expect(existsSync(join(dir, "events.json"))).toBe(true);
    expect(existsSync(join(dir, "anchors.partial.json"))).toBe(true);
  }, 60_000);

  test("CONTROL: a clean stop leaves anchors.json and no partial", async () => {
    const { dir, h } = await startTake({});
    await sleep(2_000);
    h.send({ cmd: "stop", seq: 2 });
    await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stopped");
    expect(existsSync(join(dir, "anchors.json"))).toBe(true);
    expect(existsSync(join(dir, "anchors.partial.json"))).toBe(false);
  }, 60_000);
});
