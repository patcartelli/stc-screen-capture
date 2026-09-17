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
// The one place `ms` reaches the page — the bar's animation is driven from
// it rather than a literal duration in the stylesheet (ruling 2), so the CSS
// and `toast-window.ts`'s own timer cannot disagree about how long the
// window is. `animationName` is set HERE too, not in the stylesheet
// (`toast.html`'s own comment on `#bar`) — setting both together is what
// keeps the animation from ever starting at the CSS default duration (0s)
// for the instant before this line runs.
bar.style.animationDuration = `${ms}ms`;
bar.style.animationName = "drain";

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
