/**
 * The undo toast's whole view (STC-392 Task 6).
 *
 * A separate compiled file rather than an inline `<script>` in `toast.html`,
 * the same reason every other renderer here is: the CSP header
 * (`script-src 'self'`) has no `'unsafe-inline'`, so an inline script would
 * not run at all.
 *
 * `dir` and `ms` (the undo window's length) arrive on the page's own URL
 * query string — `toast-window.ts` put them there loading this file, so there
 * is nothing to ask main for before the bar can start.
 */
export {};

declare global {
  interface Window {
    toast: {
      undo(dir: string): Promise<boolean>;
      onExpire(cb: () => void): () => void;
    };
  }
}

const params = new URLSearchParams(window.location.search);
const dir = params.get("dir") ?? "";
const ms = Number(params.get("ms") ?? "0");

const bar = document.getElementById("bar") as HTMLDivElement;

/**
 * The one place `ms` reaches the page — the bar's animation is driven from
 * it rather than a literal duration in the stylesheet (ruling 2), so the CSS
 * and `toast-window.ts`'s own timer cannot disagree about how long the
 * window is. `animationName` is set HERE too, not in the stylesheet
 * (`toast.html`'s own comment on `#bar`) — setting both together is what
 * keeps the animation from ever starting at the CSS default duration (0s)
 * for the instant before this line runs.
 *
 * Reduced motion is decided HERE too (STC-392 review, I1), not left to a
 * stylesheet media query: an inline style — which `animationName`/
 * `animationDuration` become the instant this function sets them — outranks
 * every stylesheet rule short of `!important`, so a `@media
 * (prefers-reduced-motion: reduce)` block could never have overridden them.
 * Same decision `countdown-renderer.ts` makes for the countdown ring, and
 * the same reason: the OS setting is only readable from a page, so whatever
 * sets the inline style has to be the thing that checks it.
 */
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
function applyBarMotion(): void {
  if (reducedMotion.matches) {
    // No animation at all — the bar starts, and stays, fully drained. Never
    // partially drained: a static bar reading "most of the time is gone" for
    // the whole 8s window would be a worse lie than no bar at all.
    bar.style.animationName = "none";
    bar.style.transform = "scaleX(0)";
  } else {
    bar.style.animationDuration = `${ms}ms`;
    bar.style.animationName = "drain";
  }
}
applyBarMotion();
// Belt: the toast is on screen for up to UNDO_WINDOW_MS, long enough that a
// setting flipped mid-toast is not purely theoretical — `countdown-renderer
// .ts` re-decides every draw for the identical reason.
reducedMotion.addEventListener("change", applyBarMotion);

const undoBtn = document.getElementById("undo") as HTMLButtonElement;
undoBtn.addEventListener("click", () => {
  // Disabled immediately, not after the round trip: a second click while the
  // first is still in flight must not ask main to take back a promise it has
  // already taken back.
  undoBtn.disabled = true;
  void window.toast.undo(dir);
});

// Main tells this page the window has expired just before it destroys it
// (`toast-window.ts`) — disables the button for the instant between that and
// the destroy actually landing, so a click in that gap cannot start an undo
// for a promise about to be committed.
window.toast.onExpire(() => { undoBtn.disabled = true; });
