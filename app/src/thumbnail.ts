/**
 * The post-capture floating thumbnail's decisions (STC-296), with no DOM and no
 * Electron.
 *
 * Same split the rest of this project uses for a windowed interaction
 * (`selection.ts` / `overlay-session.ts`, `still-decorate.ts` / `still-render.ts`):
 * what the panel IS at any moment — `idle` or `open` — lives here and is
 * exercised by `app/test/thumbnail.test.ts` with no window and no clock.
 * `app/src/thumbnail-window.ts` owns the real `BrowserWindow`; it asks this
 * module what that means.
 *
 * This is STC-343, the third study in STC-338's series (scrubber → selection
 * overlay handles → floating thumbnail motion → take library). STC-296 shipped
 * the panel, the right-click menu, swipe-to-discard, true drag-out and
 * stacking across several passes; this study is what STC-342 was for the
 * selection overlay — writing the vocabulary down in one place, and a careful
 * adversarial pass over the motion math that shipped believing it correct.
 * That pass found one real defect: rule 6 below.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE RULES
 * ════════════════════════════════════════════════════════════════════════
 *
 * **1–3 (STC-343, superseded by STC-392). There is no clock in this module any
 * more.** The original three rules here described a `showing` state with an
 * `expiresAt`, a `now` parameter threaded through `show`/`isExpired` so the
 * timeout could be replayed in a test, and a floor (`clampTimeoutMs`)
 * enforced on every read of a stored preference. STC-392 reverses the
 * ticket's own premise — "the panel never closes on its own" — so all three
 * are gone rather than kept and disabled: a clock nobody can see is worse
 * than no clock. See the doc on `ThumbnailState` for what replaced them.
 *
 * **4. Multiple captures STACK, newest at the corner — and a stack of one is
 * not a separate calculation from a lone panel.** `stackLayout(...)[0]` IS
 * `positionFor(...)`, so the single-panel case cannot drift from the stacked
 * one; it is the same formula asked for the first size in the list. "Drains
 * oldest-first on timeout" (STC-296's original wording) no longer applies
 * post-STC-392 — and
 * as of Task 5b (STC-392 D7), a stack over `MAX_STACKED` no longer evicts
 * anything either. The panels past the cap stay alive, only HIDDEN, and
 * `hiddenCount` is how many of them there are — see `thumbnail-window.ts`'s
 * `restack`, which hides and reshows rather than destroying.
 *
 * **5. Only ONE gesture destroys a capture, and it needs the corner to mean
 * anything.** A swipe toward the panel's OWN corner discards; the same delta
 * from the opposite corner does nothing — `discardDirection` is what makes
 * "the direction that throws it away is the direction you can see it
 * leaving" true rather than a coincidence. It is also what tells a discard
 * apart from a drag-out (rule 7): one pointer gesture, and nothing but its
 * direction to choose between the two outcomes.
 *
 * **6. A discard must never race the panel's own timeout, and asking it not
 * to is not enough — it has to be TOLD.** The trash is an async round trip;
 * the timer that can settle-and-hide the very same panel lives in a
 * different process and has no way to know a discard is already in flight.
 * Before this rule was enforced, a timeout landing in that gap would hide
 * the window, and a delete that then FAILED would strand its own recovery —
 * the renderer restoring the panel and reporting the error — inside a
 * window main had already hidden, headed for a silent destroy at
 * `SETTLE_BACKSTOP_MS` regardless. The fix, as first built for STC-343, was a
 * `discarding` event sent as the FIRST thing the (then only) trash path —
 * `discard()` — did, before anything async: found reviewing this module for
 * the study, the same shape of defect as the scrubber's rubber-band sign bug
 * and the selection overlay's resize floor — a real gap neither the panel's
 * own tests nor its window's could see, because proving it needs a live race
 * no deterministic test can reliably produce.
 *
 * (STC-392: the panel's own TIMEOUT is gone, so the ORIGINAL race — against a
 * timer — cannot recur in the form found here. **The event also moved**:
 * STC-392 collapsed the four ways to trash a take (the ✕ button, ⌘⌫, the
 * context menu, and the swipe's `discard()`) onto ONE function,
 * `thumbnail-renderer.ts`'s `run()`, and the `discarding` send moved WITH the
 * trash logic into `run`'s trash branch — `discard()` itself no longer sends
 * it; it delegates to `perform("trash")`, which reaches `run`. That is what
 * gives all four gestures the same head start rather than only the swipe
 * having one. The event stays regardless — a discard still races anything
 * else that can hide or destroy the window asynchronously, which today means
 * the overflow eviction above `MAX_STACKED` and the app quitting, not a
 * clock. `thumbnail-discard-race.test.ts` pins the current source properties
 * — ordering inside `run()`, and that `discard()` itself no longer sends the
 * event — rather than reproducing the race live.)
 *
 * **7. Drag-out commits SOONER than discard, on purpose.** `DRAG_START_PX`
 * (12) is well under `SWIPE_DISCARD_PX` (90): a drag-out handed to a
 * cancellable OS drag costs nothing if dropped on nothing, while a discard
 * destroys something, so the cheap-to-undo gesture is the one that fires
 * first. The gap between them is load-bearing, not slack — committing to a
 * drag-out any sooner would let the OS take the pointer before a swipe
 * could ever reach the discard threshold, making the two features look
 * built while one had silently made the other unreachable.
 *
 * **8. A successful drag-out does not end the panel's lifecycle.** Electron's
 * `startDrag` hands a file to the window server and gives the caller no
 * signal back — no "the drop landed", no "it was cancelled" — so there is
 * nothing to hook a dismissal to. The panel is left exactly as it was: still
 * showing, still counting down its own timeout. This is not an oversight;
 * it is the one honest answer available, and it costs nothing new — "nothing
 * is lost by doing nothing" already covers whatever happens next, since an
 * untouched panel settles and exports per its own default regardless of
 * whether a drag also happened.
 *
 * **9. Every position comes from the display's WORK AREA, never its full
 * bounds.** The work area excludes the menu bar and the Dock; a borderless
 * always-on-top panel landing partly under either on first launch would read
 * as a bug rather than as the one pixel someone forgot.
 *
 * **10. Growing or shrinking in place stays anchored to the panel's OWN
 * corner, whatever size it grows to.** Redact resizes the window and then
 * asks `thumbnail-window.ts`'s `restack` to lay the whole column out again
 * from `stackLayout`, never `positionFor` alone — a panel mid-stack that grew
 * by jumping to the bare corner would abandon the place in the stack it was
 * shown at, and one that grew by moving its origin would walk off the edge
 * it is anchored to. Reflowing the WHOLE group rather than resizing in place
 * is what STC-426 added: the neighbours below a growing panel have to move
 * to make room for it, not just sit under wherever it now ends.
 */

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

export const DEFAULT_CORNER: Corner = "bottom-right";

/** A corner named in a stored preference or a hand-edited file; anything else is the default. */
export function parseCorner(v: unknown): Corner {
  return typeof v === "string" && (CORNERS as readonly string[]).includes(v) ? v as Corner : DEFAULT_CORNER;
}

/**
 * How long `run("copy")` waits for the panel's FIRST composite before giving
 * up (`thumbnail-renderer.ts`'s `awaitComposite`) — Copy is the one action
 * that reads `composite` directly (`runExport`); Save, Edit and Trash never
 * touch it.
 *
 * In practice this never actually waits: `draw()` is awaited, and only then
 * is the panel shown and its buttons made reachable (focus rule 1's
 * `"painted"` event fires after it) — a silent panel's own auto-copy is the
 * same order, since it runs after the same `await draw()` — so a Copy cannot
 * land before the composite exists. It is a bound anyway rather than a bare
 * `if (!composite) return false`, because "cannot happen today" is a claim
 * about the current wiring, not a proof — every wait in this codebase needs
 * a bound and a reason (CLAUDE.md), and the reason here is that nothing
 * re-verifies the ordering above every time this file changes. Kept aligned
 * with `SETTLE_BACKSTOP_MS` in `thumbnail-window.ts` — reserved the same
 * way, not currently armed by anything — because `app/test/
 * thumbnail-bounds.test.ts` asserts the clearance between the two numbers
 * rather than leaving it true by luck, so they cannot drift apart silently
 * before either is wired back up.
 */
export const SETTLE_READY_MS = 10_000;

/**
 * The panel's own state machine, after STC-392: two states, and only a person
 * moves between them.
 *
 * It used to be three — `idle` → `showing` → `expanded` — with a deadline on
 * `showing` and `isExpired` as a second way out. STC-392 reverses that: "the
 * panel never closes on its own. It waits for you to choose an action." A
 * state machine with a clock in it could not express that, so the clock is
 * gone rather than set to infinity, which would have left a timeout nobody
 * could see and everybody would have had to reason about.
 *
 * The expand door went with it (D3). It existed to keep controls out of the
 * way until the timeout had passed; with nothing to pass, a panel that waits
 * forever while showing no buttons is the weaker reading of "waits for you to
 * choose an action".
 */
export type ThumbnailState = { kind: "idle" } | { kind: "open" };

export function initialState(): ThumbnailState { return { kind: "idle" }; }

/** A capture arrived. There is no second argument any more; there is no clock. */
export function show(): ThumbnailState { return { kind: "open" }; }

/**
 * Back to nothing on screen. Reached only by an action the user chose — Save,
 * Edit or Trash — or by the app shutting down. Idempotent, the same rule
 * `overlay-session.ts`'s `finish` follows.
 */
export function dismiss(): ThumbnailState { return { kind: "idle" }; }

// ── stacking ────────────────────────────────────────────────────────────────

/**
 * More than one capture on screen at once (STC-296's "multiple captures in
 * quick succession stack rather than replacing each other").
 *
 * ## The newest panel takes the corner
 *
 * Index 0 is the newest, sitting exactly where a single panel would; older
 * ones are pushed INWARD along the vertical axis. Someone who has just
 * pressed the shortcut looks at the corner, and finding their newest shot
 * anywhere else would make the stack a puzzle rather than a record.
 *
 * ## "Drains oldest-first on timeout" is gone with the timeout (STC-392)
 *
 * The ticket asked for it and it used to be free: each session armed its own
 * timer when it painted, so panels that appeared in order expired in order,
 * with no queue needed. There is no timer left to do that ordering FOR —
 * nothing drains on its own any more.
 *
 * ## Past the cap, a panel is HIDDEN, never destroyed (STC-392 D7 / Task 5b)
 *
 * `presentThumbnail` used to call `settleAndDestroy()` — later `dismissNow()`
 * — on whatever a burst of captures pushed past `MAX_STACKED`. That was safe
 * only under the OLD design, where a panel had a default outcome: it timed
 * out, exported the shot, and closed. STC-392 removed the default outcome, so
 * the same eviction would destroy a take nobody had decided on — a capture
 * silently lost, which is the one thing this whole ticket exists to prevent.
 * "Nothing is dropped, only hidden" is that correctness property applied to a
 * burst rather than to a single panel: `thumbnail-window.ts`'s `restack`
 * hides everything at index `MAX_STACKED` or past it and reshows everything
 * before it, so `panels` staying ordered newest-first is what makes "the
 * newest three are visible" and "the rest are one `hiddenCount` away from
 * being visible again" the same fact read two ways.
 *
 * A `silent` (skip-the-panel) capture is never part of this count at all
 * (STC-426) — `thumbnail-window.ts`'s `isStacked` excludes it before either
 * `visibleCount` or `stackLayout` ever sees the list. It never paints and
 * never occupies a slot, so counting it toward the cap would mean a
 * screenshot nobody will ever see could push a REAL one into hiding — the
 * cap is a screen-space budget, and an invisible window spends none.
 *
 * ## Older previews use their FULL height, not a 26px sliver (STC-426)
 *
 * The original stack (`stackPosition`, now gone) overlapped every panel but
 * the newest, showing only a thin strip of each one behind it — legible as
 * "something is waiting", not as a picture. `stackLayout` gives every VISIBLE
 * panel its own full-height slot, `STACK_GAP_PX` apart, still newest nearest
 * the corner and older ones pushed further in. A short display cannot always
 * fit `MAX_STACKED` panels in one column — three `PANEL_SIZE` cards already
 * come close on a 900pt-tall work area — so a panel that would run past the
 * work area's bottom (or top, from a top corner) starts a new column further
 * into the screen instead of running off the edge. It is recomputed from
 * scratch on every call from each PANEL'S OWN CURRENT SIZE — a function of
 * every panel's size rather than one shared constant, on purpose: Redact used
 * to grow one panel into a bigger size in place, and while STC-300 moved that
 * elsewhere, "closing the middle preview closes the gap" needs no less than
 * this to be true — there is no stored offset to update, only a fresh layout
 * of whatever list of sizes is handed in.
 */

/** Space between neighbouring previews in the vertical stack, in points (STC-426). */
export const STACK_GAP_PX = 12;

/**
 * How many panels may be VISIBLE at once, newest on top.
 *
 * Three (STC-392 D7 / Task 5b, down from the original five). The number was
 * never the point — "five captures in five seconds" was STC-296's acceptance
 * case for a design where the panel pushed out settled itself, so a bigger
 * cap cost nothing but screen space. That is not what this constant is
 * bounding any more: this ticket's own text is "max 3 panels visible", and
 * the reason a cap exists at all is unchanged — the panels are
 * always-on-top, and an unbounded stack would wall off the screen during a
 * burst. Nothing PAST the cap is lost, and that is the load-bearing half:
 * `thumbnail-window.ts`'s `restack` HIDES a panel at index `MAX_STACKED` or
 * beyond rather than destroying it, and it stays reachable through the
 * `hiddenCount` badge on the front panel. A panel is only ever torn down by a
 * decided action (Save, Edit, Trash) or the app quitting — never by this cap.
 *
 * `total`, below, is the count of STACKED panels (STC-426) — a `silent`
 * capture is never one of the panels this cap is budgeting screen space for,
 * so `thumbnail-window.ts` passes it the length of the list with silent
 * panels already filtered out, not `panels.length`.
 */
export const MAX_STACKED = 3;

/**
 * How many of `total` panels the cap leaves VISIBLE — never more than
 * `MAX_STACKED`, never negative.
 *
 * The counterpart to `hiddenCount`, kept beside it so the two cannot drift:
 * `visibleCount(n) + hiddenCount(n) === n` for every `n`, asserted in
 * `thumbnail.test.ts`.
 */
export function visibleCount(total: number): number {
  return Math.min(total, MAX_STACKED);
}

/**
 * How many of `total` panels the cap SHOULD leave HIDDEN, by the ticket's own
 * arithmetic — the badge's number whenever `restack`'s own invariant holds
 * (every panel below `visibleCount(total)` shown, every one at or past it
 * hidden).
 *
 * This is NOT what the running app reads to fill the badge (STC-392 review,
 * I1 — an earlier version of this doc claimed it was, and that claim went
 * stale the moment `showAllOverflow` existed: expanding the stack un-hides
 * everything while `total` stays the same, which this formula cannot see).
 * `thumbnail-window.ts`'s `restack`/`showAllOverflow` read the panels'
 * own `isOverflowHidden` flags instead (`overflowHiddenCount`), which is
 * correct in both states. This function is the pure, deterministic
 * definition of what those flags should add up to whenever the cap alone is
 * deciding — asserted directly in `thumbnail.test.ts`, and useful there
 * precisely because nothing here needs a window to check.
 */
export function hiddenCount(total: number): number {
  return Math.max(0, total - MAX_STACKED);
}

/**
 * Where every VISIBLE panel sits, newest (index 0) first, each at its own
 * FULL size rather than the old fixed-offset overlap (STC-426).
 *
 * `bounds[0]` is exactly `positionFor(corner, workArea, sizes[0], margin)` —
 * a stack of one cannot drift from the stacked case because it is not a
 * separate calculation, the same guarantee the old `stackPosition(0, ...)`
 * made. Each later panel is placed `STACK_GAP_PX` past the bottom (or top,
 * from a top corner) of the one before it in the SAME column, using that
 * panel's own size — a bigger card ahead of it pushes everything behind it
 * down (or up) by the difference, and shrinking it pulls them back.
 *
 * When the next panel would run past the work area's far edge, a new column
 * starts `STACK_GAP_PX` beyond the widest panel seen in the column so far,
 * back at the corner's own margin — the short-display case `docs/
 * STC-426-RUNBOOK.md` calls out, and the reason this takes every panel's
 * SIZE rather than one shared size: a column fits more cards at `PANEL_SIZE`
 * than it would of anything bigger.
 *
 * Deliberately stateless: called fresh on every stack change with whatever
 * sizes are visible right now, so there is no stored offset that removing or
 * resizing a panel could leave stale — `thumbnail-window.ts`'s `restack` is
 * the only caller that needs to reason about what changed.
 */
export function stackLayout(sizes: readonly Size[], corner: Corner, workArea: Bounds,
                            margin = 20): Bounds[] {
  let vertical = 0;
  let horizontal = 0;
  let columnWidth = 0;
  const sign = corner.startsWith("top") ? 1 : -1;
  const columnSign = corner.endsWith("left") ? 1 : -1;
  return sizes.map((size) => {
    // Only wrap once something is already in the column — the first panel in
    // any column, however tall, must still get a slot rather than looping
    // forever.
    if (vertical > 0 && vertical + size.height > workArea.height - 2 * margin) {
      horizontal += columnWidth + STACK_GAP_PX;
      vertical = 0;
      columnWidth = 0;
    }
    const base = positionFor(corner, workArea, size, margin);
    const bounds: Bounds = {
      ...size,
      x: base.x + horizontal * columnSign,
      y: base.y + vertical * sign,
    };
    vertical += size.height + STACK_GAP_PX;
    columnWidth = Math.max(columnWidth, size.width);
    return bounds;
  });
}

// ── swipe to discard ────────────────────────────────────────────────────────

/**
 * Throwing the shot away by pushing the panel off the screen (STC-296's
 * "swipe the panel off-screen to discard the shot entirely").
 *
 * ## Why the corner decides the direction
 *
 * The panel sits in a corner, so only ONE horizontal direction takes it off
 * the screen — right from a right-hand corner, left from a left-hand one.
 * Accepting either direction would mean a shot could be destroyed by a drag
 * that visibly moved it further INTO the screen, which reads as a bug however
 * it is documented. It also makes the gesture self-describing: the panel
 * follows the pointer, and the direction that makes it leave is the one where
 * you can see it leaving.
 *
 * ## The same gesture also starts a drag-out, and direction is what tells them apart
 *
 * A drag toward the near edge discards; a drag ANY OTHER WAY hands the file to
 * whatever it is dropped on (`classifyDrag`). One pointer gesture, two
 * outcomes, and nothing but its direction to choose between them — which is
 * the arrangement macOS's own screenshot thumbnail uses, and the reason the
 * corner had to be in this decision from the start rather than being added
 * for the second feature.
 *
 * It also means the two can never both fire: `classifyDrag` returns ONE
 * answer, so a drag cannot discard a shot it has just handed to Finder.
 *
 * ## Why discarding is not the same risk as it looks
 *
 * This is the only gesture in the panel that destroys a capture, in a feature
 * whose stated principle is "nothing is ever lost by doing nothing". Doing
 * nothing still saves; this is doing SOMETHING, deliberately, and it goes to
 * the Trash exactly like the right-click Delete it shares its semantics with.
 * Two ways to throw a shot away that disagreed about where it went would be
 * the defect, not the second gesture.
 */

/** Which way is off-screen from a given corner: -1 is left, +1 is right. */
export function discardDirection(corner: Corner): -1 | 1 {
  return corner.endsWith("left") ? -1 : 1;
}

/**
 * How far the panel must travel along that direction before releasing throws
 * the shot away.
 *
 * 90 px against a 220 px collapsed panel — a little under half its own width,
 * so the panel is visibly on its way out before the threshold is met. Below
 * about a third it starts to compete with the click that expands the panel,
 * which is the gesture immediately next to this one in the same pixels.
 */
export const SWIPE_DISCARD_PX = 90;

/**
 * A drag has to be predominantly horizontal to count.
 *
 * Without this a slow diagonal drag reaches the distance eventually and
 * destroys a capture the user was not aiming at. `>` rather than `>=` so a
 * perfect 45° diagonal — genuinely ambiguous — does not discard.
 */
export function isHorizontal(dx: number, dy: number): boolean {
  return Math.abs(dx) > Math.abs(dy);
}

/**
 * How far the panel should be DRAWN from its resting place, in pixels.
 *
 * Only ever along the discard direction: a drag the wrong way returns 0, so
 * the panel does not budge and the gesture reads as "that is not a thing you
 * can do here" without needing to be told. Vertical movement never displaces
 * it either — this panel leaves sideways or not at all.
 */
export function swipeOffset(dx: number, dy: number, corner: Corner): number {
  if (!isHorizontal(dx, dy)) return 0;
  const along = dx * discardDirection(corner);
  return along > 0 ? along : 0;
}

/**
 * Whether releasing here throws the shot away.
 *
 * Deliberately a function of the WHOLE gesture (its total delta), not of
 * velocity: a flick and a slow shove both mean the same thing, and a velocity
 * threshold would make the panel's behaviour depend on how fast the machine
 * happened to deliver pointer events — which on a loaded machine is the same
 * class of defect as every timing-dependent test in this repo.
 */
export function isDiscardSwipe(dx: number, dy: number, corner: Corner): boolean {
  return swipeOffset(dx, dy, corner) >= SWIPE_DISCARD_PX;
}

/**
 * What a drag on the collapsed panel MEANS.
 *
 * `none` while it is still small enough to be a click — the panel expands on
 * click, and that gesture lives in these same pixels, so nothing may commit
 * until the pointer has clearly left. `discard` toward the near edge.
 * `drag-out` any other way, which is where the OS takes over.
 *
 * Note the asymmetry, and that it is deliberate: `discard` needs
 * `SWIPE_DISCARD_PX` of travel because it destroys something, while
 * `drag-out` commits at `DRAG_START_PX` because the OS drag it starts is
 * itself cancellable — dropping on nothing does nothing. The cheap-to-undo
 * gesture is the easy one to reach.
 */
export type DragIntent = "none" | "discard" | "drag-out";

/**
 * How far the pointer must move before a drag-out is a drag rather than a
 * click that wobbled. Below this the panel still expands on release.
 */
export const DRAG_START_PX = 12;

export function classifyDrag(dx: number, dy: number, corner: Corner): DragIntent {
  const toward = dx * discardDirection(corner);
  // The discard axis first: a long horizontal push toward the edge is the one
  // gesture that must not be mistaken for anything else.
  if (isHorizontal(dx, dy) && toward >= SWIPE_DISCARD_PX) return "discard";
  if (Math.hypot(dx, dy) < DRAG_START_PX) return "none";
  // Still travelling toward the edge, just not far enough yet. Committing to
  // a drag-out here would make the discard unreachable: the OS would take the
  // pointer at 12 px and the swipe could never reach 90.
  if (isHorizontal(dx, dy) && toward > 0) return "none";
  return "drag-out";
}

export interface Size { width: number; height: number }
export interface Bounds { x: number; y: number; width: number; height: number }

/**
 * The one size the card is (D3).
 *
 * Wider and taller than the old 220×150 collapsed thumbnail, because the
 * actions are on it from the moment it appears rather than behind a click.
 * `app/test/thumbnail.test.ts` asserts a full stack of FIVE of these still
 * fits a 1440×900 work area — the old test measured the collapsed size and
 * would have stayed green while the real card ran off the bottom.
 */
export const PANEL_SIZE: Size = { width: 260, height: 210 };

// Redact used to grow this same panel in place at a bigger WINDOW size
// (`REDACT_SIZE`, STC-297) — "it is still the same panel in the same corner,
// the still EDITOR is STC-300 and this stops well short of one." STC-300
// disagreed once its own gate fired and moved Redact into a real editor
// window instead (`still-editor-window.ts`); the panel is fixed at
// `PANEL_SIZE` for its whole life now.

/**
 * Where the panel sits within a display's WORK AREA (not its full bounds) —
 * work area excludes the menu bar and the Dock, and a "borderless always-on-top
 * panel in a configurable corner" landing partly under the menu bar would read
 * as a bug on the first launch.
 */
export function positionFor(corner: Corner, workArea: Bounds, size: Size, margin = 20): { x: number; y: number } {
  const x = corner.endsWith("left") ? workArea.x + margin
    : workArea.x + workArea.width - size.width - margin;
  const y = corner.startsWith("top") ? workArea.y + margin
    : workArea.y + workArea.height - size.height - margin;
  return { x: Math.round(x), y: Math.round(y) };
}
