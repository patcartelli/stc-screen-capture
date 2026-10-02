import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * STC-488: `copy-file` puts a real file reference on the SYSTEM pasteboard,
 * and `pasteboard-files` reads the same path back.
 *
 * In the grant suite though it needs no TCC grant, for the reason
 * `still-clipboard.grant.test.ts` gives: NSPasteboard.general needs a real
 * logged-in session, which a CI runner can't be relied on to provide. What
 * Slack or Mail then accept is docs/STC-488-RUNBOOK.md.
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
  // Reliable replies come on fd3, exactly as in still-clipboard.grant.test.ts.
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const fd3: Line[] = [];
  collect(proc.stdio[3] as Readable, fd3);
  proc.stdout!.resume();
  proc.stderr!.resume();
  let seq = 800;
  return {
    request: async (c: object, ms = 20_000): Promise<Line> => {
      const s = ++seq;
      proc.stdin!.write(JSON.stringify({ ...c, seq: s }) + "\n");
      return waitFor(() => fd3.find((l) => l.seq === s), ms, `seq ${s} (${JSON.stringify(c)})`);
    },
  };
}

describe("copy-file on the real pasteboard (STC-488)", () => {
  test("the file goes on, and reads back as the same path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stc-copy-"));
    const file = join(dir, "take.mp4");
    writeFileSync(file, Buffer.from([0]));
    const h = spawnHelper();
    const copied = await h.request({ cmd: "copy-file", path: file });
    expect(copied.ev, JSON.stringify(copied)).toBe("copied-file");
    const back = await h.request({ cmd: "pasteboard-files" });
    expect(back.ev, JSON.stringify(back)).toBe("pasteboard-files");
    // realpath: tmpdir() may be a symlink (/var -> /private/var) that AppKit resolves.
    expect(back.paths.map((p: string) => p.replace(/^\/private/, ""))).toEqual([file.replace(/^\/private/, "")]);
  }, 60_000);

  test("a missing file is refused as copy-refused", async () => {
    const h = spawnHelper();
    const r = await h.request({ cmd: "copy-file", path: "/nonexistent/take.mp4" });
    expect(r.ev).toBe("error");
    expect(r.code).toBe("copy-refused");
  }, 60_000);
});
