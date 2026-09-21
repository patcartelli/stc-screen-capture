import { HelperClient, type HelperLine, type SpawnOptions } from "./helper-client.js";
import type { SupervisorState } from "./supervisor-state.js";
import { promoteTake } from "./temp-takes.js";

/**
 * Keeps a helper process alive and makes its death legible.
 *
 * The helper holds the capture devices, so its death is never a neutral event:
 * if it dies mid-recording the recording is gone, and the UI must say so rather
 * than quietly returning to an idle-looking state that implies nothing was lost.
 */

// Re-exported from supervisor-state.ts (STC-375) so every existing import of
// `SupervisorState` from here keeps working — this file is still where the
// type conceptually belongs, just not where it is safe to physically live.
export type { SupervisorState };

export interface SupervisorOptions extends SpawnOptions {
  /** restarts tolerated inside `restartWindowMs` before giving up */
  maxRestarts?: number;
  restartWindowMs?: number;
  /**
   * Where a promoted take should land (STC-412's `Settings.saveFolder`), read
   * fresh at the moment of every promotion rather than captured once at
   * construction — this supervisor is a long-lived singleton and the setting
   * can change (a folder chosen mid-session) while it is still running. A
   * function rather than a synced field for the same reason `still-io.ts`
   * takes `SendExport` as a function: this module is deliberately
   * Electron-free (no `app.getPath`), so it cannot read `settings.json`
   * itself, and the alternative — main.ts keeping a mirrored field in step —
   * is exactly the "one value, two copies" drift this codebase keeps paying
   * for. Omitted entirely, `promoteTake` falls through to its own
   * `STC_RECORDINGS_DIR`/`~/Desktop/stc` default, unchanged from before this
   * option existed.
   */
  getSaveFolder?: () => string | null;
}

type Handler = (payload: any) => void;

export class HelperSupervisor {
  state: SupervisorState = "starting";
  client: HelperClient | undefined;
  pid: number | undefined;

  private readonly handlers = new Map<string, Set<Handler>>();
  private restarts: number[] = [];
  private shuttingDown = false;
  private _recordingDir: string | undefined;

  /** The take a live recording is writing to, or undefined when idle. */
  get recordingDir(): string | undefined { return this._recordingDir; }
  private readyPromise!: Promise<void>;

  private constructor(private readonly bin: string, private readonly opts: SupervisorOptions) {}

  static start(bin: string, opts: SupervisorOptions = {}): HelperSupervisor {
    const s = new HelperSupervisor(bin, opts);
    s.launch();
    return s;
  }

  ready(): Promise<void> { return this.readyPromise; }

  on(ev: string, h: Handler): () => void {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(h);
    return () => this.handlers.get(ev)?.delete(h);
  }

  async startRecording(dir: string, params: Record<string, unknown> = {}): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    const r = await this.client.request("start", { dir, ...params });
    this._recordingDir = dir;
    this.state = "recording";
    return r;
  }

  /**
   * What the helper can record from: displays (with their global origins),
   * cameras and mics. The helper bounds the enumeration itself and answers
   * `stalled: true` if CoreAudio is wedged, so this never hangs the UI.
   */
  async devices(): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    return this.client.request("devices");
  }

  /**
   * The on-screen windows a window shot can name (STC-290).
   *
   * Read fresh every time the overlay opens rather than cached: a window list
   * is stale the moment something is closed or moved, and the overlay is the
   * one place where showing the user a window that is no longer there would
   * hand the capture an id that cannot be honoured.
   */
  async listWindows(): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    return this.client.request("windows");
  }

  /**
   * One frame (STC-289). Deliberately NOT routed through the recording state:
   * a still is legal while a take is running, and the whole point of it is
   * that it disturbs nothing.
   */
  async captureStill(params: Record<string, unknown>): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    return this.client.request("capture-still", params);
  }

  /**
   * Encode a composited still and put it on disk, the pasteboard, or both
   * (STC-293). State-free for the same reason `captureStill` is: copying a
   * still is legal while a take is running, and refusing one because the user
   * happens to be recording would make it useless exactly when it is wanted.
   */
  async exportStill(params: Record<string, unknown>): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    return this.client.request("export-still", params);
  }

  /**
   * Every clean stop promotes (STC-393): a display change, a closed window
   * or a user pressing Stop are all "the file is valid and playable" per
   * `endRecording`'s own distinction from a crash, and this is the ONE place
   * that is true regardless of which of those asked for it — so the promote
   * lives here rather than at each of `recorder:stop`, `window-all-closed`
   * and `shutdown` in `main.ts`, each remembering to call it. No recording
   * panel exists yet (STC-392), so a clean stop IS the save.
   *
   * `promoteTake` is a no-op for a `dir` outside the temp root (a bare
   * `/tmp/...` path in a test, say), so nothing here needs to ask first
   * whether promotion applies.
   */
  private async promote(dir: string | undefined): Promise<string | undefined> {
    if (!dir) return dir;
    try {
      return await promoteTake(process.env, this.opts.getSaveFolder?.() ?? null, dir);
    } catch (e: any) {
      this.emit("recording-promote-failed", { dir, error: String(e?.message ?? e) });
      return dir;
    }
  }

  async stopRecording(): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    const dir = this._recordingDir;
    const r = await this.client.request("stop");
    this._recordingDir = undefined;
    this.state = "idle";
    await this.promote(dir);
    return r;
  }

  /**
   * The recording is over without us asking. Distinct from `recording-lost`:
   * there the helper died and the take is gone, here it stopped cleanly and the
   * partial file is valid and playable.
   */
  private async endRecording(reason: string, line?: HelperLine): Promise<void> {
    if (this.state !== "recording") return;
    const dir = this._recordingDir;
    this._recordingDir = undefined;
    this.state = "idle";
    const promoted = await this.promote(dir);
    this.emit("recording-ended", { reason, dir: promoted, info: line });
  }

  /**
   * Deliberate teardown. Must not look like a crash.
   *
   * A recording in flight is STOPPED first, and waited for. The helper's own
   * `quit` does not wait for its stop to finish — it starts the teardown and
   * exits — and the 2 s grace below is far shorter than the helper's 20 s
   * stop bound, so quitting mid-take used to leave display.mp4 unfinalised
   * (no moov, unplayable) and the sidecars unwritten, with nothing to say so:
   * Cmd-Q during a recording lost the take silently. The request timeout
   * bounds the wait, the same bound every stop already has.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const c = this.client;
    if (!c) { this.state = "stopped"; return; }
    if (this.state === "recording") await this.stopRecording().catch(() => {});
    const exited = c.waitForExit();
    await c.request("quit").catch(() => {});
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    c.kill();
    this.state = "stopped";
  }

  /** Test seams — a supervisor whose restart path is never exercised is untested. */
  killForTest(): void { this.client?.kill(); }
  markRecordingForTest(dir: string): void { this._recordingDir = dir; this.state = "recording"; }

  private launch(): void {
    const c = HelperClient.spawn(this.bin, this.opts);
    this.client = c;
    this.pid = undefined;
    this.readyPromise = c.ready().then((line) => {
      this.pid = line.pid as number;
      if (this.state !== "recording") this.state = "idle";
      this.emit("ready", line);
    });
    // A helper that dies before `ready` rejects this. Callers who asked
    // (`ready()`) still see the rejection; the death itself is reported
    // through `waitForExit` below. Without a handler here it is an unhandled
    // rejection on every launch nobody awaited — including every respawn.
    this.readyPromise.catch(() => {});

    c.on("*", (line) => this.emit(`helper:${line.ev}`, line));
    c.on("stats", (line) => {
      this.emit("stats", line);
      // The heartbeat carries the helper's own state, which makes it the
      // authority. Reconciling against it heals ANY desync, not just the one
      // we know about — including a `stopped` that never reached us because
      // it raced a respawn.
      if (this.state === "recording" && line.state === "idle") {
        void this.endRecording("helper-idle");
      }
    });

    // A stop nobody asked for: the helper decided, typically because the
    // display was reconfigured (AVAssetWriter cannot change output dimensions
    // mid-file, so it stops rather than corrupting the take).
    c.on("stopped", (line) => {
      if (typeof line.seq === "number") return;   // answered a request; already handled
      void this.endRecording(String(line.reason ?? "helper-stopped"), line);
    });

    c.waitForExit().then((info) => {
      if (this.shuttingDown) return;

      // A recording in flight when the helper died is lost — the sidecars are
      // written on stop, which never happened. Say so loudly.
      if (this._recordingDir) {
        this.emit("recording-lost", {
          dir: this._recordingDir, ...info,
          // Whatever the helper managed to say on its way out — for a fault
          // signal that is "[helper] FATAL signal SIGSEGV" (STC-254).
          stderr: c.recentStderr.trim() || undefined,
        });
        this._recordingDir = undefined;
      }

      const now = Date.now();
      const windowMs = this.opts.restartWindowMs ?? 10_000;
      this.restarts = this.restarts.filter((t) => now - t < windowMs);
      this.restarts.push(now);

      if (this.restarts.length > (this.opts.maxRestarts ?? 3)) {
        // Respawning forever would turn a reproducible crash into a busy loop
        // that looks like the app merely being slow.
        this.state = "failed";
        // With the helper's last words: a binary that could not be spawned
        // at all says so here ("spawn ENOENT"), and nowhere else.
        this.emit("gave-up", { restarts: this.restarts.length, ...info,
                               stderr: c.recentStderr.trim() || undefined });
        return;
      }

      this.state = "starting";
      this.launch();
      this.emit("respawned", { ...info, restarts: this.restarts.length });
    });
  }

  private emit(ev: string, payload: unknown): void {
    for (const h of this.handlers.get(ev) ?? []) h(payload);
  }
}
