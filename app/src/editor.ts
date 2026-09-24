/**
 * The editor window (STC-373) — preview, trim, export, legibility and share,
 * split out of the main window's in-page player. The timeline's two lanes
 * (Clip, Zoom) sit over one shared span; Clip stays read-only, Zoom is now
 * editable — tuning a derived window's crop and easing (STC-330), and
 * authoring a window with no derived counterpart at all (STC-331).
 *
 * `editor.ts` inherits `app/src/scrubber.ts`'s vocabulary verbatim — see that
 * module's header for the ten rules a timeline control here is held to.
 */
interface StillSettingsView {
  format: string; quality: number; scale: string;
  stripMetadata: boolean; template: string; destination: string | null;
}
interface AppSettings {
  still: StillSettingsView;
  // STC-444 slice 3: the export dialog shows this read-only (the picker
  // itself moved to the main window's Preferences), so a take can be
  // published without a second door back to a folder picker this window
  // does not own.
  share: { destination: string | null };
}
declare const editor: {
  openPreview: (dir: string) => Promise<boolean>;
  closePreview: () => Promise<void>;
  readTakeFile: (name: string) => Promise<ArrayBuffer>;
  takeFileSize: (name: string) => Promise<number>;
  readTakeChunk: (name: string, offset: number, length: number) => Promise<ArrayBuffer>;
  writeProject: (bytes: ArrayBuffer) => Promise<boolean>;
  writeExport: (name: string, bytes: ArrayBuffer) => Promise<string>;
  captureId: () => Promise<string>;
  exportStill(req: {
    bytes: ArrayBuffer; width: number; height: number; alpha: boolean; colorSpace?: string;
    target: { file: boolean; clipboard: boolean };
    options: { format: string; quality: number; scale: string;
               stripMetadata: boolean; template: string; flattenColor?: string };
    info: { app?: string; title?: string; mode: string };
    dir?: string;
  }): Promise<{
    ok: boolean; file?: string; bytes?: number; clipboard?: string[];
    width?: number; height?: number; format?: string; alpha?: boolean;
    premultiplied?: boolean; metadata?: string; code?: string; detail?: string;
  }>;
  getSettings: () => Promise<AppSettings>;
  publish(): Promise<{
    ok: boolean; plan: string; message?: string;
    file?: string; name?: string; replaced?: boolean; snippet?: string;
  }>;
  revealPublished(): Promise<{ ok: boolean; file?: string; message?: string }>;
  getVersion(): Promise<string>;
};

import { loadSession, type LoadedSession } from "@transform/session";
import { PreviewPlayer } from "@transform/preview";
import { exportSession } from "@transform/export";
import type { Project, ZoomOverride } from "@transform/types";
import {
  parseProject, projectForWrite, exportWindow, estimateExportMs,
  clampTrim, isFullTake, minTrimNs,
} from "@transform/trim";
import { outputSizeFor, outputOptions, selectedOption, type OutputOption } from "@transform/output-size";
import { PROFILE_HINT_FILE } from "@transform/recording-profile";
import type { Size } from "@transform/spaces";
import { render } from "@transform/render";
import {
  DEFAULT_TEXT_PT, EMBED_TARGETS, legibility, legibilitySentence, zoomFactorForCrop,
} from "@transform/legibility";
import { TRANSFORM_VERSION } from "@transform/transform-version";
import { productStamp } from "./product.js";
import { zoomWindows, ZOOM_LEAD_NS, ZOOM_HOLD_NS, type ZoomPreset, type ZoomWindow } from "@transform/zoom";
import { windowId, overrideFor, resolvedWindows, rectFromGesture } from "@transform/zoom-override";
import type { Rect } from "@transform/spaces";
import {
  clampTrimFrame, decideKey, formatReadout, formatShuttle, frameAtFraction, frameToNs,
  fractionOfFrame, lastFrame, nsToFrame, rubberBandPx, tickStrideFrames, type ScrubAction,
  type ScrubState,
} from "./scrubber.js";
import { autoSlug, exportManifestName, exportMediaName, slugIsValid } from "./share.js";
import { clipActivity, zoomCurve } from "./timeline-activity.js";

const $ = (id: string) => document.getElementById(id)!;

function alertUser(text: string): void { $("alert").textContent = text; $("alert").classList.add("show"); }
function clearAlert(): void { $("alert").classList.remove("show"); }

const fmtClock = (ns: number) => {
  const s = Math.max(0, Math.round(ns / 1e9));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtEstimate = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `~${s}s to export`;
  return `~${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} to export`;
};

// ---- what to open, from the URL the window was loaded with -----------------

const params = new URLSearchParams(location.search);
const takeDir = params.get("dir") ?? "";
const takeName = params.get("name") ?? "";

// ---- state ------------------------------------------------------------------

let player: PreviewPlayer | undefined;
let scrubbing = false;
let openSession: LoadedSession | undefined;
let openProject: Project | undefined;
/** The take's capture size — the aspect every export size is derived from. */
let openCapture: Size | undefined;
/** The take's display geometry — legibility needs its width in POINTS (STC-318). */
let openDisplay: { pointWidth: number } | undefined;
/** The width the demo is shown at, in CSS px. A view setting, never stored on the take. */
let embedWidthPx = EMBED_TARGETS[0]!.widthPx;
let exportAbort: AbortController | undefined;

// ---- the shared [a, b] span the ruler and both lanes render from -----------
//
// Pan lives on the ruler; zoom anchors on the pointer (STC-373). Rather than
// re-deriving every frame<->px conversion for a zoomed, panned view, the span
// is expressed as a CSS transform on #timeline (and the two lane canvases
// beside it) that stretches the FULL-DURATION content so only [spanStart,
// spanEnd] shows in the viewport. `getBoundingClientRect()` reports the
// element's post-transform box, so every existing frame<->px helper in this
// file — written against the untransformed track — keeps working exactly as
// it did in the single in-page player.
let spanStart = 0;
let spanEnd = 0;
const MIN_SPAN_FRACTION = 1 / 64;

function resetSpan(): void {
  spanStart = 0;
  spanEnd = player?.durationNs ?? 0;
}

function applySpanTransform(): void {
  const durationNs = player?.durationNs ?? 0;
  const span = Math.max(1, spanEnd - spanStart);
  const scale = durationNs > 0 ? durationNs / span : 1;
  const translatePct = durationNs > 0 ? -(spanStart / span) * 100 : 0;
  const transform = `scaleX(${scale}) translateX(${translatePct}%)`;
  ($("timeline") as HTMLElement).style.transform = transform;
  ($("ruler-activity-wrap") as HTMLElement).style.transform = transform;
  ($("zoom-canvas-wrap") as HTMLElement).style.transform = transform;
  ($("ruler-content") as HTMLElement).style.transform = transform;
  // STC-331, found fixing this file: editor.html's own comment already
  // claimed "the shared transform on #override-blocks does the pan/zoom",
  // but this function never actually set it here — the CSS rule that makes
  // it a valid transform target was in place since STC-330, the line
  // applying one was not. #zoom-curve (the sibling canvas .zoomblock is
  // meant to overlay) WAS transformed, so any pan or zoom away from the
  // default full view put every block's click target out of registration
  // with the silhouette it is supposed to sit on. This phase's own
  // creation/resize gestures read time from the same transformed box
  // (frameAtClientX), so the misalignment would have reached further than
  // phase 1's read-only blocks ever did.
  ($("override-blocks") as HTMLElement).style.transform = transform;
  updateTicks();
  renderRulerTicks();
  renderBookmarks();
}

// ---- the ruler's adaptive ticks + played line (STC-444 slice 2) ------------
//
// Separate from updateTicks()/#ticks above, which is STC-338's export-frame
// grid drawn over the CLIP LANE — a different feature that predates this
// ticket and is untouched by it. This is the ruler's own time scale.

/** 1s → 5s → 10s → 30s → 1m → …, doubling/quintupling in the same "nice
 *  round interval" spirit as the ticket's own documented ladder, extended
 *  past 1m for takes longer than a minute (this repo already has 5-minute
 *  and 60s example recordings). */
const TICK_LADDER_S = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
/** Never closer than this (scrubber.ts rule 9, applied to the ruler). */
const MIN_TICK_SPACING_PX = 6;

const MAX_RULER_LAYOUT_RETRIES = 5;
let rulerLayoutRetriesLeft = MAX_RULER_LAYOUT_RETRIES;
/**
 * Rebuilds #ruler-ticks from the current [spanStart, spanEnd] and the
 * ruler's own on-screen width — the coarsest interval off TICK_LADDER_S
 * whose on-screen spacing is still >= MIN_TICK_SPACING_PX. Ticks are
 * authored as a fraction of FULL DURATION (left: %), so the shared pan/zoom
 * transform on #ruler-content carries them for free; only each tick's WIDTH
 * needs a 1/scale correction to stay a constant on-screen px, since
 * scaleX() stretches the X axis a %-based left/width already lives on.
 *
 * Same retry-on-zero-width shape as updateTicks() above (STC-378) — a
 * freshly created editor window is not guaranteed a final layout size on
 * the first read, and this reads a DIFFERENT element's box (#ruler, not
 * #timeline), so it needs its own retry counter rather than borrowing that
 * function's.
 */
function renderRulerTicks(): void {
  const rulerEl = $("ruler") as HTMLElement;
  const width = rulerEl.getBoundingClientRect().width;
  if (width <= 0 && player && rulerLayoutRetriesLeft > 0) {
    rulerLayoutRetriesLeft--;
    requestAnimationFrame(renderRulerTicks);
    return;
  }
  rulerLayoutRetriesLeft = MAX_RULER_LAYOUT_RETRIES;
  const ticksEl = $("ruler-ticks") as HTMLElement;
  ticksEl.innerHTML = "";
  if (!player || width <= 0) return;
  const durationNs = player.durationNs;
  if (!(durationNs > 0)) return;
  const span = Math.max(1, spanEnd - spanStart);
  const scale = durationNs / span;
  const visibleS = span / 1e9;
  const pxPerSecond = width / Math.max(1e-9, visibleS);
  let interval = TICK_LADDER_S[TICK_LADDER_S.length - 1]!;
  for (const candidate of TICK_LADDER_S) {
    if (candidate * pxPerSecond >= MIN_TICK_SPACING_PX) { interval = candidate; break; }
  }
  const durationS = durationNs / 1e9;
  const tickWidthPx = Math.max(0.05, 1 / scale);
  const frag = document.createDocumentFragment();
  for (let t = 0; t <= durationS + 1e-6; t += interval) {
    const div = document.createElement("div");
    div.className = "ruler-tick";
    div.style.left = `${Math.min(100, (t / durationS) * 100)}%`;
    div.style.width = `${tickWidthPx}px`;
    frag.appendChild(div);
  }
  ticksEl.appendChild(frag);
  // The playhead mark is the same kind of fixed-width thing a tick is.
  ($("ruler-playhead") as HTMLElement).style.width = `${tickWidthPx}px`;
}

/** The blue played bar and its bright boundary mark — updated every
 *  onTime tick, unlike renderRulerTicks (span/resize-driven only), since
 *  this is cheap (two style writes) and needs the current position. */
function updateRulerPlayhead(tNs: number): void {
  if (!player) return;
  const durationNs = player.durationNs;
  if (!(durationNs > 0)) return;
  const pct = Math.max(0, Math.min(100, (tNs / durationNs) * 100));
  ($("ruler-played") as HTMLElement).style.width = `${pct}%`;
  ($("ruler-playhead") as HTMLElement).style.left = `${pct}%`;
}

/** Pan by a fraction of the CURRENT span (positive moves later in the take). */
function panSpan(deltaFraction: number): void {
  const durationNs = player?.durationNs ?? 0;
  if (durationNs <= 0) return;
  const span = spanEnd - spanStart;
  let start = spanStart + deltaFraction * span;
  start = Math.max(0, Math.min(durationNs - span, start));
  spanStart = start;
  spanEnd = start + span;
  applySpanTransform();
}

/** Zoom by `factor` (>1 zooms in), anchored so `anchorFraction` (0..1 of the
 *  current span) stays under the pointer. */
function zoomSpan(factor: number, anchorFraction: number): void {
  const durationNs = player?.durationNs ?? 0;
  if (durationNs <= 0) return;
  const span = spanEnd - spanStart;
  const minSpan = durationNs * MIN_SPAN_FRACTION;
  const nextSpan = Math.max(minSpan, Math.min(durationNs, span / factor));
  const anchorNs = spanStart + anchorFraction * span;
  let start = anchorNs - anchorFraction * nextSpan;
  start = Math.max(0, Math.min(durationNs - nextSpan, start));
  spanStart = start;
  spanEnd = start + nextSpan;
  applySpanTransform();
}

let panning = false;
let panLastX = 0;
$("ruler").addEventListener("pointerdown", (e) => {
  // The activity toggle sits INSIDE #ruler (2026-09-24 declutter pass), and
  // without this guard #ruler's own setPointerCapture below steals the
  // button's pointer events on the very first pointerdown — a click that
  // never reaches the button, watched failing before this was added.
  if ((e.target as HTMLElement).closest("#ruleractivitytoggle")) return;
  if ((e.target as HTMLElement).closest(".rulerbookmark")) return;
  panning = true;
  panLastX = (e as PointerEvent).clientX;
  ($("ruler") as HTMLElement).setPointerCapture((e as PointerEvent).pointerId);
});
$("ruler").addEventListener("pointermove", (e) => {
  if (!panning) return;
  const r = $("ruler").getBoundingClientRect();
  const dx = (e as PointerEvent).clientX - panLastX;
  panLastX = (e as PointerEvent).clientX;
  if (r.width > 0) panSpan(-dx / r.width);
});
const stopPan = () => { panning = false; };
$("ruler").addEventListener("pointerup", stopPan);
$("ruler").addEventListener("pointercancel", stopPan);
$("ruler").addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = $("ruler").getBoundingClientRect();
  const anchor = r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0.5;
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomSpan(factor, anchor);
}, { passive: false });

// ---- trim UI ----------------------------------------------------------------

function updateTrimUI(): void {
  if (!player || !openProject) return;
  const d = player.durationNs || 1;
  const start = openProject.trim?.startNs ?? 0;
  const end = openProject.trim?.endNs ?? player.durationNs;
  const inPct = (start / d) * 100;
  const outPct = (end / d) * 100;
  ($("trim-in") as HTMLElement).style.left = `${inPct}%`;
  ($("trim-out") as HTMLElement).style.left = `${outPct}%`;
  const kept = $("kept") as HTMLElement;
  kept.style.left = `${inPct}%`;
  kept.style.width = `${Math.max(0, outPct - inPct)}%`;

  // Rule 4: what was cut is DIMMED, not fenced off — across BOTH lanes now
  // (STC-444 slice 2's "dimming across lanes"), not the Clip lane alone.
  const head = $("cut-head") as HTMLElement;
  head.style.left = "0%";
  head.style.width = `${Math.max(0, inPct)}%`;
  const tail = $("cut-tail") as HTMLElement;
  tail.style.left = `${outPct}%`;
  tail.style.width = `${Math.max(0, 100 - outPct)}%`;
  const zHead = $("zoom-cut-head") as HTMLElement;
  zHead.style.left = "0%";
  zHead.style.width = `${Math.max(0, inPct)}%`;
  const zTail = $("zoom-cut-tail") as HTMLElement;
  zTail.style.left = `${outPct}%`;
  zTail.style.width = `${Math.max(0, 100 - outPct)}%`;
  updateTicks();

  const w = exportWindow(openProject, player.durationNs);
  const est = fmtEstimate(estimateExportMs(w.maxFrames));
  $("triminfo").textContent = isFullTake(openProject, player.durationNs)
    ? `Full take · ${fmtClock(player.durationNs)} · ${est}`
    : `${fmtClock(w.startNs)}–${fmtClock(w.endNs)} · ${fmtClock(w.endNs - w.startNs)} · ${est}`;
}

/**
 * The export grid on the track (STC-338 rule 9). See renderer.ts's original
 * for the reasoning.
 *
 * STC-378: a freshly created editor `BrowserWindow` is not guaranteed to have
 * given its content view a final layout size by the time `openTakeOrThrow`'s
 * boot sequence reaches this call — reproduced live and reproducibly on CI's
 * macOS runner (`#ticks` stuck `hidden` after the very first take opened in a
 * take), never once under Xvfb here despite repeated local runs, which is
 * presumably why STC-373 didn't catch it: this sandbox's window manager lays
 * a window out immediately on creation. The existing `resize` listener below
 * only self-heals if a genuine LATER resize follows, which an explicitly
 * `width`/`height`-constructed `BrowserWindow` need not ever produce. So a
 * non-positive width is not trusted on the first read: it gets a bounded
 * number of retries on successive animation frames — each one guarantees a
 * real layout/paint has happened since the last — before `#ticks` is
 * believed to have nothing legible to draw. Same family as STC-338's
 * "a measurement that cannot fail loudly will fail quietly and plausibly":
 * the fix there was to measure after a known reveal; there is no single
 * known reveal here, so this measures again rather than trusting one read.
 */
const MAX_TICK_LAYOUT_RETRIES = 5;
let tickLayoutRetriesLeft = MAX_TICK_LAYOUT_RETRIES;
function updateTicks(): void {
  const ticks = $("ticks") as HTMLElement;
  const width = $("timeline").getBoundingClientRect().width;
  if (width <= 0 && player && tickLayoutRetriesLeft > 0) {
    tickLayoutRetriesLeft--;
    requestAnimationFrame(updateTicks);
    return;
  }
  tickLayoutRetriesLeft = MAX_TICK_LAYOUT_RETRIES;
  const stride = player ? tickStrideFrames(player.durationNs, width) : null;
  if (!player || stride === null || width <= 0) {
    ticks.setAttribute("hidden", "");
    return;
  }
  ticks.removeAttribute("hidden");
  ticks.style.setProperty("--tick-px", `${(width / lastFrame(player.durationNs)) * stride}px`);
}

window.addEventListener("resize", () => { if (player) { updateTicks(); renderRulerTicks(); } });

async function persistProject(): Promise<void> {
  if (!openProject || !player) return;
  const doc = projectForWrite(openProject, player.durationNs);
  await editor.writeProject(
    new TextEncoder().encode(JSON.stringify(doc, null, 2)).buffer as ArrayBuffer,
  );
}

function setTrim(startNs: number, endNs: number, persist: boolean): void {
  if (!openProject || !player) return;
  const next = clampTrim(startNs, endNs, player.durationNs, openProject.output.fps);
  if (next.startNs === 0 && next.endNs === player.durationNs) delete openProject.trim;
  else openProject.trim = next;
  updateTrimUI();
  if (persist) void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
}

// ---- bookmarks (STC-444 slice 4) --------------------------------------------
//
// project-8's `bookmarks` are session-relative ns (the same units `trim`
// uses); `scrubber.ts`'s ScrubState works in FRAMES (rule 1), so the boundary
// is here, the same split `scrubState()`/`applyScrubAction` already draw for
// `trimIn`/`trimOut`. M toggles the marker at the playhead's own FRAME —
// `frameToNs(currentFrame())`, not `player.currentNs`, so a bookmark set while
// paused exactly on a frame round-trips through the frame grid and a second M
// press finds the same ns again rather than landing a few sub-frame ns off.

function sortedBookmarks(list: readonly number[]): number[] {
  return [...new Set(list)].sort((a, b) => a - b);
}

function addBookmark(ns: number): void {
  if (!openProject) return;
  openProject.bookmarks = sortedBookmarks([...(openProject.bookmarks ?? []), ns]);
  renderBookmarks();
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
}

function removeBookmark(ns: number): void {
  if (!openProject) return;
  openProject.bookmarks = (openProject.bookmarks ?? []).filter((b) => b !== ns);
  renderBookmarks();
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
}

function toggleBookmarkAtPlayhead(): void {
  if (!player || !openProject) return;
  const ns = frameToNs(currentFrame(), player.durationNs);
  (openProject.bookmarks ?? []).includes(ns) ? removeBookmark(ns) : addBookmark(ns);
}

/**
 * Rebuilds #ruler-bookmarks the same way renderRulerTicks rebuilds
 * #ruler-ticks: authored as a fraction of FULL duration (left: %) so the
 * shared pan/zoom transform on #ruler-content carries it for free, with the
 * marker's own WIDTH corrected by 1/scale so it stays a constant on-screen
 * px — the same fight ticks and the playhead already have with scaleX().
 */
function renderBookmarks(): void {
  const el = $("ruler-bookmarks") as HTMLElement;
  el.innerHTML = "";
  if (!player || !openProject || !(player.durationNs > 0)) return;
  const durationNs = player.durationNs;
  const span = Math.max(1, spanEnd - spanStart);
  const scale = durationNs / span;
  const widthPx = Math.max(0.05, 3 / scale);
  const frag = document.createDocumentFragment();
  for (const ns of openProject.bookmarks ?? []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rulerbookmark";
    btn.style.left = `${Math.max(0, Math.min(100, (ns / durationNs) * 100))}%`;
    btn.style.width = `${widthPx}px`;
    btn.dataset.ns = String(ns);
    btn.setAttribute("aria-label", `Bookmark at ${fmtClock(ns)}`);
    btn.title = `${fmtClock(ns)} — right-click to remove`;
    frag.appendChild(btn);
  }
  el.appendChild(frag);
}

($("ruler-bookmarks") as HTMLElement).addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".rulerbookmark") as HTMLElement | null;
  if (!btn || !player) return;
  e.stopPropagation();
  void player.seek(Number(btn.dataset.ns));
});
($("ruler-bookmarks") as HTMLElement).addEventListener("contextmenu", (e) => {
  const btn = (e.target as HTMLElement).closest(".rulerbookmark") as HTMLElement | null;
  if (!btn) return;
  e.preventDefault();
  removeBookmark(Number(btn.dataset.ns));
});
$("togglebookmark").addEventListener("click", toggleBookmarkAtPlayhead);

// ---- the Clip and Zoom lanes (STC-373) --------------------------------------

const LANE_BUCKETS = 480;
/** The Clip activity's bars are lit from the bottom in LED-style rows
 *  (STC-444 slice 2, "LED/LCD screen" HTML variant comparison) rather than
 *  a solid fill — SEG the filled height of each row, GAP the dark space
 *  after it. */
const LED_ROW_SEG_PX = 2;
const LED_ROW_GAP_PX = 1;

/**
 * Clip activity, drawn onto the RULER now, not its own lane (2026-09-24
 * declutter pass, real-hardware feedback: three stacked lanes read as
 * cluttered, and activity is a judgment aid for where to trim, not a
 * control — it does not need a lane's worth of space to earn its keep).
 * `#ruler[data-activity]`'s CSS opacity is what actually shows or hides
 * it; this always redraws the canvas regardless, the same way the Zoom
 * lane's canvas is kept current whether or not anything is selected on it.
 */
function drawRulerActivity(): void {
  const canvas = $("ruler-activity") as HTMLCanvasElement;
  const wrap = $("ruler-activity-wrap") as HTMLElement;
  const w = Math.max(1, Math.round(wrap.getBoundingClientRect().width)) || LANE_BUCKETS;
  const h = 18;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  if (!player || !openSession) return;
  const activity = clipActivity(openSession.events, player.durationNs, LANE_BUCKETS);
  const barW = w / activity.length;
  const style = getComputedStyle(document.documentElement).getPropertyValue("--clip").trim() || "#6a8fd8";
  ctx.fillStyle = style || "#6a8fd8";
  const bw = Math.max(1, barW - 1);
  const rowStride = LED_ROW_SEG_PX + LED_ROW_GAP_PX;
  for (let i = 0; i < activity.length; i++) {
    const bh = Math.max(1, activity[i]! * (h - 2));
    const x = i * barW;
    const top = h - bh;
    for (let y = h; y > top; y -= rowStride) {
      const segH = Math.min(LED_ROW_SEG_PX, y - top);
      ctx.fillRect(x, y - segH, bw, segH);
    }
  }
}

/** #ruleractivitytoggle's own state — never persisted: a view preference
 *  for THIS look, not an edit decision, so it resets to off (declutter by
 *  default) each time the editor opens, the same way "Viewer's eye" does. */
function toggleRulerActivity(): void {
  const btn = $("ruleractivitytoggle") as HTMLButtonElement;
  const ruler = $("ruler") as HTMLElement;
  const on = btn.getAttribute("aria-pressed") !== "true";
  btn.setAttribute("aria-pressed", String(on));
  ruler.toggleAttribute("data-activity", on);
}
$("ruleractivitytoggle").addEventListener("click", toggleRulerActivity);



/** A crisp square-cell checkerboard (STC-444 slice 2: "LCD crisp", finer of
 *  the two pitches compared) rather than a soft blur — `bg` is the gap
 *  color between lit cells, so it should be the lane's own background. */
const DITHER_TILE_PX = 4;
function ditherPattern(ctx: CanvasRenderingContext2D, color: string, bg: string): CanvasPattern {
  const tile = document.createElement("canvas");
  tile.width = DITHER_TILE_PX; tile.height = DITHER_TILE_PX;
  const tctx = tile.getContext("2d")!;
  tctx.fillStyle = bg;
  tctx.fillRect(0, 0, DITHER_TILE_PX, DITHER_TILE_PX);
  tctx.fillStyle = color;
  const half = DITHER_TILE_PX / 2;
  tctx.fillRect(0, 0, half, half);
  tctx.fillRect(half, half, half, half);
  return ctx.createPattern(tile, "repeat")!;
}

function drawZoomLane(): void {
  const canvas = $("zoom-curve") as HTMLCanvasElement;
  const wrap = $("zoom-canvas-wrap") as HTMLElement;
  const w = Math.max(1, Math.round(wrap.getBoundingClientRect().width)) || LANE_BUCKETS;
  const h = 22;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  if (!player || !openSession || !openProject) return;
  const curve = zoomCurve(
    (tNs) => render(openProject!, openSession!, tNs).zoom.amount,
    player.durationNs,
    LANE_BUCKETS,
  );
  // STC-330: a FILLED area, not a stroked line — the same sampled curve now
  // reads as one trapezoid per derived window (ease-in ramp, flat top,
  // ease-out ramp), with #override-blocks laying the click targets over it.
  // Nothing about the sampling changed; only how it is drawn.
  // STC-444 slice 2: the fill itself is a dithered --zoom-fill checkerboard
  // now, not solid --zoom (which still owns the override-selection accents
  // — see editor.html's --zoom-fill comment for why those stayed separate).
  const fillColor = getComputedStyle(document.documentElement).getPropertyValue("--zoom-fill").trim() || "#4f7fe0";
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0a0a0b";
  ctx.fillStyle = ditherPattern(ctx, fillColor, bg);
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * w;
    // amount is not clamped to [0, 1] (zoom.ts's own note) — draw whatever
    // comes back, clipped to the lane's own height rather than pretending it
    // cannot exceed 1.
    const y = h - Math.max(0, Math.min(1, curve[i]!)) * (h - 2) - 1;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
}

function redrawLanes(): void { drawRulerActivity(); drawZoomLane(); layoutOverrideBlocks(); }
window.addEventListener("resize", redrawLanes);

// ---- manual zoom override (STC-330/331) — the block lane's editing half ---
//
// Selecting a block puts the preview into an EDIT mode: the player is made
// to draw the UNZOOMED frame for as long as editing lasts (by temporarily
// removing this window's own entry from the LIVE project.overrides it
// reads — PreviewPlayer holds that object by reference and re-reads it on
// every draw, so no second render path is needed), which is what lets a
// pointer pixel on #stage map straight to capture UV with no crop to invert.
// The rect and preset are held in a DRAFT until committed, so entering edit
// mode to just look and then leaving with no drag restores the original
// override exactly rather than deleting it as a side effect.
//
// STC-331 adds a SECOND kind of editing target: a window with no derived
// counterpart at all. `editingWindowId` (a derived window's own identity)
// and `editingManualId` (a manual override's own `id`) are mutually
// exclusive — never both set — and every shared piece of state below
// (draftRect, draftEasing, the rect tool, the preset picker, Done/Remove/
// Escape) works on whichever is currently open. What is NOT shared is
// timing: a manual window carries its own startNs/endNs (draftManualStart/
// End below), since there is no derived window to read them from.

let editingWindowId: string | null = null;
let editingManualId: string | null = null;
let draftRect: Rect | null = null;
let draftEasing: ZoomPreset | "" = "";
let draftManualStart = 0;
let draftManualEnd = 0;
let dragAnchorUv: { x: number; y: number } | null = null;
let resizingManualEdge: "start" | "end" | undefined;

/**
 * The floor under a manually authored window's own duration (STC-331).
 * Reused from stage 1 rather than invented: a window narrower than the
 * time its OWN spring needs just to arrive never finishes arriving, so the
 * lead time is the natural floor rather than an arbitrary pixel or frame
 * count.
 */
const MIN_MANUAL_WINDOW_NS = ZOOM_LEAD_NS;

/** Every manually authored window currently on the LIVE project — never includes the one being edited (see selectManualWindow's own note). */
function manualEntries(): Extract<ZoomOverride, { kind: "manual" }>[] {
  return (openProject?.overrides ?? []).filter((o): o is Extract<ZoomOverride, { kind: "manual" }> => o.kind === "manual");
}

function overridesWithoutWindow(overrides: Project["overrides"], id: string): NonNullable<Project["overrides"]> {
  return (overrides ?? []).filter((o) => !(o.kind === "geometry" && o.windowId === id));
}

/** Strips a `retime` entry for `id` (STC-329) — the sibling of `overridesWithoutWindow`'s geometry-only filter, kept separate rather than folded in: a geometry drag and a retime drag commit independently (dragging the rect must not discard a prior retime, and vice versa). */
function overridesWithoutRetime(overrides: Project["overrides"], id: string): NonNullable<Project["overrides"]> {
  return (overrides ?? []).filter((o) => !(o.kind === "retime" && o.windowId === id));
}

function overridesWithoutManual(overrides: Project["overrides"], id: string): NonNullable<Project["overrides"]> {
  return (overrides ?? []).filter((o) => !(o.kind === "manual" && o.id === id));
}

/**
 * A click at `clickNs`, expanded into the locked stage-1 timing shape (300ms
 * lead, 2500ms hold) as a STARTING size — the ticket's own words. Mirrors
 * `zoom.ts`'s own derivation (`startNs = e.t - LEAD`, `endNs = e.t + HOLD`)
 * exactly, treating the click the way a real trigger event would be
 * treated, so the two ways a window can come to exist agree on what "300ms
 * lead, 2500ms hold" means. Independently clamped into [0, duration] rather
 * than clamped-then-shifted, matching `zoomWindows`'s own clamp — a click
 * in the take's first 300ms opens a window that starts at 0, shorter than
 * the shape, exactly as a real trigger there would.
 */
function defaultManualSpan(clickNs: number, durationNs: number): { startNs: number; endNs: number } {
  let startNs = Math.max(0, clickNs - ZOOM_LEAD_NS);
  let endNs = Math.min(durationNs, clickNs + ZOOM_HOLD_NS);
  if (endNs - startNs < MIN_MANUAL_WINDOW_NS) startNs = Math.max(0, endNs - MIN_MANUAL_WINDOW_NS);
  return { startNs, endNs };
}

function aspectWH(): number {
  return openCapture && openCapture.height > 0 ? openCapture.width / openCapture.height : 1;
}

/**
 * Client coordinates → CAPTURE UV. Valid only while editing, because that is
 * the one time #stage is guaranteed to be showing the whole frame at every
 * amount (see the header above) — a canvas pixel otherwise sits inside
 * whatever crop is currently playing, which this does not attempt to invert.
 */
function stageUv(clientX: number, clientY: number): { x: number; y: number } {
  const r = ($("stage") as HTMLCanvasElement).getBoundingClientRect();
  return {
    x: r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0,
    y: r.height > 0 ? Math.max(0, Math.min(1, (clientY - r.top) / r.height)) : 0,
  };
}

function drawOverrideBox(rect: Rect | null): void {
  const box = $("overridebox") as HTMLElement;
  if (!rect) { box.setAttribute("hidden", ""); return; }
  box.removeAttribute("hidden");
  box.style.left = `${rect.x * 100}%`;
  box.style.top = `${rect.y * 100}%`;
  box.style.width = `${rect.width * 100}%`;
  box.style.height = `${rect.height * 100}%`;
}

/** The DYNAMIC blocks only — derived windows (at their RESOLVED position —
 *  `resolvedWindows` applies any `removed`/`retime` override, STC-329 — a
 *  removed one is dropped from the list outright) and committed manual ones.
 *  The currently-edited window of EITHER kind is NOT drawn here; it lives on
 *  the static #manualdraft element so its resize handles survive a rebuild
 *  mid-drag (updateManualDraftBlock's own note). */
function layoutOverrideBlocks(): void {
  const container = $("override-blocks-dynamic") as HTMLElement;
  container.replaceChildren();
  if (!player || !openSession) return;
  const d = player.durationNs || 1;
  for (const w of resolvedWindows(zoomWindows(openSession.events), openProject?.overrides)) {
    const id = windowId(w);
    if (id === editingWindowId) continue; // shown on #manualdraft instead
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zoomblock";
    if (overrideFor(openProject?.overrides, w)) btn.classList.add("overridden");
    btn.style.left = `${(w.startNs / d) * 100}%`;
    btn.style.width = `${Math.max(0, ((w.endNs - w.startNs) / d) * 100)}%`;
    btn.setAttribute("aria-label", `Zoom window at ${fmtClock(w.startNs)}`);
    btn.addEventListener("click", () => {
      void selectDerivedWindow(w).catch((e: any) => alertUser(String(e?.message ?? e)));
    });
    container.appendChild(btn);
  }
  // Manual windows (STC-331): the one being edited is never in this list —
  // selectManualWindow strips it from project.overrides the same way a
  // derived window's geometry override is stripped, and a brand new one was
  // never in the array to begin with.
  for (const o of manualEntries()) {
    const btn = document.createElement("button");
    btn.type = "button";
    // Always "overridden": a manual window's existence IS its geometry, so
    // there is no un-overridden state for the dot to distinguish.
    btn.className = "zoomblock manual overridden";
    btn.style.left = `${(o.startNs / d) * 100}%`;
    btn.style.width = `${Math.max(0, ((o.endNs - o.startNs) / d) * 100)}%`;
    btn.setAttribute("aria-label", `Manual zoom window at ${fmtClock(o.startNs)}`);
    btn.addEventListener("click", () => {
      void selectManualWindow(o).catch((e: any) => alertUser(String(e?.message ?? e)));
    });
    container.appendChild(btn);
  }
}

/**
 * Writes the current draft into project.overrides and persists — an empty
 * draft means "no geometry override" (unchanged since STC-330).
 *
 * A `retime` entry (STC-329) is written or cleared independently, alongside
 * whatever this call decides about geometry: dragging the rect must not
 * discard a prior retime, and dragging an edge must not discard a prior
 * geometry override — the two compose (render.ts's own header says why:
 * retime changes WHEN, geometry/stage 2 still decide WHERE). Whether a
 * retime is needed is decided against the window's TRUE derived bounds,
 * looked up fresh here rather than trusted from whatever seeded
 * `draftManualStart`/`End` — those were seeded from the ALREADY-resolved
 * (possibly already-retimed) window, so comparing against them would miss a
 * retime that exactly undoes a previous one.
 */
async function commitDraft(): Promise<void> {
  if (!openProject || !editingWindowId || !openSession) return;
  const id = editingWindowId;
  const withoutGeometry = overridesWithoutWindow(openProject.overrides, id);
  const withGeometry = draftRect
    ? [...withoutGeometry, {
        kind: "geometry" as const, windowId: id, rect: draftRect,
        ...(draftEasing ? { easing: draftEasing } : {}),
      }]
    : withoutGeometry;

  const raw = zoomWindows(openSession.events).find((w) => windowId(w) === id);
  const withoutRetime = overridesWithoutRetime(withGeometry, id);
  const startChanged = !!raw && draftManualStart !== raw.startNs;
  const endChanged = !!raw && draftManualEnd !== raw.endNs;
  openProject.overrides = (startChanged || endChanged)
    ? [...withoutRetime, {
        kind: "retime" as const, windowId: id,
        ...(startChanged ? { startNs: draftManualStart } : {}),
        ...(endChanged ? { endNs: draftManualEnd } : {}),
      }]
    : withoutRetime;
  await persistProject();
}

/**
 * Writes the current manual draft into project.overrides and persists.
 * `easing` is REQUIRED on the schema (types.ts's own note says why), so an
 * unresolved "Project default" picker selection is resolved to the
 * project's CURRENT preset at commit time — a snapshot, not a live link;
 * a manual window has no `undefined` to mean "whatever the project says",
 * unlike a geometry override which does. An empty draft (Remove pressed)
 * deletes the window outright — there is no "no override" state for a
 * manual window to fall back to, since its rect and timing ARE the window.
 */
async function commitManualDraft(): Promise<void> {
  if (!openProject || !editingManualId) return;
  const withoutThis = overridesWithoutManual(openProject.overrides, editingManualId);
  openProject.overrides = draftRect
    ? [...withoutThis, {
        kind: "manual" as const, id: editingManualId, startNs: draftManualStart, endNs: draftManualEnd,
        rect: draftRect, easing: draftEasing || openProject.zoom?.preset || "standard",
      }]
    : withoutThis;
  await persistProject();
}

/**
 * Repositions the static #manualdraft block/handles from draft state, or
 * hides it — called on every resize-drag tick, so it must never touch DOM
 * STRUCTURE (a rebuild mid-drag would drop the pointer capture the handle
 * currently being dragged holds).
 *
 * The `zoomblock` class is applied here, not in the HTML, and cleared
 * while hidden: a `hidden` attribute stops an element being PAINTED, not
 * matched by a class selector, so a `.zoomblock` element sitting `hidden`
 * in the DOM would still count as one to any query that does not also
 * check visibility — which is exactly how `.zoomblock` counts are read in
 * this file's own E2E suite.
 *
 * Shown for EITHER kind of edit now (STC-329 gave a derived window its own
 * edge handles) — `.manual` is the one visual distinction that still
 * matters, and it is applied only for `editingManualId`.
 */
function updateManualDraftBlock(): void {
  const el = $("manualdraft") as HTMLElement;
  if ((!editingManualId && !editingWindowId) || !player) {
    el.setAttribute("hidden", "");
    el.className = "";
    return;
  }
  el.removeAttribute("hidden");
  el.className = editingManualId ? "zoomblock manual selected" : "zoomblock selected";
  const d = player.durationNs || 1;
  el.style.left = `${(draftManualStart / d) * 100}%`;
  el.style.width = `${Math.max(0, ((draftManualEnd - draftManualStart) / d) * 100)}%`;
}

/** Shared tail of every way an editor can open: shows the rect tool and
 *  override bar, seeds the preset picker and Remove/Delete button, and
 *  refreshes both block layers. */
function openOverrideEditorUI(): void {
  ($("overridepreset") as HTMLSelectElement).value = draftEasing;
  const clear = $("overrideclear") as HTMLButtonElement;
  clear.disabled = !draftRect;
  clear.textContent = editingManualId ? "Delete window" : "Remove override";
  // STC-329: a derived window's OWN delete — hidden for a manual one, whose
  // single delete action stays #overrideclear (there is no crop to reset a
  // manual window BACK to).
  const del = $("overridedelete") as HTMLButtonElement;
  if (editingWindowId) del.removeAttribute("hidden"); else del.setAttribute("hidden", "");
  ($("overridehint") as HTMLElement).textContent =
    "Drag a rect on the preview to zoom into it · drag the block's edges to change its timing";
  ($("overridebar") as HTMLElement).removeAttribute("hidden");
  ($("rectoverlay") as HTMLElement).removeAttribute("hidden");
  drawOverrideBox(draftRect);
  layoutOverrideBlocks();
  updateManualDraftBlock();
}

async function commitCurrentEdit(): Promise<void> {
  if (editingWindowId) await commitDraft();
  else if (editingManualId) await commitManualDraft();
}

/** The teardown half of leaving edit mode — shared by a normal close (which
 *  commits first) and a delete (which does not: there is nothing left to
 *  commit for a window that no longer exists). */
function resetEditingState(): void {
  editingWindowId = null;
  editingManualId = null;
  draftRect = null;
  draftEasing = "";
  draftManualStart = 0;
  draftManualEnd = 0;
  dragAnchorUv = null;
  resizingManualEdge = undefined;
  ($("overridebar") as HTMLElement).setAttribute("hidden", "");
  ($("rectoverlay") as HTMLElement).setAttribute("hidden", "");
  drawOverrideBox(null);
}

async function closeOverrideEditor(): Promise<void> {
  await commitCurrentEdit();
  resetEditingState();
  layoutOverrideBlocks();
  updateManualDraftBlock();
}

/**
 * STC-329: drops the DERIVED window under edit outright — it never plays
 * again, not even at its old crop. A separate action from `commitDraft`
 * (Done/Escape), because "delete" and "commit whatever is drafted" are
 * different intents: Done never has to interpret an empty draftRect as
 * "the user wants this window gone" the way a manual window's does.
 * Any prior `geometry`/`retime` entry for this id is stripped along with
 * it — moot once the window never plays, and leaving them would carry dead
 * weight into every future write.
 */
async function deleteDerivedWindow(): Promise<void> {
  if (!openProject || !editingWindowId) return;
  const id = editingWindowId;
  const withoutTuning = (openProject.overrides ?? []).filter(
    (o) => !((o.kind === "geometry" || o.kind === "retime") && o.windowId === id),
  );
  openProject.overrides = [...withoutTuning, { kind: "removed" as const, windowId: id }];
  resetEditingState();
  await persistProject();
  layoutOverrideBlocks();
  updateManualDraftBlock();
}

async function selectDerivedWindow(w: ZoomWindow): Promise<void> {
  if (!player || !openProject) return;
  await commitCurrentEdit(); // switching straight from one block to another
  const id = windowId(w);
  editingWindowId = id;
  const existing = overrideFor(openProject.overrides, w);
  draftRect = existing?.rect ?? null;
  draftEasing = existing?.easing ?? "";
  // Seeded from `w`'s own (already RESOLVED, possibly already-retimed)
  // bounds — re-opening a retimed window edits from where it currently
  // plays, not from the original derivation.
  draftManualStart = w.startNs;
  draftManualEnd = w.endNs;
  openProject.overrides = overridesWithoutWindow(openProject.overrides, id);
  openOverrideEditorUI();
  const mid = Math.min(player.durationNs, Math.round((w.startNs + w.endNs) / 2));
  await player.seek(mid);
}

/** Opens an EXISTING manual window (STC-331) for editing — the block-lane
 *  twin of selectDerivedWindow. Stripping its own entry from the live
 *  project.overrides is what removes it from layoutOverrideBlocks' list
 *  (manualEntries reads that same array), the same trick a geometry
 *  override's removal already relies on for the "editing shows unzoomed"
 *  behaviour. */
async function selectManualWindow(o: Extract<ZoomOverride, { kind: "manual" }>): Promise<void> {
  if (!player || !openProject) return;
  await commitCurrentEdit();
  editingManualId = o.id;
  draftManualStart = o.startNs;
  draftManualEnd = o.endNs;
  draftRect = o.rect;
  draftEasing = o.easing;
  openProject.overrides = overridesWithoutManual(openProject.overrides, o.id);
  openOverrideEditorUI();
  const mid = Math.min(player.durationNs, Math.round((o.startNs + o.endNs) / 2));
  await player.seek(mid);
}

/**
 * Creates a brand new manual window (STC-331) — a drag into an empty
 * stretch of the override lane, per the ticket. `clickNs` is where the
 * gesture landed; the WINDOW is always the default stage-1 shape at that
 * point (defaultManualSpan's own note) — a drag does not set a custom
 * duration directly, only resizing the created block's edges afterward
 * does, exactly as the ticket states it ("as a starting size, then
 * resizable"). The rect defaults to the same centred square a bare click
 * on the stage would give a geometry override (rectFromGesture's a === b
 * case), since a manual window's rect is REQUIRED and there is no
 * "nothing yet" state for it to start from.
 */
async function createManualWindow(clickNs: number): Promise<void> {
  if (!player || !openProject) return;
  await commitCurrentEdit();
  const { startNs, endNs } = defaultManualSpan(clickNs, player.durationNs);
  editingManualId = crypto.randomUUID();
  draftManualStart = startNs;
  draftManualEnd = endNs;
  draftRect = rectFromGesture({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, aspectWH());
  draftEasing = "";
  openOverrideEditorUI();
  const mid = Math.min(player.durationNs, Math.round((startNs + endNs) / 2));
  await player.seek(mid);
}

$("override-blocks").addEventListener("click", (e) => {
  // A block (derived, manual, or the draft block/its handles) owns its own
  // click — this only fires for the lane's empty background, which is the
  // "empty stretch" the ticket means.
  if (e.target !== e.currentTarget || !player) return;
  const clickNs = frameToNs(frameAtClientX((e as MouseEvent).clientX), player.durationNs);
  void createManualWindow(clickNs).catch((err: any) => alertUser(String(err?.message ?? err)));
});

function onManualHandleDown(edge: "start" | "end", e: PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  resizingManualEdge = edge;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onManualHandleMove(e: PointerEvent): void {
  if (!resizingManualEdge || !player) return;
  const wanted = frameToNs(frameAtClientX(e.clientX), player.durationNs);
  if (resizingManualEdge === "start") {
    draftManualStart = Math.max(0, Math.min(wanted, draftManualEnd - MIN_MANUAL_WINDOW_NS));
  } else {
    draftManualEnd = Math.min(player.durationNs, Math.max(wanted, draftManualStart + MIN_MANUAL_WINDOW_NS));
  }
  updateManualDraftBlock();
}
function onManualHandleUp(): void { resizingManualEdge = undefined; }
$("manualhandle-start").addEventListener("pointerdown", (e) => onManualHandleDown("start", e as PointerEvent));
$("manualhandle-end").addEventListener("pointerdown", (e) => onManualHandleDown("end", e as PointerEvent));
$("manualhandle-start").addEventListener("pointermove", (e) => onManualHandleMove(e as PointerEvent));
$("manualhandle-end").addEventListener("pointermove", (e) => onManualHandleMove(e as PointerEvent));
$("manualhandle-start").addEventListener("pointerup", onManualHandleUp);
$("manualhandle-end").addEventListener("pointerup", onManualHandleUp);
$("manualhandle-start").addEventListener("pointercancel", onManualHandleUp);
$("manualhandle-end").addEventListener("pointercancel", onManualHandleUp);

$("rectoverlay").addEventListener("pointerdown", (e) => {
  if (!editingWindowId && !editingManualId) return;
  const pe = e as PointerEvent;
  (pe.currentTarget as HTMLElement).setPointerCapture(pe.pointerId);
  dragAnchorUv = stageUv(pe.clientX, pe.clientY);
  // A bare pointerdown with no move is already a valid gesture — the click
  // default (rectFromGesture's own a === b case) — so the box appears
  // immediately rather than waiting for a move that may never come.
  draftRect = rectFromGesture(dragAnchorUv, dragAnchorUv, aspectWH());
  drawOverrideBox(draftRect);
});
$("rectoverlay").addEventListener("pointermove", (e) => {
  if (!dragAnchorUv) return;
  const pe = e as PointerEvent;
  draftRect = rectFromGesture(dragAnchorUv, stageUv(pe.clientX, pe.clientY), aspectWH());
  drawOverrideBox(draftRect);
});
const endOverrideDrag = () => {
  if (!dragAnchorUv) return;
  dragAnchorUv = null;
  ($("overrideclear") as HTMLButtonElement).disabled = !draftRect;
  layoutOverrideBlocks(); // the "overridden" dot follows a fresh drag immediately, not just on Done
};
$("rectoverlay").addEventListener("pointerup", endOverrideDrag);
$("rectoverlay").addEventListener("pointercancel", endOverrideDrag);

$("overridepreset").addEventListener("change", () => {
  draftEasing = ($("overridepreset") as HTMLSelectElement).value as ZoomPreset | "";
});
$("overrideclear").addEventListener("click", () => {
  draftRect = null;
  void closeOverrideEditor().catch((e: any) => alertUser(String(e?.message ?? e)));
});
$("overridedelete").addEventListener("click", () => {
  void deleteDerivedWindow().catch((e: any) => alertUser(String(e?.message ?? e)));
});
$("overridedone").addEventListener("click", () => {
  void closeOverrideEditor().catch((e: any) => alertUser(String(e?.message ?? e)));
});
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || (!editingWindowId && !editingManualId)) return;
  e.preventDefault();
  void closeOverrideEditor().catch((err: any) => alertUser(String(err?.message ?? err)));
});

// ---- export size --------------------------------------------------------

function updateOutputSizeUI(): void {
  if (!openProject || !openCapture) return;
  const sel = $("outsize") as HTMLSelectElement;
  const out = openProject.output;
  const opts = outputOptions(openCapture);
  const known = selectedOption(openCapture, out);

  sel.replaceChildren();
  if (!known) {
    const o = document.createElement("option");
    o.value = "custom";
    o.textContent = `Custom · ${out.width}×${out.height}`;
    sel.append(o);
  }
  for (const opt of opts) {
    const o = document.createElement("option");
    o.value = opt.id;
    o.textContent = opt.label;
    o.disabled = opt.upscales;
    if (opt.upscales) o.textContent += " — larger than the capture";
    sel.append(o);
  }
  sel.value = known ? known.id : "custom";

  const note = $("outsizenote");
  note.textContent = known?.id === "capture" || (!known && sameAsCapture(out))
    ? "No rescale."
    : `Capture is ${openCapture.width}×${openCapture.height}.`;
}

const sameAsCapture = (out: Size) =>
  !!openCapture && out.width === openCapture.width && out.height === openCapture.height;

async function setOutputSize(opt: OutputOption): Promise<void> {
  if (!openProject || !player) return;
  const previous = { ...openProject.output };
  openProject.output.width = opt.size.width;
  openProject.output.height = opt.size.height;

  try {
    await persistProject();
  } catch (e) {
    openProject.output.width = previous.width;
    openProject.output.height = previous.height;
    updateOutputSizeUI();
    throw e;
  }

  updateOutputSizeUI();
  if (player.viewSize) await player.setViewSize(viewSizeForEmbed());
  else await player.outputResized();
  updateLegibilityUI();
}

$("outsize").addEventListener("change", () => {
  if (!openProject || !openCapture) return;
  const id = ($("outsize") as HTMLSelectElement).value;
  const opt = outputOptions(openCapture).find((o) => o.id === id);
  if (!opt || opt.upscales) { updateOutputSizeUI(); return; }
  void setOutputSize(opt).catch((e: any) => alertUser(String(e?.message ?? e)));
});

// ---- legibility + viewer's eye (STC-318), inside the export dialog ---------

function updateLegibilityUI(): void {
  if (!openProject || !openDisplay || !player || !openSession) return;
  const sel = $("embedtarget") as HTMLSelectElement;
  if (sel.options.length === 0) {
    for (const t of EMBED_TARGETS) {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = `${t.label} · ${t.widthPx}px`;
      sel.append(o);
    }
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = "Custom width";
    sel.append(custom);
  }
  const known = EMBED_TARGETS.find((t) => t.widthPx === embedWidthPx);
  sel.value = known?.id ?? "custom";
  ($("embedwidth") as HTMLInputElement).value = String(embedWidthPx);
  ($("textpt") as HTMLInputElement).value = String(openProject.textPt ?? DEFAULT_TEXT_PT);

  const fs = render(openProject, openSession, player.currentNs);
  const l = legibility(openDisplay, openProject.textPt ?? DEFAULT_TEXT_PT,
                       embedWidthPx, zoomFactorForCrop(fs.zoom.crop.width));
  const out = $("legibility");
  // Warns below 9pt; never blocks (STC-373's own scope line) — the export
  // button beside it stays enabled either way.
  out.textContent = legibilitySentence(l);
  out.classList.toggle("warn", l.verdict === "warn");

  ($("vieweye") as HTMLInputElement).checked = player.viewSize !== null;
}

function viewSizeForEmbed(): Size | null {
  if (!openProject) return null;
  return outputSizeFor(openProject.output, embedWidthPx);
}

function applyStageDisplay(): void {
  const stage = $("stage") as HTMLCanvasElement;
  const view = player?.viewSize ?? null;
  if (view) {
    stage.style.setProperty("--vieweye-w", `${embedWidthPx}px`);
    stage.dataset.vieweye = "";
  } else {
    stage.style.removeProperty("--vieweye-w");
    delete stage.dataset.vieweye;
  }
}

async function setEmbedWidth(px: number): Promise<void> {
  embedWidthPx = Math.max(80, Math.min(4096, Math.round(px)));
  updateLegibilityUI();
  if (player?.viewSize) await player.setViewSize(viewSizeForEmbed());
  applyStageDisplay();
}

$("embedtarget").addEventListener("change", () => {
  const id = ($("embedtarget") as HTMLSelectElement).value;
  const t = EMBED_TARGETS.find((x) => x.id === id);
  if (t) void setEmbedWidth(t.widthPx).catch((e: any) => alertUser(String(e?.message ?? e)));
  else updateLegibilityUI();
});

$("embedwidth").addEventListener("change", () => {
  void setEmbedWidth(Number(($("embedwidth") as HTMLInputElement).value))
    .catch((e: any) => alertUser(String(e?.message ?? e)));
});

$("textpt").addEventListener("change", () => {
  if (!openProject) return;
  const v = Number(($("textpt") as HTMLInputElement).value);
  if (Number.isFinite(v) && v > 0 && v <= 144) openProject.textPt = v;
  updateLegibilityUI();
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});

$("vieweye").addEventListener("change", () => {
  if (!player) return;
  const on = ($("vieweye") as HTMLInputElement).checked;
  void player.setViewSize(on ? viewSizeForEmbed() : null)
    .then(() => { applyStageDisplay(); updateLegibilityUI(); })
    .catch((e: any) => alertUser(String(e?.message ?? e)));
});

// ---- the export dialog -------------------------------------------------

const exportDialog = $("exportdialog") as HTMLDialogElement;
$("openexport").addEventListener("click", () => {
  if (!exportDialog.open) exportDialog.showModal();
  void refreshShareRow();
});
$("closeexport").addEventListener("click", () => exportDialog.close());

// ---- opening and closing the take -------------------------------------

const VIDEO_CHUNK_BYTES = 32 * 1024 * 1024;

async function readVideo(name = "display.mp4"): Promise<ArrayBuffer> {
  const size = await editor.takeFileSize(name);
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += VIDEO_CHUNK_BYTES) {
    const length = Math.min(VIDEO_CHUNK_BYTES, size - offset);
    out.set(new Uint8Array(await editor.readTakeChunk(name, offset, length)), offset);
  }
  return out.buffer;
}

async function openTakeOrThrow(dir: string): Promise<void> {
  await closeTake();
  await editor.openPreview(dir);

  const dec = new TextDecoder();
  const [anchors, events, mp4, projectRaw, profileHint] = await Promise.all([
    editor.readTakeFile("anchors.json").then((b) => JSON.parse(dec.decode(b))),
    editor.readTakeFile("events.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => ({ version: 1, events: [] })),
    readVideo(),
    editor.readTakeFile("project.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => null),
    // STC-447: present only on a take recorded with a profile selected, and
    // only until this, its first open — see `writeRecordingProfileHint`
    // (main.ts) and `PROFILE_HINT_FILE`'s own doc comment for why main
    // leaves this as two plain numbers rather than a real `project.json`.
    editor.readTakeFile(PROFILE_HINT_FILE).then((b) => JSON.parse(dec.decode(b)) as Size)
      .catch(() => null),
  ]);
  const cameraMp4 = anchors.files?.camera ? await readVideo(anchors.files.camera) : undefined;
  // STC-233: same reasoning as cameraMp4 above, one track over.
  const micM4a = anchors.files?.mic ? await readVideo(anchors.files.mic) : undefined;
  const session = await loadSession({ anchors, events, displayMp4: mp4, cameraMp4, micM4a });
  const durationNs = session.frames[session.frames.length - 1] ?? 0;
  // A hint only ever applies to a take with no project.json yet — once one
  // exists (this take was opened before, or hand-authored), its own output
  // size is the truth and the hint, if still on disk, is stale and ignored.
  const seedSize = projectRaw == null
    && Number.isInteger(profileHint?.width) && Number.isInteger(profileHint?.height)
    ? profileHint! : { width: anchors.capture.width, height: anchors.capture.height };
  const project = parseProject(
    projectRaw, seedSize.width, seedSize.height, durationNs,
    anchors.camera?.present === true,
  );

  openSession = session;
  openProject = project;
  openCapture = { width: anchors.capture.width, height: anchors.capture.height };
  openDisplay = { pointWidth: anchors.display.pointWidth };
  player = new PreviewPlayer($("stage") as HTMLCanvasElement, session, project);
  const scrub = $("scrub") as HTMLInputElement;
  scrub.max = String(lastFrame(player.durationNs));
  scrub.value = "0";
  player.onTime = (tNs, playing) => {
    const frame = nsToFrame(tNs, player!.durationNs);
    setClock(formatReadout(frame, player!.durationNs));
    setPlayState(playing);
    $("shuttle").textContent = formatShuttle(player!.rate);
    if (!scrubbing) scrub.value = String(frame);
    updateRulerPlayhead(tNs);
  };
  await player.seek(player.firstRenderableNs);
  resetSpan();
  updateTrimUI();
  updateOutputSizeUI();
  updateLegibilityUI();
  applySpanTransform();
  redrawLanes();
}

async function closeTake(): Promise<void> {
  exportAbort?.abort();
  $("framestatus").setAttribute("hidden", "");
  // Not commitDraft()+closeOverrideEditor(): the take (and its project) are
  // going away regardless, and persisting a draft against a project about to
  // be discarded would be a write nobody asked for. Just drop the state.
  editingWindowId = null;
  draftRect = null;
  draftEasing = "";
  dragAnchorUv = null;
  player?.close();
  player = undefined;
  openSession = undefined;
  openProject = undefined;
  openCapture = undefined;
  openDisplay = undefined;
  applyStageDisplay();
  await editor.closePreview();
}

// ---- the header row's transport (STC-444) -----------------------------
//
// Every button here is the SAME action its key already is — `decideKey`
// decides, the button only builds the chord — so a click and a keystroke
// cannot drift apart. Home/End go to the trim's in/out points (scrubber.ts's
// ScrubState note), which is what `|<` and `>|` mean.

/** `formatReadout`'s "current / duration", split across the two spans the
 *  narrow-width container query needs — `#clock`'s textContent is unchanged. */
let shownReadout = "";
function setClock(readout: string): void {
  if (readout === shownReadout) return;
  shownReadout = readout;
  const at = readout.indexOf(" / ");
  $("clock-cur").textContent = at < 0 ? readout : readout.slice(0, at);
  ($("clock").querySelector(".clock-dur") as HTMLElement).textContent = at < 0 ? "" : readout.slice(at);
}

/** Written only on a CHANGE: onTime fires every frame, and three attribute
 *  writes per frame is style invalidation the playhead does not need. */
let shownPlaying: boolean | undefined;
function setPlayState(playing: boolean): void {
  if (playing === shownPlaying) return;
  shownPlaying = playing;
  const btn = $("playpause") as HTMLButtonElement;
  btn.toggleAttribute("data-playing", playing);
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
  btn.title = playing ? "Pause (Space · K)" : "Play (Space · K)";
  $("stageplay").toggleAttribute("hidden", playing);
}

function togglePlay(): void {
  if (!player) return;
  player.isPlaying ? player.pause() : player.play(1);
  updateShuttleUI();
}

function pressKey(key: string, shiftKey = false): void {
  if (!player || !openProject) return;
  const action = decideKey({ key, shiftKey }, scrubState());
  if (action) applyScrubAction(action);
}

$("playpause").addEventListener("click", togglePlay);
$("toin").addEventListener("click", () => pressKey("Home"));
$("toout").addEventListener("click", () => pressKey("End"));
$("stepback").addEventListener("click", (e) => pressKey("ArrowLeft", (e as MouseEvent).shiftKey));
$("stepfwd").addEventListener("click", (e) => pressKey("ArrowRight", (e as MouseEvent).shiftKey));
// The preview itself is the play button's second face, never a second
// control (#rectoverlay sits over it while a zoom block is being edited, so
// this never fires mid-edit).
$("stage").addEventListener("click", togglePlay);
$("closepreview").addEventListener("click", () => window.close());
$("scrub").addEventListener("pointerdown", () => { scrubbing = true; });
$("scrub").addEventListener("pointerup", () => { scrubbing = false; });
$("scrub").addEventListener("pointercancel", () => { scrubbing = false; });
$("scrub").addEventListener("input", () => {
  if (!player) return;
  void player.seek(frameToNs(Number(($("scrub") as HTMLInputElement).value), player.durationNs));
});

// ---- keyboard grammar (STC-338 rule 8) --------------------------------

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (tag !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return type !== "range" && type !== "checkbox" && type !== "button";
}

const RANGE_NATIVE_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "PageUp", "PageDown", "Home", "End",
]);

window.addEventListener("keydown", (e) => {
  if (!player || !openProject) return;
  if (e.target === $("scrub") && RANGE_NATIVE_KEYS.has(e.key)) e.preventDefault();
  const action = decideKey(
    {
      key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey,
      ctrlKey: e.ctrlKey, altKey: e.altKey,
      inTextField: isTextField(document.activeElement),
    },
    scrubState(),
  );
  if (!action) return;
  e.preventDefault();
  applyScrubAction(action);
});

function currentFrame(): number {
  return player ? nsToFrame(player.currentNs, player.durationNs) : 0;
}

function scrubState(): ScrubState {
  const durationNs = player?.durationNs ?? 0;
  const trim = openProject?.trim;
  return {
    frame: currentFrame(), durationNs, rate: player?.rate ?? 0,
    ...(trim ? { trimIn: nsToFrame(trim.startNs, durationNs), trimOut: nsToFrame(trim.endNs, durationNs) } : {}),
    bookmarks: (openProject?.bookmarks ?? []).map((ns) => nsToFrame(ns, durationNs)),
  };
}

function applyScrubAction(action: ScrubAction): void {
  if (!player || !openProject) return;
  switch (action.kind) {
    case "seek":
      if (player.rate !== 0) player.pause();
      void player.seek(frameToNs(action.frame, player.durationNs));
      break;
    case "shuttle":
      action.rate === 0 ? player.pause() : player.play(action.rate);
      updateShuttleUI();
      break;
    case "mark": {
      const t = player.currentNs;
      const min = minTrimNs(openProject.output.fps);
      if (action.which === "in") {
        const end = openProject.trim?.endNs ?? player.durationNs;
        setTrim(t, t + min > end ? player.durationNs : end, true);
      } else {
        const start = openProject.trim?.startNs ?? 0;
        setTrim(t < start + min ? 0 : start, t, true);
      }
      break;
    }
    case "bookmark":
      toggleBookmarkAtPlayhead();
      break;
  }
}

function updateShuttleUI(): void {
  $("shuttle").textContent = formatShuttle(player?.rate ?? 0);
  setPlayState(!!player?.isPlaying);
}

$("markin").addEventListener("click", () => {
  if (!player || !openProject) return;
  const t = player.currentNs;
  const end = openProject.trim?.endNs ?? player.durationNs;
  const min = minTrimNs(openProject.output.fps);
  setTrim(t, t + min > end ? player.durationNs : end, true);
});
$("markout").addEventListener("click", () => {
  if (!player || !openProject) return;
  const t = player.currentNs;
  const start = openProject.trim?.startNs ?? 0;
  const min = minTrimNs(openProject.output.fps);
  setTrim(t < start + min ? 0 : start, t, true);
});
$("resettrim").addEventListener("click", () => {
  if (!player) return;
  setTrim(0, player.durationNs, true);
});

function frameAtClientX(clientX: number): number {
  const r = $("timeline").getBoundingClientRect();
  const t = r.width <= 0 ? 0 : (clientX - r.left) / r.width;
  return frameAtFraction(t, player?.durationNs ?? 0);
}

let dragging: "in" | "out" | undefined;
function onHandleDown(which: "in" | "out", e: PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  dragging = which;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onHandleMove(e: PointerEvent): void {
  if (!dragging || !player || !openProject) return;
  const durationNs = player.durationNs;
  const startFrame = nsToFrame(openProject.trim?.startNs ?? 0, durationNs);
  const endFrame = nsToFrame(openProject.trim?.endNs ?? durationNs, durationNs);
  const wanted = frameAtClientX(e.clientX);
  const opposite = dragging === "in" ? endFrame : startFrame;
  const { clamped, held } = clampTrimFrame(dragging, wanted, opposite, durationNs);

  if (dragging === "in") setTrim(frameToNs(clamped, durationNs), frameToNs(endFrame, durationNs), false);
  else setTrim(frameToNs(startFrame, durationNs), frameToNs(clamped, durationNs), false);

  const handle = $(dragging === "in" ? "trim-in" : "trim-out");
  if (held) {
    const r = $("timeline").getBoundingClientRect();
    const clampedX = r.left + fractionOfFrame(clamped, durationNs) * r.width;
    const excess = dragging === "in" ? e.clientX - clampedX : clampedX - e.clientX;
    const band = rubberBandPx(excess) * (dragging === "in" ? 1 : -1);
    handle.classList.add("held");
    handle.style.marginLeft = `${-5 + band}px`;
  } else {
    handle.classList.remove("held");
    handle.style.marginLeft = "";
  }
}

function onHandleUp(): void {
  if (!dragging) return;
  for (const id of ["trim-in", "trim-out"]) {
    $(id).classList.remove("held");
    $(id).style.marginLeft = "";
  }
  dragging = undefined;
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
}
$("trim-in").addEventListener("pointerdown", (e) => onHandleDown("in", e as PointerEvent));
$("trim-out").addEventListener("pointerdown", (e) => onHandleDown("out", e as PointerEvent));
$("trim-in").addEventListener("pointermove", (e) => onHandleMove(e as PointerEvent));
$("trim-out").addEventListener("pointermove", (e) => onHandleMove(e as PointerEvent));
$("trim-in").addEventListener("pointerup", onHandleUp);
$("trim-out").addEventListener("pointerup", onHandleUp);
$("trim-in").addEventListener("pointercancel", onHandleUp);
$("trim-out").addEventListener("pointercancel", onHandleUp);

// ---- export -------------------------------------------------------------

async function runExport(): Promise<void> {
  if (!openSession || !openProject || exportAbort) return;
  player?.pause();
  exportAbort = new AbortController();

  const bar = $("exportbar");
  const progress = $("exportprogress") as HTMLProgressElement;
  const status = $("exportstatus");
  bar.removeAttribute("hidden");
  ($("export") as HTMLButtonElement).disabled = true;
  ($("outsize") as HTMLSelectElement).disabled = true;
  progress.value = 0;
  status.textContent = "Exporting…";
  clearAlert();

  const started = performance.now();
  const exporting: Project = structuredClone(openProject);
  try {
    // STC-413: the bundle's stable identity, so the written MP4 can point
    // back at its source after a Finder rename or move. Best-effort, same as
    // main.ts's still-export path — a bundle that cannot be tagged (a
    // deleted take directory, an IPC hiccup) should not cost the user the
    // export itself.
    let captureId: string | undefined;
    try { captureId = await editor.captureId(); }
    catch (e) { console.error("[export] could not resolve a capture id:", e); }

    const result = await exportSession(openSession, exporting, {
      hash: true,
      captureId,
      signal: exportAbort.signal,
      onProgress: (done, total) => {
        progress.value = Math.round((done / total) * 1000);
        const elapsed = (performance.now() - started) / 1000;
        const rate = done / Math.max(elapsed, 0.001);
        const left = Math.max(0, Math.round((total - done) / Math.max(rate, 0.001)));
        status.textContent = `${done} / ${total} frames · ~${left}s left`;
      },
    });

    if (result.cancelled) { status.textContent = "Cancelled."; return; }

    const name = exportMediaName(takeName);
    await editor.writeExport(name, result.encoded!.buffer as ArrayBuffer);
    const lastNs = openSession.frames[openSession.frames.length - 1] ?? 0;
    await editor.writeExport(exportManifestName(takeName), new TextEncoder().encode(JSON.stringify({
      version: 1,
      transform: { version: TRANSFORM_VERSION },
      frames: result.frames,
      preEncodeHash: result.hash,
      encodedBytes: result.encodedBytes,
      micEncodedChunks: result.micEncodedChunks,
      audioOutputChunks: result.audioOutputChunks,
      output: exporting.output,
      trim: projectForWrite(exporting, lastNs).trim ?? null,
      legibility: openDisplay ? (() => {
        const l = legibility(openDisplay!, exporting.textPt ?? DEFAULT_TEXT_PT, embedWidthPx);
        return { textPt: l.textPt, embedWidthPx: l.embedWidthPx, textPx: l.textPx, verdict: l.verdict };
      })() : null,
      exportDurationMs: result.durationMs,
    }, null, 2)).buffer as ArrayBuffer);

    status.textContent = `Done — ${result.frames} frames, ${(result.encodedBytes / 1e6).toFixed(1)} MB`;
  } catch (e: any) {
    status.textContent = "Failed.";
    alertUser(`Export failed: ${e?.message ?? e}`);
  } finally {
    exportAbort = undefined;
    ($("export") as HTMLButtonElement).disabled = false;
    ($("outsize") as HTMLSelectElement).disabled = false;
  }
}

$("export").addEventListener("click", () => void runExport());
$("cancelexport").addEventListener("click", () => exportAbort?.abort());

// ---- share, folded into the export dialog (STC-444 slice 3) ---------------
//
// Used to be its own row under the timeline with its own folder picker and a
// standing "Show published" button. The picker moved to the main window's
// Preferences (one site folder for the whole app, not a per-editor-window
// control); "Show published" folded into this row's own success feedback —
// #sharereveal appears only after a publish THIS SESSION succeeds, per
// main.ts's `share:reveal` comment on why a stale reveal is worse than none.

function shareStatus(text: string): void { $("sharestatus").textContent = text; }

/** What the slug field starts showing: whatever this take was last
 *  published under, or a live default from its own name if never shared. */
function currentSlugOrDefault(): string {
  return openProject?.slug ?? autoSlug(takeName);
}

/** Re-synced every time the dialog opens, not cached: the site folder can
 *  change in the main window's Preferences while this window stays open. */
async function refreshShareRow(): Promise<void> {
  ($("shareslug") as HTMLInputElement).value = currentSlugOrDefault();
  $("sharereveal").setAttribute("hidden", "");
  shareStatus("");
  const { share } = await editor.getSettings();
  $("sitedestnote").textContent = share.destination
    ? `→ ${share.destination}` : "No site folder set — choose one in Preferences.";
}

async function publish(): Promise<void> {
  if (!openProject || !player) return;
  const btn = $("share") as HTMLButtonElement;
  const slug = ($("shareslug") as HTMLInputElement).value.trim();
  if (!slugIsValid(slug)) {
    shareStatus(`"${slug}" is not a usable name. Lowercase letters, digits and hyphens only.`);
    return;
  }
  btn.disabled = true;
  $("sharereveal").setAttribute("hidden", "");
  shareStatus("Copying…");
  try {
    // Committed BEFORE asking main to publish: `share:publish` reads
    // project.json fresh rather than taking the slug as an argument (one
    // value, one owner), so whatever is about to be shown as shared has to
    // already be on disk when that read happens.
    if (openProject.slug !== slug) {
      openProject.slug = slug;
      await persistProject();
    }
    const r = await editor.publish();
    if (!r.ok) { shareStatus(r.message ?? "Could not share."); return; }
    const verb = r.replaced ? "Replaced" : "Wrote";
    shareStatus(`${verb} ${r.name}. Snippet copied.`);
    $("sharereveal").removeAttribute("hidden");
    if (r.snippet) await navigator.clipboard.writeText(r.snippet).catch(() => {
      shareStatus(`${verb} ${r.name}. (Could not copy the snippet.)`);
    });
  } catch (e: any) {
    shareStatus(`Failed: ${e?.message ?? e}`);
  } finally {
    btn.disabled = false;
  }
}

$("share").addEventListener("click", () => void publish());
$("sharereveal").addEventListener("click", () => void (async () => {
  const r = await editor.revealPublished();
  if (!r.ok) shareStatus(r.message ?? "Nothing published yet.");
})());

// ---- the current frame as a still (STC-298/293) ----------------------------

/** The header's quiet confirmation line. It fades after a few seconds but
 *  keeps its text, so what was last copied or saved is still readable. */
let frameStatusFade: ReturnType<typeof setTimeout> | undefined;
function frameStatus(text: string): void {
  const el = $("framestatus");
  el.textContent = text;
  el.title = text;
  el.removeAttribute("hidden");
  el.classList.remove("stale");
  clearTimeout(frameStatusFade);
  frameStatusFade = setTimeout(() => el.classList.add("stale"), 4000);
}

function frameTemplate(tNs: number): string {
  return `frame-${takeName}-${Math.round(tNs / 1e6)}ms`;
}

let frameBusy = false;
async function withFrame(action: "copy" | "save"): Promise<void> {
  if (!player || frameBusy) return;
  frameBusy = true;
  try {
    const { tNs, rgba, width, height } = await player.captureFrame();
    const settings = (await editor.getSettings()).still;
    const r = await editor.exportStill({
      bytes: rgba, width, height, alpha: false, colorSpace: "srgb",
      target: { file: action === "save", clipboard: action === "copy" },
      options: { ...settings, template: frameTemplate(tNs) },
      info: { app: takeName, mode: "frame" },
      ...(takeDir ? { dir: takeDir } : {}),
    });
    if (!r.ok) throw new Error(r.detail ?? r.code ?? "export failed");
    if (action === "copy") {
      frameStatus(`Copied frame at ${fmtClock(tNs)} (${r.width}×${r.height}`
        + `${r.clipboard?.length ? `, ${r.clipboard.join(" + ")}` : ""})`);
    } else {
      frameStatus(`Saved frame at ${fmtClock(tNs)} → ${r.file?.split("/").pop() ?? ""}`);
    }
  } catch (e: any) {
    alertUser(`Could not ${action} the frame: ${e?.message ?? e}`);
  } finally {
    frameBusy = false;
  }
}
// One icon (STC-444): click copies, ⌥-click saves, and a right-click on it
// OR on the preview opens a two-item menu with both.
$("framegrab").addEventListener("click", (e) => void withFrame((e as MouseEvent).altKey ? "save" : "copy"));

const frameMenu = $("framemenu") as HTMLElement;
function openFrameMenu(x: number, y: number): void {
  if (!player) return;
  frameMenu.removeAttribute("hidden");
  const r = frameMenu.getBoundingClientRect();
  frameMenu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  frameMenu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  ($("copyframe") as HTMLButtonElement).focus();
}
function closeFrameMenu(): void { frameMenu.setAttribute("hidden", ""); }
for (const id of ["framegrab", "stagewrap"]) {
  $(id).addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openFrameMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY);
  });
}
$("copyframe").addEventListener("click", () => { closeFrameMenu(); void withFrame("copy"); });
$("saveframe").addEventListener("click", () => { closeFrameMenu(); void withFrame("save"); });
document.addEventListener("pointerdown", (e) => {
  if (!frameMenu.hidden && !frameMenu.contains(e.target as Node)) closeFrameMenu();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !frameMenu.hidden) { e.preventDefault(); e.stopImmediatePropagation(); closeFrameMenu(); }
}, { capture: true });
document.addEventListener("keydown", (e) => {
  if (!player || !(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
  if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
  if (e.key === "C" || e.key === "c") { e.preventDefault(); void withFrame("copy"); }
  if (e.key === "S" || e.key === "s") { e.preventDefault(); void withFrame("save"); }
});

// ---- boot -------------------------------------------------------------

window.addEventListener("beforeunload", () => { void editor.closePreview(); });

// STC-399: set once, not re-derived per render — the model code and version
// do not change while the window is open.
void editor.getVersion().then((v) => { $("modelstamp").textContent = productStamp(v); });

void (async () => {
  if (!takeDir) {
    alertUser("No take was given to open.");
    return;
  }
  try {
    await openTakeOrThrow(takeDir);
  } catch (e: any) {
    alertUser(`Could not open "${takeName || takeDir}".\n${e?.message ?? e}`);
  }
})();
