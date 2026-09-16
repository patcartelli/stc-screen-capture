import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import {
  COUNTDOWN_TICK_MS, countdownView,
  type CountdownOutcome, type CountdownPurpose,
} from "./countdown.js";
import { HIDE_SETTLE_MS, windowIdOf } from "./overlay-session.js";

/**
 * The countdown's real window and its real clock (STC-391).
 *
 * `countdown.ts` decides what a countdown IS; this owns the one
 * `BrowserWindow` that shows it, the interval that drives it, and the promise
 * that answers exactly once. The state machine lives HERE and not in the page,
 * the same arrangement `overlay-session.ts` has and for a related reason: the
 * page can be occluded, throttled or never painted, and a countdown whose
 * clock lived there could silently take longer than it promised.
 *
 * ## A panel, not a scrim — and centred
 *
 * The obvious countdown is a full-screen number. It cannot be one here: the
 * self-timer exists to let someone open a dropdown or hold a hover state
 * WHILE it runs, and a full-display window either swallows those clicks or has
 * to be click-through — at which point Skip and Cancel are unclickable. So it
 * is a small panel, leaving every other pixel of the screen live.
 *
 * It sits in the CENTRE of the target display, horizontally and vertically.
 * The first cut put it at the bottom centre on the reasoning that a countdown
 * should keep out of the way; watched on hardware (2026-09-16) the centre is
 * what reads as a countdown rather than as a notification, and is where other
 * screen recorders put one. The cost is real and small: a 260x156 panel over
 * the middle of the screen blocks clicks there for its duration. It cannot
 * corrupt a capture — it is destroyed and excluded before the frame is taken —
 * so what it costs is reach, not fidelity.
 *
 * ## Focus, and what is lost when it goes
 *
 * The panel takes focus when it appears, which is what makes Return and Escape
 * work without registering either as a GLOBAL shortcut — and registering them
 * globally is the thing to avoid rather than an implementation detail: a bare
 * Return grabbed machine-wide for three seconds would be eaten from the very
 * dropdown the self-timer was opened to photograph. The cost is stated rather
 * than hidden: click into another app during the countdown and the keyboard
 * equivalents go with the focus. Skip and Cancel are still one click away, and
 * the countdown still fires on time.
 *
 * ## Never in the captured frame
 *
 * The ticket's requirement 3, belt and braces, exactly as `overlay-session.ts`
 * does it: the window is hidden, `HIDE_SETTLE_MS` is waited out, the window is
 * DESTROYED, and its CGWindowID is handed back so a still capture can also
 * name it in `excludeWindowIds`. Either alone is a race. A recording gets the
 * hide and the destroy but has no exclusion list to be added to — `start` takes
 * no such parameter — which is sound because the countdown is over before
 * `start` is called at all, where a still capture's request can be in flight
 * while the window server is still catching up.
 */

/** Panel geometry. Small enough to leave the screen usable, big enough for the
 * number to be read from across a desk. */
const PANEL = { width: 260, height: 156 };

export interface CountdownOptions {
  /** How long, ms. The caller has already clamped it and already checked
   * `needsCountdown` — a countdown of zero never gets this far. */
  ms: number;
  purpose: CountdownPurpose;
  /** Which display to show on. An id that no longer exists, or none at all,
   * falls back to the display under the pointer — the same rule
   * `wholeDisplay` uses, and for the same reason: the thing being looked at is
   * the one under the cursor. */
  displayId?: number;
  /** Where `countdown-preload.cjs` lives (`here` in main.ts). */
  dist: string;
  /** Where `countdown.html` lives (`join(here, "..", "renderer")`). */
  rendererDir: string;
}

export interface CountdownResult {
  outcome: CountdownOutcome;
  /** The panel's CGWindowID, for a still capture's `excludeWindowIds`. Empty
   * when the id could not be read, in which case the hide above still stands. */
  excludeWindowIds: number[];
}

let active: Session | undefined;

/** Whether a countdown is on screen right now — for `captureStill`'s guard and
 * for tests. */
export function countdownIsOpen(): boolean { return active !== undefined; }

/**
 * Show the countdown, and answer when it ends.
 *
 * Resolves `elapsed` when it runs out, `skipped` when the user asked for it
 * now, `cancelled` when they pressed Escape or Cancel. Never rejects: a
 * countdown that threw would leave a hotkey with an unhandled rejection and a
 * capture that silently did nothing, the same rule `captureStill` follows.
 */
export function runCountdown(opts: CountdownOptions): Promise<CountdownResult> {
  // A second countdown while one is running is not a second panel. Callers
  // already refuse to reach here twice (`capturing`/`countdownIsOpen`); this is
  // the structural half, so a caller that forgets cannot put two clocks on
  // screen.
  if (active) return Promise.resolve({ outcome: "cancelled", excludeWindowIds: [] });
  return new Promise<CountdownResult>((resolve) => {
    // Constructed, PUBLISHED, and only then started. The obvious one-liner —
    // `active = new Session(...)` with the clock started in the constructor —
    // has a latent order bug that costs the app its ability to capture at all:
    // a session that settles during its own construction runs the callback
    // BEFORE the assignment completes, so `active = undefined` happens first
    // and the assignment then puts the dead session back. `countdownIsOpen()`
    // is true forever after that, and every later capture and Record is
    // refused. The identity check is the second half: a stale session's settle
    // may never clear a newer one.
    const session = new Session(opts, (r) => {
      if (active === session) active = undefined;
      resolve(r);
    });
    active = session;
    session.begin();
  });
}

/**
 * Cancel whatever is on screen, if anything.
 *
 * Its caller's promise still settles — with `cancelled`, so the capture or the
 * recording it was in front of does NOT happen. Used on teardown, where the
 * alternative is a panel outliving the app that owns it.
 */
export function cancelCountdown(): void {
  active?.cancel();
}

class Session {
  private win!: BrowserWindow;
  private done = false;
  private endsAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private opts: CountdownOptions, private settle: (r: CountdownResult) => void) {}

  /** Opens the panel and starts the clock. Separate from the constructor so
   * `runCountdown` can publish this session before anything it does can
   * settle — see the comment there. */
  begin(): void {
    const opts = this.opts;
    this.endsAt = Date.now() + opts.ms;
    const display = this.targetDisplay();
    const { x, y, width, height } = display.workArea;
    this.win = new BrowserWindow({
      x: Math.round(x + (width - PANEL.width) / 2),
      // Centred on the display's WORK area rather than its full bounds, so a
      // Dock or a menu bar does not pull the apparent centre off true.
      y: Math.round(y + (height - PANEL.height) / 2),
      width: PANEL.width, height: PANEL.height,
      transparent: true, frame: false, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true,
      // Not shown before its first paint — a transparent window shown empty
      // flashes the desktop through it, the same reason the overlay and the
      // thumbnail both wait.
      show: false,
      webPreferences: {
        preload: join(opts.dist, "countdown-preload.cjs"),
        contextIsolation: true, nodeIntegration: false,
        // The panel is frequently NOT the frontmost window — that is the whole
        // point of the self-timer — and a throttled renderer would show a
        // number that had stopped counting while the clock underneath it went
        // on running.
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    ipcMain.on("countdown:event", this.onEvent);
    // A window destroyed from underneath this — a crash, a quit — must not
    // leave the caller waiting for a promise nothing can settle.
    this.win.once("closed", () => { if (!this.done) void this.finish("cancelled"); });
    this.win.once("ready-to-show", () => {
      if (this.win.isDestroyed()) return;
      // `show`, not `showInactive`: focus is what makes Escape and Return
      // reach the page at all — see the header.
      this.win.show();
    });
    void this.win.loadFile(join(opts.rendererDir, "countdown.html"), {
      query: { ms: String(opts.ms), purpose: opts.purpose },
    });
    this.timer = setInterval(this.tick, COUNTDOWN_TICK_MS);
    // Paint the first frame from the main process's own clock rather than
    // waiting a tick for it, so the panel never appears showing nothing.
    this.tick();
  }

  private targetDisplay() {
    const all = screen.getAllDisplays();
    const named = this.opts.displayId !== undefined
      ? all.find((d) => d.id === this.opts.displayId) : undefined;
    return named ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  private tick = (): void => {
    if (this.done) return;
    const remainingMs = this.endsAt - Date.now();
    if (remainingMs <= 0) { void this.finish("elapsed"); return; }
    if (this.win.isDestroyed()) return;
    // The view is computed HERE and sent as a drawn answer, so the page holds
    // no clock of its own to disagree with this one. `reducedMotion` is the
    // exception and travels the other way: only the page can read the OS's
    // setting, so it re-runs `countdownView` with its own answer for that one
    // field. Same function, same rules, in both places.
    this.win.webContents.send("countdown:state", {
      remainingMs, totalMs: this.opts.ms,
      view: countdownView({ remainingMs, totalMs: this.opts.ms, purpose: this.opts.purpose }),
    });
  };

  private onEvent = (e: Electron.IpcMainEvent, ev: unknown): void => {
    if (this.done || this.win.isDestroyed()) return;
    // Only this panel's own renderer may drive it. Without the check any
    // window with the bridge could cancel a countdown it has nothing to do
    // with — the narrow version of the rule `still:writeShot` follows.
    if (e.sender !== this.win.webContents) return;
    const kind = (ev as { kind?: unknown } | null)?.kind;
    if (kind === "cancel") void this.finish("cancelled");
    else if (kind === "skip") void this.finish("skipped");
  };

  cancel(): void { if (!this.done) void this.finish("cancelled"); }

  /**
   * Answers exactly once, whichever path gets here first — the rule
   * `OverlaySession.finish` and the helper's own `start`/`stop` follow, and for
   * the same reason: a second answer to one countdown would capture twice.
   */
  private async finish(outcome: CountdownOutcome): Promise<void> {
    if (this.done) return;
    this.done = true;
    if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined; }
    ipcMain.removeListener("countdown:event", this.onEvent);

    const excludeWindowIds: number[] = [];
    // The teardown runs inside a `try` whose `finally` ALWAYS settles, and
    // that is load-bearing rather than tidy. Every line below can throw on a
    // window destroyed out from under it — `isDestroyed()` is a read, not a
    // lock, and `hide()`/`destroy()` sit after it — and `finish` is invoked as
    // `void this.finish(...)`, so a rejection here used to become an unhandled
    // rejection with `settle` never called. The caller's promise then never
    // resolved: `captureStill` waited on it forever with `capturing` still
    // true, `active` stayed set, and the app could not capture OR record again
    // for the rest of the session. A countdown failing to tear its own window
    // down must cost that window, never the app's ability to record.
    try {
      if (!this.win.isDestroyed()) {
        try {
          const id = windowIdOf(this.win.getMediaSourceId());
          if (id !== undefined) excludeWindowIds.push(id);
        } catch { /* not available here; the hide below still stands */ }
        // The fault injector, on the same idiom as `STC_CAPTURE_FAULT` and
        // `STC_WG_FAULT`: the real trigger is a window destroyed in the gap
        // between the `isDestroyed()` read above and this `hide()`, which is a
        // timing coincidence no test can schedule. Without a way to reach it,
        // the `finally` below is a guard nobody has watched fire — which this
        // file already learned is indistinguishable from one that cannot.
        if (process.env.STC_COUNTDOWN_FAULT === "teardown-throws") {
          throw new Error("fault: the countdown panel's teardown failed");
        }
        this.win.hide();
        await sleep(HIDE_SETTLE_MS);
        if (!this.win.isDestroyed()) this.win.destroy();
      }
    } catch (e) {
      // Named rather than swallowed: the panel may still be on screen, and a
      // silent catch here is how that would go unexplained.
      console.error("[countdown] tearing the panel down failed:", e);
    } finally {
      this.settle({ outcome, excludeWindowIds });
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
