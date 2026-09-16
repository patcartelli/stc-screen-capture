import {
  countdownView, decideCountdownKey,
  type CountdownPurpose, type CountdownView,
} from "./countdown.js";

/**
 * The countdown's view (STC-391). It draws state and reports input; it decides
 * nothing.
 *
 * The clock is the main process's (`countdown-window.ts`) and arrives already
 * turned into a `CountdownView`. This file re-runs `countdownView` for exactly
 * one reason: `prefers-reduced-motion` is only readable from a page, so the
 * main process cannot know it and sends its answer with `animate` true. The
 * same function with the same rules decides it here — a second rule for the
 * reduced-motion case would be the place the two could disagree.
 */

declare global {
  interface Window {
    countdown: {
      send(event: unknown): void;
      onState(cb: (payload: unknown) => void): () => void;
    };
  }
}

interface StatePayload {
  remainingMs: number;
  totalMs: number;
  view: CountdownView;
}

const $ = (id: string) => document.getElementById(id)!;
const count = $("count"), caption = $("caption"), sweep = $("sweep");

const params = new URLSearchParams(location.search);
const purpose: CountdownPurpose = params.get("purpose") === "record" ? "record" : "capture";

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
let latest: StatePayload | undefined;

/** The ring's circumference — `r` in the SVG, kept in one place so the dash
 * arithmetic and the markup cannot drift. */
const RING_R = 26;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

function draw(): void {
  if (!latest) return;
  // The main process's `view` is recomputed rather than used verbatim, so the
  // one field it could not know is not the one field that goes unhonoured.
  const view = countdownView({
    remainingMs: latest.remainingMs, totalMs: latest.totalMs,
    purpose, reducedMotion: reduced.matches,
  });
  count.textContent = view.label;
  caption.textContent = view.caption;
  // The count keeps counting under reduced motion; only the sweep goes
  // (`countdown.ts` rule 5). One attribute, and `countdown.html` does the
  // hiding — an `svg.hidden = true` here reflects no attribute and hid
  // nothing, which the E2E caught and the page's own comment records.
  document.body.dataset.animate = String(view.animate);
  if (view.animate) {
    sweep.setAttribute("stroke-dasharray", String(RING_CIRCUMFERENCE));
    sweep.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * view.fraction));
  }
}

window.countdown.onState((payload) => {
  const p = payload as StatePayload | null;
  if (!p || typeof p.remainingMs !== "number") return;
  latest = p;
  draw();
});

// A change of the OS setting mid-countdown is rare and free to honour: the
// next draw already asks, and this makes the current frame ask too.
reduced.addEventListener("change", draw);

$("skip").addEventListener("click", () => window.countdown.send({ kind: "skip" }));
$("cancel").addEventListener("click", () => window.countdown.send({ kind: "cancel" }));

window.addEventListener("keydown", (e) => {
  const decision = decideCountdownKey(e);
  // Not ours: left alone rather than swallowed, so a chord still reaches
  // whatever else binds it (`countdown.ts` rule 3).
  if (!decision) return;
  // Ours: and the default action is suppressed, because Return on a focused
  // button would otherwise ALSO click it — the second-writer trap STC-338
  // found on the scrubber's range input, one surface over.
  e.preventDefault();
  window.countdown.send({ kind: decision });
});
