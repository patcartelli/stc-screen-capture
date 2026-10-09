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
import type { GifSettings } from "@transform/gif-options.js";

export type CopyOutcome =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; detail: string };

export interface CopyJobOptions {
  takeDir: string;
  /** The final file (.mp4 or .gif); main writes outPath + PARTIAL_SUFFIX first. */
  outPath: string;
  /** STC-395: what the hidden page renders. Absent = "mp4", STC-488's Copy. */
  format?: "mp4" | "gif";
  /** STC-395: required with `format: "gif"` — read by main once, at the job's start. */
  gif?: GifSettings;
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
  /** Render INACTIVITY watchdog handle (STC-488 headless CI fix; re-armed per progress, STC-395). */
  renderTimeoutHandle?: NodeJS.Timeout;
  /** Re-arm the watchdog: called at start and on every `copy:progress` while live. */
  armWatchdog(): void;
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
  if (job?.state !== "live") return;
  job.armWatchdog();
  job.opts.onProgress(Number(done) || 0, Number(total) || 0);
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

const formatOf = (o: CopyJobOptions): "mp4" | "gif" => o.format ?? "mp4";

export function startCopyRender(opts: CopyJobOptions): Promise<CopyOutcome> {
  const existing = jobs.get(opts.takeDir);
  // STC-395: a duplicate must be asking for the SAME file. A GIF caller handed
  // a live mp4 job's outcome would paste a video (and vice versa). The panel
  // never asks for both at once; main refuses here too.
  if (existing?.state === "live" && formatOf(existing.opts) !== formatOf(opts)) {
    return Promise.resolve({ ok: false, detail: "another render of this take is running" });
  }
  // One caller per take is the contract: a duplicate gets the running job's
  // outcome and its own `onProgress` is ignored.
  if (existing?.state === "live") return existing.settled;
  // A job still cleaning up owns this take's files; start only once it is done.
  if (existing) return existing.settled.then(() => startCopyRender(opts));

  // Headless/Xvfb on CI: hidden windows may not render frames. Watchdog ensures
  // the job settles even if copy:write never arrives, preventing test hangs.
  // It is an INACTIVITY timeout (STC-395): re-armed on every `copy:progress`,
  // so a job that keeps reporting never times out, and one silent this long
  // settles as the timeout failure. A total bound was wrong once GIFs
  // arrived: a GIF of a multi-minute or 4K take can legitimately run past
  // 120 s, and the watchdog exists for a hidden window that never renders,
  // not for a slow one that does.
  // Default 120s matches the e2e test's inner bounds; override with STC_COPY_RENDER_TIMEOUT_MS.
  const RENDER_TIMEOUT_MS = Number(process.env.STC_COPY_RENDER_TIMEOUT_MS) || 120_000;

  const win = new BrowserWindow({
    // STC_COPY_RENDER_VISIBLE=1 for CI/headless: shows the render window for debugging
    show: process.env.STC_COPY_RENDER_VISIBLE === "1",
    width: process.env.STC_COPY_RENDER_VISIBLE === "1" ? 800 : 64,
    height: process.env.STC_COPY_RENDER_VISIBLE === "1" ? 600 : 64,
    skipTaskbar: process.env.STC_COPY_RENDER_VISIBLE !== "1",
    webPreferences: {
      preload: join(opts.dist, "copy-render-preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
      // Hidden windows are throttled by default. backgroundThrottling: false
      // doesn't guarantee rendering on headless systems (Xvfb), so render
      // timeout is necessary. Visible windows render normally.
      backgroundThrottling: false,
    },
  });
  const senderId = win.webContents.id;
  let resolve!: (o: CopyOutcome) => void;
  const settled = new Promise<CopyOutcome>((res) => { resolve = res; });
  const job: Job = {
    opts, win, senderId, cancelled: false, state: "live", renderTimeoutHandle: undefined, renamed: false, settled,
    armWatchdog: () => {
      if (job.state !== "live") return;
      if (job.renderTimeoutHandle) clearTimeout(job.renderTimeoutHandle);
      job.renderTimeoutHandle = setTimeout(() => {
        if (job.state === "live") {
          job.settle({
            ok: false,
            detail: `render timeout: no progress for ${RENDER_TIMEOUT_MS}ms (likely headless/hidden window rendering issue)`,
          });
        }
      }, RENDER_TIMEOUT_MS);
    },
    settle: (o) => {
      if (job.state !== "live") return;               // one outcome per job
      job.state = "settling";

      // Clear the render timeout watchdog
      if (job.renderTimeoutHandle) {
        clearTimeout(job.renderTimeoutHandle);
        job.renderTimeoutHandle = undefined;
      }

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

  // Start the render inactivity watchdog. If neither progress nor copy:write
  // arrives within RENDER_TIMEOUT_MS, settle as a timeout error. This prevents
  // hangs on CI where hidden windows don't render (Xvfb, headless Docker, etc).
  // Every `copy:progress` re-arms it; settle() cancels it.
  job.armWatchdog();

  // Destroyed by anything but settle (settle's own destroy lands here too, and
  // is a no-op: a job settles once).
  win.on("closed", () => job.settle({ ok: false, detail: "the render window closed" }));
  win.webContents.on("render-process-gone", (_e, d) =>
    job.settle({ ok: false, detail: `the render stopped (${d.reason})` }));
  // A preload that throws fires no did-fail-load, and copy-render.ts's
  // missing-bridge guard returns silently: without this the job never settles.
  win.webContents.on("preload-error", (_e, path, err) =>
    job.settle({ ok: false, detail: `the render's preload failed (${path}): ${String((err as Error)?.message ?? err)}` }));
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame) job.settle({ ok: false, detail: `the render page failed to load (${code} ${desc})` });
  });
  // Both seams travel in the query: the test delay, and (STC-395) the format
  // with the GIF settings main read once, at this job's start.
  const query: Record<string, string> = {};
  if (opts.delayMs) query.delayMs = String(opts.delayMs);
  if (opts.format === "gif" && opts.gif) {
    query.format = "gif";
    query.fps = String(opts.gif.fps);
    query.maxWidth = String(opts.gif.maxWidth);
  }
  win.loadFile(join(opts.rendererDir, "copy-render.html"),
    Object.keys(query).length ? { query } : undefined)
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
/** STC-395: what the LIVE job for this take is rendering, or undefined when none is. */
export function copyRenderFormat(takeDir: string): "mp4" | "gif" | undefined {
  const j = jobs.get(takeDir);
  return j?.state === "live" ? formatOf(j.opts) : undefined;
}
export async function cancelAllCopyRenders(): Promise<void> {
  await Promise.all([...jobs.keys()].map(cancelCopyRender));
}
