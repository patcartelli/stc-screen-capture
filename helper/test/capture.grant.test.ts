/**
 * Requires a Screen Recording grant for the process running the tests, so it
 * is NOT part of `npm test` — see vitest.grant.config.ts and `npm run
 * test:capture`.
 *
 * It is a separate FILE rather than a skip on purpose. A skipped test reads
 * as covered and quietly rots; a named script that someone has to run is at
 * least honest about being a manual step. The routine way to exercise this
 * path is tools/test-host, which holds the grant.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

// helper binary is built once by vitest.global-setup.ts

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

function spawnHelper() {
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  collect(proc.stdio[3] as Readable, fd3);
  proc.stderr!.resume();
  return {
    out, fd3,
    send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n"),
    kill: () => proc.kill("SIGKILL"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 15_000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}
const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);
const session = () => mkdtempSync(join(tmpdir(), "stc-cap-"));

/** Did this environment's TCC identity get a Screen Recording grant? */
/**
 * Try one recording and report what the helper said about it.
 *
 * It was called `probeGranted` and returned a boolean, which is what made the
 * old message wrong: it never probed TCC, it only asked whether `start` came
 * back `started`, and every other refusal was then reported as a missing
 * grant. Returning the OUTCOME instead of a verdict is what lets the caller
 * name the real cause (`_start-outcome.ts`).
 */
async function tryOneRecording(): Promise<StartOutcome> {
  const h = spawnHelper();
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir: session(), seq: 1 });
  const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (r.ev === "started") h.send({ cmd: "stop", seq: 2 });
  await sleep(200);
  h.kill();
  return r as StartOutcome;
}

describe("capture — a real recording (requires Screen Recording)", () => {
  test("produces schema-valid display.mp4, events.json and anchors.json", async () => {
    const probe = await tryOneRecording();
    if (probe.ev !== "started") throw explainFailedStart(probe, "the real capture path");
    const dir = session();
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir, seq: 1 });
    const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "started");
    expect(started.ev).toBe("started");

    await sleep(3000);                       // record ~3 s
    h.send({ cmd: "stop", seq: 2 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stopped");
    expect(stopped.ev).toBe("stopped");
    expect(stopped.frames as number).toBeGreaterThan(0);

    for (const f of ["display.mp4", "events.json", "anchors.json"]) {
      expect(existsSync(join(dir, f)), `${f} missing`).toBe(true);
    }

    const ajv = new Ajv({ allErrors: true, strict: true });
    const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
    for (const [file, schema] of [
      // events-2 since STC-309: cursor-shape events beside the moves.
      ["events.json", "schema/events-2.schema.json"],
      // v2 since STC-232 increment 3: the helper always emits version 2 and
      // always writes a camera block, present:false when there is no camera.
      // This file is grant-gated, so `npm test` cannot catch it drifting —
      // which is exactly how the takes.ts version gate went stale (STC-262).
      ["anchors.json", "schema/anchors-2.schema.json"],
    ] as const) {
      const validate = ajv.compile(load(join(root, schema)));
      const ok = validate(load(join(dir, file)));
      expect(ok, `${file}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }

    // STC-309: the shape changes in the file are what the helper counted, and
    // each one is a CHANGE — two consecutive cursor events with the same shape
    // would mean the sampler is emitting per tick, not per change. Zero is a
    // legitimate count (nothing but the arrow was shown), so the assertion is
    // consistency, not presence: the terminal running this may well be showing
    // an I-beam, and a test that demanded zero would fail for being right.
    const events = load(join(dir, "events.json"));
    expect(events.version).toBe(2);
    const cursor = events.events.filter((e: any) => e.kind === "cursor");
    expect(stopped.cursorEvents, "stop reply carries cursorEvents").toBe(cursor.length);
    for (let i = 1; i < cursor.length; i++) {
      expect(cursor[i].shape, `cursor event ${i} repeats ${cursor[i - 1].shape}`).not.toBe(cursor[i - 1].shape);
    }
    // The sampler has its own thread precisely so it cannot starve the tap
    // (a sample measured 1-41 ms); if it did, the system would have disabled
    // the tap and the helper would have counted a re-enable.
    expect(stopped.tapReenables,
      `tap re-enabled while sampling the pointer: ${JSON.stringify(stopped.tapDisabled)}`).toBe(0);
    // Printed on SUCCESS, like the lossy test's numbers: the first hardware
    // run of the sampler reported tapReenables: 1, and it took a diagnosis
    // build to learn it was stop()'s own disable being reported back. The
    // `afterStop` count is that disable; `timeout` is the one that would
    // mean starvation.
    process.stderr.write(
      `[capture] ${stopped.frames} frames, ${stopped.events} events (${cursor.length} cursor), ` +
      `tap disables ${JSON.stringify(stopped.tapDisabled)}\n`);
    // Two clocks feed one file; the helper orders it on the way out.
    const ts = events.events.map((e: any) => e.t as number);
    expect(ts.every((t: number, i: number) => i === 0 || t >= ts[i - 1]!), "events.json is not time-ordered").toBe(true);

    // anchors must describe a capture that respects the hardware-encode cliff
    const anchors = load(join(dir, "anchors.json"));
    expect(anchors.capture.width).toBeLessThanOrEqual(3840);
    expect(anchors.capture.height).toBeLessThanOrEqual(2160);
    expect(typeof anchors.t0Ns).toBe("string");
  }, 120_000);
});

describe("capture — pause and resume on a live take (STC-240)", () => {
  test("the display gate fires, and nothing on disk sits inside a pause", async () => {
    const probe = await tryOneRecording();
    if (probe.ev !== "started") throw explainFailedStart(probe, "pause/resume");

    const dir = session();
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir, seq: 1 });
    expect((await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "started")).ev)
      .toBe("started");

    await sleep(1000);
    h.send({ cmd: "pause", seq: 2 });
    const paused = await waitFor(() => h.fd3.find((l) => l.seq === 2), 10_000, "paused");
    expect(paused.ev).toBe("paused");
    expect(paused.paused).toBe(true);
    expect(paused.changed).toBe(true);

    // 2 s, not 200 ms: a short pause is indistinguishable from a momentarily
    // idle screen, which VFR legitimately emits no frames for. At 60 fps this
    // span would carry ~120 frames if the gate did nothing.
    await sleep(2000);

    // Idempotence on the real helper, not only in the pure tests.
    h.send({ cmd: "pause", seq: 3 });
    const again = await waitFor(() => h.fd3.find((l) => l.seq === 3), 10_000, "pause again");
    expect(again.ev).toBe("paused");
    expect(again.changed).toBe(false);

    h.send({ cmd: "resume", seq: 4 });
    const resumed = await waitFor(() => h.fd3.find((l) => l.seq === 4), 10_000, "resumed");
    expect(resumed.ev).toBe("resumed");
    expect(resumed.paused).toBe(false);
    expect(resumed.changed).toBe(true);

    await sleep(1000);
    h.send({ cmd: "stop", seq: 5 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 5), 30_000, "stopped");
    expect(stopped.ev).toBe("stopped");

    // The display gate fired. Read from the stop reply's own stats rather than
    // polled mid-take: heartbeat stats land on the LOSSY stdout channel at a
    // 2 s default interval, so a test timing itself against them would be
    // racing a channel designed to drop messages.
    //
    // THIS IS THE LOAD-BEARING ASSERTION OF THIS TEST. Display frames flow
    // continuously and unconditionally at capture's own frame rate — nothing
    // needs to move for one to arrive — so `framesPaused` discriminates
    // whether the display gate exists REGARDLESS of what the machine running
    // this test is doing. It is what catches a broken/removed display gate;
    // the events-inside-the-pause assertion below cannot be trusted to (see
    // its own comment).
    expect(stopped.framesPaused as number,
      "frames arrived during the pause and were gated").toBeGreaterThan(0);
    expect(stopped.frames as number, "the take still recorded").toBeGreaterThan(0);

    const load = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
    const anchors = load("anchors.json");
    expect(anchors.version).toBe(5);
    expect(anchors.pauses).toHaveLength(1);
    const [span] = anchors.pauses;
    expect(span.endNs).toBeGreaterThan(span.startNs);

    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(JSON.parse(
      readFileSync(join(root, "schema/anchors-5.schema.json"), "utf8")));
    expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);

    // THE INVARIANT. The helper's drop rule and the transform's cut rule are
    // the same predicate over the same intervals, so a survivor means they
    // have drifted — and PR B would then cut a real sample out of the export,
    // which looks like correct video. Half-open, so the synthetic re-anchor AT
    // endNs is outside the span and needs no exception carved for it.
    //
    // THIS ONLY DISCRIMINATES WHEN REAL INPUT ACTUALLY LANDED DURING THE
    // PAUSE. Nothing moves the mouse on an automated, idle machine, so
    // "no events inside the span" is trivially true whether the tap gate
    // exists or not — the repo's own recorded trap: an empty events.json
    // does not mean the tap is broken, verifying input needs deliberate
    // input. Confirmed directly: with the tap-gate drop line removed from
    // `handleTapEvent` (Capture.swift), a run producing 0 real events left
    // this assertion PASSING — it is the `framesPaused` assertion above,
    // not this one, that catches a broken display gate. This assertion is
    // real and stays (a machine that DOES generate input during the pause
    // — a stray moved pointer, a scheduled job — is still held to it), but
    // its silence on an idle run is not evidence the tap gate works. See
    // the vacuity notice just below.
    const events = load("events.json");
    const inside = events.events.filter(
      (e: { t: number }) => e.t >= span.startNs && e.t < span.endNs);
    expect(inside, `events recorded inside the pause: ${JSON.stringify(inside)}`).toEqual([]);

    // And the one thing that must exist at the seam.
    const anchor = events.events.find(
      (e: { t: number; kind: string }) => e.kind === "move" && e.t === span.endNs);
    expect(anchor, "a resume must leave one synthetic move at its own instant").toBeTruthy();

    // Vacuity notice, not a failure. Two of the helper's own synthetics land
    // just outside the span by construction — `recordResumeAnchor`'s move at
    // exactly `span.endNs`, and `recordHeldButtonReleases`'s `up`(s) at
    // `span.startNs - 1` — so neither can ever land INSIDE it and neither
    // counts as "real input during the pause". If nothing else exists in
    // `events.json` at all, this run had nothing for the invariant assertion
    // above to discriminate on, and its PASS says nothing about the tap
    // gate. `process.stderr.write`, not `console.warn`: vitest discards
    // console output from tests, and a skip/vacuity notice that vanishes is
    // this repo's own recorded trap.
    const real = events.events.filter((e: { t: number; kind: string }) =>
      !(e.kind === "move" && e.t === span.endNs) &&
      !(e.kind === "up" && e.t === span.startNs - 1));
    if (real.length === 0) {
      process.stderr.write(
        "[pause-resume] VACUOUS: no real input events were recorded on this " +
        "take at all, so the events-inside-the-pause assertion had nothing " +
        "to discriminate on — the tap gate is UNPROVEN by this run. Only " +
        "framesPaused (above) is evidence the display gate works.\n");
    }
  }, 90_000);
});
