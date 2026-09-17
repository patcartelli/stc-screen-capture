import { app, BrowserWindow, screen } from "electron";
import { join } from "node:path";
import {
  positionFor, stackPosition, visibleCount, PANEL_SIZE, REDACT_SIZE,
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
 * Captures STACK, newest at the corner, up to `MAX_STACKED` VISIBLE. A panel
 * pushed past the cap is HIDDEN (`hideForOverflow`), never dismissed — Task
 * 5b (STC-392 D7) removed the eviction that used to destroy it. It stays
 * alive exactly where `capture-still` wrote it, reachable through the newest
 * panel's `+N` badge (`overflowHiddenCount`, below; clicking it is
 * `showAllOverflow`). Nothing about a hidden-for-overflow panel is a
 * decision — it still waits for one, same as a visible panel.
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
   * `panel:trash` handler in `main.ts`), and anything that can act on this
   * same window WHILE it is in flight — today, `restack` hiding it past the
   * cap (`hideForOverflow`, below; Task 5b changed this from a destroy to a
   * hide, but the race it could land inside is the same shape) — still needs
   * to hear about it first. `thumbnail.ts`'s module doc has the STC-392
   * update to the original race this closed.
   */
  | { kind: "discarding" }
  | { kind: "done" }
  /**
   * The `+N` badge was clicked (Task 5b / STC-392 D7) — bring every
   * overflow-hidden panel back on screen. Any panel can send this in
   * principle (`onEvent` is per-window), but only the newest ever carries a
   * nonzero badge (`restack` below), so in practice it is always that one.
   */
  | { kind: "showOverflow" };

/**
 * Every panel that exists, NEWEST FIRST — not just the visible ones.
 *
 * Was a single slot until stacking: a capture arriving while a panel was up
 * replaced it, destroying whatever it displaced. Stacking kept every panel
 * alive instead of settling the outgoing one; Task 5b (STC-392 D7) goes
 * further and keeps every panel alive PAST the visible cap too — this array
 * holds every panel from the newest down to whatever the badge is counting,
 * and `restack` is what decides which of them are actually on screen.
 */
let panels: ThumbnailSession[] = [];

/**
 * Put the panel on screen for a fresh capture, joining the stack in front of
 * whatever was already there.
 *
 * No eviction here any more (Task 5b / STC-392 D7) — every panel past the
 * cap is HIDDEN by `restack`, not settled or destroyed. `presentThumbnail`
 * calling `settleAndDestroy()`/`dismissNow()` on whatever it pushed past
 * `MAX_STACKED` was safe only under the OLD design, where a panel had a
 * default outcome (the timeout's export); STC-392 removed that default, so
 * the same eviction would destroy a take the user never decided on. A panel
 * destroyed here would be exactly that — the one thing this ticket exists to
 * make impossible.
 */
export function presentThumbnail(opts: PresentOptions): void {
  panels.unshift(new ThumbnailSession(opts));
  restack();
}

/**
 * Put every panel where its position in the stack says it belongs, and show
 * or hide it accordingly.
 *
 * Called whenever the list changes — a new capture, or one leaving the stack
 * from anywhere in it — because every panel's place (and whether it is
 * visible at all) is a function of the whole stack, not of where it happened
 * to start.
 *
 * Positions EVERY panel, hidden ones included: a panel hidden by the cap
 * today may be un-hidden by a later restack (something ahead of it closes,
 * or the badge is clicked), and it needs to already be where it belongs when
 * that happens rather than catching up a beat late.
 */
function restack(): void {
  // `visibleCount`, not a bare `i >= MAX_STACKED` comparison written twice —
  // this IS the production use of that helper (`thumbnail.ts` review, I6):
  // the number of panels this loop is about to leave shown is exactly what
  // `visibleCount` is defined to answer, so naming it here is the same
  // quantity, not a restatement of it.
  const visible = visibleCount(panels.length);
  panels.forEach((p, i) => {
    p.moveToStackIndex(i);
    // Past the cap: alive, hidden, reachable through the badge — never
    // settled, never destroyed. `thumbnail.ts`'s `MAX_STACKED` doc is the
    // rest of this reasoning.
    if (i >= visible) p.hideForOverflow(); else p.reshowFromOverflow();
  });
  // The newest panel carries the badge: it is the one on top and the one
  // with focus, so it is where a count of what is waiting belongs. Every
  // other panel's count is cleared — a panel that used to be newest and is
  // not any more must not go on showing a stale number.
  //
  // Counted from the panels THEMSELVES (`overflowHiddenCount`, below), not
  // recomputed from `thumbnail.ts`'s `hiddenCount(panels.length)` formula.
  // That formula is only true while the invariant this very loop just
  // enforced (index `< visible` ⇒ shown, `>=` ⇒ hidden) still holds —
  // `showAllOverflow` deliberately breaks it for a moment, and asking the
  // formula for the count in that moment would answer for an invariant that
  // is not currently true. Reading the panels' own flags back is correct
  // regardless of which function last touched them, which is what "one
  // source" has to mean here (STC-392 review, I1).
  panels.forEach((p, i) => p.setHiddenCount(i === 0 ? overflowHiddenCount() : 0));
}

/**
 * How many panels the overflow cap has ACTUALLY hidden right now, read from
 * the panels themselves rather than recomputed from a count and a constant.
 * See `restack`'s own doc for why the formula in `thumbnail.ts` cannot
 * stand in for this everywhere it might be asked.
 */
function overflowHiddenCount(): number {
  return panels.filter((p) => p.isOverflowHidden).length;
}

/**
 * Bring every overflow-hidden panel back on screen at once — the badge's
 * "clicking expands a list of waiting takes with the same actions" (Task 5b
 * / STC-392 D7).
 *
 * Not a second list UI: these ARE the waiting takes, already positioned by
 * `restack` (every panel is repositioned whether visible or not, including
 * hidden ones — see `restack`'s own doc), so showing them again is the whole
 * of "expanding the stack". `MAX_STACKED` itself is unchanged — the next
 * `restack` (a new capture, or any panel closing) re-applies the cap and
 * re-hides whatever is still past it.
 */
function showAllOverflow(): void {
  for (const p of panels) p.reshowFromOverflow();
  // Read back from the panels, exactly like `restack` does — this is 0
  // because the loop just above cleared every panel's flag, not because 0
  // was asserted independently of that fact (STC-392 review, I1).
  panels[0]?.setHiddenCount(overflowHiddenCount());
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
 *
 * `reshow` only lifts the CAPTURE reason a panel might be hidden for. A
 * panel also hidden by the overflow cap (`hideForOverflow`) stays hidden
 * regardless — two independent reasons, two independent flags, and this call
 * only ever clears one of them. A single shared "hidden" boolean would mean
 * this line un-hides an overflow panel the cap still wants hidden, which
 * would put it back in front of the NEXT capture too — the exact failure
 * `beforeCapture` exists to prevent, reintroduced by the very call meant to
 * undo it.
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

/**
 * Directories of every panel still showing a take nobody has saved
 * (STC-392 D8) — what Task 5c's quit warning counts and what "Save All"
 * promotes.
 *
 * Filtered to `origin: "fresh"` deliberately: a `library`-origin panel
 * (STC-294's reopen) is already on disk with nothing to promote — quitting
 * past it loses nothing, so it is not "unhandled" the way a take that exists
 * ONLY because this panel is open would be. Counting every open panel here
 * would warn on a quit that could not lose anything.
 */
export function unsavedTakeDirs(): string[] {
  return panels.filter((p) => p.take.origin === "fresh").map((p) => p.takeDir);
}

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
  /**
   * Two independent reasons a panel can be off screen, tracked SEPARATELY
   * (Task 5b / STC-392 D7). A capture hides every panel so it cannot appear
   * in its own screenshot (`beforeCapture`/`afterCapture`); the overflow cap
   * hides whatever `restack` pushes past `MAX_STACKED`. Either can be true
   * while the other is not — a panel mid-capture-hide can ALSO be past the
   * cap, and a panel past the cap can ALSO be caught by a capture starting.
   * Folding these into one boolean would mean lifting either reason un-hides
   * a panel the OTHER reason still wants hidden: `afterCapture`'s `reshow`
   * would un-hide an overflow panel, putting it back in the very next
   * capture's pixels — precisely the failure `beforeCapture` exists to
   * prevent, reintroduced by the call meant to undo it. `updateVisibility`
   * is the one place both are read; a panel is shown only when NEITHER is
   * set.
   */
  private hiddenForCapture = false;
  private hiddenForOverflow = false;
  /**
   * The last badge count `setHiddenCount` was given, kept even when it
   * cannot be DELIVERED yet. `restack` runs synchronously right after a new
   * panel is constructed — before `loadFile`'s page has run far enough to
   * register the `ipcRenderer.on` listener `onHiddenCount` sets up — so a
   * `webContents.send` that early would be lost the same way
   * `overlay-session.ts`'s `push` is deliberately deferred to
   * `ready-to-show` rather than sent at construction. The `painted` branch
   * of `onEvent` below re-sends this once it is safe to.
   */
  private hiddenCountValue = 0;
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
      // Deferred from `setHiddenCount` — see `hiddenCountValue`'s own doc for
      // why this could not simply be sent when it was first set.
      this.win.webContents.send("thumbnail:hiddenCount", this.hiddenCountValue);
      // STC-392 focus rule 1: "the panel takes focus when it appears." Only
      // when neither hide reason is set — a panel can in principle be pushed
      // past the cap before its own first paint lands (a burst arriving
      // faster than one page can load), and painting is not a reason to
      // override the cap. `updateVisibility` will show it (without focus)
      // once whichever reason applies is lifted.
      if (!this.hiddenForCapture && !this.hiddenForOverflow) {
        this.win.show();
        this.focusNow();
      }
    } else if (ev.kind === "redact") {
      this.resizeTo(ev.on ? REDACT_SIZE : PANEL_SIZE);
    } else if (ev.kind === "discarding") {
      // No-op today — see the `ThumbEvent` doc on this case. Kept as its own
      // branch, not folded into the default no-match, so the next thing that
      // needs to hear about a discard in flight has an obvious place to add
      // real logic rather than a new branch to discover.
    } else if (ev.kind === "showOverflow") {
      showAllOverflow();
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
   * Lift the CAPTURE hide reason. Does not itself take focus —
   * `afterCapture`'s caller decides which panel in the stack gets that
   * (focus rule 3), and it would be wrong for every reshown panel to grab
   * it.
   *
   * Clears the FLAG unconditionally, whether or not this panel has painted
   * yet — only the visual act of showing it waits on that (`updateVisibility`
   * no-ops before paint, and the `"painted"` branch of `onEvent` re-checks
   * both flags once it fires). A five-capture burst can call `hide()` on a
   * panel and then `afterCapture`'s `reshow()` on it again before its OWN
   * first paint has ever landed; gating the CLEAR on `hasPainted` — an
   * earlier version of this method did — left the flag stuck `true` forever,
   * because nothing calls `reshow` a second time once a capture cycle has
   * moved on. Caught by `panel-waits.e2e.test.ts`'s burst test hanging at 1
   * visible panel instead of `MAX_STACKED`.
   *
   * Does NOT show the window directly — `updateVisibility` does, and only if
   * `hiddenForOverflow` is ALSO clear. See `hiddenForCapture`'s own doc for
   * why the two reasons cannot share one flag.
   */
  reshow(): void {
    if (this.done || this.win.isDestroyed()) return;
    this.hiddenForCapture = false;
    this.updateVisibility();
  }

  /**
   * Push this panel past the visible cap (Task 5b / STC-392 D7) — alive,
   * hidden, reachable through the badge. Not gated on `hasPainted`: a panel
   * that has never shown itself is already invisible (`show: false` at
   * construction), so hiding it early costs nothing and saves a branch here
   * from having to reason about the two flags plus a third state.
   */
  hideForOverflow(): void {
    if (this.done || this.win.isDestroyed()) return;
    this.hiddenForOverflow = true;
    this.updateVisibility();
  }

  /**
   * Lift the OVERFLOW hide reason — this panel is back within `MAX_STACKED`,
   * or the badge was clicked. Clears the flag unconditionally, exactly like
   * `reshow` — see that method's doc for why gating the clear itself on
   * `hasPainted` is the bug rather than the safeguard it looks like.
   */
  reshowFromOverflow(): void {
    if (this.done || this.win.isDestroyed()) return;
    this.hiddenForOverflow = false;
    this.updateVisibility();
  }

  /**
   * Whether the overflow cap currently has this panel hidden — read-only,
   * for `overflowHiddenCount` (module scope, above) to total up. This is the
   * badge's real source of truth: the FLAG itself, not a formula that
   * assumes nothing has overridden it (STC-392 review, I1).
   */
  get isOverflowHidden(): boolean { return this.hiddenForOverflow; }

  /**
   * The one place both hide reasons are read together. Shown only when
   * NEITHER is set AND the panel has painted; hidden if EITHER reason is
   * set — an overflow-hidden panel mid a capture, or a capture-hidden panel
   * just pushed past the cap, both land here and both stay hidden. A no-op
   * before the first paint (`hasPainted` false) is deliberate: there is
   * nothing on screen yet to show, and the `"painted"` branch of `onEvent`
   * is what checks the flags again once there is.
   */
  private updateVisibility(): void {
    if (this.done || this.win.isDestroyed() || !this.hasPainted) return;
    if (this.hiddenForCapture || this.hiddenForOverflow) {
      if (this.win.isVisible()) this.win.hide();
    } else if (!this.win.isVisible()) {
      this.win.showInactive();
    }
  }

  /**
   * Tell this panel's card how many panels the overflow cap is hiding right
   * now — this method only carries the answer across the process boundary,
   * it does not compute one of its own. Callers (`restack`, `showAllOverflow`)
   * both derive that number from `overflowHiddenCount()`, which counts the
   * panels' own `isOverflowHidden` flags rather than re-deriving it from a
   * count and `MAX_STACKED` — see `restack`'s doc for why that formula is
   * not safe to use as a second way to ask (STC-392 review, I1). `restack`
   * calls this on every panel after every stack change, 0 for everything but
   * the newest.
   */
  setHiddenCount(n: number): void {
    if (this.done || this.win.isDestroyed()) return;
    // Remembered regardless of whether it can be delivered right now — see
    // `hiddenCountValue`'s own doc. Only actually sent once painted; a send
    // before the page has registered its `ipcRenderer.on` listener would be
    // silently lost, the same reason `overlay-session.ts`'s `push` waits for
    // `ready-to-show` rather than firing at construction.
    this.hiddenCountValue = n;
    if (this.hasPainted) this.win.webContents.send("thumbnail:hiddenCount", n);
  }

  /**
   * Give this panel the keyboard again, the same way it did when it first
   * painted (focus rule 3: the most recent panel gets focus back after a
   * capture). Refuses on one that has never painted, for the same reason
   * `reshow` does — there is nothing on screen yet to focus.
   *
   * Also refuses on either hide reason (STC-392 review, safe-guard note): a
   * panel that is not supposed to be ON SCREEN must not be handed the
   * keyboard either. Not reachable in practice today — the only caller,
   * `afterCapture`, calls `reshow()` on `panels[0]` in the very same pass
   * before this, and the newest panel (index 0) is never overflow-hidden —
   * so this changes no observed behaviour. It is here anyway because a
   * guard that holds only by call-site convention is one future caller away
   * from being silently wrong, and this one costs a single early return.
   */
  takeFocus(): void {
    if (this.done || this.win.isDestroyed() || !this.hasPainted) return;
    if (this.hiddenForCapture || this.hiddenForOverflow) return;
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

  /**
   * Sets the CAPTURE hide reason, hides the window and returns its
   * CGWindowID, for `beforeCapture`. Unconditional — hiding an already
   * overflow-hidden window is a no-op on the window itself, and the flag
   * still needs setting so a later `reshow` alone (without an intervening
   * `reshowFromOverflow`) correctly leaves it hidden.
   */
  hide(): number | undefined {
    if (this.done || this.win.isDestroyed()) return undefined;
    let id: number | undefined;
    try { id = windowIdOf(this.win.getMediaSourceId()); } catch { /* not available; hide still stands */ }
    this.hiddenForCapture = true;
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
   * What this panel is showing — `panel-actions.ts`'s own `PanelTake`,
   * handed back verbatim. `unsavedTakeDirs` (below) is the one reader: it
   * needs `origin` to tell a fresh capture from a reopened one, the same
   * distinction the constructor's own doc comment already explains.
   */
  get take(): PanelTake { return this.opts.take; }

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
   * A panel can leave from the MIDDLE — any of Save, Edit or Trash can be
   * performed on a panel that is not the newest — so the ones behind it have
   * to move up. Without the restack they would keep a hole where it was,
   * which reads as a panel that failed to appear. (The overflow cap no
   * longer removes anything from `panels` at all, as of Task 5b — it only
   * hides; this restack is purely about a panel actually CLOSING.)
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
