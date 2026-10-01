/**
 * The hidden windows that render a recording's Copy (STC-488), one per job,
 * keyed by take directory. The panel never renders: it stays small and
 * responsive, and the job doesn't care if the panel restacks or is hidden
 * for a capture.
 *
 * Cancel DESTROYS the window. `exportSession` hands its bytes over only at
 * the end, so a destroyed window has written nothing, and there is no signal
 * to thread across IPC. A cancel that lands while `copy:write` is mid-write
 * is caught by job LIVENESS below (not a flag), which deletes the partial and,
 * if the rename already ran, the final file.
 *
 * A job stays in `jobs` until its cleanup has finished, and a new job for the
 * same take waits for that (`startCopyRender`), so an old job's late `rm` can
 * never delete a newer job's files.
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
  /** "live" until the first settle; "settling" while cleanup runs. */
  state: "live" | "settling";
  /** The in-flight `copy:write`, so cleanup can wait for it. */
  writing?: Promise<void>;
  /** The rename ran: outPath belongs to this job and is removed if it settles unsuccessfully. */
  renamed: boolean;
  settle(o: CopyOutcome): void;
  /** Resolves only after the window is gone AND the files are cleaned up. */
  settled: Promise<CopyOutcome>;
}

const jobs = new Map<string, Job>();
const bySender = new Map<number, Job>();

const logRm = (what: string) => (e: unknown) => console.error(`[copy] could not remove ${what}:`, e);

ipcMain.on("copy:progress", (e, done: number, total: number) => {
  const job = bySender.get(e.sender.id);
  if (job?.state === "live") job.opts.onProgress(Number(done) || 0, Number(total) || 0);
});
ipcMain.on("copy:failed", (e, detail: string) => {
  bySender.get(e.sender.id)?.settle({ ok: false, detail: String(detail) });
});
ipcMain.handle("copy:write", (e, bytes: Uint8Array) => {
  const job = bySender.get(e.sender.id);
  if (!job || job.state !== "live") throw new Error("not a copy job");
  const partial = job.opts.outPath + PARTIAL_SUFFIX;
  job.writing = (async () => {
    await mkdir(dirname(partial), { recursive: true });
    if (job.state !== "live") return;                 // settled before we began: write nothing
    await writeFile(partial, bytes);
    // Liveness, not `cancelled`: a render death settles too. Cleanup awaits
    // this promise, so it removes the partial (and a renamed outPath) AFTER us.
    if (job.state !== "live") return;
    await rename(partial, job.opts.outPath);
    job.renamed = true;
    if (job.state !== "live") return;                 // settled during the rename: cleanup removes outPath
    job.settle({ ok: true, path: job.opts.outPath });
  })();
  return job.writing;
});

export function startCopyRender(opts: CopyJobOptions): Promise<CopyOutcome> {
  const existing = jobs.get(opts.takeDir);
  // One caller per take is the contract: a duplicate gets the running job's
  // outcome and its own `onProgress` is ignored.
  if (existing?.state === "live") return existing.settled;
  // A job still cleaning up owns this take's files; start only once it is done.
  if (existing) return existing.settled.then(() => startCopyRender(opts));
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
  let resolve!: (o: CopyOutcome) => void;
  const settled = new Promise<CopyOutcome>((res) => { resolve = res; });
  const job: Job = {
    opts, win, senderId, cancelled: false, state: "live", renamed: false, settled,
    settle: (o) => {
      if (job.state !== "live") return;               // one outcome per job
      job.state = "settling";
      bySender.delete(senderId);
      opts.revoke(senderId);
      if (!win.isDestroyed()) win.destroy();
      void (async () => {
        try {
          if (!o.ok) {
            await job.writing?.catch(() => {});       // nothing may write after the rm below
            await rm(opts.outPath + PARTIAL_SUFFIX, { force: true }).catch(logRm("the partial"));
            if (job.renamed) await rm(opts.outPath, { force: true }).catch(logRm("an orphaned copy"));
          }
        } finally {
          if (jobs.get(opts.takeDir) === job) jobs.delete(opts.takeDir);
          resolve(o);
        }
      })();
    },
  };
  jobs.set(opts.takeDir, job);
  bySender.set(senderId, job);
  opts.grant(senderId, opts.takeDir);
  win.webContents.on("render-process-gone", (_e, d) =>
    job.settle({ ok: false, detail: `the render stopped (${d.reason})` }));
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame) job.settle({ ok: false, detail: `the render page failed to load (${code} ${desc})` });
  });
  win.loadFile(join(opts.rendererDir, "copy-render.html"),
    opts.delayMs ? { query: { delayMs: String(opts.delayMs) } } : undefined)
    .catch((e) => job.settle({ ok: false, detail: `the render page failed to load: ${String(e?.message ?? e)}` }));
  return settled;
}

export async function cancelCopyRender(takeDir: string): Promise<void> {
  const job = jobs.get(takeDir);
  if (!job) return;
  job.cancelled = true;
  job.settle({ ok: false, cancelled: true });
  await job.settled;
}

export function copyRenderInFlight(takeDir: string): boolean { return jobs.get(takeDir)?.state === "live"; }
export function copyRenderWindowCount(): number {
  return [...jobs.values()].filter((j) => j.state === "live").length;
}
export async function cancelAllCopyRenders(): Promise<void> {
  await Promise.all([...jobs.keys()].map(cancelCopyRender));
}
