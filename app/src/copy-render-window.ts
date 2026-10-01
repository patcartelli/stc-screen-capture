/**
 * The hidden windows that render a recording's Copy (STC-488), one per job,
 * keyed by take directory. The panel never renders: it stays small and
 * responsive, and the job doesn't care if the panel restacks or is hidden
 * for a capture.
 *
 * Cancel DESTROYS the window. `exportSession` hands its bytes over only at
 * the end, so a destroyed window has written nothing, and there is no signal
 * to thread across IPC. A cancel that lands while `copy:write` is mid-write
 * is caught by the `cancelled` flag below, which deletes the partial.
 */
import { BrowserWindow, ipcMain } from "electron";
import { join, dirname } from "node:path";
import { rename, rm, writeFile, mkdir } from "node:fs/promises";
import { PARTIAL_SUFFIX } from "./recording-copy.js";

export type CopyOutcome =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; detail: string };

export interface CopyJobOptions {
  takeDir: string;
  /** The final .mp4; main writes outPath + PARTIAL_SUFFIX first. */
  outPath: string;
  dist: string;
  rendererDir: string;
  /** Test seam (STC_COPY_RENDER_DELAY_MS): the render waits this long before loading. */
  delayMs?: number;
  /** main's openTakes.set */
  grant(webContentsId: number, takeDir: string): void;
  /** main's openTakes.delete */
  revoke(webContentsId: number): void;
  onProgress(done: number, total: number): void;
}

interface Job {
  opts: CopyJobOptions;
  win: BrowserWindow;
  senderId: number;
  cancelled: boolean;
  settle(o: CopyOutcome): void;
  settled: Promise<CopyOutcome>;
}

const jobs = new Map<string, Job>();
const bySender = new Map<number, Job>();

ipcMain.on("copy:progress", (e, done: number, total: number) => {
  bySender.get(e.sender.id)?.opts.onProgress(Number(done) || 0, Number(total) || 0);
});
ipcMain.on("copy:failed", (e, detail: string) => {
  bySender.get(e.sender.id)?.settle({ ok: false, detail: String(detail) });
});
ipcMain.handle("copy:write", async (e, bytes: ArrayBuffer) => {
  const job = bySender.get(e.sender.id);
  if (!job) throw new Error("not a copy job");
  const partial = job.opts.outPath + PARTIAL_SUFFIX;
  await mkdir(dirname(partial), { recursive: true });
  await writeFile(partial, Buffer.from(bytes));
  if (job.cancelled) { await rm(partial, { force: true }); return; }
  await rename(partial, job.opts.outPath);
  job.settle({ ok: true, path: job.opts.outPath });
});

export function startCopyRender(opts: CopyJobOptions): Promise<CopyOutcome> {
  const existing = jobs.get(opts.takeDir);
  if (existing) return existing.settled;
  const win = new BrowserWindow({
    show: false, width: 64, height: 64, skipTaskbar: true,
    webPreferences: {
      preload: join(opts.dist, "copy-render-preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
      // A hidden window is throttled by default, which would stretch a
      // 40 s render well past it.
      backgroundThrottling: false,
    },
  });
  const senderId = win.webContents.id;
  let settle!: (o: CopyOutcome) => void;
  const settled = new Promise<CopyOutcome>((res) => { settle = res; });
  const job: Job = {
    opts, win, senderId, cancelled: false, settled,
    settle: (o) => {
      if (!jobs.has(opts.takeDir)) return;            // one outcome per job
      jobs.delete(opts.takeDir);
      bySender.delete(senderId);
      opts.revoke(senderId);
      if (!win.isDestroyed()) win.destroy();
      if (!o.ok) void rm(opts.outPath + PARTIAL_SUFFIX, { force: true });
      settle(o);
    },
  };
  jobs.set(opts.takeDir, job);
  bySender.set(senderId, job);
  opts.grant(senderId, opts.takeDir);
  win.webContents.on("render-process-gone", (_e, d) =>
    job.settle({ ok: false, detail: `the render stopped (${d.reason})` }));
  void win.loadFile(join(opts.rendererDir, "copy-render.html"),
    opts.delayMs ? { query: { delayMs: String(opts.delayMs) } } : undefined);
  return settled;
}

export async function cancelCopyRender(takeDir: string): Promise<void> {
  const job = jobs.get(takeDir);
  if (!job) return;
  job.cancelled = true;
  job.settle({ ok: false, cancelled: true });
  await job.settled;
}

export function copyRenderInFlight(takeDir: string): boolean { return jobs.has(takeDir); }
export function copyRenderWindowCount(): number { return jobs.size; }
export async function cancelAllCopyRenders(): Promise<void> {
  await Promise.all([...jobs.keys()].map(cancelCopyRender));
}
