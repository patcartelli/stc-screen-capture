import { BrowserWindow, ipcMain, screen, type Rectangle } from "electron";
import { join } from "node:path";
import type { HelperSupervisor } from "./supervisor.js";
import {
  MIN_PILL_WIDTH_PX, PILL_DRAG_FRAME_MS, PILL_STOPPED_DWELL_MS, decidePillAction, dragTarget, easeStep,
  pillBounds, resizePillBounds, shouldDwell, shouldShowTrackNotice, type PillPoint, type PillWindowState,
} from "./pill.js";
import { pillLabel, trackLossPillLabel, TRACK_LOSS_WARNINGS } from "./stop-copy.js";
import { setBoundsUnlessClosing, trackClosing } from "./window-geometry.js";
import { PANEL_WINDOW_TYPE } from "./panel-focus.js";
import { HIDE_SETTLE_MS, windowIdOf } from "./overlay-session.js";

/**
 * The pill's own window (STC-550). `pill.ts` decides; this owns the real
 * `BrowserWindow`, one per take.
 *
 * Until STC-550 the pill was the library window collapsed to 26px (STC-375),
 * which tied it to whatever state the library was in: closed (STC-524),
 * minimized (STC-538), hidden with ⌘H. Now the library only steps aside
 * (`main.ts`, `pill.ts`'s `libraryAroundTake`) and the pill is this.
 *
 * ## One take's life
 *
 * 1. `preparePill`, before `start`: the window is made, loaded and shown
 *    WITHOUT focus at opacity 0 and click-through, top-centre of the display
 *    about to be recorded. It has to be on screen already, because the
 *    helper can only leave out of the take a window `SCShareableContent`
 *    lists as on screen, and its CGWindowID goes in `start`'s
 *    `excludeWindowIds` (requirement 9). Invisible, it is in no frame and
 *    takes no click.
 * 2. `pillStarted`, once `start` has ANSWERED: attached to the supervisor.
 *    It becomes visible only off `sup.state`, the helper-confirmed value
 *    (traps 1 and 3 in `pill.ts`'s header), never off the Record click.
 * 3. When the take ends (and any STC-531 dwell is over), or `start` never
 *    happened (`discardPill`), the window is hidden, then destroyed, and the
 *    caller's `onOver` runs once. `main.ts` brings the library back there.
 *
 * Nothing about where the pill was dragged survives step 3: the next take's
 * pill opens top-centre again (decided 2026-10-15).
 *
 * ## Not a document window, and not focusable by accident
 *
 * It is an NSPanel (`PANEL_WINDOW_TYPE`), so a click on Stop does not
 * activate the app and pull the library or the editor forward over the
 * screen being recorded, and `acceptFirstMouse` makes that first click count.
 * `main.ts`'s `documentWindowCount` never sees it (requirement 8), so "Menu
 * bar only" gets no Dock icon for a take.
 */

export interface PrepareOptions {
  /** The work area of the display the take is about to record. */
  workArea: Rectangle;
  /** Where `pill-preload.cjs` lives (`here` in main.ts). */
  dist: string;
  /** Where `pill.html` lives. */
  rendererDir: string;
  /** Runs once when this take's pill is gone, whichever way it went. */
  onOver: () => void;
}

/**
 * The last width the pill's content reported, so the next take's pill opens
 * at the right size rather than at the floor and then resizing.
 */
let lastContentWidthPx = MIN_PILL_WIDTH_PX;

let active: PillSession | undefined;

/** Whether a pill (visible or still invisible) exists right now. For tests and guards. */
export function pillIsUp(): boolean { return active !== undefined; }

/**
 * Step 1. Never rejects: a pill that could not be made costs the take its
 * pill, never the take. Answers the window ids to exclude, which is empty if
 * the id could not be read.
 */
export async function preparePill(opts: PrepareOptions): Promise<number[]> {
  // A pill left over from a take that never told us it ended. Gone first, so
  // two can never be on screen.
  active?.end();
  try {
    const session = new PillSession(opts);
    active = session;
    return await session.prepare();
  } catch (e) {
    console.error("[pill] could not prepare the pill:", e);
    return [];
  }
}

/** Step 2: `start` answered and the take is live. */
export function pillStarted(sup: HelperSupervisor): void {
  active?.attach(sup);
}

/** `start` was never sent, or was refused: put the prepared pill away. */
export function discardPill(): void {
  active?.end();
}

class PillSession {
  private win: BrowserWindow;
  private detach: (() => void) | undefined;
  private sup: HelperSupervisor | undefined;
  private over = false;

  constructor(private opts: PrepareOptions) {
    const b = pillBounds(opts.workArea, lastContentWidthPx);
    this.win = new BrowserWindow({
      ...b,
      show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, hiddenInMissionControl: true,
      // The same opaque dark the page paints, so nothing light shows while
      // the page is loading or the window is being resized.
      backgroundColor: "#0b0b0c",
      type: PANEL_WINDOW_TYPE,
      acceptFirstMouse: true,
      title: "Recording",
      webPreferences: {
        preload: join(opts.dist, "pill-preload.cjs"),
        contextIsolation: true, nodeIntegration: false,
        // It is never the frontmost window, and a throttled page would let
        // the timer stall while the take runs on.
        backgroundThrottling: false,
      },
    });
    trackClosing(this.win);
    this.win.setAlwaysOnTop(true, "screen-saver");
    // A Space switch mid-take must not lose the pill, fullscreen apps included.
    // To float over a fullscreen app Electron hides the Dock icon here
    // (`DockHide`), the same as the overlay and the countdown already did on
    // every Record. So "Menu bar only" never gets one for a take
    // (requirement 8); the caller's `onOver` puts the preference back after.
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.once("closed", () => this.end());
  }

  async prepare(): Promise<number[]> {
    const shown = new Promise<void>((resolve) => this.win.once("ready-to-show", () => resolve()));
    await this.win.loadFile(join(this.opts.rendererDir, "pill.html"));
    await shown;
    if (this.over || this.win.isDestroyed()) return [];
    this.win.setOpacity(0);
    this.win.setIgnoreMouseEvents(true);
    this.win.showInactive();
    // The window server has to have it on screen before the helper asks
    // ScreenCaptureKit what is — the same wait every hide in this app takes.
    await sleep(HIDE_SETTLE_MS);
    if (this.over || this.win.isDestroyed()) return [];
    const id = windowIdOf(this.win.getMediaSourceId());
    return id === undefined ? [] : [id];
  }

  attach(sup: HelperSupervisor): void {
    if (this.over || this.detach) return;
    this.sup = sup;
    const pill = attachPillToSupervisor(this.win, sup, {
      show: () => this.show(),
      hide: () => this.end(),
    });
    this.detach = pill.detach;
    pill.reconcileNow();
    // A take that was already over by the time `start`'s answer got here
    // never shows its pill at all.
    if (sup.state !== "recording") this.end();
  }

  private show(): void {
    if (this.over || this.win.isDestroyed()) return;
    this.win.setIgnoreMouseEvents(false);
    this.win.setOpacity(1);
    // Already shown (at opacity 0) by `prepare`; this covers a pill whose
    // prepare lost the race with the take starting.
    if (!this.win.isVisible()) this.win.showInactive();
  }

  /** `pill:contentWidth`, from this session's own page only. */
  resizeTo(sender: Electron.WebContents, px: unknown): void {
    if (this.over || this.win.isDestroyed() || sender !== this.win.webContents) return;
    if (typeof px !== "number" || !Number.isFinite(px) || px <= 0) return;
    lastContentWidthPx = px;
    const current = this.win.getBounds();
    const workArea = screen.getDisplayMatching(current).workArea;
    setBoundsUnlessClosing(this.win, resizePillBounds(current, workArea, px), "pill resize");
  }

  private drag: { windowAt: PillPoint; pointerAt: PillPoint; reduced: boolean } | undefined;
  private dragTo: PillPoint | undefined;
  private dragNow: PillPoint | undefined;
  private dragTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * `pill:drag`, from this session's own page only: the page's pointer, in
   * screen coordinates. The window eases toward where the pointer says
   * (`easeStep`), or goes straight there under reduced motion.
   */
  onDrag(sender: Electron.WebContents, msg: unknown): void {
    if (this.over || this.win.isDestroyed() || sender !== this.win.webContents) return;
    const m = msg as { phase?: unknown; x?: unknown; y?: unknown; reduced?: unknown } | null;
    if (m?.phase === "end") { this.drag = undefined; return; }
    if (typeof m?.x !== "number" || typeof m?.y !== "number" || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    const pointer = { x: m.x, y: m.y };
    if (m.phase === "start") {
      const b = this.win.getBounds();
      this.drag = { windowAt: { x: b.x, y: b.y }, pointerAt: pointer, reduced: m.reduced === true };
      this.dragNow = { x: b.x, y: b.y };
      this.dragTo = this.dragNow;
      return;
    }
    if (m.phase !== "move" || !this.drag) return;
    this.dragTo = dragTarget(this.drag.windowAt, this.drag.pointerAt, pointer);
    if (this.drag.reduced) { this.dragNow = this.dragTo; this.place(this.dragTo); return; }
    this.dragTimer ??= setInterval(this.dragFrame, PILL_DRAG_FRAME_MS);
  }

  private dragFrame = (): void => {
    if (this.over || this.win.isDestroyed() || !this.dragNow || !this.dragTo) { this.stopDragTimer(); return; }
    this.dragNow = easeStep(this.dragNow, this.dragTo);
    this.place(this.dragNow);
    // Settled, and the pointer is up: nothing left to move.
    if (!this.drag && this.dragNow.x === this.dragTo.x && this.dragNow.y === this.dragTo.y) this.stopDragTimer();
  };

  private stopDragTimer(): void {
    if (this.dragTimer !== undefined) clearInterval(this.dragTimer);
    this.dragTimer = undefined;
  }

  private place(p: PillPoint): void {
    setBoundsUnlessClosing(this.win, { x: Math.round(p.x), y: Math.round(p.y) }, "pill drag");
  }

  /** `pill:stop`, from this session's own page only. */
  async stop(sender: Electron.WebContents): Promise<{ ok: boolean }> {
    if (this.over || sender !== this.win.webContents || this.sup?.state !== "recording") return { ok: false };
    try {
      // `stopRecording` leaves the take in temp storage; `take-ended` puts up
      // its panel (STC-487), the same as every other way a take is stopped.
      await this.sup.stopRecording();
      return { ok: true };
    } catch (e) {
      console.error("[pill] stop failed:", e);
      return { ok: false };
    }
  }

  /** Step 3. Idempotent, and `onOver` runs exactly once. */
  end(): void {
    if (this.over) return;
    this.over = true;
    this.stopDragTimer();
    this.detach?.();
    if (active === this) active = undefined;
    const win = this.win;
    if (!win.isDestroyed()) {
      win.hide();
      // Destroyed a settle later, the way the countdown is, so the window
      // server is not asked to drop a window it is still drawing.
      setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, HIDE_SETTLE_MS);
    }
    try { this.opts.onOver(); } catch (e) { console.error("[pill] onOver failed:", e); }
  }
}

ipcMain.on("pill:contentWidth", (e, px: unknown) => active?.resizeTo(e.sender, px));
ipcMain.on("pill:drag", (e, msg: unknown) => active?.onDrag(e.sender, msg));
ipcMain.handle("pill:stop", (e) => active?.stop(e.sender) ?? { ok: false });

export interface AttachOptions {
  /** The confirmed state says the take is live: make the pill visible. */
  show: () => void;
  /** The take is over and any dwell has run: put the pill away. */
  hide: () => void;
}

/**
 * Drives the pill off the supervisor's own heartbeat-confirmed state —
 * traps 1 and 3 from STC-375, encoded rather than trusted.
 *
 * Trap 1: the pill shows after `start` is answered, never inside it. This
 * is never called from a click handler or from inside `startRecording()`'s
 * own promise — only after it resolves, and from the supervisor's `stats`
 * heartbeat and its explicit `recording-ended` / `recording-lost` /
 * `take-ended` events, all of which fire strictly *after* a `start`/`stop`
 * round trip has already completed.
 *
 * Trap 3: the click that started the take is not the signal `sup.state` is.
 * A take the helper stopped on its own (`recording-ended`, or the heartbeat
 * itself noticing `state: "idle"` — see `HelperSupervisor`'s own self-heal)
 * reaches this the exact same way a take the user stopped does, so the pill
 * cannot outlive a recording that has already ended.
 *
 * Returns `detach` and `reconcileNow`; the caller owns the window's lifetime.
 */
export function attachPillToSupervisor(
  win: BrowserWindow,
  sup: HelperSupervisor,
  opts: AttachOptions,
): PillAttachment {
  let current: PillWindowState = "expanded";
  // STC-531: the pill showing why the helper stopped its take. While this is
  // set, `decidePillAction` holds the hide; it ends on its own timer.
  let dwell: ReturnType<typeof setTimeout> | undefined;

  const endDwell = (): void => {
    if (dwell === undefined) return;
    clearTimeout(dwell);
    dwell = undefined;
    sendPill(win, "pill:stopped", { label: null });
  };

  // STC-237: a mic or camera lost while the take KEEPS recording. The pill shows it in
  // place of the timer for the same time a stop's label shows, then goes back. It moves
  // no window, so it never touches `reconcile`. A second loss restarts the clock with its
  // own label; a stop takes over from it (`onEnded`).
  let notice: ReturnType<typeof setTimeout> | undefined;
  const endNotice = (): void => {
    if (notice === undefined) return;
    clearTimeout(notice);
    notice = undefined;
    sendPill(win, "pill:notice", { label: null });
  };
  const onWarning = (l: { code?: unknown } | undefined): void => {
    const code = String(l?.code);
    // STC-528: no mic track from here on, so the meter goes back to hatched.
    if (TRACK_LOSS_WARNINGS.has(code) && !code.startsWith("camera")) sendPill(win, "pill:micLost", {});
    const label = trackLossPillLabel(code);
    if (win.isDestroyed() || !shouldShowTrackNotice(current, sup.state, label)) return;
    if (notice !== undefined) clearTimeout(notice);
    sendPill(win, "pill:notice", { label });
    notice = setTimeout(() => {
      notice = undefined;
      sendPill(win, "pill:notice", { label: null });
    }, PILL_STOPPED_DWELL_MS);
  };

  const reconcile = (): void => {
    if (win.isDestroyed()) { endDwell(); return; }
    const action = decidePillAction(current, sup.state, dwell !== undefined);
    if (action === "collapse") {
      current = "collapsed";
      opts.show();
    } else if (action === "restore") {
      current = "expanded";
      opts.hide();
    }
  };

  // `recording-ended` is only ever a stop the HELPER decided on (the
  // supervisor's own contract), so its reason is what the pill says.
  //
  // `take-ended` comes through here too, and FIRST: the supervisor emits it
  // just before `recording-ended`, for every clean stop. Reconciling on it
  // alone put the pill away before the helper's reason could hold it up, so
  // "Window closed" never showed (found on hardware, 2026-10-15). A stop the
  // user asked for has reason "stopped", which has no label, so it goes at once.
  const onEnded = (i: { reason?: unknown } | undefined): void => {
    endNotice();
    const label = pillLabel(typeof i?.reason === "string" ? i.reason : undefined);
    if (dwell === undefined && !win.isDestroyed() && shouldDwell(current, label)) {
      sendPill(win, "pill:stopped", { label });
      dwell = setTimeout(() => {
        dwell = undefined;
        reconcile();
      }, PILL_STOPPED_DWELL_MS);
    }
    reconcile();
  };

  const offStats = sup.on("stats", (l: { elapsedMs?: unknown } | undefined) => {
    if (typeof l?.elapsedMs === "number") sendPill(win, "pill:elapsed", { elapsedMs: l.elapsedMs });
    reconcile();
  });
  const offLevel = sup.on("helper:level", (l) => sendPill(win, "pill:level", l));
  const offEnded = sup.on("recording-ended", onEnded);
  const offLost = sup.on("recording-lost", () => { endNotice(); reconcile(); });
  const offTakeEnded = sup.on("take-ended", onEnded);
  const offWarning = sup.on("helper:warning", onWarning);
  return {
    detach: () => {
      endDwell(); endNotice();
      offStats(); offLevel(); offEnded(); offLost(); offTakeEnded(); offWarning();
    },
    reconcileNow: reconcile,
  };
}

function sendPill(win: BrowserWindow, channel: string, payload: unknown): void {
  if (win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

export interface PillAttachment {
  /** Stop listening. The caller owns the window's lifetime. */
  detach: () => void;
  /** Reconcile against the supervisor's state right now, instead of waiting for the next heartbeat. */
  reconcileNow: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
