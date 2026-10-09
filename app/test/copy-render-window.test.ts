import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The hidden render window's job bookkeeping (STC-488, STC-395), with
 * Electron faked: the rules under test are this module's own wiring of a
 * window's lifetime, not anything a pure function holds. The fake models only
 * what `copy-render-window.ts` touches.
 *
 * - The watchdog is an INACTIVITY timeout (STC-395): a GIF of a long or 4K
 *   take legitimately runs past 120 s, so every `copy:progress` re-arms it.
 * - A live job answers a duplicate only when it is rendering the same FORMAT.
 * - The GIF settings reach the page in the query.
 */

let nextId = 1;
class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  destroyed = false;
  loaded: { file: string; opts?: { query?: Record<string, string> } } | undefined;
  webContents = Object.assign(new EventEmitter(), { id: nextId++ });
  constructor() { super(); FakeWindow.all.push(this); }
  isDestroyed() { return this.destroyed; }
  loadFile(file: string, opts?: { query?: Record<string, string> }) {
    this.loaded = { file, opts };
    return Promise.resolve();
  }
  destroy() { this.destroyed = true; this.emit("closed"); }
}

const ipc = new EventEmitter();

vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  ipcMain: {
    on: (ch: string, fn: (...a: unknown[]) => void) => ipc.on(ch, fn),
    handle: () => {},
  },
}));

async function freshModule() {
  vi.resetModules();
  FakeWindow.all = [];
  ipc.removeAllListeners();
  return import("../src/copy-render-window.js");
}

const out = join(tmpdir(), `stc-395-copy-render-window-${process.pid}.gif`);
const opts = (extra: Record<string, unknown> = {}) => ({
  takeDir: "/t/a", outPath: out, dist: "/d", rendererDir: "/r",
  grant() {}, revoke() {}, onProgress() {}, ...extra,
});
const progress = (w: FakeWindow) => ipc.emit("copy:progress", { sender: w.webContents }, 1, 10);

describe("the copy render's watchdog is an inactivity timeout (STC-395)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    process.env.STC_COPY_RENDER_TIMEOUT_MS = "1000";
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.STC_COPY_RENDER_TIMEOUT_MS;
  });

  test("control: a job that never reports settles as the timeout failure", async () => {
    const m = await freshModule();
    const p = m.startCopyRender(opts());
    vi.advanceTimersByTime(1001);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(!r.ok && !r.cancelled && r.detail).toMatch(/render timeout/);
  });

  test("a job that keeps reporting progress outlives the timeout", async () => {
    const m = await freshModule();
    const p = m.startCopyRender(opts());
    const w = FakeWindow.all[0]!;
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(900); progress(w); }
    expect(m.copyRenderInFlight("/t/a")).toBe(true);
    // ...and once it goes silent, the same bound applies again.
    vi.advanceTimersByTime(1001);
    const r = await p;
    expect(!r.ok && !r.cancelled && r.detail).toMatch(/render timeout/);
  });
});

describe("a live job and a second caller (STC-395)", () => {
  test("a GIF caller is never handed a live mp4 job's outcome, nor the reverse", async () => {
    const m = await freshModule();
    const mp4 = m.startCopyRender(opts());
    expect(m.copyRenderFormat("/t/a")).toBe("mp4");
    const r = await m.startCopyRender(opts({ format: "gif", gif: { fps: 15, maxWidth: 960 } }));
    expect(r).toEqual({ ok: false, detail: "another render of this take is running" });
    expect(FakeWindow.all).toHaveLength(1);
    await m.cancelCopyRender("/t/a");
    await mp4;

    const gif = m.startCopyRender(opts({ format: "gif", gif: { fps: 15, maxWidth: 960 } }));
    expect(m.copyRenderFormat("/t/a")).toBe("gif");
    expect((await m.startCopyRender(opts())).ok).toBe(false);
    await m.cancelCopyRender("/t/a");
    expect(await gif).toEqual({ ok: false, cancelled: true });
    expect(m.copyRenderFormat("/t/a")).toBeUndefined();
  });

  test("control: a same-format duplicate joins the running job", async () => {
    const m = await freshModule();
    const g = { format: "gif", gif: { fps: 15, maxWidth: 960 } };
    const first = m.startCopyRender(opts(g));
    const joined = m.startCopyRender(opts(g));
    expect(joined).toBe(first);
    expect(FakeWindow.all).toHaveLength(1);
    await m.cancelCopyRender("/t/a");
  });

  test("the GIF settings travel to the page in the query; an mp4 job sends none", async () => {
    const m = await freshModule();
    void m.startCopyRender(opts({ format: "gif", gif: { fps: 12, maxWidth: "original" } }));
    expect(FakeWindow.all[0]!.loaded?.opts?.query).toEqual({ format: "gif", fps: "12", maxWidth: "original" });
    await m.cancelCopyRender("/t/a");
    void m.startCopyRender(opts());
    expect(FakeWindow.all[1]!.loaded?.opts).toBeUndefined();
    await m.cancelCopyRender("/t/a");
  });
});
