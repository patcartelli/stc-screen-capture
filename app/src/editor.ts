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
  /** STC-454: the preview's mute button, an app setting. */
  previewMuted?: boolean;
  // STC-444 slice 3: the export dialog shows this read-only (the picker
  // itself moved to the main window's Preferences), so a take can be
  // published without a second door back to a folder picker this window
  // does not own.
  share: { destination: string | null };
}
declare const editor: {
  fitWindow: (contentHeight: number) => Promise<void>;
  /** STC-484: ⌘= ⌘− ⌘0, claimed by main ahead of the page-zoom menu items. */
  onTimelineZoom: (cb: (intent: string) => void) => void;
  openPreview: (dir: string) => Promise<boolean>;
  closePreview: () => Promise<void>;
  readTakeFile: (name: string) => Promise<ArrayBuffer>;
  readTakeFileOptional: (name: string) => Promise<ArrayBuffer | null>;
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
  setPreviewMuted: (muted: boolean) => Promise<unknown>;
  setPipStyleDefault: (style: unknown) => Promise<unknown>;
  publish(): Promise<{
    ok: boolean; plan: string; message?: string;
    file?: string; name?: string; replaced?: boolean; snippet?: string;
  }>;
  revealPublished(): Promise<{ ok: boolean; file?: string; message?: string }>;
  getVersion(): Promise<string>;
};

import type { LoadedSession } from "@transform/session";
import { loadTake, type TakeIO, type CountingSource } from "./session-io.js";
import { PreviewPlayer } from "@transform/preview";
import { exportSession } from "@transform/export";
import {
  levelFromSliderPct, sliderPctFromLevel, exportAudioPlan, type PcmTrack, type ExportDecoded,
  micLevelFromSliderPct, sliderPctFromMicLevel, formatLevelDb,
  nudgeLevelDb, MIC_LEVEL_MAX, MIC_UNITY_PCT,
} from "@transform/audio-mix";
import {
  meterStep, meterFill, clipLit, snapToUnity, METER_IDLE, type MeterState,
} from "@transform/audio-meter";
import { decodeMicForMix, decodeSystemForMix } from "@transform/decode-audio";
import type { DemuxedAudio } from "@transform/demux-audio";
import { PreviewAudio } from "@transform/preview-audio";
import { mixPeaks, isClipped } from "@transform/waveform";
import type { NarrationCleanup, Project, ZoomOverride } from "@transform/types";
import {
  projectForWrite, exportWindow, estimateExportMs,
  clampTrim, isFullTake, minTrimNs, DEFAULT_NARRATION_CLEANUP,
} from "@transform/trim";
import { outputSizeFor, outputOptions, selectedOption, type OutputOption } from "@transform/output-size";
import type { Size } from "@transform/spaces";
import { holdFraming, restoreFraming, withHeldFraming, chosenFraming, type FramingHold } from "./framing-hold.js";
import { contentFraction, framingLayout, DEFAULT_SOLID_COLOR, type Framing, type FramingPreset } from "@transform/framing";
import { render } from "@transform/render";
import {
  DEFAULT_TEXT_PT, EMBED_TARGETS, effectivePointWidth, legibility, legibilitySentence, zoomFactorForCrop,
} from "@transform/legibility";
import { TRANSFORM_VERSION } from "@transform/transform-version";
import { productStamp } from "./product.js";
import { zoomWindows, ZOOM_LEAD_NS, ZOOM_HOLD_NS, type ZoomPreset, type ZoomWindow } from "@transform/zoom";
import { windowId, overrideFor, resolvedWindows, rectFromGesture } from "@transform/zoom-override";
import { deriveZoomCrop } from "@transform/zoom-change";
import {
  committedOverrides, overridesWithoutWindow, overridesWithoutManual, draftOf, NO_SPEEDS, type OverrideEdit, type SpeedDraft,
  chipSpeed, withChipSpeed, chipSideFor, amountOf, rectAtAmount, ZOOM_AMOUNT_MIN, ZOOM_AMOUNT_MAX, type ChipSide,
} from "./override-edit.js";
import type { Rect } from "@transform/spaces";
import {
  clampTrimFrame, decideKey, formatReadout, formatShuttle, frameAtFraction, frameToNs,
  fractionOfFrame, lastFrame, nsToFrame, rubberBandPx, tickStrideFrames, type ScrubAction,
  type ScrubState,
} from "./scrubber.js";
import { autoSlug, exportManifestName, exportMediaName, slugIsValid } from "./share.js";
import {
  isFit, isMinSpan, overviewBox, panBy, timelineZoomKeyIntent,
  wheelIntent, zoomAbout, zoomByIntent, zoomReadout, type ZoomIntent,
} from "./timeline-zoom.js";
import {
  clipActivity, zoomCurve, laneBitmap, formatBlockTime, zoomAmountLabel, trimRangeParts, activityIn, activityLabel,
} from "./timeline-activity.js";
import {
  editPipStyle, pipRect, pipSize, dragCenter, resizeFromCorner, styleFromFixedCorner,
  anchorCenter, anchorOf, PIP_CIRCLE_HANDLE_FRACTION, PIP_SNAP_THRESHOLD_SCREEN_PX, type PipAnchor, type PipEdit, type PipStyle,
  panFraming, zoomFraming, framingSource,
} from "@transform/pip-style";
import { buildPipInspector, pipSummary, type PipInspectorContext } from "./pip-inspector.js";
import {
  framingPadding, framingRadius, framingShadowOn, withPadding, withRadius, withShadow, radiusPx,
  framingColor, withColor,
} from "./framing-edit.js";
import { homeRelative } from "./path-label.js";

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
// STC-429: the library's "Share" tile action opens the take here and asks
// for its own Share flow to run immediately, rather than duplicating
// share.ts's plumbing in the grid.
const autoShare = params.get("autoShare") === "1";

// ---- the window shell (STC-603) ----------------------------------------------

// The glass title bar turns opaque under Reduce Transparency; main reads it
// (Chromium may not report the media query) and passes it in the URL.
document.body.classList.toggle("reduce-transparency", params.get("reduceTransparency") === "1");
$("titlename").textContent = takeName;
// Where an export lands: always the take's own folder (STC-604's Folder row).
$("exportfolder").textContent = homeRelative(takeDir);
$("exportfolder").title = takeDir;

// The stage panel letterboxes the picture at its own aspect. The player sets
// the canvas's width/height attributes (on open, and again when the export size
// changes), so watching them is all it takes to keep --stage-ar true without a
// call from every place that resizes the canvas.
{
  const canvas = $("stage") as HTMLCanvasElement;
  const syncAspect = () => {
    if (canvas.width > 0 && canvas.height > 0) {
      canvas.parentElement!.style.setProperty("--stage-ar", `${canvas.width} / ${canvas.height}`);
    }
  };
  new MutationObserver(syncAspect).observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
  syncAspect();
}

/** The title bar's right-hand readout: what the export is made at. */
function updateTitleMeta(): void {
  const o = openProject?.output;
  $("titlemeta").textContent = o ? `${o.width}×${o.height} · ${o.fps} fps` : "";
}

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

function resetSpan(): void {
  spanStart = 0;
  spanEnd = player?.durationNs ?? 0;
}

/** The span the lane canvases draw: the whole take until a span is set. */
function visibleSpan(): { start: number; end: number } {
  const dur = player?.durationNs ?? 0;
  return spanEnd > spanStart ? { start: spanStart, end: spanEnd } : { start: 0, end: dur };
}

function applySpanTransform(): void {
  const durationNs = player?.durationNs ?? 0;
  const span = Math.max(1, spanEnd - spanStart);
  const scale = durationNs > 0 ? durationNs / span : 1;
  const translatePct = durationNs > 0 ? -(spanStart / span) * 100 : 0;
  const transform = `scaleX(${scale}) translateX(${translatePct}%)`;
  ($("timeline") as HTMLElement).style.transform = transform;
  // STC-484: what the transform stretches, the trim brackets and the playhead
  // thumb counter-scale by (editor.html's `scale: var(--inv)`), so they stay
  // the same width however far in the lane is zoomed.
  ($("timeline") as HTMLElement).style.setProperty("--inv", String(1 / scale));
  // STC-605: the ruler's labels and pennants and the strip's bookmark lines
  // undo it the same way.
  for (const id of ["ruler-content", "strip-content", "audio-dims"]) {
    ($(id) as HTMLElement).style.transform = transform;
    ($(id) as HTMLElement).style.setProperty("--inv", String(1 / scale));
  }
  // The three canvases are NOT transformed any more: stretching a bitmap is
  // what made a zoomed lane blocky. They are redrawn for the visible span.
  scheduleLaneRedraw();
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
  updateZoomBar();
  updateRulerPlayhead(player?.currentNs ?? 0);
  layoutExportOverlays();
  layoutZoomChip();
}

// ---- the ruler's adaptive ticks + played line (STC-444 slice 2) ------------
//
// Separate from updateTicks()/#ticks above, which is STC-338's export-frame
// grid drawn over the CLIP LANE — a different feature that predates this
// ticket and is untouched by it. This is the ruler's own time scale.

/** Major ticks: coarser intervals (STC-452) — 5s → 10s → 30s → 1m → …
 *  These are the visually emphasized marks that define the ruler's hierarchy. */
const MAJOR_TICK_LADDER_S = [5, 10, 30, 60, 300, 600, 1800, 3600, 7200];
/** Minor ticks: finer intervals for visual continuity between major marks.
 *  Drawn at reduced height/opacity so they don't clutter the ruler. */
const MINOR_TICK_LADDER_S = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
/** Major ticks must be at least this far apart to avoid clutter (STC-452).
 *  Increased from 6px to 16px to provide sparser, more readable marks at zoom
 *  levels showing long takes (2+ hours). */
const MIN_MAJOR_TICK_SPACING_PX = 16;
/** Minor ticks can be closer, used as subtle guidance between major marks. */
const MIN_MINOR_TICK_SPACING_PX = 6;

const MAX_RULER_LAYOUT_RETRIES = 5;
let rulerLayoutRetriesLeft = MAX_RULER_LAYOUT_RETRIES;
/**
 * Rebuilds #ruler-ticks from the current [spanStart, spanEnd] and the
 * ruler's own on-screen width — STC-452 two-tier tick hierarchy:
 * major ticks at wider spacing (>= 16px) for primary marks, and minor ticks
 * at finer intervals (>= 6px) for visual continuity between them.
 *
 * Ticks are authored as a fraction of FULL DURATION (left: %), so the shared
 * pan/zoom transform on #ruler-content carries them for free; only each tick's
 * WIDTH needs a 1/scale correction to stay a constant on-screen px, since
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

  // Find major tick interval (STC-452: wider spacing for primary marks)
  let majorInterval = MAJOR_TICK_LADDER_S[MAJOR_TICK_LADDER_S.length - 1]!;
  for (const candidate of MAJOR_TICK_LADDER_S) {
    if (candidate * pxPerSecond >= MIN_MAJOR_TICK_SPACING_PX) { majorInterval = candidate; break; }
  }

  // Find minor tick interval (can be finer than major)
  let minorInterval = MINOR_TICK_LADDER_S[MINOR_TICK_LADDER_S.length - 1]!;
  for (const candidate of MINOR_TICK_LADDER_S) {
    if (candidate * pxPerSecond >= MIN_MINOR_TICK_SPACING_PX && candidate < majorInterval) {
      minorInterval = candidate;
      break;
    }
  }

  const durationS = durationNs / 1e9;
  const tickWidthPx = Math.max(0.05, 1 / scale);
  const frag = document.createDocumentFragment();

  // Render minor ticks first (so they appear behind major ticks in z-order)
  if (minorInterval < majorInterval) {
    const majorTickTolerance = 1e-6;
    for (let t = 0; t <= durationS + 1e-6; t += minorInterval) {
      // Skip if this position coincides with a major tick (approximately, accounting for FP error)
      const nearestMajorTick = Math.round(t / majorInterval) * majorInterval;
      if (Math.abs(t - nearestMajorTick) < majorTickTolerance) continue;
      const div = document.createElement("div");
      div.className = "ruler-tick minor";
      div.style.left = `${Math.min(100, (t / durationS) * 100)}%`;
      div.style.width = `${tickWidthPx}px`;
      frag.appendChild(div);
    }
  }

  // Render major ticks (these are always drawn). STC-605: a major tick also
  // carries its time, as the frame does, but only every Nth one when they
  // are closer than a label is wide, so labels never touch.
  const labelEvery = Math.max(1, Math.ceil(MIN_RULER_LABEL_SPACING_PX / (majorInterval * pxPerSecond)));
  let k = 0;
  for (let t = 0; t <= durationS + 1e-6; t += majorInterval, k++) {
    const left = `${Math.min(100, (t / durationS) * 100)}%`;
    const div = document.createElement("div");
    div.className = "ruler-tick";
    div.style.left = left;
    div.style.width = `${tickWidthPx}px`;
    frag.appendChild(div);
    if (k % labelEvery !== 0) continue;
    const label = document.createElement("span");
    label.className = "ruler-label";
    label.style.left = left;
    label.textContent = fmtRulerTime(t);
    frag.appendChild(label);
  }

  ticksEl.appendChild(frag);
}

/** A ruler label needs about this much room: "1:00:00" at 9px mono, plus air. */
const MIN_RULER_LABEL_SPACING_PX = 48;

/** m:ss, or h:mm:ss from an hour: the ruler's whole seconds, not a frame timecode. */
function fmtRulerTime(s: number): string {
  const whole = Math.round(s);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const ss = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The one playhead over the ruler and every lane (STC-605). Updated every
 *  onTime tick and on any span change; placed in .timelinewrap's own px from
 *  #timeline's transformed box, and hidden when the span has panned past it. */
function updateRulerPlayhead(tNs: number): void {
  const el = $("playhead") as HTMLElement;
  const durationNs = player?.durationNs ?? 0;
  if (!(durationNs > 0)) { el.hidden = true; return; }
  const frac = Math.max(0, Math.min(1, tNs / durationNs));
  const track = $("timeline").getBoundingClientRect();
  const lane = (document.querySelector(".laneviewport.clip") as HTMLElement).getBoundingClientRect();
  const wrap = (document.querySelector(".timelinewrap") as HTMLElement).getBoundingClientRect();
  const x = track.left + frac * track.width;
  el.hidden = track.width <= 0 || x < lane.left || x > lane.right;
  el.style.left = `${x - wrap.left}px`;
}

/** Pan by a fraction of the CURRENT span (positive moves later in the take). */
function panSpan(deltaFraction: number): void {
  const durationNs = player?.durationNs ?? 0;
  if (durationNs <= 0) return;
  setSpan(panBy({ startNs: spanStart, endNs: spanEnd }, durationNs, deltaFraction));
}

/** Zoom by `factor` (>1 zooms in), anchored so `anchorFraction` (0..1 of the
 *  current span) stays under the pointer. */
function zoomSpan(factor: number, anchorFraction: number): void {
  const durationNs = player?.durationNs ?? 0;
  if (durationNs <= 0) return;
  const anchorNs = spanStart + anchorFraction * (spanEnd - spanStart);
  setSpan(zoomAbout({ startNs: spanStart, endNs: spanEnd }, durationNs, factor, anchorNs));
}

/** The one writer of the span after a user's input (STC-484): applies it and
 *  lets the hidden readout say so. resetSpan() is not that — opening a take
 *  is not the user zooming. */
function setSpan(next: { startNs: number; endNs: number }): void {
  if (next.startNs === spanStart && next.endNs === spanEnd) return;
  spanStart = next.startNs;
  spanEnd = next.endNs;
  applySpanTransform();
  pulseZoomReadout();
}

/** The button / key doors: playhead-anchored (timeline-zoom.ts rule 2). */
function zoomIntent(intent: ZoomIntent): void {
  const durationNs = player?.durationNs ?? 0;
  if (durationNs <= 0) return;
  setSpan(zoomByIntent({ startNs: spanStart, endNs: spanEnd }, durationNs, intent, player?.currentNs ?? 0));
}

// ---- the zoom controls: buttons, readout, the ruler as a slider (STC-484) ----
//
// STC-605 took out the overview strip (the v2 frames have none). #ruler is
// the pan handle by itself: drag it, scroll it, or focus it and use the arrow
// keys. It reports the visible part of the take as a slider the way the strip
// did, and carries the same left/width percentages as data attributes.

let zoomReadoutTimer: ReturnType<typeof setTimeout> | undefined;
const ZOOM_READOUT_MS = 1500;

function pulseZoomReadout(): void {
  const el = $("zoomreadout") as HTMLElement;
  el.setAttribute("data-live", "");
  if (zoomReadoutTimer !== undefined) clearTimeout(zoomReadoutTimer);
  zoomReadoutTimer = setTimeout(() => el.removeAttribute("data-live"), ZOOM_READOUT_MS);
}

function updateZoomBar(): void {
  const durationNs = player?.durationNs ?? 0;
  const span = { startNs: spanStart, endNs: spanEnd };
  const box = overviewBox(span, durationNs);
  const ruler = $("ruler") as HTMLElement;
  ruler.dataset.spanLeft = String(box.leftPct);
  ruler.dataset.spanWidth = String(box.widthPct);
  ruler.setAttribute("aria-valuenow", String(Math.round(box.leftPct)));
  ruler.setAttribute("aria-valuetext", zoomReadout(span, durationNs));
  $("zoomreadout").textContent = zoomReadout(span, durationNs);
  const open = durationNs > 0;
  ($("zoomin") as HTMLButtonElement).disabled = !open || isMinSpan(span, durationNs);
  ($("zoomout") as HTMLButtonElement).disabled = !open || isFit(span, durationNs);
  ($("zoomfit") as HTMLButtonElement).disabled = !open || isFit(span, durationNs);
}

$("zoomin").addEventListener("click", () => zoomIntent("in"));
$("zoomout").addEventListener("click", () => zoomIntent("out"));
$("zoomfit").addEventListener("click", () => zoomIntent("fit"));

$("ruler").addEventListener("keydown", (e) => {
  const k = (e as KeyboardEvent).key;
  if (k !== "ArrowLeft" && k !== "ArrowRight") return;
  e.preventDefault();
  e.stopPropagation(); // the timeline's own Left/Right step the playhead
  panSpan((k === "ArrowRight" ? 1 : -1) * 0.25);
});

let panning = false;
let panLastX = 0;
$("ruler").addEventListener("pointerdown", (e) => {
  // A pennant takes its own click (seek) — without this guard #ruler's
  // setPointerCapture below would steal it on the first pointerdown.
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
// Wheel on the ruler AND the lanes (STC-484): ⌘-scroll or a pinch zooms around
// the pointer, plain scroll pans. The pointer's place is read against the
// RULER, whose box is the untransformed viewport every lane shares.
function onTimelineWheel(e: WheelEvent): void {
  e.preventDefault();
  const r = $("ruler").getBoundingClientRect();
  if (r.width <= 0) return;
  const intent = wheelIntent(e);
  if (intent.kind === "zoom") {
    zoomSpan(intent.factor, Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  } else if (intent.kind === "pan") {
    panSpan(intent.deltaPx / r.width);
  }
}
for (const el of [$("ruler"), $("overlay-strip"), ...Array.from(document.querySelectorAll<HTMLElement>(".laneviewport"))]) {
  el.addEventListener("wheel", (e) => onTimelineWheel(e as WheelEvent), { passive: false });
}

// ⌘= ⌘− ⌘0. In the packaged app main claims these in before-input-event (they
// are Electron's page-zoom menu items otherwise) and sends the intent; this
// listener is the same door for anything that still reaches the page.
window.addEventListener("keydown", (e) => {
  const intent = timelineZoomKeyIntent(e);
  if (!intent || !player) return;
  e.preventDefault();
  zoomIntent(intent);
});
editor.onTimelineZoom((intent) => {
  if (intent === "in" || intent === "out" || intent === "fit") zoomIntent(intent);
});

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
  // STC-606: and the Audio lane, the Export frame's third.
  const aHead = $("audio-cut-head") as HTMLElement;
  aHead.style.left = "0%";
  aHead.style.width = `${Math.max(0, inPct)}%`;
  const aTail = $("audio-cut-tail") as HTMLElement;
  aTail.style.left = `${outPct}%`;
  aTail.style.width = `${Math.max(0, 100 - outPct)}%`;
  updateTicks();

  const w = exportWindow(openProject, player.durationNs, player.firstRenderableNs);
  const est = fmtEstimate(estimateExportMs(w.maxFrames));
  $("triminfo").textContent = isFullTake(openProject, player.durationNs)
    ? `Full take · ${fmtClock(player.durationNs)} · ${est}`
    : `${fmtClock(w.startNs)}–${fmtClock(w.endNs)} · ${fmtClock(w.endNs - w.startNs)} · ${est}`;
  // The Export section's Length (STC-604): the window the export renders.
  $("exportlength").textContent = fmtClock(w.endNs - w.startNs);
  // STC-606: the strip's range chip reads the same window.
  const parts = trimRangeParts(w.startNs, w.endNs);
  $("rangechip").replaceChildren(...([["In", parts.in], ["Out", parts.out], ["", parts.length]] as const).map(([k, v]) => {
    const span = document.createElement("span");
    if (k) { const key = document.createElement("span"); key.className = "k"; key.textContent = k; span.append(key); }
    span.append(v);
    return span;
  }));
  layoutExportOverlays();
}

/**
 * STC-606, Export (Figma 171:2050): place the full-height in/out bars and the
 * strip's range chip in px, the way updateRulerPlayhead places the playhead.
 * They show only while Export is the active section (editor.html's
 * .exportonly); a bar whose point is panned out of view is hidden.
 */
function layoutExportOverlays(): void {
  if (paneSection !== "export" || !player || !openProject) return;
  const d = player.durationNs || 1;
  const track = $("timeline").getBoundingClientRect();
  const lane = (document.querySelector(".laneviewport.clip") as HTMLElement).getBoundingClientRect();
  const wrap = (document.querySelector(".timelinewrap") as HTMLElement).getBoundingClientRect();
  const xAt = (ns: number) => track.left + (ns / d) * track.width;
  const inX = xAt(openProject.trim?.startNs ?? 0);
  const outX = xAt(openProject.trim?.endNs ?? player.durationNs);
  for (const [id, x] of [["exportbar-in", inX], ["exportbar-out", outX]] as const) {
    const bar = $(id) as HTMLElement;
    bar.hidden = track.width <= 0 || x < lane.left - 1 || x > lane.right + 1;
    bar.style.left = `${x - wrap.left}px`;
  }
  // The chip sits just past the in-point, kept inside the strip.
  const chip = $("rangechip") as HTMLElement;
  const strip = $("overlay-strip").getBoundingClientRect();
  const CHIP_GAP_PX = 8;
  const max = Math.max(0, strip.width - chip.offsetWidth - 2);
  chip.style.left = `${Math.min(max, Math.max(2, inX - strip.left + CHIP_GAP_PX))}px`;
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
  // STC-461: while reframing, the LIVE project carries a temporary display
  // PiP (the whole camera frame) that must never reach disk. Every other edit
  // stays usable meanwhile, so the write still happens — of a COPY whose PiP
  // is the one the reframe would commit right now (reframedProject). STC-396:
  // a framing held aside by the override editor is put back on that copy.
  const reframed = reframing ? reframedProject(openProject, reframing) : openProject;
  // STC-500: the same for an open zoom-override edit — the LIVE project has
  // that window's own entry stripped (so the stage shows the unzoomed picture
  // to draw on), and a save made meanwhile (trim, levels, a slug…) must not
  // write it out without it. The copy carries the edit as Done would commit
  // it right now; the live project stays stripped.
  const overrides = editedOverrides();
  const live = overrides ? { ...reframed, overrides } : reframed;
  const doc = projectForWrite(withHeldFraming(live, heldFraming), player.durationNs);
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
 * shared pan/zoom transform on #ruler-content carries it for free. STC-605:
 * each bookmark is a clay pennant on the ruler plus a line down through the
 * overlay strip (#strip-bookmarks, under the same transform); both keep a
 * constant on-screen size through CSS's --inv, which applySpanTransform sets.
 */
function renderBookmarks(): void {
  const el = $("ruler-bookmarks") as HTMLElement;
  const lines = $("strip-bookmarks") as HTMLElement;
  el.innerHTML = "";
  lines.innerHTML = "";
  if (!player || !openProject || !(player.durationNs > 0)) return;
  const durationNs = player.durationNs;
  const frag = document.createDocumentFragment();
  const lineFrag = document.createDocumentFragment();
  for (const ns of openProject.bookmarks ?? []) {
    const left = `${Math.max(0, Math.min(100, (ns / durationNs) * 100))}%`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rulerbookmark";
    btn.style.left = left;
    btn.dataset.ns = String(ns);
    btn.setAttribute("aria-label", `Bookmark at ${fmtClock(ns)}`);
    btn.title = `${fmtClock(ns)} — right-click to remove`;
    frag.appendChild(btn);
    const line = document.createElement("div");
    line.className = "stripbookmark";
    line.style.left = left;
    lineFrag.appendChild(line);
  }
  el.appendChild(frag);
  lines.appendChild(lineFrag);
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

/**
 * The bars of the Clip and Audio lanes, in CSS px (STC-605, from the v2
 * frame): Clip draws 3px bars on a 5px pitch from the lane's floor, Audio 2px
 * bars on a 4px pitch about its middle. A peak is a column of 3px squares on
 * a 5px pitch, one px wider each side than the bar it marks.
 */
const CLIP_BAR_PX = 3;
const CLIP_PITCH_PX = 5;
const CLIP_PAD_PX = 4;
const WAVE_BAR_PX = 2;
const WAVE_PITCH_PX = 4;
const PEAK_DOT_PX = 3;
const PEAK_PITCH_PX = 5;

/** The largest of `values` over the part of the take one column covers, so a
 *  zoomed-out lane cannot step over a burst between two columns. */
function columnMax(values: ArrayLike<number>, f0: number, f1: number): number {
  const n = values.length;
  const b0 = Math.max(0, Math.floor(f0 * n));
  const b1 = Math.max(b0 + 1, Math.ceil(f1 * n));
  let m = 0;
  for (let b = b0; b < b1 && b < n; b++) m = Math.max(m, values[b]!);
  return m;
}

/** Fills a rect with its corners rounded by `r` (the frame's bars are 1px). */
function fillBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  ctx.fill();
}

/**
 * Clip activity (STC-373), its own lane again since STC-605: the 2026-09-24
 * declutter pass had moved it onto the ruler behind a toggle, and the v2
 * frames give it the Clip lane, under the trim track. Drawn for the VISIBLE
 * span at device resolution, as the other two lanes are.
 */
function drawClipLane(): void {
  const canvas = $("clip-activity") as HTMLCanvasElement;
  const wrap = $("clip-canvas-wrap") as HTMLElement;
  const box = wrap.getBoundingClientRect();
  const cssW = box.width || LANE_BUCKETS;
  const cssH = box.height || 56;
  const { width: w, height: h, scale } = laneBitmap(cssW, cssH, window.devicePixelRatio);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  if (!player || !openSession) return;
  const activity = clipActivity(openSession.events, player.durationNs, LANE_BUCKETS);
  const dur = player.durationNs;
  const vis = visibleSpan();
  const f0 = dur > 0 ? vis.start / dur : 0;
  const f1 = dur > 0 ? vis.end / dur : 1;
  const clip = getComputedStyle(document.documentElement).getPropertyValue("--clip").trim() || "#6fa3a0";
  ctx.fillStyle = withAlpha(clip, 0.85);
  const floor = (cssH - CLIP_PAD_PX) * scale;
  const room = cssH - 2 * CLIP_PAD_PX;
  for (let x = 0; x + CLIP_BAR_PX <= cssW; x += CLIP_PITCH_PX) {
    const a = columnMax(activity, f0 + (x / cssW) * (f1 - f0), f0 + ((x + CLIP_PITCH_PX) / cssW) * (f1 - f0));
    const bh = Math.max(1.5, a * room) * scale;
    fillBar(ctx, x * scale, floor - bh, CLIP_BAR_PX * scale, bh, scale);
  }
}

// ---- the waveform on the ruler (STC-454 part 4) -------------------------
//
// The export's mix. It began as a ruler overlay behind a toggle (Patrick,
// 2026-09-25); STC-483 (2026-10-16) gave it a lane of its own, always shown for
// a take with audio, with clipped peaks in red. The mix, not the raw tracks.
// The peaks come from waveform.ts's `mixPeaks`, which runs `mixBlock` over
// the same tracks and the same `previewLevels()` the preview plays, so a
// level, a mute or the cleaned mic changes the drawing the way it changes
// the sound. A long take is millions of samples (~1.5 s per 10 min of two
// tracks, measured), so the work is spread over short idle slices and a run
// that a newer change has superseded stops at its next slice. Until the new
// peaks land, the old drawing stays up.

const WAVE_SLICE_MS = 8;
let wavePeaks: Float32Array | null = null;
let waveRun = 0;

/** Recompute the peaks from what the preview would play now. */
function scheduleWaveform(): void {
  const run = ++waveRun;
  const canvas = $("audio-waveform") as HTMLCanvasElement;
  const audio = previewAudio;
  if (!audio || !player || !audio.hasSound) {
    wavePeaks = null;
    canvas.dataset.state = "none";
    drawAudioLane();
    return;
  }
  const levels = previewLevels();
  const it = mixPeaks({
    mic: audio.micTrack, system: audio.systemTrack,
    micLevel: levels.mic, systemLevel: levels.system,
    durationNs: player.durationNs,
  });
  canvas.dataset.state = "computing";
  const step = (): void => {
    if (run !== waveRun) return;
    const until = performance.now() + WAVE_SLICE_MS;
    for (;;) {
      const r = it.next();
      if (r.done) {
        wavePeaks = r.value;
        canvas.dataset.state = "ready";
        canvas.dataset.run = String(run);
        drawAudioLane();
        return;
      }
      if (performance.now() >= until) break;
    }
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

/** Mirrored about the lane's middle, linear: full height is full scale. A
 *  clipped bucket (waveform.ts's `isClipped`) is drawn in --wave-clip. STC-605:
 *  2px bars on a 4px pitch, as the v2 frame draws them. */
function drawAudioLane(): void {
  const canvas = $("audio-waveform") as HTMLCanvasElement;
  const wrap = $("audio-canvas-wrap") as HTMLElement;
  const lane = $("audio-lane") as HTMLElement;
  const cssW = wrap.getBoundingClientRect().width || LANE_BUCKETS;
  const cssH = lane.clientHeight || audioLaneHeight;
  const { width: w, height: h, scale } = laneBitmap(cssW, cssH, window.devicePixelRatio);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  const peaks = wavePeaks;
  if (!peaks) return;
  const css = getComputedStyle(document.documentElement);
  const normal = withAlpha(css.getPropertyValue("--wave").trim() || "#6fa3a0", 0.8);
  const hot = css.getPropertyValue("--wave-clip").trim() || "#e5483f";
  const mid = cssH / 2;
  const half = mid - PEAK_DOT_PX;
  // STC-484: the canvas shows the VISIBLE span only, redrawn on every zoom or
  // pan rather than CSS-stretched, so a zoomed lane stays sharp.
  const dur = player?.durationNs ?? 0;
  const vis = visibleSpan();
  const f0 = dur > 0 ? vis.start / dur : 0;
  const f1 = dur > 0 ? vis.end / dur : 1;
  for (let x = 0; x + WAVE_BAR_PX <= cssW; x += WAVE_PITCH_PX) {
    // Every bucket the column covers, so a narrow window cannot skip a peak.
    const peak = columnMax(peaks, f0 + (x / cssW) * (f1 - f0), f0 + ((x + WAVE_PITCH_PX) / cssW) * (f1 - f0));
    if (!(peak > 0)) continue;
    const a = Math.max(1, peak * half);
    if (!isClipped(peak)) {
      ctx.fillStyle = normal;
      fillBar(ctx, x * scale, (mid - a) * scale, WAVE_BAR_PX * scale, 2 * a * scale, scale);
      continue;
    }
    // STC-601: red and teal sit within 1.4:1 in luminance, so a peak is
    // marked by texture too, not by color alone: a column of squares where
    // the rest of the waveform is a solid bar.
    ctx.fillStyle = hot;
    const dx = (x - (PEAK_DOT_PX - WAVE_BAR_PX) / 2) * scale;
    for (let y = mid - a; y < mid + a; y += PEAK_PITCH_PX) {
      ctx.fillRect(dx, y * scale, PEAK_DOT_PX * scale, Math.min(PEAK_DOT_PX, mid + a - y) * scale);
    }
  }
}

/** The lane exists only for a take with audio. */
function updateAudioLane(): void {
  const has = !!openSession?.micAudio || !!openSession?.systemAudio;
  $("audio-lane").toggleAttribute("hidden", !has);
  if (has) drawAudioLane();
  scheduleFitWindow();
}

// ---- the audio lane's height (STC-483) ------------------------------------
//
// Resizable by dragging its bottom edge (Patrick, 2026-10-16). Defaults, the
// minimum and the remembered size are this ticket's own calls, still open with
// him: 32 px minimum (peaks readable), 160 px maximum, remembered per viewer in
// localStorage (a view preference, not an edit decision). The default is the
// v2 frame's 44 px since STC-605 (it was 56).
const AUDIO_LANE_MIN = 32;
const AUDIO_LANE_MAX = 160;
const AUDIO_LANE_DEFAULT = 44;
const AUDIO_LANE_KEY = "stc.editor.audioLaneHeight";

function clampAudioLane(px: number): number {
  return Math.round(Math.min(AUDIO_LANE_MAX, Math.max(AUDIO_LANE_MIN, Number.isFinite(px) ? px : AUDIO_LANE_DEFAULT)));
}
let audioLaneHeight = AUDIO_LANE_DEFAULT;
try {
  const saved = Number(localStorage.getItem(AUDIO_LANE_KEY));
  if (saved > 0) audioLaneHeight = clampAudioLane(saved);
} catch { /* storage unavailable: the default stands */ }

function setAudioLaneHeight(px: number, persist: boolean): void {
  audioLaneHeight = clampAudioLane(px);
  document.documentElement.style.setProperty("--audio-lane-h", `${audioLaneHeight}px`);
  drawAudioLane();
  if (persist) {
    try { localStorage.setItem(AUDIO_LANE_KEY, String(audioLaneHeight)); } catch { /* not remembered */ }
  }
}
setAudioLaneHeight(audioLaneHeight, false);

(() => {
  const grip = $("audio-resize") as HTMLButtonElement;
  let startY = 0, startH = 0;
  // Window-level listeners, not pointer capture: the drag keeps working
  // however the pointer leaves the strip, and does not depend on capture.
  const move = (e: PointerEvent): void => setAudioLaneHeight(startH + (e.clientY - startY), false);
  const end = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    grip.classList.remove("dragging");
    setAudioLaneHeight(audioLaneHeight, true);
  };
  grip.addEventListener("pointerdown", (e) => {
    startY = e.clientY; startH = audioLaneHeight;
    grip.classList.add("dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    e.preventDefault();
  });
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault(); e.stopPropagation();
    setAudioLaneHeight(audioLaneHeight + (e.key === "ArrowDown" ? 8 : -8), true);
  });
})();

/** `#rrggbb` as `rgba(...)` — a canvas gradient stop takes a color string, and
 *  fading to transparent needs an alpha the token itself does not carry. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function drawZoomLane(): void {
  const canvas = $("zoom-curve") as HTMLCanvasElement;
  const wrap = $("zoom-canvas-wrap") as HTMLElement;
  // STC-451: a bitmap at DEVICE resolution, drawn in device pixels (no
  // ctx.scale) so the curve's edge stays crisp on a 2x display; CSS still
  // sizes the canvas to the lane (#zoom-curve is 100% x 100%).
  const box = wrap.getBoundingClientRect();
  const { width: w, height: h, scale } = laneBitmap(
    box.width || LANE_BUCKETS, box.height || 64, window.devicePixelRatio);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  if (!player || !openSession || !openProject) return;
  const curve = zoomCurve(
    (tNs) => render(openProject!, openSession!, tNs).zoom.amount,
    player.durationNs,
    LANE_BUCKETS,
    visibleSpan().start,
    visibleSpan().end,
  );
  // STC-330: a FILLED area, not a stroked line — the same sampled curve
  // reads as one silhouette per window (ease-in ramp, flat top, ease-out
  // ramp), with #override-blocks laying the click targets over it.
  // STC-605, from the v2 frame: each block is filled with its OWN smooth
  // brass gradient, 0.5 alpha at its top edge fading to 0.04 at the floor,
  // and outlined along its top in brass at 0.85. --zoom-fill owns the fill;
  // --zoom keeps the override-selection accents. The dither STC-566 tried is
  // retired. amount is not clamped to [0, 1] (zoom.ts's own note): it is
  // clipped to the lane's height rather than pretending it cannot exceed 1.
  const fillColor = getComputedStyle(document.documentElement).getPropertyValue("--zoom-fill").trim() || "#d6b25e";
  const top = 2 * scale;
  const yAt = (v: number): number => h - Math.max(0, Math.min(1, v)) * (h - top);
  const xAt = (i: number): number => (i / (curve.length - 1)) * w;
  ctx.lineWidth = 2 * scale;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (let i = 0; i < curve.length;) {
    if (!(curve[i]! > ZOOM_LANE_FLOOR)) { i++; continue; }
    // One block: the run of samples above the floor, with the samples either
    // side of it so its ramps start and end on the floor.
    const a = Math.max(0, i - 1);
    let b = i;
    while (b < curve.length - 1 && curve[b + 1]! > ZOOM_LANE_FLOOR) b++;
    b = Math.min(curve.length - 1, b + 1);
    let peak = h;
    for (let j = a; j <= b; j++) peak = Math.min(peak, yAt(curve[j]!));
    const gradient = ctx.createLinearGradient(0, peak, 0, h);
    gradient.addColorStop(0, withAlpha(fillColor, 0.5));
    gradient.addColorStop(1, withAlpha(fillColor, 0.04));
    ctx.beginPath();
    ctx.moveTo(xAt(a), h);
    for (let j = a; j <= b; j++) ctx.lineTo(xAt(j), yAt(curve[j]!));
    ctx.lineTo(xAt(b), h);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(xAt(a), yAt(curve[a]!));
    for (let j = a + 1; j <= b; j++) ctx.lineTo(xAt(j), yAt(curve[j]!));
    ctx.strokeStyle = withAlpha(fillColor, 0.85);
    ctx.stroke();
    i = b + 1;
  }
}

/** Below this the zoom is at rest: no block is drawn, so the lane's floor
 *  stays empty between windows instead of carrying a hairline. */
const ZOOM_LANE_FLOOR = 0.002;

function redrawLanes(): void {
  drawClipLane(); drawAudioLane(); drawZoomLane(); layoutOverrideBlocks();
  updateRulerPlayhead(player?.currentNs ?? 0);
  layoutExportOverlays();
  layoutZoomChip();
}

/** A zoom or pan redraws the three canvases; a drag fires many per frame, so
 *  they are coalesced to one per animation frame. */
let laneRedrawQueued = false;
function scheduleLaneRedraw(): void {
  if (laneRedrawQueued) return;
  laneRedrawQueued = true;
  requestAnimationFrame(() => {
    laneRedrawQueued = false;
    drawClipLane(); drawAudioLane(); drawZoomLane();
  });
}
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
// STC-396: the FRAME is set aside the same way. With project.framing set the
// stage shows the picture INSET, so a pointer pixel on #stage is no longer
// capture UV and #overridebox (a percentage of the overlay) would sit in the
// wrong place. While editing, framing is held in `heldFraming` and removed
// from the live project; every path that ends editing restores it, and
// persistProject/export write the project WITH it (`withHeldFraming`).
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
let heldFraming: FramingHold | null = null;
let editingManualId: string | null = null;
let draftRect: Rect | null = null;
let draftEasing: SpeedDraft = { ...NO_SPEEDS };
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

// overridesWithoutWindow / overridesWithoutRetime / overridesWithoutManual
// moved to override-edit.ts (STC-500) with the commit rule that uses them.

/**
 * The open zoom-override edit as data, or null when none is open (STC-500) —
 * what `committedOverrides` needs to say what the edit would commit to right
 * now. Done, every save made mid-edit, and every output read it the same way.
 */
function editState(): OverrideEdit | null {
  if (editingWindowId !== null) {
    return {
      kind: "derived", windowId: editingWindowId, rect: draftRect, easing: draftEasing,
      startNs: draftManualStart, endNs: draftManualEnd,
    };
  }
  if (editingManualId !== null) {
    return {
      kind: "manual", id: editingManualId, rect: draftRect, easing: draftEasing,
      startNs: draftManualStart, endNs: draftManualEnd,
    };
  }
  return null;
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

// STC-484: the override box is drawn only while the pointer is over the
// selected Zoom block or over the box itself, and for the length of a drag.
// The editing state (`draftRect`, the overlay) is untouched: hiding it is a
// matter of paint, not of what the override is.
let overrideBlockHover = false;
let overrideBoxHover = false;
function syncOverrideBoxShown(): void {
  const box = $("overridebox") as HTMLElement;
  const dragging = dragAnchorUv !== null;
  if (dragging || overrideBlockHover || overrideBoxHover) box.setAttribute("data-shown", "");
  else box.removeAttribute("data-shown");
}
function overBlockTarget(e: Event): boolean {
  return (e.target as HTMLElement | null)?.closest?.(".zoomblock.selected, #manualdraft, #zoomchip") != null;
}
document.addEventListener("pointerover", (e) => {
  if (overBlockTarget(e) !== overrideBlockHover) { overrideBlockHover = overBlockTarget(e); syncOverrideBoxShown(); }
});

function drawOverrideBox(rect: Rect | null): void {
  $("zoomamount").textContent = zoomAmountLabel(rect);
  syncZoomAmount();
  const box = $("overridebox") as HTMLElement;
  if (!rect) { box.setAttribute("hidden", ""); return; }
  box.removeAttribute("hidden");
  box.style.left = `${rect.x * 100}%`;
  box.style.top = `${rect.y * 100}%`;
  box.style.width = `${rect.width * 100}%`;
  box.style.height = `${rect.height * 100}%`;
  // STC-606: "2.2× · 412×232", the amount and the region in capture pixels.
  const px = openCapture ? ` · ${Math.round(rect.width * openCapture.width)}×${Math.round(rect.height * openCapture.height)}` : "";
  $("overridereadout").textContent = `${zoomAmountLabel(rect)}${px}`;
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
 * The live project's overrides with the open edit committed into it, or
 * undefined when no edit is open (STC-500). `committedOverrides`
 * (override-edit.ts) is the rule; its header says what a derived and a manual
 * commit each write. Undefined, too, for a derived edit with no session
 * loaded: its retime is decided against the events, and guessing without them
 * would drop one. Used by Done (below) and by persistProject for a save made
 * mid-edit — one rule, so the two cannot drift.
 */
function editedOverrides(): ZoomOverride[] | undefined {
  const edit = editState();
  if (!openProject || !edit || (edit.kind === "derived" && !openSession)) return undefined;
  return committedOverrides(openProject.overrides, edit, openSession?.events ?? [], openProject.zoom?.preset);
}

/**
 * Done for a DERIVED window: writes the draft into project.overrides and
 * persists. An empty draft means "no geometry override" (STC-330); a retime
 * (STC-329) is written or cleared independently, decided against the window's
 * TRUE derived bounds — both are `committedOverrides`' rules now. The edit is
 * still open while persistProject runs, so it commits the same edit into its
 * copy again: a no-op, because the rule is idempotent (and tested to be).
 */
async function commitDraft(): Promise<void> {
  if (!openProject || !editingWindowId || !openSession) return;
  openProject.overrides = editedOverrides()!;
  await persistProject();
}

/**
 * Done for a MANUAL window (STC-331): writes the draft into project.overrides
 * and persists. An unresolved "Project default" easing resolves to the
 * project's CURRENT preset at commit time (a snapshot, not a live link), and
 * an empty draft (Remove pressed) deletes the window outright — both are
 * `committedOverrides`' rules now.
 */
async function commitManualDraft(): Promise<void> {
  if (!openProject || !editingManualId) return;
  openProject.overrides = editedOverrides()!;
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
  $("zoomstarts").textContent = formatBlockTime(draftManualStart);
  $("zoomends").textContent = formatBlockTime(draftManualEnd);
  el.className = editingManualId ? "zoomblock manual selected" : "zoomblock selected";
  const d = player.durationNs || 1;
  el.style.left = `${(draftManualStart / d) * 100}%`;
  el.style.width = `${Math.max(0, ((draftManualEnd - draftManualStart) / d) * 100)}%`;
  layoutZoomChip();
}

/** Shared tail of every way an editor can open: shows the rect tool and
 *  override bar, seeds the preset picker and Remove/Delete button, and
 *  refreshes both block layers. */
function openOverrideEditorUI(): void {
  ($("overridein") as HTMLSelectElement).value = draftEasing.in;
  ($("overrideout") as HTMLSelectElement).value = draftEasing.out;
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
  // The pane follows selection (STC-604): the block's controls live in Zoom.
  selectSection("zoom");
  chipSide = chipSideFor(draftEasing);
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
function setAsideFraming(): void {
  if (!openProject || heldFraming) return;
  heldFraming = holdFraming(openProject);
}

function putBackFraming(): void {
  if (openProject) restoreFraming(openProject, heldFraming);
  heldFraming = null;
}

function resetEditingState(): void {
  putBackFraming();
  editingWindowId = null;
  editingManualId = null;
  draftRect = null;
  draftEasing = { ...NO_SPEEDS };
  draftManualStart = 0;
  draftManualEnd = 0;
  dragAnchorUv = null;
  resizingManualEdge = undefined;
  ($("overridebar") as HTMLElement).setAttribute("hidden", "");
  ($("rectoverlay") as HTMLElement).setAttribute("hidden", "");
  drawOverrideBox(null);
  layoutZoomChip();
  // The Zoom lane's curve samples render(), so a committed easing, retime or
  // removal changes it; the lane is otherwise redrawn only on open, zoom, pan
  // and resize, so without this it stayed stale until one of those (STC-619).
  scheduleLaneRedraw();
}

async function closeOverrideEditor(): Promise<void> {
  await commitCurrentEdit();
  resetEditingState();
  layoutOverrideBlocks();
  updateManualDraftBlock();
  if (player) await player.seek(player.currentNs); // repaint framed again
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
  if (player) await player.seek(player.currentNs); // repaint framed again
}

async function selectDerivedWindow(w: ZoomWindow): Promise<void> {
  if (!player || !openProject) return;
  await commitCurrentEdit(); // switching straight from one block to another
  const id = windowId(w);
  editingWindowId = id;
  const existing = overrideFor(openProject.overrides, w);
  draftRect = existing?.rect ?? null;
  draftEasing = draftOf(existing?.easing);
  // Seeded from `w`'s own (already RESOLVED, possibly already-retimed)
  // bounds — re-opening a retimed window edits from where it currently
  // plays, not from the original derivation.
  draftManualStart = w.startNs;
  draftManualEnd = w.endNs;
  openProject.overrides = overridesWithoutWindow(openProject.overrides, id);
  setAsideFraming();
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
  draftEasing = draftOf(o.easing);
  openProject.overrides = overridesWithoutManual(openProject.overrides, o.id);
  setAsideFraming();
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
  draftEasing = { ...NO_SPEEDS };
  setAsideFraming();
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
  syncOverrideBoxShown();
});
$("rectoverlay").addEventListener("pointermove", (e) => {
  const pe = e as PointerEvent;
  if (!dragAnchorUv) {
    // Not dragging: is the pointer over the box? (the box itself takes no
    // pointer events, so this is a hit test against its rect.)
    const uv = stageUv(pe.clientX, pe.clientY);
    const over = draftRect !== null
      && uv.x >= draftRect.x && uv.x <= draftRect.x + draftRect.width
      && uv.y >= draftRect.y && uv.y <= draftRect.y + draftRect.height;
    if (over !== overrideBoxHover) { overrideBoxHover = over; syncOverrideBoxShown(); }
    return;
  }
  draftRect = rectFromGesture(dragAnchorUv, stageUv(pe.clientX, pe.clientY), aspectWH());
  drawOverrideBox(draftRect);
});
const endOverrideDrag = () => {
  if (!dragAnchorUv) return;
  dragAnchorUv = null;
  syncOverrideBoxShown(); // a finished drag leaves the pointer on the box: still hovered
  ($("overrideclear") as HTMLButtonElement).disabled = !draftRect;
  layoutOverrideBlocks(); // the "overridden" dot follows a fresh drag immediately, not just on Done
};
$("rectoverlay").addEventListener("pointerleave", () => {
  if (overrideBoxHover) { overrideBoxHover = false; syncOverrideBoxShown(); }
});
$("rectoverlay").addEventListener("pointerup", endOverrideDrag);
$("rectoverlay").addEventListener("pointercancel", endOverrideDrag);

// The two Ease rows (STC-619): Slow / Medium / Fast for the push in and the
// release out, each on its own, "" = the project default for that side.
$("overridein").addEventListener("change", () => {
  draftEasing = { ...draftEasing, in: ($("overridein") as HTMLSelectElement).value as SpeedDraft["in"] };
  layoutZoomChip();
});
$("overrideout").addEventListener("change", () => {
  draftEasing = { ...draftEasing, out: ($("overrideout") as HTMLSelectElement).value as SpeedDraft["out"] };
  layoutZoomChip();
});

// ---- the Zoom chip (STC-606, Figma 171:561) --------------------------------
//
// The open block's chip, in the overlay strip above it (Patrick, 2026-10-30):
// the amount (drag sideways or arrow keys), In / Out / Both choosing which side
// Slow / Med / Fast sets, and delete. It edits the same draft as the Zoom
// section's rows (draftRect, draftEasing), so Done, Escape and every mid-edit
// save treat a chip edit exactly as an inspector one (override-edit.ts's
// committedOverrides).

let chipSide: ChipSide = "both";

function editingBlock(): boolean {
  return editingWindowId !== null || editingManualId !== null;
}

/** Where an Auto block (no drawn region) starts when its amount is first set:
 *  the region stage 2 would zoom to, else a default box at the centre. */
function startingRect(): Rect {
  if (editingWindowId && openSession) {
    const w = zoomWindows(openSession.events).find((x) => windowId(x) === editingWindowId);
    const r = w ? deriveZoomCrop(w, openSession.changes, openSession.anchors, openSession.frames) : null;
    if (r) return r;
  }
  return rectFromGesture({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, aspectWH());
}

/** The inspector's Amount slider and the chip's amount, from draftRect. */
function syncZoomAmount(): void {
  const range = $("zoomamountrange") as HTMLInputElement;
  const editing = editingBlock();
  range.disabled = !editing;
  const a = editing ? amountOf(draftRect ?? startingRect()) : ZOOM_AMOUNT_MIN;
  range.value = String(Math.round(a * 10) / 10);
  range.style.setProperty("--fill-pct", `${((Number(range.value) - ZOOM_AMOUNT_MIN) / (ZOOM_AMOUNT_MAX - ZOOM_AMOUNT_MIN)) * 100}%`);
  $("chipamount").textContent = zoomAmountLabel(draftRect);
}

function setZoomAmount(amount: number): void {
  if (!editingBlock()) return;
  draftRect = rectAtAmount(draftRect ?? startingRect(), amount);
  ($("overrideclear") as HTMLButtonElement).disabled = false;
  drawOverrideBox(draftRect);
  ($("overridebox") as HTMLElement).setAttribute("data-shown", "");
  layoutOverrideBlocks();
}

/** Show, fill and place the chip: centred over the open block, inside the strip. */
function layoutZoomChip(): void {
  const chip = $("zoomchip") as HTMLElement;
  const shown = editingBlock() && paneSection === "zoom";
  chip.hidden = !shown;
  if (!shown) return;
  for (const b of $("chipside").querySelectorAll<HTMLElement>("[data-side]")) {
    b.setAttribute("aria-checked", String(b.dataset.side === chipSide));
  }
  const speed = chipSpeed(draftEasing, chipSide);
  for (const b of $("chipspeed").querySelectorAll<HTMLElement>("[data-speed]")) {
    b.setAttribute("aria-checked", String(b.dataset.speed === speed));
  }
  const block = $("manualdraft").getBoundingClientRect();
  const strip = $("overlay-strip").getBoundingClientRect();
  const mid = (block.left + block.right) / 2 - strip.left;
  const max = Math.max(2, strip.width - chip.offsetWidth - 2);
  chip.style.left = `${Math.min(max, Math.max(2, mid - chip.offsetWidth / 2))}px`;
}

$("chipside").addEventListener("click", (e) => {
  const side = (e.target as HTMLElement).closest<HTMLElement>("[data-side]")?.dataset.side as ChipSide | undefined;
  if (!side) return;
  chipSide = side;
  layoutZoomChip();
});
$("chipspeed").addEventListener("click", (e) => {
  const speed = (e.target as HTMLElement).closest<HTMLElement>("[data-speed]")?.dataset.speed as ZoomPreset | undefined;
  if (!speed || !editingBlock()) return;
  // The lit speed pressed again goes back to the project default for that side.
  const next = chipSpeed(draftEasing, chipSide) === speed ? "" : speed;
  draftEasing = withChipSpeed(draftEasing, chipSide, next);
  ($("overridein") as HTMLSelectElement).value = draftEasing.in;
  ($("overrideout") as HTMLSelectElement).value = draftEasing.out;
  layoutZoomChip();
});
$("chipdelete").addEventListener("click", () => {
  // A derived block's delete drops it (it never plays); a manual block's is
  // the same as the section's Delete window.
  if (editingWindowId) $("overridedelete").click();
  else $("overrideclear").click();
});
$("zoomamountrange").addEventListener("input", () => {
  setZoomAmount(Number(($("zoomamountrange") as HTMLInputElement).value));
});
(() => {
  const btn = $("chipamount");
  let drag: { x: number; amount: number } | null = null;
  btn.addEventListener("pointerdown", (e) => {
    if (!editingBlock()) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { x: e.clientX, amount: amountOf(draftRect ?? startingRect()) };
    btn.setPointerCapture(e.pointerId);
  });
  btn.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if ((e.buttons & 1) === 0) { drag = null; return; }
    // 100 px of drag is one whole step of zoom (1.0x).
    setZoomAmount(Math.round((drag.amount + (e.clientX - drag.x) / 100) * 10) / 10);
  });
  const end = (): void => { drag = null; };
  btn.addEventListener("pointerup", end);
  btn.addEventListener("pointercancel", end);
  btn.addEventListener("lostpointercapture", end);
  btn.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowUp" || e.key === "ArrowRight" ? 0.1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -0.1 : 0;
    if (!step || !editingBlock()) return;
    e.preventDefault();
    e.stopPropagation();
    setZoomAmount(Math.round((amountOf(draftRect ?? startingRect()) + step) * 10) / 10);
  });
})();
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
  updateTitleMeta();
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

function frameFractionFor(p: Project): number {
  return openCapture ? contentFraction(p === openProject ? chosenFraming(p, heldFraming) : p.framing, p.output, openCapture.width / openCapture.height) : 1;
}

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
                       embedWidthPx, zoomFactorForCrop(fs.zoom.crop.width),
                       frameFractionFor(openProject));
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

// ---- the Export section (was the export dialog; STC-604) -----------------

/** Show the Export section, with the share row filled in. */
async function showExportSection(): Promise<void> {
  // STC-461/STC-500: the section never opens over a reframe or an open zoom-
  // override edit — every output it leads to reads the live project, which
  // holds the temporary display PiP / the stripped override meanwhile.
  await finishOpenEdits();
  selectSection("export");
  await refreshShareRow();
}
$("openexport").addEventListener("click", () => void showExportSection()
  .catch((e: any) => alertUser(String(e?.message ?? e))));

// ---- opening and closing the take -------------------------------------

/** This window's bridge as session-io.ts's TakeIO (STC-488). */
const takeIO: TakeIO = {
  read: (n) => editor.readTakeFile(n),
  readOptional: (n) => editor.readTakeFileOptional(n),
  size: (n) => editor.takeFileSize(n),
  chunk: (n, o, l) => editor.readTakeChunk(n, o, l),
};

let openVideoSources: { display: CountingSource; camera?: CountingSource } | undefined;

// Test hook (app/test/preview.e2e.test.ts): how much of each video file the
// open take has actually read. Read-only, and zero when nothing is open.
(window as unknown as { __stcVideoBytesRead: () => { display: number; displaySize: number; camera: number } })
  .__stcVideoBytesRead = () => ({
    display: openVideoSources?.display.bytesRead ?? 0,
    displaySize: openVideoSources?.display.size ?? 0,
    camera: openVideoSources?.camera?.bytesRead ?? 0,
  });

// STC-469: what the preview is holding, for the e2e suite. Read-only.
(window as unknown as { __stcPreviewAudio: () => unknown }).__stcPreviewAudio = () => {
  const playing = previewAudio?.micTrack ?? null;
  return {
    micAudio: micSource,
    rawMicHeld: rawMic !== null,
    cleanedFor,
    playing: playing === null ? null : playing === cleanedMic ? "cleaned" : playing === rawMic ? "raw" : null,
    cleaning: ($("previewaudio") as HTMLButtonElement).dataset.cleaning === "true",
    micLength: playing?.channels[0]?.length ?? null,
  };
};

// STC-469: the export exactly as the editor runs it, with or without the
// preview's tracks — for the e2e identity check and the memory measurement.
// Nothing is written; the encoded file is discarded. Unlike the read-only
// hooks above, this one does REAL work (a whole export's decode and encode),
// and exists only for the e2e identity check and the memory measurement.
(window as unknown as { __stcExportForTest: (o: { reuse: boolean }) => Promise<unknown> }).__stcExportForTest =
  async ({ reuse }) => {
    if (!openSession || !openProject) throw new Error("no take open");
    await finishOpenEdits(); // STC-461/STC-500: never export a reframe or an override edit uncommitted
    // runExport holds exportAbort for its whole run (cleared in its finally,
    // even after a cancel), so set means a real export is still in flight.
    if (exportAbort) throw new Error("a real export is running");
    const r = await exportSession(openSession, structuredClone(openProject), {
      audioHash: true, decoded: reuse ? decodedForExport() : undefined,
    });
    return { audioHash: r.audioHash, audioReused: r.audioReused };
  };

async function openTakeOrThrow(dir: string): Promise<void> {
  await closeTake();
  await editor.openPreview(dir);

  const { session, project, anchors, sources } = await loadTake(takeIO);
  openVideoSources = sources;

  openSession = session;
  openProject = project;
  updateTitleMeta();
  openCapture = { width: anchors.capture.width, height: anchors.capture.height };
  openDisplay = { pointWidth: effectivePointWidth(anchors) };
  player = new PreviewPlayer($("stage") as HTMLCanvasElement, session, project);
  const scrub = $("scrub") as HTMLInputElement;
  scrub.max = String(lastFrame(player.durationNs));
  scrub.value = "0";
  player.onTime = (tNs, playing) => {
    const frame = nsToFrame(tNs, player!.durationNs);
    setClock(formatReadout(frame, player!.durationNs));
    setPlayState(playing);
    $("shuttle").textContent = formatShuttle(player!.rate);
    // STC-454: which clock the playhead follows, for the e2e suite (sound
    // plays at 1x only, and then the picture runs on the audio clock).
    ($("stage") as HTMLCanvasElement).dataset.clock = player!.clock;
    if (!scrubbing) scrub.value = String(frame);
    updateRulerPlayhead(tNs);
  };
  // STC-236: a frame read or decode failed (the take deleted from the library
  // while open here, say). The player has already paused and reports once;
  // the error's own message names the file. Without this the picture froze
  // with the playhead still running and the cause only in the console.
  player.onError = (e) => {
    setPlayState(false);
    alertUser(`The preview stopped: ${e.message}`);
  };
  await player.seek(player.firstRenderableNs);
  resetSpan();
  applySpanTransform(); // draws the zoom bar and the lanes for the opening span (STC-484)
  updateTrimUI();
  updateOutputSizeUI();
  updateLegibilityUI();
  updateSystemAudioUI();
  updateVoiceCleanUI();
  updatePipButton();
  void loadPreviewAudio(session, audioGen);
  applySpanTransform();
  redrawLanes();
  // STC-483: show every lane without scrolling. After layout, once per open take.
  scheduleFitWindow();
}

async function closeTake(): Promise<void> {
  exportAbort?.abort();
  // STC-461: a take closed mid-reframe COMMITS it — dropping it would lose the
  // reframe the user can see. STC-500: so does an open zoom-override edit. It
  // used to be dropped here ("a write nobody asked for"), but the live project
  // has that window's own entry stripped while it is open, so dropping the
  // draft lost the window's EXISTING override from disk as soon as any other
  // save had happened mid-edit — and the decision (2026-10-02) is that what
  // you see is what's kept. postOpenEditWrites builds and SENDS both writes
  // synchronously, before the teardown below clears openProject/player and
  // the edit state; it is awaited at the end so the writes have landed when
  // closeTake settles. No closeOverrideEditor(): its repaint is for a take
  // that stays open.
  const editWrites = postOpenEditWrites();
  $("framestatus").setAttribute("hidden", "");
  editingWindowId = null;
  editingManualId = null;
  heldFraming = null; // the project is discarded below; nothing to restore into
  draftRect = null;
  draftEasing = { ...NO_SPEEDS };
  dragAnchorUv = null;
  // STC-454: detach and drop the sound first, and bump the generation so a
  // decode or a cleanup still in flight for THIS take lands nowhere.
  audioGen++;
  player?.attachAudio(null);
  previewAudio?.close();
  previewAudio = null;
  rawMic = null;
  micSource = null;
  rawLoading = false;
  cleanedMic = null;
  cleanedFor = null;
  cleanWanted = null;
  setPreviewAudioState("none");
  scheduleWaveform(); // no sound now: cancels any run in flight and clears the drawing
  player?.close();
  player = undefined;
  openSession = undefined;
  openVideoSources = undefined;
  openProject = undefined;
  updateTitleMeta();
  openCapture = undefined;
  openDisplay = undefined;
  updateSystemAudioUI();
  updateVoiceCleanUI();
  updatePipButton();
  applyStageDisplay();
  await editor.closePreview();
  await editWrites.catch((e: any) => alertUser(String(e?.message ?? e)));
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

// STC-605 (Patrick, 2026-10-29): the playhead can be grabbed anywhere along
// its full height, not only on the Clip lane. #playhead itself stays
// pointer-events:none, so a press is caught on .timelinewrap in the CAPTURE
// phase when it lands within PLAYHEAD_GRAB_PX of the line. A trim bracket, a
// bookmark pennant or a zoom block under the pointer still wins: those are
// controls of their own, the playhead sits on the in-point bracket whenever it
// is at frame 0, and selecting a zoom block seeks to its MIDDLE, so the line
// lands on the block the user just clicked and a second click must still
// reach it. The drag is the same seek #scrub's input makes (rule 3: a drag is
// direct).
const PLAYHEAD_GRAB_PX = 6;
const NOT_THE_PLAYHEAD = ".handle, .rulerbookmark, .zoomblock, #manualdraft, #audio-resize, .zoomctl, .overlayctl";
let draggingPlayhead = false;

function nearPlayhead(e: PointerEvent): boolean {
  const ph = $("playhead") as HTMLElement;
  if (ph.hidden || !player) return false;
  const r = ph.getBoundingClientRect();
  return Math.abs(e.clientX - (r.left + r.width / 2)) <= PLAYHEAD_GRAB_PX
    && !(e.target as HTMLElement).closest(NOT_THE_PLAYHEAD);
}

// ---- the Frame section's hover (STC-606, Figma 171:78) -------------------
//
// Over the lanes, while Frame is the active section and nothing is held: a
// hairline at the pointer through every lane, and a tooltip with the time and
// the clicks and keys the Clip bar under the pointer stands for (the same
// CLIP_PITCH_PX column drawClipLane draws, over the visible span).

function hideFrameHover(): void {
  ($("hoverline") as HTMLElement).hidden = true;
  ($("hovertip") as HTMLElement).hidden = true;
}

function frameHover(e: PointerEvent): void {
  if (paneSection !== "frame" || e.buttons !== 0 || draggingPlayhead || !player || !openSession) {
    hideFrameHover();
    return;
  }
  const wrap = (document.querySelector(".timelinewrap") as HTMLElement).getBoundingClientRect();
  const lanes = $("clip-canvas-wrap").getBoundingClientRect();
  const x = e.clientX - lanes.left;
  if (x < 0 || x > lanes.width || lanes.width <= 0 || e.clientY < lanes.top) { hideFrameHover(); return; }
  const vis = visibleSpan();
  const at = (px: number) => vis.start + (px / lanes.width) * (vis.end - vis.start);
  const col = Math.floor(x / CLIP_PITCH_PX) * CLIP_PITCH_PX;
  $("hovertime").textContent = formatBlockTime(at(x));
  $("hovercount").textContent = activityLabel(activityIn(openSession.events, openSession.keys, at(col), at(col + CLIP_PITCH_PX)));
  const line = $("hoverline") as HTMLElement;
  const tip = $("hovertip") as HTMLElement;
  line.hidden = false;
  tip.hidden = false;
  const lineX = e.clientX - wrap.left;
  line.style.left = `${lineX}px`;
  // Beside the line, flipped to its left when it would run past the lanes.
  const TIP_GAP_PX = 8;
  const right = lineX + TIP_GAP_PX;
  tip.style.left = `${right + tip.offsetWidth > lanes.right - wrap.left ? lineX - TIP_GAP_PX - tip.offsetWidth : right}px`;
}

function seekToClientX(clientX: number): void {
  if (!player) return;
  const frame = frameAtClientX(clientX);
  ($("scrub") as HTMLInputElement).value = String(frame);
  void player.seek(frameToNs(frame, player.durationNs));
}

(() => {
  const wrap = document.querySelector(".timelinewrap") as HTMLElement;
  wrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !nearPlayhead(e)) return;
    e.preventDefault();
    e.stopPropagation();
    draggingPlayhead = true;
    scrubbing = true;
    wrap.setAttribute("data-playhead-drag", "");
    wrap.setPointerCapture(e.pointerId);
  }, { capture: true });
  wrap.addEventListener("pointermove", (e) => {
    if (draggingPlayhead) { seekToClientX(e.clientX); return; }
    wrap.toggleAttribute("data-near-playhead", nearPlayhead(e));
  });
  const end = (): void => {
    if (!draggingPlayhead) return;
    draggingPlayhead = false;
    scrubbing = false;
    wrap.removeAttribute("data-playhead-drag");
  };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);
  wrap.addEventListener("pointerleave", () => { if (!draggingPlayhead) wrap.removeAttribute("data-near-playhead"); });
  wrap.addEventListener("pointermove", (e) => frameHover(e));
  wrap.addEventListener("pointerleave", hideFrameHover);
})();

// ---- system-audio level (STC-418 PR 3) --------------------------------
//
// Shown only for a take that recorded system audio. The level lives on the
// project (project-9's systemAudioLevel, 0..1) and is applied by the export's
// mix (audio-mix.ts) — and, since STC-454, by the preview's sound, which
// reads it per 100 ms chunk, so a move is heard while playing. `input`
// updates the value live; `change` (release, or a key) is what persists, the
// same drag-then-settle split the trim handles use.
//
// The slider is a DECIBEL fader, not the gain itself (audio-mix.ts's
// levelFromSliderPct): a linear 30% still sounded loud on hardware.

function updateSystemAudioUI(): void {
  updateAudioButton();
  const row = $("sysaudio");
  const has = !!openSession?.systemAudio && !!openProject;
  row.toggleAttribute("hidden", !has);
  if (!has) return;
  const level = openProject!.systemAudioLevel ?? 1;
  ($("sysaudiolevel") as HTMLInputElement).value = String(sliderPctFromLevel(level));
  $("sysaudiovalue").textContent = formatLevelDb(level);
  showMute("sysmute", row, !!openProject!.systemAudioMuted, "system audio");
}

$("sysaudiolevel").addEventListener("input", () => {
  if (!openProject) return;
  const pct = Number(($("sysaudiolevel") as HTMLInputElement).value);
  openProject.systemAudioLevel = levelFromSliderPct(pct);
  $("sysaudiovalue").textContent = formatLevelDb(openProject.systemAudioLevel);
  scheduleWaveform();
});
$("sysaudiolevel").addEventListener("change", () => {
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});

// ---- the Audio popover and the mic level (STC-454 part 2) ---------------
//
// Every audio control for the take lives in one popover behind the "Audio"
// button (Patrick, 2026-09-25: the timecode row had filled up). The button
// shows only for a take with audio; each row only for the track it acts on.
// The mic level can BOOST (+12 dB at 100%, as recorded at 75%) and is saved
// as project-11's `micLevel`; the preview reads it per chunk, so a move is
// heard while playing. Same input/change split as the other sliders.

/** Ask main to grow the window to the content (STC-483). Debounced: lanes appear as
 *  the take's pieces load, and the content height settles a moment after the last. */
let fitTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleFitWindow(): void {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    requestAnimationFrame(() => void editor.fitWindow(naturalContentHeight() + FIT_MARGIN_PX));
  }, 150);
}

/**
 * What the window needs to show everything at the stage's minimum height
 * (STC-603). Not `documentElement.scrollHeight`: the shell fills the viewport,
 * so that is always the viewport's own height, and asking for it plus a margin
 * grew the window by the margin on every call. The stage panel absorbs spare
 * height, so only the stage's minimum, the group and the gutters count.
 */
function naturalContentHeight(): number {
  const col = document.querySelector<HTMLElement>(".workcol")!;
  const cs = getComputedStyle(col);
  const gap = parseFloat(cs.rowGap) || 0;
  const stageMin = parseFloat(getComputedStyle(document.querySelector<HTMLElement>(".stagebox")!).minHeight) || 0;
  const alert = $("alert").offsetHeight;
  return parseFloat(cs.paddingTop) + (alert ? alert + gap : 0) + stageMin + gap
    + col.querySelector<HTMLElement>(".editorbody")!.offsetHeight + parseFloat(cs.paddingBottom);
}
/** Room beyond the measured content, so a rounding error never leaves a scrollbar. */
const FIT_MARGIN_PX = 24;

function updateAudioButton(): void {
  const has = !!openProject && (!!openSession?.micAudio || !!openSession?.systemAudio);
  $("audiobtn").toggleAttribute("hidden", !has);
  updateAudioLane();
  updateKeycastUI();
  updateClicksUI();
  updateFramingUI();
  if (!has && !$("audiopanel").hasAttribute("hidden")) selectSection("frame");
}

function updateMicUI(): void {
  updateAudioButton();
  const has = !!openSession?.micAudio && !!openProject;
  $("micaudio").toggleAttribute("hidden", !has);
  if (!has) return;
  const level = openProject!.micLevel ?? 1;
  ($("miclevel") as HTMLInputElement).value = String(sliderPctFromMicLevel(level));
  $("miclevelvalue").textContent = formatLevelDb(level);
  showMute("micmute", $("micaudio"), !!openProject!.micMuted, "mic");
}

$("miclevel").addEventListener("input", () => {
  if (!openProject) return;
  openProject.micLevel = micLevelFromSliderPct(Number(($("miclevel") as HTMLInputElement).value));
  $("miclevelvalue").textContent = formatLevelDb(openProject.micLevel);
  scheduleWaveform();
});
$("miclevel").addEventListener("change", () => {
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});

// ---- per-track mute (STC-454 part 3) -----------------------------------
//
// A speaker before each track's name (Patrick, 2026-09-25). Muting is its
// OWN field (project-12's micMuted/systemAudioMuted), never level 0, so the
// slider keeps its position — dimmed — and un-muting returns to exactly the
// level that was set. The preview hears it at once (the levels callback
// reads the mute per chunk); the export leaves a muted track out entirely,
// and with every track muted writes no audio track at all.

function showMute(id: string, row: HTMLElement, muted: boolean, what: string): void {
  const btn = $(id) as HTMLButtonElement;
  btn.setAttribute("aria-pressed", String(muted));
  const label = `${muted ? "Unmute" : "Mute"} ${what}`;
  btn.setAttribute("aria-label", label);
  btn.title = label;
  row.toggleAttribute("data-muted", muted);
}

// ---- keycast (STC-419) -------------------------------------------------
// One switch, saved to the project. Hiding is project.keycast.show === false
// and nothing else: the take's keys stay in events.json.
function updateKeycastUI(): void {
  const btn = $("keycastbtn") as HTMLButtonElement;
  const has = !!openSession?.keys?.length;
  btn.hidden = !has;
  $("keycastrow").hidden = !has;
  const shown = openProject?.keycast?.show !== false;
  btn.setAttribute("aria-pressed", shown ? "true" : "false");
  btn.title = shown ? "Hide keystrokes in the preview and export" : "Show keystrokes in the preview and export";
}

$("keycastbtn").addEventListener("click", () => {
  if (!openProject || !player) return;
  const shown = openProject.keycast?.show !== false;
  openProject.keycast = { show: !shown };
  updateKeycastUI();
  void player.seek(player.currentNs);   // repaint this frame with the new choice
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});

// ---- click highlight (STC-492) -----------------------------------------
// One switch, saved to the project (project-13's showClicks; absent = on).
// render() reads it for both sinks, so the preview and the export agree.
function updateClicksUI(): void {
  const btn = $("clicksbtn") as HTMLButtonElement;
  const shown = openProject?.showClicks !== false;
  btn.setAttribute("aria-pressed", shown ? "true" : "false");
  btn.title = shown ? "Hide the click highlight in the preview and export" : "Show the click highlight in the preview and export";
}

$("clicksbtn").addEventListener("click", () => {
  if (!openProject || !player) return;
  openProject.showClicks = openProject.showClicks === false;
  updateClicksUI();
  void player.seek(player.currentNs);   // repaint this frame with the new choice
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});

// ---- PiP (STC-461) ----------------------------------------------------------
//
// The pane's Camera section hosts pip-inspector.ts (STC-604: it was a popover);
// #pipoverlay lets the PiP be dragged (snapping, pip-style.ts's snapCenter,
// unless the Snap to edges row is off) and resized from its corner. Every
// decision is pip-style.ts's. The player shares `openProject`, so an edit is a
// mutation plus a repaint; a COMMIT also persists.
//
// The overlay shows while the Camera section is the active one, and stays up
// for a drag in flight (layoutPipOverlay checks `pipDrag`). Unlike the popover
// it replaced, the section does not close on a drag: the Anchor row follows
// the PiP to wherever it was dropped.

function pipCamera(): Size | null {
  const cam = openSession?.anchors.camera;
  return cam?.present ? { width: cam.width, height: cam.height } : null;
}

/**
 * The rect the PiP lives in, in output px (STC-396 rule 3): framing.ts's own
 * content rect for the LIVE project — what the stage is drawing right now, so
 * a framing held aside by the override editor counts as none — or the whole
 * output when there is no framing. pip-style.ts's "output" is this rect's size;
 * the overlay adds its origin. With no framing every number below is what it
 * was before STC-396.
 */
function pipFrame(): Rect | null {
  if (!openProject) return null;
  const out = openProject.output;
  const layout = openCapture && openCapture.height > 0
    ? framingLayout(openProject.framing, out, openCapture.width / openCapture.height)
    : undefined;
  return layout?.content ?? { x: 0, y: 0, width: out.width, height: out.height };
}

const sizeOf = (r: Rect): Size => ({ width: r.width, height: r.height });

/** The take's style, or the fixed corner expressed as one so a first edit cannot jump. */
function currentPipStyle(): PipStyle | null {
  const cam = pipCamera();
  if (!openProject?.pip || !cam) return null;
  // While reframing, the live project holds the temporary display style; the
  // take's REAL one (with the framing being edited) is held here.
  if (reframing) return reframing.real;
  const frame = pipFrame()!;
  return openProject.pip.style ?? styleFromFixedCorner(openProject.pip, sizeOf(frame), cam);
}

function persistPip(): void {
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
}

function setPipStyle(style: PipStyle, persist: boolean): void {
  if (!openProject?.pip || !player) return;
  openProject.pip.style = style;
  renderPipInspector(style, openProject.pip.enabled);
  layoutPipOverlay();
  void player.seek(player.currentNs);
  if (persist) persistPip();
}

const pipInspector = buildPipInspector($("pippanel"), {
  onEdit(edit: PipEdit, phase) {
    const style = currentPipStyle();
    const cam = pipCamera();
    if (!style || !cam) return;
    setPipStyle(editPipStyle(style, edit, cam), phase === "commit");
  },
  onEnabled(enabled) {
    if (!openProject?.pip || !player) return;
    openProject.pip.enabled = enabled;
    layoutPipOverlay();
    void player.seek(player.currentNs);
    persistPip();
  },
  onAnchor(anchor: PipAnchor) {
    const style = currentPipStyle();
    const cam = pipCamera();
    const frame = pipFrame();
    if (!style || !cam || !frame) return;
    const center = anchorCenter(anchor, pipSize(style, sizeOf(frame), cam), sizeOf(frame));
    setPipStyle(editPipStyle(style, { kind: "move", center }, cam), true);
  },
  onSnap(on) { pipSnap = on; },
  onReframe: () => enterReframe(),
  onUseAsDefault() {
    const style = currentPipStyle();
    if (style) void editor.setPipStyleDefault(style).catch((e: any) => alertUser(String(e?.message ?? e)));
  },
});

/** Whether a drag snaps to the nine places (the Snap to edges row). A session setting, never saved; on = as before. */
let pipSnap = true;

/** The Camera section is the pane's active one (the overlay shows then, as it did while the popover was open). */
const pipPanelOpen = (): boolean => !$("pippanel").hasAttribute("hidden");

function pipContext(style: PipStyle): PipInspectorContext {
  const cam = pipCamera();
  const frame = pipFrame();
  return {
    frameWidthPx: frame?.width ?? 0,
    anchor: cam && frame ? anchorOf(style.center, pipSize(style, sizeOf(frame), cam), sizeOf(frame)) : null,
  };
}

function renderPipInspector(style: PipStyle, enabled: boolean): void {
  pipInspector.render(style, enabled, pipContext(style));
}

function updatePipButton(): void {
  const has = !!openProject?.pip && !!pipCamera();
  $("pipbtn").toggleAttribute("hidden", !has);
  if (!has && pipPanelOpen()) selectSection("frame");
  const style = currentPipStyle();
  if (style && openProject?.pip) renderPipInspector(style, openProject.pip.enabled);
  layoutPipOverlay();
}

/** Output px → stage CSS px, from the stage's live box (it already reflects any CSS transform). */
function stageScale(): { left: number; top: number; k: number } {
  const r = ($("stage") as HTMLCanvasElement).getBoundingClientRect();
  return { left: r.left, top: r.top, k: openProject ? r.width / openProject.output.width : 1 };
}

/** Shown while the inspector is open (or a drag is still finishing) for a PiP that is drawn. */
function layoutPipOverlay(): void {
  const overlay = $("pipoverlay");
  const style = currentPipStyle();
  const cam = pipCamera();
  const shown = !reframing && !!style && !!cam && !!openProject?.pip?.enabled && (pipPanelOpen() || !!pipDrag);
  overlay.hidden = !shown;
  const frame = pipFrame();
  if (!shown || !style || !cam || !openProject || !frame) return;
  const r = pipRect(style, sizeOf(frame), cam);
  const { k } = stageScale();
  $("piplabel").textContent = pipSummary(style, pipContext(style));
  const box = overlay.querySelector<HTMLElement>(".pipbox")!;
  Object.assign(box.style, {
    left: `${(frame.x + r.x) * k}px`, top: `${(frame.y + r.y) * k}px`, width: `${r.width * k}px`, height: `${r.height * k}px`,
    borderRadius: style.shape === "circle" ? "50%" : `${style.cornerRadius * Math.min(r.width, r.height) * k}px`,
  });
  // STC-606: the readout hugs the box's side nearest the stage edge, and goes
  // under the box when the box is too near the top for it to fit above.
  const LABEL_ROOM_PX = 26;
  box.classList.toggle("right", r.x + r.width / 2 > frame.width / 2);
  box.classList.toggle("below", (frame.y + r.y) * k < LABEL_ROOM_PX);
  // The resize handle: a corner of the box, except on a circle, where the
  // corner floats off the picture and the handle sits ON the edge instead
  // (resizeFromCorner measures a circle by distance, so grabbing it does not
  // jump). The inline values are cleared for any other shape.
  const handle = $("piphandle");
  if (style.shape === "circle") {
    const at = `${PIP_CIRCLE_HANDLE_FRACTION * 100}%`;
    Object.assign(handle.style, { left: at, top: at, right: "auto", bottom: "auto", transform: "translate(-50%, -50%)" });
  } else {
    Object.assign(handle.style, { left: "", top: "", right: "", bottom: "", transform: "" });
  }
}

let pipDrag: { kind: "move" | "resize"; dx: number; dy: number } | null = null;

$("pipoverlay").addEventListener("pointerdown", (e) => {
  const style = currentPipStyle();
  const cam = pipCamera();
  const frame = pipFrame();
  if (!style || !cam || !openProject || !frame) return;
  const target = e.target as HTMLElement;
  if (!target.closest(".pipbox")) return;
  const { left, top, k } = stageScale();
  // Content-rect px: output px less the rect's origin (both zero with no framing).
  const px = (e.clientX - left) / k - frame.x, py = (e.clientY - top) / k - frame.y;
  pipDrag = target.id === "piphandle"
    ? { kind: "resize", dx: 0, dy: 0 }
    : { kind: "move", dx: px - style.center.x * frame.width, dy: py - style.center.y * frame.height };
  target.setPointerCapture(e.pointerId);
  e.preventDefault();
});

$("pipoverlay").addEventListener("pointermove", (e) => {
  if (!pipDrag || !openProject) return;
  const style = currentPipStyle();
  const cam = pipCamera();
  const frame = pipFrame();
  if (!style || !cam || !frame) return;
  const { left, top, k } = stageScale();
  const out = sizeOf(frame);
  const px = (e.clientX - left) / k - frame.x, py = (e.clientY - top) / k - frame.y;
  if (pipDrag.kind === "resize") {
    setPipStyle(resizeFromCorner(style, { x: px, y: py }, out, cam), false);
    return;
  }
  const raw = { x: (px - pipDrag.dx) / out.width, y: (py - pipDrag.dy) / out.height };
  const snapped = dragCenter(raw, pipSize(style, out, cam), out, PIP_SNAP_THRESHOLD_SCREEN_PX / k, pipSnap);
  setPipStyle(editPipStyle(style, { kind: "move", center: snapped }, cam), false);
});

function endPipDrag(): void {
  if (!pipDrag) return;
  pipDrag = null;
  persistPip();
  // The Anchor row names where the drop landed.
  const style = currentPipStyle();
  if (style && openProject?.pip) renderPipInspector(style, openProject.pip.enabled);
  layoutPipOverlay();
}
$("pipoverlay").addEventListener("pointerup", endPipDrag);
$("pipoverlay").addEventListener("pointercancel", endPipDrag);

window.addEventListener("resize", () => {
  if (!$("pipoverlay").hidden) layoutPipOverlay();
  layoutFramingWindow();
});

// ---- PiP reframe (STC-461) ----------------------------------------------------
//
// STC-330's override editing, for the camera: the LIVE project the player
// reads gets a temporary PiP — the whole camera frame, large and centred, same
// mirror — so render() itself draws the full frame and no second drawing path
// exists. #pipframing draws the crop window over it in the PiP's real shape
// and dims the rest (#pipframewindow is the surface STC-497's guides draw
// inside). Drag the window to pan, slider or wheel to zoom; every bound is
// pip-style.ts's clampFraming. Done or Escape restores the real style with
// the new framing and persists, and so does closing the take. A write made
// meanwhile (a trim, a level) writes the reframe's committed style, never the
// temporary display one — persistProject's reframedProject.
//
// Mirror: the display style keeps the real `mirror`, so the picture under the
// window is the one the viewer sees. framingSource is in UNMIRRORED camera px,
// so the window is drawn flipped about the shown rect's centre; a drag passes
// its delta AS SEEN and panFraming flips x back itself.

let reframing: { real: PipStyle; before: PipStyle | undefined } | null = null;
let frameDrag: { x: number; y: number } | null = null;

function displayStyleFor(real: PipStyle): PipStyle {
  return { ...real, shape: "rect", cornerRadius: 0, width: 0.5, center: { x: 0.5, y: 0.5 },
    border: null, shadow: false, framing: undefined };
}

/** The shown (display-style) rect in output px, and stage CSS px per camera px / per output px.
 *  The display style is centred in the CONTENT rect, as render() places it (STC-396 rule 3). */
function framingScale(real: PipStyle, cam: Size): { shown: Rect; s: number; k: number } | null {
  const frame = pipFrame();
  if (!openProject || !frame) return null;
  const local = pipRect(displayStyleFor(real), sizeOf(frame), cam);
  const shown = { ...local, x: local.x + frame.x, y: local.y + frame.y };
  const { k } = stageScale();
  return { shown, s: (shown.width / cam.width) * k, k };
}

function layoutFramingWindow(): void {
  const cam = pipCamera();
  if (!reframing || !cam) return;
  const sc = framingScale(reframing.real, cam);
  if (!sc) return;
  const { shown, s, k } = sc;
  const real = reframing.real;
  const src = framingSource(real, cam);
  const srcX = real.mirror ? cam.width - src.x - src.width : src.x;
  Object.assign($("pipframewindow").style, {
    left: `${shown.x * k + srcX * s}px`, top: `${shown.y * k + src.y * s}px`,
    width: `${src.width * s}px`, height: `${src.height * s}px`,
    borderRadius: real.shape === "circle" ? "50%"
      : `${real.cornerRadius * Math.min(src.width, src.height) * s}px`,
  });
  ($("pipzoom") as HTMLInputElement).value = String(real.framing?.zoom ?? 1);
}

function enterReframe(): void {
  if (reframing || !openProject?.pip?.enabled || !player) return;
  const real = currentPipStyle();
  if (!real) return;
  reframing = { real, before: openProject.pip.style };
  if (pipPanelOpen()) selectSection("frame");
  openProject.pip.style = displayStyleFor(real); // LIVE project only — persistProject writes reframedProject meanwhile
  $("pipoverlay").hidden = true;
  $("pipframing").hidden = false;
  $("pipframebar").hidden = false;
  void player.seek(player.currentNs);
  layoutFramingWindow();
}

/**
 * Leave reframe. `commit` puts the real style back WITH the new framing and
 * persists (Done, Escape, the Camera button, closing the take or the window,
 * and every output entry point — export, publish, a frame grab — before it
 * reads the live project); the returned promise settles when that write has.
 * Not committing restores the live project as it was and writes nothing — no
 * caller does that today; a reframe the user can see is never thrown away.
 * Synchronous up to the write: the live project is real again on return.
 */
function exitReframe(commit: boolean): Promise<void> {
  if (!reframing) return Promise.resolve();
  const { real, before } = reframing;
  reframing = null;
  frameDrag = null;
  $("pipframing").hidden = true;
  $("pipframebar").hidden = true;
  if (!openProject?.pip) return Promise.resolve();
  if (!commit) { openProject.pip.style = before; return Promise.resolve(); }
  const committed = committedReframeStyle({ real, before });
  if (committed === undefined) {
    openProject.pip.style = undefined;
    updatePipButton();
    if (player) void player.seek(player.currentNs);
  } else {
    setPipStyle(committed, false);
  }
  return persistProject();
}

/**
 * The style a reframe commits to — the ONE rule exitReframe and persistProject
 * share. A take still on the fixed corner whose framing was never touched stays
 * on it (and at its own project version) rather than being rewritten as an
 * explicit style: undefined. Otherwise the real style, with the framing as it
 * stands right now.
 */
function committedReframeStyle(r: { real: PipStyle; before: PipStyle | undefined }): PipStyle | undefined {
  return r.before === undefined && r.real.framing === undefined ? undefined : r.real;
}

/** A copy of the live project with the reframe's committed PiP in place of the
 *  temporary display one — what persistProject writes mid-reframe. */
function reframedProject(p: Project, r: { real: PipStyle; before: PipStyle | undefined }): Project {
  if (!p.pip) return p;
  const { style: _display, ...pip } = p.pip;
  const style = committedReframeStyle(r);
  return { ...p, pip: style === undefined ? pip : { ...pip, style } };
}

/** Fire-and-report form, for the UI's own ways out of reframe. */
function commitReframe(): void {
  void exitReframe(true).catch((e: any) => alertUser(String(e?.message ?? e)));
}

/**
 * Before any OUTPUT (export dialog, export, publish, frame copy/save, the
 * export test hook): commit a reframe (STC-461) and an open zoom-override
 * edit (STC-500), so what goes out is what the user sees and keeps. The
 * override editor is CLOSED, not just committed — an export of a project
 * whose window is still stripped from the live copy would leave it out — and
 * closing repaints the stage framed again. Every output reads the live
 * project, so this must settle before it does.
 */
async function finishOpenEdits(): Promise<void> {
  await exitReframe(true);
  if (editingWindowId !== null || editingManualId !== null) await closeOverrideEditor();
}

/**
 * The going-away form, for closeTake and beforeunload: commit a reframe and an
 * open override edit WITHOUT any teardown of the UI. Both writes are POSTED
 * synchronously, before this returns — exitReframe is synchronous up to its
 * write, and so are commitDraft/commitManualDraft (editedOverrides is
 * synchronous and persistProject's first await is `editor.writeProject`,
 * whose IPC invoke is sent as it is called) — so the caller may clear
 * openProject/player/the edit state straight after. The returned promise
 * settles when both writes have landed.
 */
function postOpenEditWrites(): Promise<void> {
  const reframeWrite = exitReframe(true);
  // With BOTH a reframe and an override edit open, this is a second write,
  // and main's `preview:writeProject` (a plain `writeFile` of the same path)
  // may run the two concurrently. Safe because they are the SAME bytes: the
  // reframe's write already carried the edit (persistProject composes
  // editedOverrides()), and this one carries the reframe (exitReframe has just
  // put the real PiP back on the live project). Whichever lands last, the
  // file holds that one document. Not skipped, because exitReframe can
  // return without writing at all (no PiP), and then this is the only write.
  const editWrite = commitCurrentEdit();
  return Promise.all([reframeWrite, editWrite]).then(() => undefined);
}

$("pipframewindow").addEventListener("pointerdown", (e) => {
  if (!reframing) return;
  frameDrag = { x: e.clientX, y: e.clientY };
  $("pipframewindow").setPointerCapture(e.pointerId);
  e.preventDefault();
});
$("pipframewindow").addEventListener("pointermove", (e) => {
  const cam = pipCamera();
  if (!frameDrag || !reframing || !cam) return;
  const sc = framingScale(reframing.real, cam);
  if (!sc || sc.s <= 0) return;
  // Stage px -> camera px, as seen; panFraming un-mirrors x itself.
  const delta = { x: (e.clientX - frameDrag.x) / sc.s, y: (e.clientY - frameDrag.y) / sc.s };
  frameDrag = { x: e.clientX, y: e.clientY };
  reframing.real = { ...reframing.real, framing: panFraming(reframing.real, delta, cam) };
  layoutFramingWindow();
});
const endFrameDrag = (): void => { frameDrag = null; };
$("pipframewindow").addEventListener("pointerup", endFrameDrag);
$("pipframewindow").addEventListener("pointercancel", endFrameDrag);

function setFramingZoom(zoom: number): void {
  const cam = pipCamera();
  if (!reframing || !cam || !Number.isFinite(zoom)) return;
  reframing.real = { ...reframing.real, framing: zoomFraming(reframing.real, zoom, cam) };
  layoutFramingWindow();
}
for (const type of ["input", "change"] as const) {
  $("pipzoom").addEventListener(type, () => setFramingZoom(Number(($("pipzoom") as HTMLInputElement).value)));
}
$("pipframing").addEventListener("wheel", (e) => {
  if (!reframing) return;
  e.preventDefault();
  setFramingZoom((reframing.real.framing?.zoom ?? 1) * Math.exp(-e.deltaY / 500));
}, { passive: false });
$("pipframedone").addEventListener("click", commitReframe);
// Capture phase + stopImmediatePropagation: Escape here ends the reframe and
// nothing else (not the override editor's, not the frame menu's, not the timeline's).
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !reframing) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  commitReframe();
}, { capture: true });

// ---- framing (STC-396) -------------------------------------------------
// A preset (or none) saved to the project. Preview and export both go through
// render(), so what is previewed is what exports.
const framePresetButtons = (): HTMLButtonElement[] =>
  [...$("framepreset").querySelectorAll<HTMLButtonElement>("[data-frame-preset]")];
/** The Style control's value: the checked segment ("none" = no frame). */
const framePresetValue = (): string =>
  framePresetButtons().find((b) => b.getAttribute("aria-checked") === "true")?.dataset.framePreset ?? "none";
function setFramePresetUI(value: string): void {
  for (const b of framePresetButtons()) b.setAttribute("aria-checked", String(b.dataset.framePreset === value));
}
function setFramePresetDisabled(disabled: boolean): void {
  for (const b of framePresetButtons()) b.disabled = disabled;
}

function updateFramingUI(): void {
  const f = chosenFraming(openProject, heldFraming);
  setFramePresetUI(f?.preset ?? "none");
  // One swatch for every style (STC-604): the fill for Solid, the gradient's
  // first colour for Clean and Dark. Nothing to colour with no frame.
  const color = $("framecolor") as HTMLInputElement;
  color.hidden = !f;
  $("framecolorrow").hidden = !f;
  color.value = f ? framingColor(f) : DEFAULT_SOLID_COLOR;
  $("framecolorvalue").textContent = color.value.toUpperCase();
  // Padding, corners and shadow adjust a frame, so they wait for one.
  const short = openProject ? Math.min(openProject.output.width, openProject.output.height) : 0;
  const pad = $("framepadding") as HTMLInputElement;
  const radius = $("frameradius") as HTMLInputElement;
  const shadow = $("frameshadow") as HTMLInputElement;
  const base: Framing = f ?? { preset: "clean" };
  pad.value = String(Math.round(framingPadding(base) * 1000) / 10);
  radius.value = String(Math.round(framingRadius(base) * 1000) / 10);
  shadow.checked = framingShadowOn(base);
  pad.disabled = radius.disabled = shadow.disabled = !f;
  $("framepadding-out").textContent = f ? `${pad.value}%` : "–";
  $("frameradius-out").textContent = f ? `${radiusPx(base, short)} px` : "–";
  for (const r of [pad, radius]) {
    r.style.setProperty("--fill-pct", `${(Number(r.value) / Number(r.max)) * 100}%`);
  }
}

/** The Padding and Corners readouts (and the sliders' fill) for a framing mid-drag. */
function updateFramingReadouts(f: Framing | undefined): void {
  if (!f || !openProject) return;
  const short = Math.min(openProject.output.width, openProject.output.height);
  const pad = $("framepadding") as HTMLInputElement;
  const radius = $("frameradius") as HTMLInputElement;
  $("framepadding-out").textContent = `${Math.round(framingPadding(f) * 1000) / 10}%`;
  $("frameradius-out").textContent = `${radiusPx(f, short)} px`;
  for (const r of [pad, radius]) r.style.setProperty("--fill-pct", `${(Number(r.value) / Number(r.max)) * 100}%`);
}

/**
 * Apply a framing. `persist` false is a LIVE edit (a slider mid-drag): the
 * picture repaints, nothing is written; the commit on release writes it.
 */
async function setFraming(next: Framing | undefined, persist = true): Promise<void> {
  if (!openProject || !player) return;
  // While an override editor has the frame set aside, a change replaces the
  // held value and the live project stays unframed until editing ends.
  const previous = chosenFraming(openProject, heldFraming);
  const apply = (f: Framing | undefined): void => {
    if (editingWindowId !== null || editingManualId !== null) {
      heldFraming = f ? { framing: f } : null;
    } else if (f) openProject!.framing = f; else delete openProject!.framing;
  };
  apply(next);
  if (persist) {
    try {
      await persistProject();
    } catch (e) {
      apply(previous);
      updateFramingUI();
      throw e;
    }
    updateFramingUI();
  } else {
    // The control being dragged keeps its own value; only the readouts follow.
    updateFramingReadouts(next);
  }
  updateLegibilityUI();
  layoutPipOverlay();                    // the PiP lives in the content rect, which just moved
  await player.seek(player.currentNs);   // repaint this frame with the new choice
}

function framingFromControls(): Framing | undefined {
  const v = framePresetValue();
  if (v === "none") return undefined;
  const preset = v as FramingPreset;
  const was = chosenFraming(openProject, heldFraming);
  // A new style starts on its OWN colours: a colour edit belongs to the style
  // it was made on, so it is not carried across (a custom Clean gradient must
  // not turn Dark into Clean). Solid keeps a colour the user already gave it.
  const next: Framing = preset === "solid"
    ? { preset, color: was?.preset === "solid" ? framingColor(was) : DEFAULT_SOLID_COLOR }
    : { preset };
  // The numbers set in the Frame section (padding, corners, shadow) are the
  // user's own, so a new style keeps them (STC-604).
  if (was?.paddingPct !== undefined) next.paddingPct = was.paddingPct;
  if (was?.radiusPct !== undefined) next.radiusPct = was.radiusPct;
  if (was?.shadow !== undefined) next.shadow = was.shadow;
  return next;
}

// The Colour swatch edits the chosen framing (framing-edit.ts's withColor):
// the picture repaints while the picker moves, and the write is on its commit.
function editFramingColor(persist: boolean): void {
  const f = chosenFraming(openProject, heldFraming);
  if (!f) return;
  const hex = ($("framecolor") as HTMLInputElement).value;
  void setFraming(withColor(f, hex), persist).catch((e: any) => alertUser(String(e?.message ?? e)));
  $("framecolorvalue").textContent = hex.toUpperCase();
}
$("framecolor").addEventListener("input", () => editFramingColor(false));
$("framecolor").addEventListener("change", () => editFramingColor(true));
// The Style segments: a click picks one (a rollback on a failed write redraws it).
$("framepreset").addEventListener("click", (e) => {
  const seg = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-frame-preset]");
  if (!seg || seg.disabled || seg.getAttribute("aria-checked") === "true") return;
  setFramePresetUI(seg.dataset.framePreset!);
  void setFraming(framingFromControls()).catch((err: any) => alertUser(String(err?.message ?? err)));
});

// Padding, corners and shadow edit the chosen framing (framing-edit.ts). The
// sliders follow the editor's input/change split: `input` repaints, `change`
// writes. A preset change keeps the explicit numbers, as framing.ts says an
// explicit field wins.
function editFraming(edit: (f: Framing) => Framing, persist: boolean): void {
  const f = chosenFraming(openProject, heldFraming);
  if (!f) return;
  void setFraming(edit(f), persist).catch((e: any) => alertUser(String(e?.message ?? e)));
}
for (const [id, make] of [
  ["framepadding", (f: Framing, v: number) => withPadding(f, v / 100)],
  ["frameradius", (f: Framing, v: number) => withRadius(f, v / 100)],
] as const) {
  const input = $(id) as HTMLInputElement;
  input.addEventListener("input", () => editFraming((f) => make(f, Number(input.value)), false));
  input.addEventListener("change", () => editFraming((f) => make(f, Number(input.value)), true));
}
$("frameshadow").addEventListener("change", () => {
  const on = ($("frameshadow") as HTMLInputElement).checked;
  editFraming((f) => withShadow(f, on), true);
});

$("micmute").addEventListener("click", () => {
  if (!openProject) return;
  openProject.micMuted = !openProject.micMuted;
  updateMicUI();
  scheduleWaveform();
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});
$("sysmute").addEventListener("click", () => {
  if (!openProject) return;
  openProject.systemAudioMuted = !openProject.systemAudioMuted;
  updateSystemAudioUI();
  scheduleWaveform();
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});

// ---- narration cleanup (STC-455) ---------------------------------------
//
// Shown only for a take with a mic. One switch and one strength (Patrick,
// 2026-09-25), saved to the project (project-10's narrationCleanup) and
// applied by the export (narration-clean.ts, then the mix). The strength is
// disabled, not reset, while the switch is off, so turning it back on returns
// to the same setting. Same input/change split as the level above.

function updateVoiceCleanUI(): void {
  updateMicUI();
  const row = $("voiceclean");
  const has = !!openSession?.micAudio && !!openProject;
  row.toggleAttribute("hidden", !has);
  if (!has) return;
  const n = openProject!.narrationCleanup ?? DEFAULT_NARRATION_CLEANUP;
  const pct = Math.round(n.strength * 100);
  ($("voicecleanon") as HTMLInputElement).checked = n.enabled;
  const strength = $("voicecleanstrength") as HTMLInputElement;
  strength.value = String(pct);
  strength.disabled = !n.enabled;
  $("voicecleanvalue").textContent = `${pct}%`;
}

function currentCleanup(): NarrationCleanup {
  return { ...(openProject?.narrationCleanup ?? DEFAULT_NARRATION_CLEANUP) };
}

$("voicecleanon").addEventListener("change", () => {
  if (!openProject) return;
  openProject.narrationCleanup = { ...currentCleanup(), enabled: ($("voicecleanon") as HTMLInputElement).checked };
  updateVoiceCleanUI();
  refreshCleanMic();
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});
$("voicecleanstrength").addEventListener("input", () => {
  if (!openProject) return;
  const pct = Number(($("voicecleanstrength") as HTMLInputElement).value);
  openProject.narrationCleanup = { ...currentCleanup(), strength: pct / 100 };
  $("voicecleanvalue").textContent = `${pct}%`;
});
$("voicecleanstrength").addEventListener("change", () => {
  // On release, not per `input`: every re-clean is ~1 s a minute of audio.
  refreshCleanMic();
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});

// ---- slider feel and level meters (STC-460) ------------------------------
//
// Presentation only: every number the meters show is measured by `mixBlock`
// (audio-mix.ts) while it makes the sound the preview plays, and read back
// through `previewAudio.meterNow()`. Nothing here touches the audio.
//
// Slider feel: the tick at "as recorded" is in the markup (`--unity`); a
// pointer DRAG within 2% of it snaps onto it (keys never snap — a snap there
// would make the neighbouring steps unreachable); double-click resets to it;
// Shift+arrow nudges 0.1 dB. Arrow keys on a focused slider still never reach
// the playhead: the window handler below returns for these targets.

const FADERS: Record<string, { unityPct: number }> = {
  miclevel: { unityPct: MIC_UNITY_PCT },
  sysaudiolevel: { unityPct: 100 },
};
const faderDefaults: Record<string, () => number> = {
  miclevel: () => MIC_UNITY_PCT,
  sysaudiolevel: () => 100,
  voicecleanstrength: () => Math.round(DEFAULT_NARRATION_CLEANUP.strength * 100),
};
let draggingFader: string | null = null;

$("audiopanel").addEventListener("pointerdown", (e) => {
  const id = (e.target as HTMLElement).id;
  if (id in FADERS) draggingFader = id;
});
window.addEventListener("pointerup", () => { draggingFader = null; });
window.addEventListener("pointercancel", () => { draggingFader = null; });

// Capture phase on the panel, so the snap lands BEFORE the slider's own
// `input` handler reads the value.
$("audiopanel").addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (!draggingFader || el.id !== draggingFader || !(el.id in FADERS)) return;
  el.value = String(snapToUnity(Number(el.value), FADERS[el.id]!.unityPct));
}, true);

function resetFader(el: HTMLInputElement): void {
  const def = faderDefaults[el.id];
  if (!def || el.disabled) return;
  el.value = String(def());
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

$("audiopanel").addEventListener("dblclick", (e) => resetFader(e.target as HTMLInputElement));

// Double-click is hidden, so the value label is the visible reset: clickable
// (and accent-coloured) only while the level differs from its default. Dirty
// is read from the PROJECT, not the slider: a 0.1 dB nudge rounds to the same
// slider position as as-recorded.
function faderIsDefault(id: string): boolean {
  if (!openProject) return true;
  if (id === "miclevel") return (openProject.micLevel ?? 1) === 1;
  if (id === "sysaudiolevel") return (openProject.systemAudioLevel ?? 1) === 1;
  const strength = (openProject.narrationCleanup ?? DEFAULT_NARRATION_CLEANUP).strength;
  return Math.round(strength * 100) === faderDefaults.voicecleanstrength!();
}

function syncResetHints(): void {
  // The slider's filled part: native ranges have no fill, so the track's
  // gradient stops at --fill-pct.
  for (const r of $("audiopanel").querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    const min = Number(r.min) || 0;
    const max = Number(r.max) || 100;
    r.style.setProperty("--fill-pct", `${((Number(r.value) - min) / (max - min)) * 100}%`);
  }
  for (const span of $("audiopanel").querySelectorAll<HTMLElement>("[data-resets]")) {
    const id = span.dataset.resets!;
    const dirty = !faderIsDefault(id);
    span.toggleAttribute("data-dirty", dirty);
    if (dirty) {
      const def = faderDefaults[id]!();
      span.title = id === "voicecleanstrength" ? `Reset to ${def}%` : "Reset to 0 dB (as recorded)";
      span.setAttribute("role", "button");
    } else {
      span.removeAttribute("title");
      span.removeAttribute("role");
    }
  }
}

$("audiopanel").addEventListener("click", (e) => {
  const span = (e.target as HTMLElement).closest<HTMLElement>("[data-resets][data-dirty]");
  if (span) resetFader($(span.dataset.resets!) as HTMLInputElement);
});
// Bubble phase: the slider's own `input`/`change` handlers have already
// written the project by the time this runs.
$("audiopanel").addEventListener("input", syncResetHints);
$("audiopanel").addEventListener("change", syncResetHints);

let nudgePersist: ReturnType<typeof setTimeout> | null = null;
$("audiopanel").addEventListener("keydown", (e) => {
  const el = e.target as HTMLInputElement;
  if (!e.shiftKey || (el.id !== "miclevel" && el.id !== "sysaudiolevel" && el.id !== "voicecleanstrength")) return;
  const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
  if (!dir || !openProject) return;
  e.preventDefault();
  if (el.id === "voicecleanstrength") {
    // A percentage already moves in 1% steps natively; Shift only needs to
    // stay out of the playhead's way, so a plain step is applied here.
    el.value = String(Math.min(100, Math.max(0, Number(el.value) + dir)));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (el.id === "miclevel") {
    openProject.micLevel = nudgeLevelDb(openProject.micLevel ?? 1, dir * 0.1, MIC_LEVEL_MAX);
    el.value = String(sliderPctFromMicLevel(openProject.micLevel));
    $("miclevelvalue").textContent = formatLevelDb(openProject.micLevel);
  } else {
    openProject.systemAudioLevel = nudgeLevelDb(openProject.systemAudioLevel ?? 1, dir * 0.1, 1);
    el.value = String(sliderPctFromLevel(openProject.systemAudioLevel));
    $("sysaudiovalue").textContent = formatLevelDb(openProject.systemAudioLevel);
  }
  scheduleWaveform();
  syncResetHints();
  // A held key repeats: persist once it settles, not per repeat.
  if (nudgePersist) clearTimeout(nudgePersist);
  nudgePersist = setTimeout(() => {
    nudgePersist = null;
    void persistProject().catch((err: any) => alertUser(String(err?.message ?? err)));
  }, 300);
});

// The meters run only while the panel is open: a rAF loop for a closed panel
// is work nobody can see.
let meterRaf = 0;
let meterLastMs = 0;
let micMeter: MeterState = METER_IDLE;
let sysMeter: MeterState = METER_IDLE;

function paintMeter(id: "mic" | "sys", m: MeterState, nowMs: number): void {
  const bar = $(`${id}meter`);
  bar.style.transform = `scaleX(${meterFill(m.db)})`;
  bar.toggleAttribute("data-hot", m.db > -3);
  bar.dataset.db = m.db.toFixed(1);
  $(`${id}clip`).toggleAttribute("data-lit", clipLit(m, nowMs));
}

function meterFrame(nowMs: number): void {
  const blk = previewAudio?.meterNow() ?? null;
  const dt = meterLastMs ? nowMs - meterLastMs : 16;
  meterLastMs = nowMs;
  const limited = !!blk && blk.mix > 1;
  micMeter = meterStep(micMeter, blk?.mic ?? 0, limited && (blk?.mic ?? 0) > 0, nowMs, dt);
  sysMeter = meterStep(sysMeter, blk?.system ?? 0, limited && (blk?.system ?? 0) > 0, nowMs, dt);
  paintMeter("mic", micMeter, nowMs);
  paintMeter("sys", sysMeter, nowMs);
  // The meter line shows only while the preview plays (editor.html's CSS).
  $("audiopanel").toggleAttribute("data-playing", !!player?.isPlaying);
  meterRaf = requestAnimationFrame(meterFrame);
}

function setMetersRunning(open: boolean): void {
  if (open && !meterRaf) { meterLastMs = 0; meterRaf = requestAnimationFrame(meterFrame); }
  if (!open && meterRaf) {
    cancelAnimationFrame(meterRaf);
    meterRaf = 0;
    micMeter = METER_IDLE; sysMeter = METER_IDLE;
    paintMeter("mic", micMeter, 0); paintMeter("sys", sysMeter, 0);
    $("audiopanel").removeAttribute("data-playing");
  }
}

// ---- the pane's section switch (STC-604) ---------------------------------
//
// Frame, Audio, Camera, Zoom, Export: one section shown at a time, Frame by
// default. The pane follows selection: choosing a zoom block calls
// selectSection("zoom"). The meters run only while Audio is the active
// section, for the same reason they ran only while its popover was open.

type PaneSection = "frame" | "audio" | "camera" | "zoom" | "export";
let paneSection: PaneSection = "frame";

function selectSection(s: PaneSection): void {
  // A tab that is not offered (Audio for a take with no sound, Camera for one
  // with no camera) cannot be chosen.
  if ($("sectionswitch").querySelector(`[data-section="${s}"]`)?.hasAttribute("hidden")) s = "frame";
  const was = paneSection;
  paneSection = s;
  // STC-606: the section overlays show only while their section is active,
  // keyed off this attribute in CSS (body[data-section="zoom"] ...).
  document.body.dataset.section = s;
  layoutExportOverlays();
  layoutZoomChip();
  for (const tab of $("sectionswitch").querySelectorAll<HTMLElement>("[data-section]")) {
    const on = tab.dataset.section === s;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  $("audiopanel").toggleAttribute("hidden", s !== "audio");
  $("pippanel").toggleAttribute("hidden", s !== "camera");
  $("zoompanel").toggleAttribute("hidden", s !== "zoom");
  $("exportpanel").toggleAttribute("hidden", s !== "export");
  $("framepanel").toggleAttribute("hidden", s !== "frame");
  setMetersRunning(s === "audio");
  if (s === "audio") syncResetHints();
  // Camera chosen mid-reframe: finish the reframe first, so the inspector
  // edits the real style and never the temporary display one.
  if (s === "camera" && was !== "camera") commitReframe();
  // Leaving Zoom mid-edit: the block's controls go with the section, so the
  // edit is committed and closed, as Done would.
  if (was === "zoom" && s !== "zoom" && (editingWindowId || editingManualId)) {
    void closeOverrideEditor().catch((e: any) => alertUser(String(e?.message ?? e)));
  }
  layoutPipOverlay();
}

$("sectionswitch").addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-section]");
  if (tab) selectSection(tab.dataset.section as PaneSection);
});
$("sectionswitch").addEventListener("keydown", (e) => {
  const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  const tabs = [...$("sectionswitch").querySelectorAll<HTMLElement>("[data-section]")].filter((t) => !t.hidden);
  if (!dir && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? tabs[0] : e.key === "End" ? tabs[tabs.length - 1]
    : tabs[(at + dir + tabs.length) % tabs.length];
  if (!next) return;
  selectSection(next.dataset.section as PaneSection);
  next.focus();
});

// ---- preview sound (STC-454) ---------------------------------------------
//
// The preview plays the EXPORT's mix (preview-audio.ts over audio-mix.ts's
// mixBlock), at 1x only, silent while dragging, with the picture following
// the audio clock while it plays. Decoded after the take opens, so a take
// with long audio shows its picture first; `audioGen` drops a decode (or a
// cleanup) that lands after its take has closed.
//
// Narration cleanup is applied here too, the export's own `cleanNarration`,
// run in `narration-worker.ts` so a long take does not stall the transport.
// Until the cleaned mic arrives, whatever was playing keeps playing
// (Patrick, 2026-09-25: "cleaned, after a short wait").

let previewAudio: PreviewAudio | null = null;
let previewMuted = false;
let audioGen = 0;
let rawMic: PcmTrack | null = null;
/** The take's COMPRESSED mic — what the cleanup worker and a raw re-decode start from (STC-469). Null when there is no playable mic. */
let micSource: DemuxedAudio | null = null;
let cleanedMic: PcmTrack | null = null;
let cleanedFor: number | null = null;
let cleanWanted: number | null = null;
let cleanBusy = false;
let rawLoading = false;
let cleanSeq = 0;
let cleanWorker: Worker | null = null;

type PreviewAudioState = "none" | "loading" | "ready" | "unavailable";

function setPreviewAudioState(state: PreviewAudioState, detail = ""): void {
  const btn = $("previewaudio") as HTMLButtonElement;
  btn.dataset.state = state;
  btn.toggleAttribute("hidden", state === "none");
  btn.disabled = state === "unavailable";
  updatePreviewAudioButton(detail);
}

function updatePreviewAudioButton(detail = ""): void {
  const btn = $("previewaudio") as HTMLButtonElement;
  btn.setAttribute("aria-pressed", String(previewMuted));
  // The Audio section's "Mute while editing" is the same setting.
  const sw = $("previewmuteswitch") as HTMLInputElement;
  sw.checked = previewMuted;
  sw.disabled = btn.disabled;
  $("previewgroup").toggleAttribute("hidden", btn.hasAttribute("hidden"));
  const label = previewMuted ? "Unmute preview sound" : "Mute preview sound";
  btn.setAttribute("aria-label", label);
  const state = btn.dataset.state;
  btn.title = state === "loading" ? `${label} — preparing the sound…`
    : state === "unavailable" ? `Preview sound unavailable${detail ? `: ${detail}` : ""}. Exports are not affected.`
    : btn.dataset.cleaning === "true" ? `${label} — cleaning up the voice…`
    : label;
}

function setCleaning(on: boolean): void {
  ($("previewaudio") as HTMLButtonElement).dataset.cleaning = String(on);
  updatePreviewAudioButton();
}

async function loadPreviewAudio(session: LoadedSession, gen: number): Promise<void> {
  if (!session.micAudio && !session.systemAudio) { setPreviewAudioState("none"); return; }
  setPreviewAudioState("loading");
  try {
    const [mic, system] = await Promise.all([
      session.micAudio ? decodeMicForMix(session.micAudio, null) : null,
      session.systemAudio ? decodeSystemForMix(session.systemAudio) : null,
    ]);
    if (gen !== audioGen || !player) return;
    rawMic = mic;
    micSource = mic ? session.micAudio! : null;
    // A muted track plays at 0 (STC-454 part 3): the sound keeps being
    // scheduled, so the clock the picture follows never changes under a mute.
    previewAudio = new PreviewAudio({ mic, system }, previewLevels);
    previewAudio.setMuted(previewMuted);
    player.attachAudio(previewAudio);
    setPreviewAudioState(previewAudio.hasSound ? "ready" : "none");
    refreshCleanMic();
    scheduleWaveform();
  } catch (e: any) {
    // A track that will not decode costs the preview its SOUND, never its
    // picture: the player carries on, on the wall clock, exactly as before.
    if (gen !== audioGen) return;
    setPreviewAudioState("unavailable", String(e?.message ?? e));
  }
}

/**
 * The levels the preview plays and the waveform draws — ONE reader, so the
 * two cannot disagree. A muted track plays at 0 (STC-454 part 3): the sound
 * keeps being scheduled, so the clock the picture follows never changes
 * under a mute.
 */
function previewLevels(): { system: number; mic: number } {
  return {
    system: openProject?.systemAudioMuted ? 0 : openProject?.systemAudioLevel ?? 1,
    mic: openProject?.micMuted ? 0 : openProject?.micLevel ?? 1,
  };
}

/**
 * The tracks the preview holds, offered to the export (STC-469). The mic is
 * tagged with what it IS — raw, or cleaned at a strength — and
 * `reusableTracks` decides whether that is what this export needs.
 */
function decodedForExport(): ExportDecoded {
  const mic = previewAudio?.micTrack ?? null;
  const cleanedAt = mic !== null && mic === cleanedMic ? cleanedFor : null;
  const known = mic !== null && (mic === cleanedMic || mic === rawMic);
  return {
    system: previewAudio?.systemTrack ?? null,
    mic: known ? { track: mic!, cleanedAt } : null,
  };
}

/** Swap the mic the preview plays, and redraw the waveform when it actually changed. */
function useMic(track: PcmTrack | null): void {
  if (!previewAudio || previewAudio.micTrack === track) return;
  previewAudio.setMic(track);
  scheduleWaveform();
}

/** Point the preview at the mic the export would use: raw, or cleaned at the project's strength. */
function refreshCleanMic(): void {
  if (!previewAudio || !micSource) return;
  const cleanup = openProject?.narrationCleanup;
  const { cleanMic } = exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, cleanup });
  if (!cleanMic) {
    cleanWanted = null;
    if (rawMic) {
      useMic(rawMic);
      // STC-469: off means raw, so the cleaned copy is dead weight now.
      cleanedMic = null;
      cleanedFor = null;
    } else {
      // The raw mic was dropped while the cleaned one played: decode it back.
      // Whatever is playing keeps playing until it arrives.
      ensureRawMic();
    }
    if (!cleanBusy) setCleaning(false);
    return;
  }
  if (cleanedMic && cleanedFor === cleanup!.strength) {
    cleanWanted = null;
    useMic(cleanedMic);
    // STC-469: the cleaned mic is what plays; the worker re-cleans from the
    // COMPRESSED track, so the raw decoded copy buys nothing any more.
    rawMic = null;
    return;
  }
  cleanWanted = cleanup!.strength;
  pumpClean();
}

/** Decode the raw mic again (STC-469), then let `refreshCleanMic` re-decide — the project may have changed meanwhile. */
function ensureRawMic(): void {
  if (rawMic || rawLoading || !micSource) return;
  rawLoading = true;
  const gen = audioGen;
  decodeMicForMix(micSource, null).then((track) => {
    // Defensive: closeTake runs once per page today (the editor reloads its renderer per take), so this is live only if a take is ever switched in-page.
    if (gen !== audioGen) return;
    rawLoading = false;
    // It decoded once already, so null here would mean the decoder changed
    // its mind; with no raw to fall back to, there is no playable mic.
    if (!track) { micSource = null; return; }
    rawMic = track;
    refreshCleanMic();
  }, (e: any) => {
    if (gen !== audioGen) return;
    rawLoading = false;
    console.warn(`preview mic re-decode failed: ${e?.message ?? e}`);
  });
}

function pumpClean(): void {
  if (cleanBusy || cleanWanted === null || !micSource) return;
  const strength = cleanWanted;
  const id = ++cleanSeq;
  const gen = audioGen;
  cleanBusy = true;
  setCleaning(true);
  const worker = cleanWorker ??= new Worker("../dist/narration-worker.js");
  worker.onmessage = (e: MessageEvent<{ id: number; track?: PcmTrack | null; error?: string }>) => {
    if (e.data.id !== id) return;
    cleanBusy = false;
    if (gen !== audioGen) { setCleaning(false); return; }
    if (e.data.track) {
      cleanedMic = e.data.track;
      cleanedFor = strength;
      if (cleanWanted === strength) {
        cleanWanted = null;
        useMic(cleanedMic);
        rawMic = null; // STC-469: see refreshCleanMic
      }
    } else if (e.data.track === null) {
      cleanWanted = null; // a mic that decodes to nothing has nothing to clean
    } else {
      // The export cleans on its own; a preview that cannot is still a
      // preview. Keep playing what was playing and say so.
      cleanWanted = null;
      console.warn(`preview narration cleanup failed: ${e.data.error}`);
    }
    if (cleanWanted !== null) pumpClean();
    else setCleaning(false);
    // The one case this exists for: a cleaned mic landed AFTER cleanup was
    // switched off, so the preview must hand back to raw (decoding it again
    // if it was dropped). Gated on cleanup being OFF, not merely on nothing
    // being wanted: mid strength-slider drag `input` updates the project
    // without refreshing (only `change` does), and re-deciding here would
    // start a clean at a strength the drag is only passing through. Gated on
    // a successful track too: after an error or a null reply, re-deciding
    // would re-request the same failing clean forever.
    if (e.data.track && cleanWanted === null && !cleanBusy &&
        !exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, cleanup: openProject?.narrationCleanup }).cleanMic) {
      refreshCleanMic();
    }
  };
  // The COMPRESSED mic, cloned (STC-469): the worker decodes it itself, so
  // nothing here has to keep a raw decoded copy alive just to send one.
  worker.postMessage({ id, strength, audio: micSource });
}

function togglePreviewMuted(): void {
  previewMuted = !previewMuted;
  previewAudio?.setMuted(previewMuted);
  updatePreviewAudioButton();
  void editor.setPreviewMuted(previewMuted).catch(() => {});
}
$("previewaudio").addEventListener("click", togglePreviewMuted);
$("previewmuteswitch").addEventListener("change", togglePreviewMuted);

void editor.getSettings().then((s) => {
  previewMuted = s.previewMuted === true;
  previewAudio?.setMuted(previewMuted);
  updatePreviewAudioButton();
}).catch(() => {});

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
  // The level slider is the opposite case: its arrow keys adjust the LEVEL
  // and must not also step the playhead (STC-418 PR 3).
  if (e.target === $("sysaudiolevel") && RANGE_NATIVE_KEYS.has(e.key)) return;
  if (e.target === $("voicecleanstrength") && RANGE_NATIVE_KEYS.has(e.key)) return;
  if (e.target === $("miclevel") && RANGE_NATIVE_KEYS.has(e.key)) return;
  // Space on the focused switch belongs to the SWITCH (STC-455). Without
  // this the timeline takes it as play/pause and the switch never toggles —
  // measured: the e2e's mutation check fails on exactly that.
  if (e.target === $("voicecleanon") && (e.key === " " || e.key === "Enter")) return;
  // And for every control in the Camera section (STC-461): its sliders' arrow
  // keys move the slider, its buttons and switches take Space/Enter.
  if ($("pippanel").contains(e.target as Node)
      && (RANGE_NATIVE_KEYS.has(e.key) || e.key === " " || e.key === "Enter")) return;
  // The Audio section (STC-604): its sliders take the arrow keys, its
  // switches and the section tabs take Space/Enter.
  if (($("audiopanel").contains(e.target as Node) || $("sectionswitch").contains(e.target as Node)
        || $("exportpanel").contains(e.target as Node) || $("zoompanel").contains(e.target as Node)
        || $("framepanel").contains(e.target as Node))
      && (RANGE_NATIVE_KEYS.has(e.key) || e.key === " " || e.key === "Enter")) return;
  // The same for the per-track mutes (STC-454 part 3).
  if ((e.target === $("micmute") || e.target === $("sysmute")) && (e.key === " " || e.key === "Enter")) return;
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
  // STC-606: a move with no button down means the release was missed (seen
  // when a second drag followed at once: the in-point then chased the pointer
  // to the out bar). End the drag rather than move a point nobody holds.
  if ((e.buttons & 1) === 0) { onHandleUp(); return; }
  const durationNs = player.durationNs;
  const startFrame = nsToFrame(openProject.trim?.startNs ?? 0, durationNs);
  const endFrame = nsToFrame(openProject.trim?.endNs ?? durationNs, durationNs);
  const wanted = frameAtClientX(e.clientX);
  const opposite = dragging === "in" ? endFrame : startFrame;
  const { clamped, held } = clampTrimFrame(dragging, wanted, opposite, durationNs);

  if (dragging === "in") setTrim(frameToNs(clamped, durationNs), frameToNs(endFrame, durationNs), false);
  else setTrim(frameToNs(startFrame, durationNs), frameToNs(clamped, durationNs), false);

  // STC-606: the Export section's bar for the same point rubber-bands with it.
  const marks = dragging === "in" ? ["trim-in", "exportbar-in"] : ["trim-out", "exportbar-out"];
  for (const id of marks) {
    const handle = $(id);
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
}

function onHandleUp(): void {
  if (!dragging) return;
  for (const id of ["trim-in", "trim-out", "exportbar-in", "exportbar-out"]) {
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
$("trim-in").addEventListener("lostpointercapture", onHandleUp);
$("trim-out").addEventListener("lostpointercapture", onHandleUp);
// STC-606: the Export section's bars drag the same points.
for (const [id, which] of [["exportbar-in", "in"], ["exportbar-out", "out"]] as const) {
  $(id).addEventListener("pointerdown", (e) => onHandleDown(which, e as PointerEvent));
  $(id).addEventListener("pointermove", (e) => onHandleMove(e as PointerEvent));
  $(id).addEventListener("pointerup", onHandleUp);
  $(id).addEventListener("pointercancel", onHandleUp);
  $(id).addEventListener("lostpointercapture", onHandleUp);
}

// ---- export -------------------------------------------------------------

async function runExport(): Promise<void> {
  if (!openSession || !openProject || exportAbort) return;
  // STC-461/STC-500: commit a reframe and an open override edit first — the
  // export reads the live project.
  await finishOpenEdits();
  player?.pause();
  exportAbort = new AbortController();

  const bar = $("exportbar");
  const progress = $("exportprogress") as HTMLProgressElement;
  const status = $("exportstatus");
  bar.removeAttribute("hidden");
  ($("export") as HTMLButtonElement).disabled = true;
  ($("outsize") as HTMLSelectElement).disabled = true;
  setFramePresetDisabled(true);
  ($("framecolor") as HTMLInputElement).disabled = true;
  for (const id of ["framepadding", "frameradius", "frameshadow"]) ($(id) as HTMLInputElement).disabled = true;
  progress.value = 0;
  status.textContent = "Exporting…";
  clearAlert();

  const started = performance.now();
  const exporting: Project = structuredClone(withHeldFraming(openProject, heldFraming));
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
      decoded: decodedForExport(),
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
      // STC-418: nonzero only when the take had system audio and was mixed.
      mixEncodedChunks: result.mixEncodedChunks,
      output: exporting.output,
      trim: projectForWrite(exporting, lastNs).trim ?? null,
      legibility: openDisplay ? (() => {
        const l = legibility(openDisplay!, exporting.textPt ?? DEFAULT_TEXT_PT, embedWidthPx, 1, frameFractionFor(exporting));
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
    setFramePresetDisabled(false);
    ($("framecolor") as HTMLInputElement).disabled = false;
    updateFramingUI();   // padding, corners and shadow wait for a frame again
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
  // STC-461/STC-500: commit a reframe and an open override edit first, so the
  // take main publishes is the one the user ends up with — the live project
  // still holds the temporary display style / the stripped override until
  // they are committed.
  await finishOpenEdits();
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
    // STC-461/STC-500: commit a reframe and an open override edit first —
    // captureFrame re-renders the live project.
    await finishOpenEdits();
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
// One icon (STC-444): click copies, and a right-click on it OR on the preview
// opens a two-item menu with Copy and Save. STC-453: that menu is the one
// path to Save with the mouse — the ⌥-click shortcut was removed because it
// applied to the icon only and nothing showed it.
$("framegrab").addEventListener("click", () => void withFrame("copy"));

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

// STC-461: the editor reloads its renderer per take, so closing the window or
// opening another take mid-reframe never reaches closeTake. Commit here too:
// postOpenEditWrites sends the writes synchronously (the IPC messages are out
// before the page goes), so the reframe the user can see — and, STC-500, an
// open zoom-override edit — is not silently dropped.
window.addEventListener("beforeunload", () => {
  void postOpenEditWrites().catch(() => { /* the page is going; nowhere to report */ });
  void editor.closePreview();
});

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
    // Share lives in the Export section (STC-444 slice 3) — show it the same
    // way `#openexport`'s own click does, so the slug field and site-folder
    // note are populated before `publish()` reads them, and so the person can
    // actually see the status line while it runs.
    if (autoShare) {
      await showExportSection();
      void publish();
    }
  } catch (e: any) {
    alertUser(`Could not open "${takeName || takeDir}".\n${e?.message ?? e}`);
  }
})();
