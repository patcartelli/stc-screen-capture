import { formatElapsedTimer, meterView, NO_SIGNAL_TOOLTIP, parseLevel, type LevelReading } from "./pill.js";

/**
 * The pill's view (STC-550; the pill itself is STC-375). It draws what main
 * sends and reports two things: a click on Stop, and how wide its content is.
 * It decides nothing — `pill.ts` and `pill-window.ts` do.
 *
 * Moved here from the library's `renderer.ts`, where it lived while the pill
 * was the library window collapsed. The window is one per take, so a page
 * starts every take fresh: timer at 00:00, meter hatched.
 */

declare global {
  interface Window {
    pill: {
      stop(): Promise<{ ok: boolean }>;
      reportWidth(px: number): void;
      on(channel: string, cb: (payload: unknown) => void): () => void;
    };
  }
}

const $ = (id: string) => document.getElementById(id)!;
const pill = $("pill");
const row = $("pill-row");
const timer = $("pill-timer");
const meter = $("pill-meter");
const labelEl = $("pill-label");
const stopBtn = $("pill-stop") as HTMLButtonElement;

// The drag region is the whole pill (pill.html); Stop is the one control in it.
// Disabled while the request is out, so a second click cannot stop the NEXT take.
stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  const r = await window.pill.stop().catch(() => ({ ok: false }));
  // The window goes away when the take ends; a refused stop gives the button back.
  if (!r.ok && !pill.classList.contains("stopped")) stopBtn.disabled = false;
});

// Main sizes the window to the content (`resizePillBounds`). Only the content
// can change that width — the timer gaining an hour digit, or a label standing
// in for it — and a ResizeObserver reports exactly when it does.
new ResizeObserver(() => {
  window.pill.reportWidth(Math.ceil(row.getBoundingClientRect().width));
}).observe(row);

window.pill.on("pill:elapsed", (p) => {
  const ms = (p as { elapsedMs?: unknown } | null)?.elapsedMs;
  if (typeof ms === "number") timer.textContent = formatElapsedTimer(ms);
});

// STC-528: the level meter. `meterView` decides; this only draws.
let lastLevel: LevelReading | undefined;
let micLost = false;
function drawMeter(): void {
  const v = meterView(lastLevel, micLost);
  meter.classList.toggle("live", v.mode === "live");
  meter.classList.toggle("no-signal", v.mode === "no-signal");
  meter.style.setProperty("--level", v.fill.toFixed(3));
  if (v.mode === "no-signal") meter.title = NO_SIGNAL_TOOLTIP;
  else meter.removeAttribute("title");
}
window.pill.on("pill:level", (l) => {
  const r = parseLevel(l);
  if (!r) return;
  lastLevel = r;
  drawMeter();
});
window.pill.on("pill:micLost", () => { micLost = true; drawMeter(); });

const labelOf = (p: unknown): string | null => {
  const l = (p as { label?: unknown } | null)?.label;
  return typeof l === "string" && l ? l : null;
};

// STC-531: the helper stopped the take by itself. For PILL_STOPPED_DWELL_MS
// main sends the cause (`stop-copy.ts`'s `pillLabel`), then puts the pill away.
// Stop is disabled meanwhile: there is no take left to stop.
window.pill.on("pill:stopped", (p) => {
  const label = labelOf(p);
  pill.classList.toggle("stopped", label !== null);
  if (label !== null) pill.classList.remove("notice"); // STC-237: a stop ends any notice
  stopBtn.disabled = label !== null;
  labelEl.textContent = label ?? "";
  pill.setAttribute("aria-label", label ? `Recording stopped: ${label}` : "Recording");
});

// STC-237: a mic or camera was lost and the take keeps recording. The label
// stands in for the timer for PILL_STOPPED_DWELL_MS; Stop stays Stop.
window.pill.on("pill:notice", (p) => {
  const label = labelOf(p);
  if (pill.classList.contains("stopped")) return; // a stop's label outranks it
  pill.classList.toggle("notice", label !== null);
  labelEl.textContent = label ?? "";
  stopBtn.setAttribute("aria-label", label ? `Stop recording (${label})` : "Stop recording");
});
