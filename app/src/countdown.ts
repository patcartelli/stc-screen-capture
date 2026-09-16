/**
 * The countdown's decisions (STC-391) — no DOM, no Electron, no timer.
 *
 * ONE countdown surface with two ways in: Record always counts down, and a
 * still capture counts down only when it was started with the self-timer.
 * Everything that DECIDES — how long, what number is on screen, what a
 * keystroke means, what the caption says, and whether the thing being waited
 * for should then happen at all — lives here. `countdown-window.ts` owns the
 * real `BrowserWindow` and the real clock; `app/renderer/countdown.html` draws
 * what this decides. Same split `selection.ts`/`overlay-session.ts` and
 * `pill.ts`/`pill-window.ts` already use.
 *
 * ## The rules
 *
 * 1. **A countdown is a DURATION, not a tick count.** What it promises is
 *    "you have three seconds", not "three repaints" — so every decision here
 *    takes milliseconds remaining and the view may sample them as often or as
 *    rarely as it likes. A slow frame shortens no countdown.
 *
 * 2. **The number on screen is `ceil(remaining / 1000)`, and it is never 0.**
 *    Counting down reads 3, 2, 1 and then the thing happens; a 0 on screen is
 *    a promise that has already been kept, and the frame that would show it is
 *    the frame the capture fires on. `countdownLabel` clamps at 1 rather than
 *    letting a last-tick rounding race paint a zero.
 *
 * 3. **Escape cancels, Return skips, and a modifier chord is neither.** Both
 *    are the ticket's own requirements; the chord rule is `scrubber.ts`'s rule
 *    8 met again — ⌘Return belongs to whatever else the app binds, and a
 *    countdown that swallowed it would be a global key grab with a 3-second
 *    fuse.
 *
 * 4. **Skip is not "cancel that fires".** `skipped` and `elapsed` are separate
 *    outcomes that both proceed, because they are separate things that
 *    happened, and a single boolean would lose which. `countdownFired` is the
 *    one place that maps an outcome onto "so does the capture happen", so no
 *    caller compares outcome strings itself.
 *
 * 5. **Reduced motion removes the ANIMATION, not the count.** The ticket asks
 *    for "count changes without animation" — so `animate` turns off the sweep
 *    and the number goes on changing. A countdown that stopped counting would
 *    honour the preference by deleting the feature.
 *
 * 6. **A duration of zero is not a countdown.** `needsCountdown` is false at
 *    or below zero and the caller fires immediately with nothing on screen —
 *    which is exactly what Capture already does without the self-timer, so the
 *    "off" case needs no second code path to be correct.
 *
 * 7. **This never decides scope, and never runs before scope is set.** The
 *    ticket makes them separate steps (scope overlay → countdown → capture)
 *    and nothing here takes a display, a region or a window: a countdown that
 *    knew what it was pointed at would be a second place to decide it.
 */

/**
 * The default, and the ticket's own Open item — answered 3s (2026-09-16).
 *
 * Long enough to move a pointer onto a control and hold it, short enough that
 * Record does not feel broken. It is a stored preference rather than a
 * constant (`settings.ts`'s `countdownMs`) so the number can move without a
 * code change; there is deliberately no control for it in this ticket.
 */
export const DEFAULT_COUNTDOWN_MS = 3000;

/**
 * The longest a stored preference may ask for.
 *
 * Not taste: `countdown-window.ts` puts a focusable panel on screen and
 * refuses a second capture while one is running, so an absurd value read off
 * a hand-edited settings file would be indistinguishable from the app having
 * wedged. A minute is far past any self-timer anyone means and still recovers
 * on its own.
 */
export const MAX_COUNTDOWN_MS = 60_000;

/** How often the window re-reads the clock. Roughly 60fps, so the sweep in
 * rule 5 is a sweep rather than a stepped dimming — the same reasoning and the
 * same number as `scope-indicator-window.ts`'s fade. */
export const COUNTDOWN_TICK_MS = 16;

/** Which of the two ways in this countdown is for. The countdown itself is one
 * component; only the caption differs. */
export type CountdownPurpose = "record" | "capture";

/**
 * What happened. `elapsed` and `skipped` both proceed (rule 4); `cancelled`
 * is the ticket's requirement 1 — nothing is captured or recorded.
 */
export type CountdownOutcome = "elapsed" | "skipped" | "cancelled";

/** Whether the thing being waited for should now happen. The ONE place an
 * outcome is turned into that answer. */
export function countdownFired(outcome: CountdownOutcome): boolean {
  return outcome === "elapsed" || outcome === "skipped";
}

/**
 * Whether there is anything to put on screen at all (rule 6).
 *
 * A non-finite or non-positive duration is "no countdown", not an error: a
 * preference file can hold anything, and the honest reading of "0" is the
 * behaviour Capture already has.
 */
export function needsCountdown(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0;
}

/**
 * A stored preference → a duration this is willing to run, or 0 for "off".
 *
 * Here rather than in `settings.ts` so the clamp and the constant it clamps
 * to cannot drift apart, the same reason `hotkeys.ts` owns both the grammar
 * and the reserved list.
 */
export function clampCountdownMs(ms: unknown): number {
  const n = typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms) : DEFAULT_COUNTDOWN_MS;
  if (n <= 0) return 0;
  return Math.min(n, MAX_COUNTDOWN_MS);
}

/** The digit on screen (rule 2). */
export function countdownLabel(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return "1";
  return String(Math.max(1, Math.ceil(remainingMs / 1000)));
}

/**
 * The one sentence under the number.
 *
 * Wording lives here for `explainShortcut`'s reason: it is testable, and a
 * third purpose cannot be added without the exhaustive switch failing to
 * describe it.
 */
export function countdownCaption(purpose: CountdownPurpose): string {
  switch (purpose) {
    case "record": return "Recording starts in";
    case "capture": return "Capturing in";
  }
}

export interface CountdownInput {
  /** What the countdown was asked for, ms. */
  totalMs: number;
  /** How much is left, ms, as the clock last reported it. */
  remainingMs: number;
  /** The OS's `prefers-reduced-motion`, as the view read it. Absent is "not
   * reduced" — the same direction `still-redact.ts` fails in, toward doing the
   * ordinary thing rather than toward the special case. */
  reducedMotion?: boolean;
  purpose: CountdownPurpose;
}

export interface CountdownView {
  /** "3", "2", "1" — never "0" (rule 2). */
  label: string;
  caption: string;
  /**
   * 0 at the start, 1 when it fires — the sweep's progress.
   *
   * Always computed, even when `animate` is false, so the two answers are
   * independent: a view that wanted to draw a static bar at the current
   * position could, and a `fraction` that went missing under reduced motion
   * would make rule 5 a property of this function rather than of the drawing.
   */
  fraction: number;
  /** False under `prefers-reduced-motion` (rule 5). */
  animate: boolean;
}

/** Everything the page needs to draw one frame. */
export function countdownView(input: CountdownInput): CountdownView {
  const total = Number.isFinite(input.totalMs) && input.totalMs > 0 ? input.totalMs : 0;
  const remaining = Number.isFinite(input.remainingMs)
    ? Math.min(Math.max(input.remainingMs, 0), total || input.remainingMs)
    : 0;
  return {
    label: countdownLabel(remaining),
    caption: countdownCaption(input.purpose),
    fraction: total > 0 ? Math.min(Math.max((total - remaining) / total, 0), 1) : 1,
    animate: !input.reducedMotion,
  };
}

// ── input ───────────────────────────────────────────────────────────────────

/** A `KeyboardEvent` reduced to what matters, the same shape `hotkeys.ts`'s
 * `KeyStroke` takes and for the same reason: `code` is layout-independent. */
export interface CountdownKey {
  code: string;
  metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
}

/** What a keystroke over the countdown means, or `null` for "not mine" — which
 * the view must then leave alone rather than swallow (rule 3). */
export function decideCountdownKey(e: CountdownKey): "cancel" | "skip" | null {
  // A chord belongs to whatever else the app binds. Escape is deliberately
  // included in that rule: ⌘⎋ is not the ticket's "Esc cancels".
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.code === "Escape") return "cancel";
  // Shift+Return is still Return here — nothing else on this surface binds it,
  // and a user holding shift while confirming meant to confirm.
  if (e.code === "Enter" || e.code === "NumpadEnter") return "skip";
  return null;
}
