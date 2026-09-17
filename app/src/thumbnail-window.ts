import { app, BrowserWindow, screen } from "electron";
import { join } from "node:path";
import {
  positionFor, stackPosition, MAX_STACKED, PANEL_SIZE, REDACT_SIZE,
  type Corner, type Size,
} from "./thumbnail.js";
import { HIDE_SETTLE_MS, windowIdOf } from "./overlay-session.js";
import { focusPanel, PANEL_WINDOW_TYPE } from "./panel-focus.js";
import { type PanelTake } from "./panel-actions.js";

/**
 * The post-capture floating thumbnail's window (STC-296, reworked by
 * STC-392).
 *
 * `thumbnail.ts` decides what STATE a panel is in; this owns the real
 * `BrowserWindow`s the same split `overlay-session.ts` makes for the
 * selection overlay. There is no timer here any more — see the module doc on
 * `thumbnail.ts`'s `ThumbnailState` for why.
 *
 * Captures STACK, newest at the corner, up to `MAX_STACKED`. A panel pushed
 * out by the cap is DISMISSED (`dismissNow`), never merely dropped — nothing
 * exported, and the take stays in temp storage for STC-393's recovery to
 * find, the same as any other panel this module tears down without a
 * decision having been made.
 *
 * ## The panel takes focus when it appears (STC-392 focus rule 1)
 *
 * A panel that waits for a decision and cannot be typed at is a panel whose
 * keyboard paths do not exist. `onEvent`'s `"painted"` branch calls
 * `focusPanel`, not `showInactive` — through `panel-focus.ts`, not
 * `win.focus()`, because an application-level activation on macOS raises the
 * main window too (STC-391's follow-up, 5850e4f). The window is created with
 * `type: PANEL_WINDOW_TYPE` for the same reason: an NSPanel can become key
 * without activating its application.
 *
 * ## The `skip` panel drives itself
 *
 * A `silent` panel is never shown at all — there is nothing to animate into —
 * so it has no reason to wait on a "painted" round trip through main the way
 * a visible panel does. It composites and exports itself the moment `draw()`
 * finishes (`?silent=1`, `thumbnail-renderer.ts`) and reports only `"done"`
 * when it is. One fewer message crossing the process boundary for a window
 * nobody ever sees.
 */

// Redact mode's size (STC-297) — `REDACT_SIZE` itself now lives in
// `thumbnail.ts`, imported above, so `thumbnail-renderer.ts` can derive its
// own canvas box from the SAME number rather than an independently-tuned one
// (STC-392 review, M5).
const CORNER_MARGIN = 20;

/**
 * How long a future renderer round trip would get before this gives up on it
 * and destroys the window anyway — reserved, not currently armed by
 * anything.
 *
 * `dismissNow` is synchronous (hide, then destroy), so nothing today asks the
 * renderer to do work before closing and nothing needs bounding. This exists
 * for Task 4's export-then-close, which reintroduces exactly that: a hidden
 * window waiting on a composite-and-export it cannot see the progress of. A
 * hidden window that never closes is invisible on screen but not gone — it
 * would still show up in `app.getAllWindows()`, in Mission Control's spaces
 * bookkeeping, and in the next capture's exclusion list forever pointing at a
 * stale id — which is the fault this bound exists to prevent once something
 * arms it again. Kept, rather than deleted with the rest of the timeout,
 * because `SETTLE_READY_MS` (`thumbnail.ts`) is checked against it —
 * `app/test/thumbnail-bounds.test.ts` — so the two cannot drift apart before
 * either is wired back up.
 */
export const SETTLE_BACKSTOP_MS = 15_000;

export interface PresentOptions {
  dir: string;
  /** The shot document exactly as `capture-still` wrote it — not yet parsed. */
  shot: unknown;
  corner: Corner;
  /** Where `thumbnail.html` and its preload live. */
  dist: string;
  rendererDir: string;
  /**
   * The "skip the panel" preference: never shown, and copies to the
   * clipboard the instant it has composited. Still a real (hidden) window
   * rather than a second compositing path — reusing the one the panel
   * already has is exactly what STC-293's Note forbids a second
   * implementation of. The renderer decides to do this itself, from `silent`
   * alone — never a stored preference, the same reason `take` below is a
   * call-site fact rather than one.
   */
  silent?: boolean;
  /**
   * What the panel is showing — `panel-actions.ts`'s own type, not a second
   * spelling of it. Decides which of the four actions the card draws
   * (`actionsFor`) and what Save and Trash MEAN: `origin: "library"` is a
   * shot RE-OPENED (STC-294), already on disk, so there is nothing to
   * promote and ignoring it must do nothing at all — unlike a `"fresh"`
   * capture, where the panel is the only place the take exists. Required,
   * not optional, because every caller has an answer — a capture `main.ts`
   * just made is always `{ kind: "shot", origin: "fresh" }`, `still:reopen`
   * is always `origin: "library"` — and a call site that forgot to say which
   * would rather be a type error than default to the wrong one.
   */
  take: PanelTake;
}

type ThumbEvent =
  | { kind: "painted" }
  /** Redact mode opening or closing (STC-297), which the panel is resized for. */
  | { kind: "redact"; on: boolean }
  /**
   * A discard has committed — the swipe passed its threshold, or the
   * right-click Delete — and the renderer is about to ask main to trash the
   * capture (STC-343).
   *
   * Currently a NO-OP on this side (see `onEvent`'s branch): the race it
   * guarded was against the panel's own timeout, which is gone. Kept as a
   * real event rather than deleted because the shape of the race survives —
   * a discard is still an async round trip (`window.thumb.trash`, the
   * `panel:trash` handler in `main.ts`), and anything that can hide or
   * destroy this same window WHILE it is in flight — today, the overflow
   * eviction above `MAX_STACKED` (`presentThumbnail`, below) — still needs to
   * hear about it first. `thumbnail.ts`'s module doc has the STC-392 update
   * to the original race this closed.
   */
  | { kind: "discarding" }
  | { kind: "done" };

/**
 * Every panel on screen, NEWEST FIRST.
 *
 * Was a single slot until stacking: a capture arriving while a panel was up
 * replaced it. It still DISMISSES what it displaces — nothing exported, the
 * take left in temp storage — which is the same "nothing is lost" promise
 * replacing always kept, now kept the STC-392 way. A burst of captures leaves
 * a legible stack instead of one survivor.
 */
let panels: ThumbnailSession[] = [];

/**
 * Put the panel on screen for a fresh capture, replacing whatever panel — if
 * any — was already showing.
 */
export function presentThumbnail(opts: PresentOptions): void {
  panels.unshift(new ThumbnailSession(opts));
  // Over the cap, the oldest is DISMISSED to make room — its take stays in
  // temp storage, findable by STC-393's recovery, rather than exported.
  const overflow = panels.slice(MAX_STACKED);
  for (const old of overflow) old.dismissNow();
  restack();
}

/**
 * Put every panel where its position in the stack says it belongs.
 *
 * Called whenever the list changes — a new capture, or one settling out of the
 * middle — because every panel's place is a function of the whole stack, not
 * of where it happened to start.
 */
function restack(): void {
  panels.forEach((p, i) => p.moveToStackIndex(i));
}

/**
 * Get the panel out of a capture's pixels. Hides it (if one is showing) and
 * reports its window id for `excludeWindowIds`, then waits the same settle
 * time the overlay does before returning — belt and braces, exactly as
 * `overlay-session.ts` reasons about it: the exclusion list is what makes the
 * capture correct, this only keeps the common case from depending on it.
 *
 * Does NOT destroy the panels: they are hidden for the duration of one capture
 * and `presentThumbnail` shows the stack again. A caller that hides without
 * following up with a new capture (there is none today) would leave them
 * hidden but alive — worth knowing if one is ever added.
 */
export async function beforeCapture(): Promise<number[]> {
  if (panels.length === 0) return [];
  // EVERY panel, not just the newest. With a stack, excluding one and leaving
  // the rest visible would photograph the others — the exact failure
  // `excludeWindowIds` exists to prevent, reintroduced by the feature that
  // made more than one panel possible.
  const ids = panels.map((p) => p.hide()).filter((id): id is number => id !== undefined);
  await sleep(HIDE_SETTLE_MS);
  return ids;
}

/**
 * Put the stack back on screen after a capture.
 *
 * The counterpart to `beforeCapture`, and it has to be called on EVERY exit
 * from a capture — including a cancelled one. `beforeCapture` hides panels
 * that are not about to be replaced (a stack persists where a single panel
 * used to be destroyed), so without this a cancelled selection would leave
 * the whole stack invisible — with nothing left to bring it back, since
 * nothing times out any more.
 */
export function afterCapture(): void {
  for (const p of panels) p.reshow();
  // STC-392 focus rule 3: "when panels come back, the most recent one gets
  // focus." `panels[0]` IS the most recent — `presentThumbnail` always
  // `unshift`s the newest onto the front, the same ordering `stackPosition`
  // reads for its index (asserted in `thumbnail.test.ts`'s stacking block,
  // for POSITION — that block does not and cannot drive this file, since it
  // imports no Electron). Focus rules 1 and 3 have NO test of their own: OS
  // key-focus is not observable from a pure test, and this sandbox's own
  // runbook history (STC-391) says even a real E2E run cannot see it either
  // — only a person running the app can. Stated here rather than implied.
  panels[0]?.takeFocus();
}

/**
 * Tears down whatever panel is on screen. Resolves once every window is
 * actually gone, so a caller that awaits this before quitting cannot destroy
 * the process out from under a window still tearing itself down.
 * `dismissNow` is synchronous (hide, then destroy) — there is no wait left
 * to bound here; `waitUntilClosed` resolves from the `"closed"` event Electron
 * fires once `destroy()` has actually run.
 *
 * Nothing is exported and nothing is deleted (STC-392): a take still showing
 * when this runs is left exactly where `capture-still` wrote it, in temp
 * storage, for STC-393's recovery to find on the next launch. Before this
 * ticket the same call SETTLED every panel — composited, exported, then
 * destroyed — because a timeout was still the promise that "nothing is lost
 * by doing nothing" leaned on. That promise is kept a different way now: the
 * panel waits for a person, and quitting without answering it is a choice
 * the recovery prompt gives them the chance to revisit, not a silent export.
 */
export function closeThumbnail(): Promise<void> {
  // A copy: dismissing mutates `panels` as each one closes.
  const all = [...panels];
  if (all.length === 0) return Promise.resolve();
  for (const p of all) p.dismissNow();
  return Promise.all(all.map((p) => p.waitUntilClosed())).then(() => undefined);
}

/**
 * Close the panel showing this take, once its action has been performed.
 *
 * Matched on the dir the panel was PRESENTED with, so it must be called
 * before anything reassigns that dir — `panel:save` promotes first and then
 * dismisses, which works because `promoteTake` returns a new path and leaves
 * the panel's own `opts.dir` alone. A dismiss that ran after the panel had
 * learned its new home would match nothing and leave the window up.
 */
export function dismissThumbnail(dir: string): void {
  for (const p of [...panels]) if (p.takeDir === dir) p.dismissNow();
}

/** Whether any panel is on screen right now, for tests. */
export function thumbnailIsOpen(): boolean { return panels.length > 0; }

/** How many are stacked right now, for tests. */
export function thumbnailCount(): number { return panels.length; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ThumbnailSession {
  private readonly win: BrowserWindow;
  private done = false;
  /**
   * It has painted at least once, so it is a panel the user has SEEN.
   *
   * `win.show()` plus `focusNow()` runs on the one-time `painted` event (focus
   * rule 1), so re-showing a panel hidden for a capture (`reshow`, below)
   * cannot go through that path — and showing one that has never painted
   * would flash the desktop through a transparent window, which is the
   * reason `show: false` is set in the first place.
   */
  private hasPainted = false;
  /** Where in the stack this panel currently sits; 0 is the newest. */
  private stackIndex = 0;
  private readonly corner: Corner;
  private resolveClosed!: () => void;
  private readonly closed: Promise<void>;

  constructor(private readonly opts: PresentOptions) {
    this.closed = new Promise((res) => { this.resolveClosed = res; });
    this.corner = opts.corner;
    // At the corner: a new panel is always the newest, so index 0. `restack`
    // moves the ones behind it immediately afterwards.
    const { x, y } = positionFor(this.corner, this.workArea(), PANEL_SIZE, CORNER_MARGIN);
    this.win = new BrowserWindow({
      x, y, width: PANEL_SIZE.width, height: PANEL_SIZE.height,
      transparent: true, frame: false, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true,
      // An NSPanel: it must be able to hold the keyboard WITHOUT activating
      // the app, or focusing it raises the main window — see `panel-focus.ts`
      // and the class doc's focus rule 1.
      type: PANEL_WINDOW_TYPE,
      // Not shown before its first paint — the same reason the overlay isn't:
      // a transparent window shown empty flashes the desktop through it.
      show: false,
      webPreferences: {
        preload: join(opts.dist, "thumbnail-preload.cjs"),
        contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // `take` is what decides which buttons the card draws and what Save and
    // Trash mean — `panel-actions.ts`'s own type, passed through verbatim
    // rather than reduced to a settle-action string the renderer would have
    // to decode back into a decision it already had here.
    this.win.loadFile(join(opts.rendererDir, "thumbnail.html"), {
      query: {
        dir: opts.dir,
        shot: JSON.stringify(opts.shot),
        take: JSON.stringify(opts.take),
        // The view needs it too, and only for the swipe: which way is
        // off-screen is a property of where the panel was put.
        corner: opts.corner,
        ...(opts.silent ? { silent: "1" } : {}),
      },
    });
    this.win.webContents.on("ipc-message", (_e, channel, ev: ThumbEvent) => {
      if (channel === "thumbnail:event") this.onEvent(ev);
    });
    this.win.on("closed", () => {
      this.done = true;
      this.leaveStack();
      this.resolveClosed();
    });
  }

  waitUntilClosed(): Promise<void> { return this.closed; }

  private workArea(): { x: number; y: number; width: number; height: number } {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  }

  private onEvent(ev: ThumbEvent): void {
    if (this.done) return;
    if (ev.kind === "painted") {
      this.hasPainted = true;
      // STC-392 focus rule 1: "the panel takes focus when it appears."
      // `showInactive` was right when the panel was a transient notice you
      // could ignore; a panel that waits for a decision and cannot be typed
      // at is a panel whose keyboard paths (rule 4) do not exist.
      this.win.show();
      this.focusNow();
    } else if (ev.kind === "redact") {
      this.resizeTo(ev.on ? REDACT_SIZE : PANEL_SIZE);
    } else if (ev.kind === "discarding") {
      // No-op today — see the `ThumbEvent` doc on this case. Kept as its own
      // branch, not folded into the default no-match, so the next thing that
      // needs to hear about a discard in flight has an obvious place to add
      // real logic rather than a new branch to discover.
    } else if (ev.kind === "done") {
      this.destroy();
    }
  }

  /**
   * Grow or shrink in place, staying in ITS corner. Recomputed rather than
   * kept as an offset: a panel in the bottom-right that grew by moving its
   * origin would walk off the bottom of the display.
   */
  private resizeTo(size: Size): void {
    if (this.done || this.win.isDestroyed()) return;
    // Through `stackPosition`, not `positionFor`: a panel expanded from the
    // middle of a stack must grow where it IS, not jump to the corner.
    const { x, y } = stackPosition(this.stackIndex, this.corner, this.workArea(),
                                   size, CORNER_MARGIN);
    this.win.setBounds({ x, y, width: size.width, height: size.height });
  }

  /**
   * Show a panel that was hidden for a capture.
   *
   * Only one that has already painted: see `hasPainted`. Does not itself take
   * focus — `afterCapture`'s caller decides which panel in the stack gets that
   * (focus rule 3), and it would be wrong for every reshown panel to grab it.
   */
  reshow(): void {
    if (this.done || this.win.isDestroyed() || !this.hasPainted) return;
    if (!this.win.isVisible()) this.win.showInactive();
  }

  /**
   * Give this panel the keyboard again, the same way it did when it first
   * painted (focus rule 3: the most recent panel gets focus back after a
   * capture). Refuses on one that has never painted, for the same reason
   * `reshow` does — there is nothing on screen yet to focus.
   */
  takeFocus(): void {
    if (this.done || this.win.isDestroyed() || !this.hasPainted) return;
    this.focusNow();
  }

  /**
   * The one call to `focusPanel`, shared by the initial paint and by
   * `takeFocus` — through `panel-focus.ts`, not `win.focus()`, because an
   * application-level activation on macOS raises the main window too, the
   * exact fault STC-391's follow-up (5850e4f) spent a session finding. The
   * window is created with `type: PANEL_WINDOW_TYPE` for the same reason.
   */
  private focusNow(): void {
    void focusPanel(this.win, () => app.focus({ steal: true })).then((took) => {
      if (took === "escalated") {
        console.warn("[thumbnail] the panel could not take key focus; activated the app instead");
      }
    });
  }

  /** Hides the window and returns its CGWindowID, for `beforeCapture`. */
  hide(): number | undefined {
    if (this.done || this.win.isDestroyed()) return undefined;
    let id: number | undefined;
    try { id = windowIdOf(this.win.getMediaSourceId()); } catch { /* not available; hide still stands */ }
    this.win.hide();
    return id;
  }

  /**
   * Which take this panel is showing.
   *
   * Exposed because main's handlers are reached from the RENDERER, and a
   * renderer names a take, never a window — the same rule `panel:trash`
   * and `still:revealShot` already follow. `readonly` via the getter: a panel
   * whose directory could be reassigned from outside would be a second owner
   * of a value `promoteTake` already moves.
   */
  get takeDir(): string { return this.opts.dir; }

  /**
   * Take the panel off the screen without deciding anything.
   *
   * This used to be `settleAndDestroy`, and the difference is the whole
   * ticket: it told the renderer to composite-and-export first, because a
   * panel that vanished on a timeout still had to keep "nothing is lost by
   * doing nothing". Nothing times out now, so the only callers left are the
   * ones where the take's fate is decided elsewhere — the renderer has just
   * performed a Save, an Edit or a Trash — or where there is no fate to
   * decide, which is the app shutting down.
   *
   * A take still in temp storage when this runs is not lost either: STC-393's
   * recovery prompt finds it on the next launch. That is the promise now, and
   * it is a better one than a silent export nobody asked for.
   */
  dismissNow(): void {
    if (this.done) return;
    this.hide();
    this.destroy();
  }

  private destroy(): void {
    if (this.done) return;
    this.done = true;
    if (!this.win.isDestroyed()) this.win.destroy();
    this.leaveStack();
  }

  /**
   * Drop out of the stack and close the gap.
   *
   * A panel can leave from the MIDDLE — a dismiss, or the overflow eviction —
   * so the ones behind it have to move up. Without the restack they would
   * keep a hole where it was, which reads as a panel that failed to appear.
   */
  private leaveStack(): void {
    const at = panels.indexOf(this);
    if (at === -1) return;
    panels.splice(at, 1);
    restack();
  }

  /** Move to the place `index` in the stack says, keeping its current size. */
  moveToStackIndex(index: number): void {
    if (this.done || this.win.isDestroyed()) return;
    this.stackIndex = index;
    const { width, height } = this.win.getBounds();
    const { x, y } = stackPosition(index, this.corner, this.workArea(),
                                   { width, height }, CORNER_MARGIN);
    this.win.setBounds({ x, y, width, height });
  }
}

// Every export request goes through `ipcMain.handle("still:export", ...)`
// (`main.ts`), which is Electron-agnostic about WHICH window called it — the
// thumbnail's own preload reaches it the same way the main window's does.
// Nothing here duplicates that handler; see `app/src/still-io.ts`'s header.
