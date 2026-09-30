import type { Anchors, SessionEvent } from "./types.js";
import type { Changes } from "./changes.js";
import type { Rect } from "./spaces.js";
import { zoomWindows, type ZoomWindow } from "./zoom.js";
import {
  deriveZoomCrop, classifyCells, triggerPointsUv, CELL_ACTIVE_FRACTION, AMBIENT_FRAME_FRACTION,
  type CellClass,
} from "./zoom-change.js";

/**
 * Where did auto-zoom stage 2 go wrong on a real take (STC-405)? Pure: a
 * take's anchors, events and `changes.json` in, an audit out — no decode, no
 * DOM, so `scripts/zoom-audit-one.mjs` is a thin reader around it and the
 * fixtures in `transform/test/zoom-audit.test.ts` hold the rules.
 *
 * ## What "a false trigger" can and cannot mean here
 *
 * Stage 1 (`zoom.ts`) opens a window ONLY on a click or a drag. Visual noise
 * — a video tile, a toast, the active-speaker border — cannot open one. So on
 * a screen share, noise does not cause zooms; it corrupts WHERE a real click's
 * zoom lands, in one of three ways this audit names per window:
 *
 *   suppressed   the change track said "don't zoom" where the cursor alone
 *                would have framed the click. Noise swallowed a real zoom.
 *   misdirected  the change crop does not contain the click. The picture
 *                zooms to something else the screen was doing.
 *   drifted      it contains the click but sits far off the cursor's own
 *                answer — framed on the click AND on something beside it.
 *
 * Plus a census of change OUTSIDE every window: a take's noise floor, which is
 * what STC-319/320's temporal filter has to reject.
 *
 * Only a take WITH a `changes.json` exercises the change path at all; without
 * one every window takes the cursor fallback, which cannot be misled by
 * pixels. `scripts/change-track-one.mjs` writes that sidecar.
 */

/** A crop whose centre sits this far (UV) from the cursor crop's is "drifted". 0.1 = a tenth of the frame; provisional, like every threshold in zoom-change.ts. */
export const DRIFT_UV = 0.1;
/** A surviving cell this far (UV) from every trigger point is "far" — change that passed the burst filter but is not where the user clicked. */
export const FAR_CELL_UV = 0.2;
/** Outside-window frames with at least this changedFraction count as a noise burst. */
export const NOISE_BURST_FRACTION = 0.02;
/** Burst frames closer together than this belong to one burst. */
export const NOISE_BURST_GAP_NS = 250_000_000;
/** A burst this close to a window (either side) can reach its classifier's burst margin or its crop. */
export const NEAR_WINDOW_NS = 1_000_000_000;

export type Finding = "clean" | "suppressed" | "misdirected" | "drifted" | "no-coverage";

export interface WindowAudit {
  index: number;
  startNs: number;
  endNs: number;
  triggers: number;
  /** trigger positions in capture UV */
  points: { x: number; y: number }[];
  cursorCrop: Rect | null;
  changeCrop: Rect | null;
  cells: Record<CellClass, number>;
  /** survivor cells farther than FAR_CELL_UV from every trigger point */
  farSurvivors: number;
  containsTriggers: boolean | null;
  /** UV distance between the two crops' centres; null when either is null */
  offsetUv: number | null;
  finding: Finding;
}

export interface NoiseBurst {
  startNs: number;
  endNs: number;
  frames: number;
  peakFraction: number;
  nearWindow: boolean;
}

export interface NoiseCensus {
  frames: number;
  /** frames outside every zoom window */
  idleFrames: number;
  idleP50: number;
  idleP95: number;
  idleMax: number;
  gridWidth: number;
  gridHeight: number;
  /** per cell: fraction of ALL frames on which it was active, row-major top-left first */
  cellActivity: number[];
  /** cells active on at least AMBIENT_FRAME_FRACTION of frames: what a continuous tile looks like */
  persistentCells: number;
  bursts: NoiseBurst[];
}

export interface TakeAudit {
  windows: WindowAudit[];
  census: NoiseCensus;
}

const contains = (r: Rect, p: { x: number; y: number }) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function auditWindow(
  window: ZoomWindow, index: number, anchors: Anchors, frames: readonly number[], changes: Changes,
): WindowAudit {
  const points = triggerPointsUv(window, anchors, frames);
  const cursorCrop = deriveZoomCrop(window, undefined, anchors, frames);
  const inWindow = changes.frames.filter((f) => f.t >= window.startNs && f.t <= window.endNs);
  const cells: Record<CellClass, number> = { survivor: 0, ambient: 0, quiet: 0, unconcentrated: 0 };
  let farSurvivors = 0;

  if (inWindow.length === 0) {
    return {
      index, startNs: window.startNs, endNs: window.endNs, triggers: window.events.length, points,
      cursorCrop, changeCrop: null, cells, farSurvivors, containsTriggers: null, offsetUv: null, finding: "no-coverage",
    };
  }

  const changeCrop = deriveZoomCrop(window, changes, anchors, frames);
  const classes = classifyCells(window, changes, inWindow);
  const { gridWidth, gridHeight } = changes;
  classes.forEach((c, i) => {
    cells[c]++;
    if (c !== "survivor") return;
    const cx = ((i % gridWidth) + 0.5) / gridWidth, cy = (Math.floor(i / gridWidth) + 0.5) / gridHeight;
    if (points.length > 0 && points.every((p) => Math.hypot(p.x - cx, p.y - cy) > FAR_CELL_UV)) farSurvivors++;
  });

  const containsTriggers = changeCrop ? points.every((p) => contains(changeCrop, p)) : null;
  let offsetUv: number | null = null;
  if (changeCrop && cursorCrop) {
    const a = centre(changeCrop), b = centre(cursorCrop);
    offsetUv = Math.hypot(a.x - b.x, a.y - b.y);
  }

  let finding: Finding = "clean";
  if (changeCrop === null && cursorCrop !== null) finding = "suppressed";
  else if (changeCrop !== null && containsTriggers === false) finding = "misdirected";
  else if (offsetUv !== null && offsetUv > DRIFT_UV) finding = "drifted";

  return {
    index, startNs: window.startNs, endNs: window.endNs, triggers: window.events.length, points,
    cursorCrop, changeCrop, cells, farSurvivors, containsTriggers, offsetUv, finding,
  };
}

function census(windows: readonly ZoomWindow[], changes: Changes): NoiseCensus {
  const { gridWidth, gridHeight } = changes;
  const n = changes.frames.length;
  const cellActivity = new Array<number>(gridWidth * gridHeight).fill(0);
  const idle: { t: number; fraction: number }[] = [];
  const isIdle = (t: number) => !windows.some((w) => t >= w.startNs && t <= w.endNs);

  for (const f of changes.frames) {
    for (let i = 0; i < cellActivity.length; i++) if (f.cells[i]! >= CELL_ACTIVE_FRACTION) cellActivity[i]!++;
    if (isIdle(f.t)) idle.push({ t: f.t, fraction: f.changedFraction });
  }
  for (let i = 0; i < cellActivity.length; i++) cellActivity[i] = n === 0 ? 0 : cellActivity[i]! / n;

  const sorted = idle.map((x) => x.fraction).sort((a, b) => a - b);
  const bursts: NoiseBurst[] = [];
  for (const x of idle) {
    if (x.fraction < NOISE_BURST_FRACTION) continue;
    const last = bursts[bursts.length - 1];
    if (last && x.t - last.endNs <= NOISE_BURST_GAP_NS) {
      last.endNs = x.t; last.frames++; last.peakFraction = Math.max(last.peakFraction, x.fraction);
    } else {
      bursts.push({ startNs: x.t, endNs: x.t, frames: 1, peakFraction: x.fraction, nearWindow: false });
    }
  }
  for (const b of bursts) {
    b.nearWindow = windows.some((w) => b.endNs >= w.startNs - NEAR_WINDOW_NS && b.startNs <= w.endNs + NEAR_WINDOW_NS);
  }

  return {
    frames: n, idleFrames: idle.length,
    idleP50: quantile(sorted, 0.5), idleP95: quantile(sorted, 0.95), idleMax: sorted[sorted.length - 1] ?? 0,
    gridWidth, gridHeight, cellActivity,
    persistentCells: cellActivity.filter((a) => a >= AMBIENT_FRAME_FRACTION).length,
    bursts,
  };
}

export function auditTake(input: { anchors: Anchors; events: readonly SessionEvent[]; changes: Changes }): TakeAudit {
  const { anchors, events, changes } = input;
  const frames = changes.frames.map((f) => f.t);
  const windows = zoomWindows(events);
  return {
    windows: windows.map((w, i) => auditWindow(w, i, anchors, frames, changes)),
    census: census(windows, changes),
  };
}

// --- the report -------------------------------------------------------------

const RAMP = " .:-=+*#%@";
const secs = (ns: number) => (ns / 1e9).toFixed(2) + "s";
const mmss = (ns: number) => {
  const s = ns / 1e9;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};
const pct = (x: number) => (x * 100).toFixed(1) + "%";
const rectStr = (r: Rect | null) => (r ? `${r.x.toFixed(2)},${r.y.toFixed(2)} ${r.width.toFixed(2)}×${r.height.toFixed(2)}` : "none");

/** The activity map, two grid rows per line so 64×36 fits a terminal. Dark = a cell that is active most of the take. */
export function activityMap(c: NoiseCensus): string {
  const lines: string[] = [];
  for (let row = 0; row < c.gridHeight; row += 2) {
    let line = "";
    for (let col = 0; col < c.gridWidth; col++) {
      const a = Math.max(c.cellActivity[row * c.gridWidth + col]!, c.cellActivity[Math.min(row + 1, c.gridHeight - 1) * c.gridWidth + col]!);
      line += RAMP[Math.min(RAMP.length - 1, Math.floor(a * RAMP.length))];
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

export function renderReport(a: TakeAudit, label = "take"): string {
  const out: string[] = [];
  out.push(`# STC-405 audit — ${label}`, "");

  out.push("## Zoom windows", "");
  if (a.windows.length === 0) out.push("No windows: the take has no click or drag, so auto-zoom asks for nothing.", "");
  else {
    const tally: Record<Finding, number> = { clean: 0, suppressed: 0, misdirected: 0, drifted: 0, "no-coverage": 0 };
    for (const w of a.windows) tally[w.finding]++;
    out.push(`${a.windows.length} windows — ` + (Object.keys(tally) as Finding[]).map((k) => `${tally[k]} ${k}`).join(", "), "");
    out.push("| # | at | triggers | finding | change crop | cursor crop | offset | far cells | judged (you) |", "|---|---|---|---|---|---|---|---|---|");
    for (const w of a.windows) {
      out.push(`| ${w.index} | ${mmss(w.startNs)}–${mmss(w.endNs)} | ${w.triggers} | **${w.finding}** | ${rectStr(w.changeCrop)} | ${rectStr(w.cursorCrop)} | ${w.offsetUv === null ? "–" : w.offsetUv.toFixed(2)} | ${w.farSurvivors} | |`);
    }
    out.push("", "Cell classes per window (survivor / ambient / unconcentrated / quiet):", "");
    for (const w of a.windows) {
      out.push(`- #${w.index}: ${w.cells.survivor} / ${w.cells.ambient} / ${w.cells.unconcentrated} / ${w.cells.quiet}`);
    }
    out.push("");
  }

  const c = a.census;
  out.push("## Noise floor (outside every zoom window)", "");
  out.push(`${c.idleFrames} of ${c.frames} frames. Changed fraction: median ${pct(c.idleP50)}, p95 ${pct(c.idleP95)}, max ${pct(c.idleMax)}.`);
  out.push(`${c.persistentCells} cells are active on at least ${pct(AMBIENT_FRAME_FRACTION)} of all frames (continuous tiles).`, "");
  out.push("Activity map (darker = active on more frames; 64×36 grid, two rows per line):", "", "```", activityMap(c), "```", "");

  out.push(`### Bursts (≥ ${pct(NOISE_BURST_FRACTION)} changed, outside any window): ${c.bursts.length}`, "");
  if (c.bursts.length > 0) {
    out.push("| at | length | frames | peak | near a window | what it was (you) |", "|---|---|---|---|---|---|");
    for (const b of [...c.bursts].sort((x, y) => y.peakFraction - x.peakFraction).slice(0, 25)) {
      out.push(`| ${mmss(b.startNs)} | ${secs(b.endNs - b.startNs)} | ${b.frames} | ${pct(b.peakFraction)} | ${b.nearWindow ? "**yes**" : "no"} | |`);
    }
    out.push("");
  }
  return out.join("\n");
}
