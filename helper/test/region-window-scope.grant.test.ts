/**
 * STC-370: `start` accepting a region or a window, not just a displayId.
 *
 * Needs a Screen Recording grant, same as capture.grant.test.ts — see that
 * file for why grant tests live apart from `npm test` rather than skipping.
 * Written on Linux; NOTHING here has run against real ScreenCaptureKit.
 * `docs/STC-370-RUNBOOK.md` is what a Mac still owes this ticket.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

interface Line { ev: string; seq?: number; [k: string]: any }
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

function spawnHelper(env: Record<string, string> = {}) {
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  collect(proc.stdio[3] as Readable, fd3);
  proc.stderr!.resume();
  let seq = 100;
  return {
    out, fd3,
    send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n"),
    request: async (c: object, ms = 15_000): Promise<Line> => {
      const s = ++seq;
      proc.stdin!.write(JSON.stringify({ ...c, seq: s }) + "\n");
      return waitFor(() => fd3.find((l) => l.seq === s), ms, `seq ${s} (${JSON.stringify(c)})`);
    },
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
const session = () => mkdtempSync(join(tmpdir(), "stc-scope-"));

/**
 * A titled, reasonably sized on-screen window — the same heuristic
 * still.grant.test.ts uses for a window shot. No window at all is a skip,
 * not a failure: the code under test never got a subject.
 */
async function findWindow(h: ReturnType<typeof spawnHelper>): Promise<{ id: number; width: number; height: number }> {
  const list = await h.request({ cmd: "windows" });
  expect(list.ev, JSON.stringify(list)).toBe("windows");
  const win = (list.windows as any[]).find((w) => w.title && w.width > 50 && w.height > 50);
  if (!win) throw new Error("SKIP-GRANT: no titled on-screen window to capture");
  return win;
}

const validate3 = new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/anchors-3.schema.json"), "utf8")));

function loadAnchors(dir: string): any {
  const raw = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
  expect(validate3(raw), JSON.stringify(validate3.errors, null, 2)).toBe(true);
  return raw;
}

/** Starts, throwing `explainFailedStart`'s classified error on any refusal. */
async function startOrExplain(h: ReturnType<typeof spawnHelper>, cmd: object, what: string): Promise<Line> {
  const started = await h.request({ cmd: "start", ...cmd }, 30_000);
  if (started.ev !== "started") throw explainFailedStart(started as StartOutcome, what);
  return started;
}

describe("recording scope — region and window (STC-370)", () => {
  test("a region take writes a v3 anchors document with scope.region, and a smaller capture", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const dir = session();
    const region = { x: 0, y: 0, width: 640, height: 480 };
    await startOrExplain(h, { dir, region }, "a region-scope take (STC-370)");
    await sleep(1000);
    await h.request({ cmd: "stop" }, 30_000);

    const anchors = loadAnchors(dir);
    expect(anchors.version).toBe(3);
    expect(anchors.scope?.kind).toBe("region");
    expect(anchors.scope?.region).toEqual(region);
    // Capture pixels should track the region, not the whole display: at 1x
    // backing scale that is exactly the region's own size (clamped even);
    // at 2x it is roughly double. Either way it must be far smaller than a
    // typical whole-display capture, which this loose bound catches without
    // hardcoding a backing scale this environment does not control.
    expect(anchors.capture.width).toBeLessThanOrEqual(region.width * 2 + 2);
    expect(anchors.capture.height).toBeLessThanOrEqual(region.height * 2 + 2);
  }, 60_000);

  test("a window take writes a v3 anchors document with scope.window", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const win = await findWindow(h);

    const dir = session();
    await startOrExplain(h, { dir, windowId: win.id }, "a window-scope take (STC-370)");
    await sleep(1000);
    await h.request({ cmd: "stop" }, 30_000);

    const anchors = loadAnchors(dir);
    expect(anchors.version).toBe(3);
    expect(anchors.scope?.kind).toBe("window");
    expect(anchors.scope?.window?.id).toBe(win.id);
    expect(anchors.scope?.window?.bounds.width).toBe(win.width);
    expect(anchors.scope?.window?.bounds.height).toBe(win.height);
  }, 60_000);

  test("a windowId that is not on screen is refused, the same as capture-still's", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const r = await h.request({ cmd: "start", dir: session(), windowId: 0x7fffffff }, 30_000);
    expect(r.ev).toBe("error");
    expect(r.code).toBe("window-not-found");
  }, 60_000);

  // STC-370's mid-take decision: a window-scope take whose window changes
  // size ends cleanly rather than delivering frames of the wrong size, or a
  // mix of sizes in one file. There is no API to resize another app's real
  // window on demand from a test, so this drives the WATCHER'S REACTION
  // directly via the same fault-injection idiom stream-died.grant.test.ts
  // already uses for a stream that dies mid-take — the reaction (stop,
  // finalised sidecars, the right reason) is what is under test, and it is
  // identical whether the trigger is a real resize or the fault.
  //
  // What this canNOT prove is stated in docs/STC-370-RUNBOOK.md §3a/§3b: that
  // a real resize/close is actually DETECTED by the 1 Hz poll in the first
  // place. Only a Mac, with a real window, answers that.
  test("a window resize (STC_CAPTURE_FAULT=window-resized) ends the take cleanly", async () => {
    const h = spawnHelper({ STC_CAPTURE_FAULT: "window-resized" });
    await waitFor(() => find(h.fd3, "ready"));
    const win = await findWindow(h);

    const dir = session();
    await startOrExplain(h, { dir, windowId: win.id }, "the window-resize fault (STC-370)");
    // The fault fires ~0.5 s in (Capture.swift's windowFaultDelaySeconds) as
    // an UNSOLICITED "stopped", not an answer to a request this test sent.
    const stopped = await waitFor(() => find(h.fd3, "stopped"), 15_000, "unsolicited stopped");
    expect(stopped.reason).toBe("window-resized");

    const anchors = loadAnchors(dir);
    expect(anchors.stop?.reason).toBe("window-resized");
  }, 60_000);

  test("a window close (STC_CAPTURE_FAULT=window-closed) ends the take cleanly", async () => {
    const h = spawnHelper({ STC_CAPTURE_FAULT: "window-closed" });
    await waitFor(() => find(h.fd3, "ready"));
    const win = await findWindow(h);

    const dir = session();
    await startOrExplain(h, { dir, windowId: win.id }, "the window-closed fault (STC-370)");
    const stopped = await waitFor(() => find(h.fd3, "stopped"), 15_000, "unsolicited stopped");
    expect(stopped.reason).toBe("window-closed");

    const anchors = loadAnchors(dir);
    expect(anchors.stop?.reason).toBe("window-closed");
  }, 60_000);
});
