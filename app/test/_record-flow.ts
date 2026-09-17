import type { ElectronApplication, Page } from "playwright";

/**
 * The real Record flow, end to end through the overlay and its options bar
 * (STC-388, task 6b).
 *
 * Task 6 made scope a per-take choice: `#record` now opens the same selection
 * overlay `#capturestill` already uses, instead of starting a recording on
 * the spot, and only the bar's own Record control — pressed after a scope is
 * confirmed — ever calls `startRecording`. Four E2E files press Record only
 * to get a take RUNNING so they can test something else (the countdown panel,
 * the camera toggle, the display picker, quitting mid-take), and all four
 * hung the identical way once that landed: `win.click("#record")` then
 * nothing, because the countdown they were waiting for now sits behind an
 * overlay pick and a bar press nobody was making.
 *
 * Each of those files could have driven the overlay for itself, the way
 * `still-overlay.e2e.test.ts` already does. That would mean the camera toggle
 * and the display picker tests — which have nothing to do with the options
 * bar — depend on its geometry and control ids, so a bar layout change would
 * break tests about the camera and the pill along with it. One helper here
 * keeps the real path and gives it a single owner: a bar change breaks this
 * file, not five.
 *
 * ## The seam
 *
 * The same one `still-overlay.e2e.test.ts` already uses, for the same reason
 * recorded in `overlay.ts`'s own header: every caller here sets
 * `STC_OVERLAY_SYNTHETIC_INPUT=1` (they already needed it for the overlay to
 * exist at all under Xvfb — see `overlay-session.ts`), which stops the
 * overlay's real DOM listeners from ever installing, so `window.overlay.send`
 * — the exact `overlay:event` message those listeners would otherwise have
 * produced — is the only input the window sees. A second way of driving the
 * overlay (real coordinates dispatched over the bar's own drawn geometry, say)
 * would be exactly the flake `overlay.ts`'s header already records paying for
 * once, this time over the bar instead of the marquee.
 *
 * The bar's own controls are pressed the same way: `{ t: "control", id }` is
 * what `overlay.ts`'s real pointerdown handler sends once it has hit-tested a
 * press against `record-options.ts`'s `controlAt`, so sending it directly
 * skips the hit-test, not the decision — `OverlaySession.onControl` cannot
 * tell the two apart.
 *
 * ## What this does NOT do
 *
 * It stops the instant the bar's Record control has been sent — before any
 * countdown window exists and before `startRecording` is ever called.
 * `countdown.e2e.test.ts` needs to look at the countdown itself, including
 * Escape cancelling it, so baking "wait for the recording to start" in here
 * would make that file unable to use this at all. The other three callers
 * want the take to actually begin and poll for that themselves, exactly as
 * they did before this ticket, against whatever their own countdown setting
 * (`_countdown-fixture.ts`) leaves in the way.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function send(overlay: Page, event: unknown): Promise<void> {
  await overlay.evaluate((e) => (window as any).overlay.send(e), event);
}

/**
 * The overlay window, once it is up. Identified by its URL, same as every
 * other file that drives it — the main window is also in `app.windows()`, and
 * on a machine with more than one display so would be a second overlay.
 */
async function overlayWindow(app: ElectronApplication, ms: number): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app.windows()) {
      if (p.url().includes("overlay.html")) return p;
    }
    if (Date.now() - start > ms) {
      throw new Error(`no overlay window appeared within ${ms}ms; windows: ` +
                      JSON.stringify(app.windows().map((p) => p.url())));
    }
    await sleep(50);
  }
}

/**
 * Wait until a drag has produced a selection Enter would actually confirm.
 *
 * `#size` is drawn from `confirm()`'s own result (overlay.ts), so text in
 * that chip IS the precondition Return needs — `still-overlay.e2e.test.ts`
 * found what happens without this check: `reduce` treats an unconfirmable
 * Return as a no-op, the overlay hangs open, and the caller's promise never
 * settles. The failure message carries the overlay's own state rather than
 * leaving the next reader to guess why.
 */
async function awaitConfirmable(overlay: Page, ms: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if ((await overlay.textContent("#size"))?.trim()) return;
    if (Date.now() - start > ms) {
      const seen = await overlay.evaluate(() => JSON.stringify((window as any).__overlayState ?? null));
      throw new Error(
        `the drag never produced a confirmable selection within ${ms}ms — ` +
        `Return would be a no-op and the overlay would hang. Overlay state: ${seen}`);
    }
    await sleep(50);
  }
}

/**
 * Wait until the options bar is actually live.
 *
 * `#bar`'s `hidden` IDL property is exactly `OverlaySession`'s own
 * `phase === "options"`, mirrored on every state push by `overlay.ts`'s
 * `renderBar()` — so this is the one true signal that a
 * `{ t: "control", id: "record" }` sent right now will not be silently
 * dropped by `onControl`'s own `if (this.phase !== "options") return;` guard.
 *
 * Deliberately NOT `isVisible`: `#bar { display: flex; ... }` is an ID
 * selector, which beats the UA `[hidden] { display: none }` rule regardless
 * of the attribute, so a visibility check on this element would read the same
 * whether the bar is live or not — a CSS quirk this helper works around
 * rather than depends on. The DOM `hidden` property is unaffected by it and
 * is the actual thing `overlay.ts` sets.
 */
async function awaitOptionsBar(overlay: Page, ms: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if ((await overlay.getAttribute("#bar", "hidden")) === null) return;
    if (Date.now() - start > ms) {
      const seen = await overlay.evaluate(() => JSON.stringify((window as any).__overlayState ?? null));
      throw new Error(`the options bar never appeared within ${ms}ms. Overlay state: ${seen}`);
    }
    await sleep(50);
  }
}

export interface RecordFlowOptions {
  /**
   * Pick a window instead of dragging a region: Space to enter window mode,
   * then a press at this GLOBAL point. A press over a fully-visible window
   * resolves the outcome immediately (selection.ts) — the same shape
   * `still-overlay.e2e.test.ts`'s own window-mode test drives.
   *
   * Fixed as of STC-388's follow-up: `OverlaySession.push()` used to derive
   * the options bar's layout from `state.rect` alone (`barLayout` in
   * record-options.ts), and a window-mode outcome never sets one —
   * `selection.ts`'s `reduce`/`confirm` attach only a bare `windowId` for
   * that kind, so the bar's `hidden` attribute never cleared and
   * `awaitOptionsBar` below timed out. `push()` now derives the bar's ANCHOR
   * from the pending outcome (`anchorRectFor`, overlay-session.ts) — the
   * picked window's own bounds in window mode, the live marquee in region
   * mode — so this path works the same as the region one below.
   */
  windowAt?: { x: number; y: number };
  /**
   * The region to drag, in GLOBAL points, when `windowAt` is not given.
   * Defaults to a 200x100 rect comfortably inside the primary display, the
   * same shape `still-overlay.e2e.test.ts` uses for its own region drag.
   */
  region?: { from: { x: number; y: number }; to: { x: number; y: number } };
  /**
   * Press the bar's own `expand` control once it is up, so the take covers
   * the whole display the drag landed on rather than the dragged rect.
   * Ignored with `windowAt` — expand only makes sense for a display take.
   */
  fullDisplay?: boolean;
  /**
   * How long to wait for each stage (the overlay appearing, a confirmable
   * drag, the bar appearing) — not the enclosing test's own timeout.
   */
  stepTimeoutMs?: number;
}

/**
 * Click the main window's Record button and drive the real overlay all the
 * way to the options bar's own Record control — the same path a real click
 * through `runRecordFlow` (main.ts) takes, up to (never past) any countdown
 * or the take actually starting.
 */
export async function startRecordFlow(
  app: ElectronApplication, win: Page, opts: RecordFlowOptions = {},
): Promise<void> {
  const ms = opts.stepTimeoutMs ?? 15_000;
  await win.click("#record");
  const overlay = await overlayWindow(app, ms);

  if (opts.windowAt) {
    await send(overlay, { t: "key", key: " " });
    await send(overlay, { t: "pointermove", at: opts.windowAt });
    await send(overlay, { t: "pointerdown", at: opts.windowAt });
  } else {
    const bounds = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    const region = opts.region ?? {
      from: { x: bounds.x + 100, y: bounds.y + 80 },
      to: { x: bounds.x + 300, y: bounds.y + 180 },
    };
    await send(overlay, { t: "pointerdown", at: region.from });
    await send(overlay, { t: "pointermove", at: region.to });
    await send(overlay, { t: "pointerup", at: region.to });
    await awaitConfirmable(overlay, ms);
    await send(overlay, { t: "key", key: "Enter" });
  }

  await awaitOptionsBar(overlay, ms);
  if (opts.fullDisplay && !opts.windowAt) await send(overlay, { t: "control", id: "expand" });
  await send(overlay, { t: "control", id: "record" });
}
