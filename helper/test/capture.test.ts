import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";

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

// The helper answers a start within its own backstop (CaptureSession
// .startTimeoutSeconds, 15 s) — and since STC-258 that backstop covers the
// whole request, content enumeration included. These waits must sit clearly
// ABOVE it so a slow-but-correct start is observed rather than raced: at 20 s
// there were only 5 s left for process spawn and IPC, and under a parallel
// suite that was not enough (seen failing at 20970 ms).
const START_BOUND_MS = 30_000;

/** Did this environment's TCC identity get a Screen Recording grant? */
async function probeGranted(): Promise<boolean> {
  const h = spawnHelper();
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir: session(), seq: 1 });
  const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), START_BOUND_MS, "start outcome");
  if (r.ev === "started") h.send({ cmd: "stop", seq: 2 });
  await sleep(200);
  h.kill();
  return r.ev === "started";
}

describe("start bound vs the helper's own backstop", () => {
  // STC-258 was two correctly-bounded waits set too close together: the test
  // allowed 20 s and the helper answered at up to 15 s, leaving 5 s for spawn
  // and IPC. Nothing connected the two numbers, so they drifted into a flake
  // that only appeared under a loaded parallel suite. This asserts the coupling
  // so a change to either side fails loudly here instead of intermittently
  // somewhere else.
  test("the test's start bound stays clear of the helper's backstop", () => {
    const src = readFileSync(join(root, "helper/src/Capture.swift"), "utf8");
    const m = src.match(/startTimeoutSeconds:\s*Double\s*=\s*([\d.]+)/);
    expect(m, "startTimeoutSeconds not found in Capture.swift — did it get renamed?")
      .not.toBeNull();
    const backstopMs = Number(m![1]) * 1000;
    expect(backstopMs).toBeGreaterThan(0);
    // Enough headroom to absorb process spawn, IPC, and a contended machine.
    expect(START_BOUND_MS).toBeGreaterThanOrEqual(backstopMs + 10_000);
  });
});

describe("capture — behaviour without a Screen Recording grant", () => {
  test("start reports a specific, actionable error rather than hanging", async () => {
    if (await probeGranted()) return;      // covered by the granted suite instead
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir: session(), seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), START_BOUND_MS, "start outcome");
    expect(r.ev).toBe("error");
    // The environment decides WHICH failure: with no grant at all the display
    // list is empty; with a partial one the list arrives and the stream is then
    // interrupted (-3805). Both are fine. What must never happen is a request
    // that is simply never answered, which is what this originally caught.
    expect(["no-displays", "stream-failed", "writer-failed",
            "writer-rejected-input", "start-timeout", "display-not-found"]).toContain(r.code);
    expect(String(r.detail ?? "").length).toBeGreaterThan(0);
    if (r.code === "no-displays") expect(String(r.detail)).toMatch(/Screen Recording/i);
    // Budget: probeGranted (START_BOUND_MS) + this start (START_BOUND_MS),
    // plus spawn overhead. A per-test timeout equal to the sum of its own
    // waits cannot pass when those waits actually run.
  }, 90_000);

  // STC-247. Before this, a displayId SCK did not list fell back to whichever
  // display it listed first — a take of the wrong screen that said nothing.
  // Without a grant SCK lists nothing and the answer is no-displays; with one
  // it must be display-not-found, naming what WAS available. Either way the
  // one thing that must not happen is `started`.
  test("a displayId the helper cannot find is refused, never swapped for another display", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir: session(), displayId: 4_000_000_001, seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), START_BOUND_MS, "start outcome");
    expect(r.ev).toBe("error");
    expect(["no-displays", "display-not-found"]).toContain(r.code);
    if (r.code === "display-not-found") {
      expect(String(r.detail)).toContain("4000000001");
      expect(String(r.detail)).toMatch(/displays: \[/);
    }
    h.send({ cmd: "status", seq: 2 });
    const st = await waitFor(() => h.fd3.find((l) => l.seq === 2), 10_000, "status");
    expect(st.state, "a refused start must leave the helper idle").toBe("idle");
  }, 90_000);

  // STC-370: a malformed scope answers before ScreenCaptureKit is ever
  // touched (parseStartRequest runs first in App.start), so these run
  // regardless of whether this machine has a Screen Recording grant — the
  // same reason capture-still's own request-validation tests need no grant.
  test("region and windowId together is refused, never picking one silently", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({
      cmd: "start", dir: session(), seq: 1,
      windowId: 42, region: { x: 0, y: 0, width: 100, height: 100 },
    });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 10_000, "start outcome");
    expect(r.ev).toBe("error");
    expect(r.code).toBe("region-and-window");
    h.send({ cmd: "status", seq: 2 });
    const st = await waitFor(() => h.fd3.find((l) => l.seq === 2), 10_000, "status");
    expect(st.state, "a refused start must leave the helper idle").toBe("idle");
  }, 30_000);

  test("a region with non-positive size is refused, not silently clamped", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir: session(), seq: 1, region: { x: 0, y: 0, width: 0, height: 100 } });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 10_000, "start outcome");
    expect(r.ev).toBe("error");
    expect(r.code).toBe("bad-region");
  }, 30_000);

  test("a windowId that is not a valid CGWindowID is refused, not treated as absent", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir: session(), seq: 1, windowId: -1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 10_000, "start outcome");
    expect(r.ev).toBe("error");
    expect(r.code).toBe("bad-window-id");
  }, 30_000);

  test("a denied start leaves the helper idle and retryable, not wedged", async () => {
    if (await probeGranted()) return;
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir: session(), seq: 1 });
    await waitFor(() => h.fd3.find((l) => l.seq === 1), START_BOUND_MS, "first start");
    h.send({ cmd: "status", seq: 2 });
    const st = await waitFor(() => h.fd3.find((l) => l.seq === 2), 10_000, "status");
    expect(st.state).toBe("idle");
    // and it can be asked again — the failure is not terminal
    h.send({ cmd: "start", dir: session(), seq: 3 });
    const again = await waitFor(() => h.fd3.find((l) => l.seq === 3), START_BOUND_MS, "second start");
    expect(again.ev).toBe("error");
    // Budget: probeGranted + two starts (START_BOUND_MS each) + the status
    // wait, so ~100 s of waits in the worst case. Same rule as above.
  }, 150_000);
});

// STC-376. `state` becomes `.starting` (and `capture` is assigned)
// SYNCHRONOUSLY inside `App.start`, before ScreenCaptureKit is ever asked
// anything — so this race lives entirely in the gap before
// `SCShareableContent` resolves and needs no grant at all, granted or not.
describe("shutdown vs. an in-flight stop (STC-376)", () => {
  // `IO.readCommands` dispatches each parsed line onto the main queue with
  // its own `DispatchQueue.main.async`, in the order the lines were read —
  // so three commands sent with no waits between them run `handle(start)`,
  // `handle(stop)`, `handle(quit)` back to back on main, strictly in that
  // order. `handle(stop)` sets `state = .stopping` synchronously before its
  // own teardown (writing the sidecars, finishing display.mp4) goes async;
  // `handle(quit)` then calls `shutdown()` while that teardown is still in
  // flight. The old guard (`state == .recording || .starting`) treated
  // `.stopping` as neither case and exited immediately — `bye`, then
  // `exit()` — before the in-flight stop's own async completion had
  // written anything. Reproduced live on real hardware via the shell idiom
  // `docs/STC-370-RUNBOOK.md` uses (`stop` with the pipe closing right
  // behind it, STC-376's own discovery); this drives the identical
  // interleaving deterministically, through an explicit `quit` rather than
  // stdin closing, so it needs no sleep and no grant.
  test("stop immediately followed by quit does not exit before the stop's own teardown finishes", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const dir = session();
    h.send({ cmd: "start", dir, seq: 1 });
    h.send({ cmd: "stop", seq: 2 });
    h.send({ cmd: "quit", seq: 3 });
    const bye = await waitFor(() => find(h.fd3, "bye"), START_BOUND_MS, "bye");
    expect(bye.reason).toBe("quit");
    // The stop this raced against must still have answered — not been
    // silently abandoned by an early exit.
    const stopped = h.fd3.find((l) => l.seq === 2);
    expect(stopped?.ev, JSON.stringify(stopped)).toBe("stopped");
    // And its teardown must have actually RUN, not merely been about to:
    // `writeSidecars` completes before `stopped` is even sent (finishUp
    // calls it before invoking its own completion), so both files must
    // already be on disk by the time the process is allowed to exit.
    expect(existsSync(join(dir, "events.json"))).toBe(true);
    expect(existsSync(join(dir, "anchors.json"))).toBe(true);
  }, 60_000);
});

// STC-240 (task 5). No grant needed: both commands are refused before
// CaptureSession is ever touched when nothing is recording.
describe("pause and resume dispatch (STC-240)", () => {
  test("pause and resume are refused when nothing is recording", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));

    h.send({ cmd: "pause", seq: 1 });
    const p = await waitFor(() => h.fd3.find((l) => l.seq === 1), 15_000, "pause reply");
    expect(p.ev).toBe("error");
    expect(p.code).toBe("bad-state");

    h.send({ cmd: "resume", seq: 2 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 2), 15_000, "resume reply");
    expect(r.ev).toBe("error");
    expect(r.code).toBe("bad-state");
  }, 30_000);

  test("an unknown command is still unknown — the new cases did not widen the switch", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "paws", seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 15_000, "unknown reply");
    expect(r.ev).toBe("error");
    expect(r.code).toBe("unknown-command");
  }, 30_000);
});
