import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * STC-522: `prime-capture` runs a REAL ScreenCaptureKit stream and stops it.
 * Needs a Screen Recording grant (`npm run test:capture`); ungranted, the
 * same command answers `no-displays`, which `ipc.test.ts` covers on CI.
 *
 * What this cannot show is the point of the ticket: whether macOS's
 * picker-bypass consent comes up during the prime rather than during the
 * first take. A Mac that has answered it once never shows it again, so that
 * is a clean VM's question, `docs/STC-522-RUNBOOK.md` §2.
 */
const BIN = join(__dirname, "..", "build", "stc-helper");

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

async function waitFor<T>(f: () => T | undefined, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function spawnHelper() {
  // Reliable replies come on fd3, as in every grant test.
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const fd3: Line[] = [];
  collect(proc.stdio[3] as Readable, fd3);
  proc.stdout!.resume();
  proc.stderr!.resume();
  let seq = 900;
  return {
    request: async (c: object, ms = 20_000): Promise<Line> => {
      const s = ++seq;
      proc.stdin!.write(JSON.stringify({ ...c, seq: s }) + "\n");
      return waitFor(() => fd3.find((l) => l.seq === s), ms, `seq ${s} (${JSON.stringify(c)})`);
    },
  };
}

describe("prime-capture with a grant (STC-522)", () => {
  test("a real stream delivers frames, stops, and leaves the helper idle and primeable", async () => {
    const h = spawnHelper();
    const r = await h.request({ cmd: "prime-capture", holdMs: 500 });
    expect(r.ev, JSON.stringify(r)).toBe("primed");
    expect(r.heldMs).toBe(500);
    // 10 fps for 500 ms: a static screen may send idle samples only, but a
    // live stream sends something. Zero means it never really ran.
    expect(r.frames, JSON.stringify(r)).toBeGreaterThan(0);
    process.stderr.write(`[prime] ${r.frames} samples in ${r.heldMs} ms\n`);
    expect((await h.request({ cmd: "status" })).state).toBe("idle");
    // Released, not wedged: a second prime runs too.
    expect((await h.request({ cmd: "prime-capture", holdMs: 100 })).ev).toBe("primed");
  }, 60_000);
});
