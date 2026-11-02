import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * STC-628: the helper reads the desktop wallpaper, beside a window shot and
 * through the `wallpaper` verb. A GRANT test, run with `npm run test:capture`
 * on a Mac: the wallpaper window is captured through ScreenCaptureKit, which
 * CI cannot be granted.
 *
 * What it holds: a window shot asked for its wallpaper gets `wallpaper.png`
 * beside its frame (a PNG at most the display's pixel size), the reply says
 * which source it came from, and shot.json is untouched; the verb writes the
 * same file for a display named by id; and `STC_CAPTURE_FAULT=wallpaper-
 * unavailable` turns both into the sentence the app falls back to Clean on —
 * with the shot itself still taken. The CONTROL beside the fault is the
 * unfaulted run in the same file: without it, a fault that "works" could be a
 * read that never works at all.
 *
 * What it cannot hold: that the picture IS the wallpaper (and, for a dynamic
 * or aerial one, the frame showing). That is an eye's, and the runbook's.
 */

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
    fd3,
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
const shotDir = () => mkdtempSync(join(tmpdir(), "stc-wallpaper-"));

function pngSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** A window to shoot, and its display's pixel size, or a SKIP naming why not. */
async function target(h: ReturnType<typeof spawnHelper>) {
  const list = await h.request({ cmd: "windows" });
  if (list.ev !== "windows") {
    throw new Error(`SKIP-GRANT: windows answered ${list.code}: ${list.detail}. Without a Screen ` +
      "Recording grant for the process running the tests, the wallpaper read is unverified.");
  }
  const win = (list.windows as Array<{ id: number; fullyVisible: boolean; displayId?: number }>)
    .find((w) => w.fullyVisible && w.displayId !== undefined);
  if (!win) throw new Error("SKIP-WINDOW: no fully visible window to shoot; open one and run again.");
  return win as { id: number; displayId: number };
}

describe("the wallpaper (STC-628)", () => {
  test("a window shot that asks gets wallpaper.png beside its frame, and shot.json is untouched", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
    const win = await target(h);
    const dir = shotDir();
    const r = await h.request({ cmd: "capture-still", dir, kind: "window", windowId: win.id, wallpaper: true });
    expect(r.ev, JSON.stringify(r)).toBe("still");
    expect(r.wallpaperError, `the wallpaper was not read: ${r.wallpaperError}`).toBeUndefined();
    expect(r.wallpaper.file).toBe("wallpaper.png");
    expect(["cache", "wallpaper-window", "desktop-image-file"]).toContain(r.wallpaper.source);
    expect(typeof r.wallpaper.ms).toBe("number");
    process.stderr.write(`[wallpaper] shot: source ${r.wallpaper.source}, read in ${Number(r.wallpaper.ms).toFixed(1)} ms\n`);

    expect(readdirSync(dir).sort()).toEqual(["frame.png", "shot.json", "wallpaper.png"]);
    const shot = JSON.parse(readFileSync(join(dir, "shot.json"), "utf8"));
    expect(shot.version).toBe(1);
    expect(shot.decoration.mode).toBe("window-only");
    // Capped at the display's pixel size: never larger than covering it needs.
    const size = pngSize(join(dir, "wallpaper.png"));
    expect(size.width).toBeLessThanOrEqual(shot.display.pixelWidth);
    expect(size.height).toBeLessThanOrEqual(shot.display.pixelHeight);
    expect(size.width).toBeGreaterThan(0);
    h.kill();
  }, 60_000);

  test("a window shot that does not ask gets no wallpaper", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
    const win = await target(h);
    const dir = shotDir();
    const r = await h.request({ cmd: "capture-still", dir, kind: "window", windowId: win.id });
    expect(r.ev, JSON.stringify(r)).toBe("still");
    expect(r.wallpaper).toBeUndefined();
    expect(r.wallpaperError).toBeUndefined();
    expect(readdirSync(dir).sort()).toEqual(["frame.png", "shot.json"]);
    h.kill();
  }, 60_000);

  test("the wallpaper verb writes the named display's wallpaper into a folder", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
    const win = await target(h);
    const dir = shotDir();
    const r = await h.request({ cmd: "wallpaper", dir, displayId: win.displayId, file: "wallpaper.png" });
    expect(r.ev, JSON.stringify(r)).toBe("wallpaper");
    expect(r.file).toBe("wallpaper.png");
    process.stderr.write(`[wallpaper] verb: source ${r.source}, read in ${Number(r.ms).toFixed(1)} ms\n`);
    expect(readdirSync(dir)).toEqual(["wallpaper.png"]);
    pngSize(join(dir, "wallpaper.png"));
    // Again, into the same folder: replaced, never a second file or a partial.
    const again = await h.request({ cmd: "wallpaper", dir, displayId: win.displayId });
    expect(again.ev, JSON.stringify(again)).toBe("wallpaper");
    expect(readdirSync(dir)).toEqual(["wallpaper.png"]);
    h.kill();
  }, 60_000);

  test("STC_CAPTURE_FAULT=wallpaper-unavailable: the shot is still taken, and says why it has no wallpaper", async () => {
    const h = spawnHelper({ STC_CAPTURE_FAULT: "wallpaper-unavailable" });
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
    const win = await target(h);
    const dir = shotDir();
    const r = await h.request({ cmd: "capture-still", dir, kind: "window", windowId: win.id, wallpaper: true });
    expect(r.ev, JSON.stringify(r)).toBe("still");
    expect(r.wallpaper).toBeUndefined();
    expect(String(r.wallpaperError)).toContain("STC_CAPTURE_FAULT=wallpaper-unavailable");
    expect(readdirSync(dir).sort()).toEqual(["frame.png", "shot.json"]);

    const v = await h.request({ cmd: "wallpaper", dir: shotDir(), displayId: win.displayId });
    expect(v.ev).toBe("error");
    expect(v.code).toBe("wallpaper-unavailable");
    h.kill();
  }, 60_000);
});
