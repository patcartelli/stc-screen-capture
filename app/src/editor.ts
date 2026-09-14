/**
 * The editor window (STC-373) — preview, trim, export, legibility and share,
 * split out of the main window's in-page player. v1 is trim-only: the
 * timeline's two lanes (Clip, Zoom) are read-only visualisations over the
 * shared span; there is no manual override yet (STC-328/330/331).
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
}
declare const editor: {
  openPreview: (dir: string) => Promise<boolean>;
  closePreview: () => Promise<void>;
  readTakeFile: (name: string) => Promise<ArrayBuffer>;
  takeFileSize: (name: string) => Promise<number>;
  readTakeChunk: (name: string, offset: number, length: number) => Promise<ArrayBuffer>;
  writeProject: (bytes: ArrayBuffer) => Promise<boolean>;
  writeExport: (name: string, bytes: ArrayBuffer) => Promise<string>;
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
  chooseShareDestination(): Promise<{ destination: string | null }>;
  revealPublished(): Promise<{ ok: boolean; file?: string; message?: string }>;
};

import { loadSession, type LoadedSession } from "@transform/session";
import { PreviewPlayer } from "@transform/preview";
import { exportSession } from "@transform/export";
import type { Project } from "@transform/types";
import {
  parseProject, projectForWrite, exportWindow, estimateExportMs,
  clampTrim, isFullTake, minTrimNs,
} from "@transform/trim";
import { outputSizeFor, outputOptions, selectedOption, type OutputOption } from "@transform/output-size";
import type { Size } from "@transform/spaces";
import { render } from "@transform/render";
import {
  DEFAULT_TEXT_PT, EMBED_TARGETS, legibility, legibilitySentence, zoomFactorForCrop,
} from "@transform/legibility";
import { TRANSFORM_VERSION } from "@transform/transform-version";
import {
  clampTrimFrame, decideKey, formatReadout, formatShuttle, frameAtFraction, frameToNs,
  fractionOfFrame, lastFrame, nsToFrame, rubberBandPx, tickStrideFrames, type ScrubAction,
} from "./scrubber.js";
import { exportManifestName, exportMediaName } from "./share.js";
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
  ($("clip-canvas-wrap") as HTMLElement).style.transform = transform;
  ($("zoom-canvas-wrap") as HTMLElement).style.transform = transform;
  ($("ruler-content") as HTMLElement).style.transform = transform;
  updateTicks();
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

  // Rule 4: what was cut is DIMMED, not fenced off.
  const head = $("cut-head") as HTMLElement;
  head.style.left = "0%";
  head.style.width = `${Math.max(0, inPct)}%`;
  const tail = $("cut-tail") as HTMLElement;
  tail.style.left = `${outPct}%`;
  tail.style.width = `${Math.max(0, 100 - outPct)}%`;
  updateTicks();

  const w = exportWindow(openProject, player.durationNs);
  const est = fmtEstimate(estimateExportMs(w.maxFrames));
  $("triminfo").textContent = isFullTake(openProject, player.durationNs)
    ? `Full take · ${fmtClock(player.durationNs)} · ${est}`
    : `${fmtClock(w.startNs)}–${fmtClock(w.endNs)} · ${fmtClock(w.endNs - w.startNs)} · ${est}`;
}

/**
 * How many animation frames a zero-width `#timeline` measurement gets
 * retried before it is trusted (STC-379).
 *
 * master's CI failed this exact test deterministically (3/3 checked runs)
 * starting at the commit that introduced this editor window, while 5+ runs
 * here under Xvfb never reproduced it — a gap consistent with (not proven to
 * be) real macOS window creation reporting a fresh `BrowserWindow`'s content
 * at zero width on the very first synchronous layout query, before the OS
 * has finished handing the window its real size, then correcting itself on
 * a later frame with no DOM event this code was listening for in between —
 * the existing `resize` listener only re-measures once `player` already
 * exists, and by then the window's first, wrong size may be the only one it
 * ever announces. This retry is the fix for THAT theory; CI on a real Mac is
 * what actually confirms or refutes it, which this sandbox cannot do.
 * Bounded, not indefinite: a window that is genuinely too narrow must still
 * hide the ticks — that refusal is rule 9's own point — so this only
 * postpones the verdict long enough for a transient zero to resolve itself.
 */
const TICK_WIDTH_RETRY_FRAMES = 5;
let tickWidthRetriesLeft = 0;

/** The export grid on the track (STC-338 rule 9). See renderer.ts's original for the reasoning. */
function updateTicks(): void {
  const ticks = $("ticks") as HTMLElement;
  const width = $("timeline").getBoundingClientRect().width;
  const stride = player ? tickStrideFrames(player.durationNs, width) : null;
  if (!player || stride === null || width <= 0) {
    ticks.setAttribute("hidden", "");
    if (player && width <= 0 && tickWidthRetriesLeft > 0) {
      tickWidthRetriesLeft--;
      requestAnimationFrame(updateTicks);
    }
    return;
  }
  ticks.removeAttribute("hidden");
  ticks.style.setProperty("--tick-px", `${(width / lastFrame(player.durationNs)) * stride}px`);
}

window.addEventListener("resize", () => { if (player) updateTicks(); });

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

// ---- the Clip and Zoom lanes (STC-373) --------------------------------------

const LANE_BUCKETS = 480;

function drawClipLane(): void {
  const canvas = $("clip-activity") as HTMLCanvasElement;
  const wrap = $("clip-canvas-wrap") as HTMLElement;
  const w = Math.max(1, Math.round(wrap.getBoundingClientRect().width)) || LANE_BUCKETS;
  const h = 30;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  if (!player || !openSession) return;
  const activity = clipActivity(openSession.events, player.durationNs, LANE_BUCKETS);
  const barW = w / activity.length;
  const style = getComputedStyle(document.documentElement).getPropertyValue("--clip").trim() || "#6a8fd8";
  ctx.fillStyle = style || "#6a8fd8";
  for (let i = 0; i < activity.length; i++) {
    const bh = Math.max(1, activity[i]! * (h - 4));
    ctx.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
  }
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
  const style = getComputedStyle(document.documentElement).getPropertyValue("--zoom").trim() || "#d88a3b";
  ctx.strokeStyle = style || "#d88a3b";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * w;
    // amount is not clamped to [0, 1] (zoom.ts's own note) — draw whatever
    // comes back, clipped to the lane's own height rather than pretending it
    // cannot exceed 1.
    const y = h - Math.max(0, Math.min(1, curve[i]!)) * (h - 2) - 1;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function redrawLanes(): void { drawClipLane(); drawZoomLane(); }
window.addEventListener("resize", redrawLanes);

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
  const [anchors, events, mp4, projectRaw] = await Promise.all([
    editor.readTakeFile("anchors.json").then((b) => JSON.parse(dec.decode(b))),
    editor.readTakeFile("events.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => ({ version: 1, events: [] })),
    readVideo(),
    editor.readTakeFile("project.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => null),
  ]);
  const cameraMp4 = anchors.files?.camera ? await readVideo(anchors.files.camera) : undefined;
  const session = await loadSession({ anchors, events, displayMp4: mp4, cameraMp4 });
  const durationNs = session.frames[session.frames.length - 1] ?? 0;
  const project = parseProject(
    projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
    anchors.camera?.present === true,
  );

  openSession = session;
  openProject = project;
  openCapture = { width: anchors.capture.width, height: anchors.capture.height };
  openDisplay = { pointWidth: anchors.display.pointWidth };
  player = new PreviewPlayer($("stage") as HTMLCanvasElement, session, project);
  tickWidthRetriesLeft = TICK_WIDTH_RETRY_FRAMES;
  const scrub = $("scrub") as HTMLInputElement;
  scrub.max = String(lastFrame(player.durationNs));
  scrub.value = "0";
  player.onTime = (tNs, playing) => {
    const frame = nsToFrame(tNs, player!.durationNs);
    $("clock").textContent = formatReadout(frame, player!.durationNs);
    ($("playpause") as HTMLButtonElement).textContent = playing ? "Pause" : "Play";
    $("shuttle").textContent = formatShuttle(player!.rate);
    if (!scrubbing) scrub.value = String(frame);
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
  player?.close();
  player = undefined;
  openSession = undefined;
  openProject = undefined;
  openCapture = undefined;
  openDisplay = undefined;
  applyStageDisplay();
  await editor.closePreview();
}

$("playpause").addEventListener("click", () => {
  if (!player) return;
  player.isPlaying ? player.pause() : player.play(1);
  updateShuttleUI();
});
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
    { frame: currentFrame(), durationNs: player.durationNs, rate: player.rate },
  );
  if (!action) return;
  e.preventDefault();
  applyScrubAction(action);
});

function currentFrame(): number {
  return player ? nsToFrame(player.currentNs, player.durationNs) : 0;
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
  }
}

function updateShuttleUI(): void {
  $("shuttle").textContent = formatShuttle(player?.rate ?? 0);
  ($("playpause") as HTMLButtonElement).textContent = player?.isPlaying ? "Pause" : "Play";
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
    const result = await exportSession(openSession, exporting, {
      hash: true,
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

// ---- share ----------------------------------------------------------------

function shareStatus(text: string): void { $("sharestatus").textContent = text; }

async function publish(): Promise<void> {
  const btn = $("share") as HTMLButtonElement;
  btn.disabled = true;
  shareStatus("Copying…");
  try {
    const r = await editor.publish();
    if (!r.ok) { shareStatus(r.message ?? "Could not share."); return; }
    const verb = r.replaced ? "Replaced" : "Wrote";
    shareStatus(`${verb} ${r.name}. Snippet copied.`);
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
$("sharedest").addEventListener("click", () => void (async () => {
  const { destination } = await editor.chooseShareDestination();
  shareStatus(destination ? `Site folder: ${destination}` : "No site folder chosen.");
})());
$("revealshared").addEventListener("click", () => void (async () => {
  const r = await editor.revealPublished();
  if (!r.ok) shareStatus(r.message ?? "Nothing published yet.");
})());

// ---- the current frame as a still (STC-298/293) ----------------------------

function frameStatus(text: string): void {
  const el = $("framestatus");
  el.textContent = text;
  el.removeAttribute("hidden");
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
$("copyframe").addEventListener("click", () => void withFrame("copy"));
$("saveframe").addEventListener("click", () => void withFrame("save"));
document.addEventListener("keydown", (e) => {
  if (!player || !(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
  if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
  if (e.key === "C" || e.key === "c") { e.preventDefault(); void withFrame("copy"); }
  if (e.key === "S" || e.key === "s") { e.preventDefault(); void withFrame("save"); }
});

// ---- boot -------------------------------------------------------------

window.addEventListener("beforeunload", () => { void editor.closePreview(); });

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
