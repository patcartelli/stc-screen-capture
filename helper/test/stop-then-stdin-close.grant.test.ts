/**
 * STC-376 — closing stdin right behind a `stop` must not lose the take.
 *
 * `App.stop()` sets `state = .stopping` SYNCHRONOUSLY, before its async
 * teardown (`session.stop` -> `writeSidecars`/`finishWriting`) has run.
 * `App.shutdown`'s guard only recognised `.recording`/`.starting`, so a
 * `stdin-closed` shutdown landing in that window took the immediate
 * bye-and-exit path and killed the process before the sidecars or
 * `display.mp4`'s `moov` atom were ever written — reproduced live during
 * STC-370's hardware verification: a `display.mp4` existed on disk with no
 * `moov` atom (QuickTime refused to open it) and no sidecars at all. It is
 * the exact `echo stop` immediately followed by closing the pipe idiom
 * `docs/STC-370-RUNBOOK.md`'s own commands used before this fix, and which
 * every command there now adds `; sleep 1` after `stop` to route around.
 *
 * The fix (`main.swift`'s `stopWaiters`) lets a shutdown that arrives while a
 * stop is already in flight JOIN that stop's own completion instead of
 * either bailing immediately or starting a second, doomed one. This test
 * drives exactly the race the runbook's workaround exists for: send `stop`,
 * then close stdin with no wait in between, and confirm the take survives.
 *
 * Reaching `.recording` for real needs a live SCStream, which needs a Screen
 * Recording grant, so this is a grant test: `npm run test:capture`, from a
 * terminal that holds the grant (PHASE-0 §6: a bare CLI binary inherits the
 * launching terminal's TCC identity).
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

function spawnHelper() {
  const proc = spawn(BIN, { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  proc.stderr!.resume();
  collect(proc.stdio[3] as Readable, fd3);
  return {
    proc, out, fd3,
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
const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);
const session = () => mkdtempSync(join(tmpdir(), "stc-stop-close-"));

/** An mp4 that was finalised carries a `moov` box; one whose writer never finished does not. */
function hasMoov(path: string): boolean {
  const b = readFileSync(path);
  return b.includes(Buffer.from("moov", "ascii"));
}

const skipGrant = (started: StartOutcome) =>
  explainFailedStart(started, "STC-376's stop/stdin-close race");

describe("stdin closing immediately after `stop` (STC-376)", () => {
  test("the take is finalised — sidecars, a moov atom, `stopped` before `bye`", async () => {
    const dir = session();
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
    h.send({ cmd: "start", dir, seq: 1 });
    const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
    if (started.ev !== "started") throw skipGrant(started);

    await sleep(500); // a moment of real capture, not an instant stop-after-start race

    const exited = new Promise<number | null>((resolve) => h.proc.on("exit", (code) => resolve(code)));
    // The exact idiom the runbook's `; sleep 1` works around: `stop`
    // immediately followed by closing the pipe, no wait for a reply.
    h.send({ cmd: "stop", seq: 2 });
    h.proc.stdin!.end();

    // CaptureSession.stopTimeoutSeconds (20s) + main.swift's
    // shutdownBackstopMarginSeconds (5s) is the worst case before the
    // process answers on its own; generous on top of that so a slow CI disk
    // finishing finishWriting() is not mistaken for the regression.
    await Promise.race([
      exited,
      sleep(40_000).then(() => { throw new Error("helper did not exit within 40s of stdin closing"); }),
    ]);

    // The regression this guards: a `bye` (or no reply at all) arriving with
    // no `stopped` first meant the process exited before its own triggered
    // stop had answered — the take lost mid-teardown.
    const stopped = h.fd3.find((l) => l.seq === 2);
    expect(stopped, "no `stopped` reply to the stop request — the take was lost").toBeDefined();
    expect(stopped!.ev).toBe("stopped");
    const bye = find(h.fd3, "bye");
    expect(bye, "no `bye` — the process never answered its own shutdown").toBeDefined();
    expect(h.fd3.indexOf(stopped!)).toBeLessThan(h.fd3.indexOf(bye!));

    expect(existsSync(join(dir, "anchors.json")), "anchors.json missing — the take was lost").toBe(true);
    expect(existsSync(join(dir, "events.json")), "events.json missing — the take was lost").toBe(true);
    expect(existsSync(join(dir, "display.mp4")), "display.mp4 missing — the take was lost").toBe(true);
    expect(statSync(join(dir, "display.mp4")).size).toBeGreaterThan(0);
    expect(hasMoov(join(dir, "display.mp4")), "display.mp4 has no moov — the writer never finished").toBe(true);

    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    // The stop was an explicit client request ("user", `stop`'s own default),
    // not the shutdown that merely let the already in-flight teardown finish
    // — that is the whole point of joining rather than starting a second stop.
    expect(anchors.stop?.reason).toBe("user");
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(JSON.parse(readFileSync(join(root, "schema/anchors-2.schema.json"), "utf8")));
    expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);
  }, 60_000);
});
