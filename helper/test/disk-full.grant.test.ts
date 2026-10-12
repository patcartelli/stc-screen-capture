/**
 * STC-527 — a full disk mid-take ends the take cleanly, with `disk-full`.
 *
 * Two ways in, one fault each, because the take can learn the disk is full
 * two ways (DiskDecisions.swift):
 *   - `STC_CAPTURE_FAULT=disk-full`: the free-space WATCH reads 0 bytes. The
 *     real timer, the real decision and the real stop run; only the number is
 *     made up. This is the path a real take almost always takes.
 *   - `STC_CAPTURE_FAULT=disk-write-failed`: the frame path's reaction to a
 *     FAILED WRITER runs with the error a real full disk produced (measured,
 *     `helper/test/disk-full.test.ts` holds it on every push).
 * Filling an actual disk under a live take is the runbook's job
 * (`docs/STC-527-RUNBOOK.md`), because the take temp root is the app's choice,
 * not the helper's.
 *
 * Needs a live SCStream, so a grant: `npm run test:capture`.
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
const session = () => mkdtempSync(join(tmpdir(), "stc-disk-full-"));
const skipGrant = (started: StartOutcome) => explainFailedStart(started, "STC-527's disk-full stop");
const validate10 = new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/anchors-10.schema.json"), "utf8")));

describe("a take whose disk fills (STC-527)", () => {
  test.each(["disk-full", "disk-write-failed"])(
    "STC_CAPTURE_FAULT=%s: warns, stops itself with disk-full, writes a v10 take, leaves no reserve",
    async (fault) => {
      const dir = session();
      const h = spawnHelper({ STC_CAPTURE_FAULT: fault });
      await waitFor(() => h.fd3.find((l) => l.ev === "ready"), 10_000, "ready");
      h.send({ cmd: "start", dir, seq: 1 });
      const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
      if (started.ev !== "started") throw skipGrant(started);

      // Nobody sends `stop`. The watch polls at 1 s and the writer fault fires
      // at 0.5 s; the stop is bounded by stopTimeoutSeconds (20 s).
      const stopped = await waitFor(
        () => h.fd3.find((l) => l.ev === "stopped" && typeof l.seq !== "number"),
        30_000, "an unsolicited `stopped`");
      expect(stopped.reason).toBe("disk-full");
      expect(stopped.stopWarning, "the writer did not finalise in time").toBeUndefined();

      // Exactly one warning, before the stop: the watch and the frame path can
      // both see a full disk, and the take ends once.
      const warnings = h.fd3.filter((l) => l.ev === "warning" && l.code === "disk-full");
      expect(warnings.length).toBe(1);
      expect(h.fd3.indexOf(warnings[0]!)).toBeLessThan(h.fd3.indexOf(stopped));

      for (const f of ["display.mp4", "events.json", "anchors.json"]) {
        expect(existsSync(join(dir, f)), `${f} missing`).toBe(true);
      }
      expect(statSync(join(dir, "display.mp4")).size).toBeGreaterThan(0);
      expect(existsSync(join(dir, ".sidecar-reserve")), "the sidecar reserve was left in the take").toBe(false);

      const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
      expect(anchors.stop?.reason).toBe("disk-full");
      expect(anchors.version).toBe(10);
      expect(validate10(anchors), JSON.stringify(validate10.errors, null, 2)).toBe(true);

      // Idle and usable afterwards.
      await waitFor(() => h.out.some((l) => l.ev === "stats" && l.state === "idle"), 5_000, "an idle heartbeat");
    }, 90_000);

  test("without a fault, a take runs past both faults' delays, holds a reserve, and releases it on stop", async () => {
    const dir = session();
    const h = spawnHelper({});
    await waitFor(() => h.fd3.find((l) => l.ev === "ready"), 10_000, "ready");
    h.send({ cmd: "start", dir, seq: 1 });
    const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
    if (started.ev !== "started") throw skipGrant(started);

    // Two watch polls on a real disk: a watch that fired on an ordinary Mac
    // would end every take after a second.
    await sleep(2_500);
    expect(h.fd3.find((l) => l.ev === "stopped")).toBeUndefined();
    expect(h.fd3.find((l) => l.ev === "warning" && l.code === "disk-full")).toBeUndefined();
    expect(statSync(join(dir, ".sidecar-reserve")).size, "the reserve is real bytes").toBe(8 << 20);

    h.send({ cmd: "stop", seq: 2 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stopped");
    expect(stopped.reason).toBe("user");
    expect(existsSync(join(dir, ".sidecar-reserve"))).toBe(false);
    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(anchors.version, "a user stop must not earn v10").not.toBe(10);
  }, 60_000);
});
