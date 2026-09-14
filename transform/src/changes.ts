import { GRID_W, GRID_H, DEFAULT_THRESHOLD, changeGrid, type Frame } from "./frame-diff-rule.js";

/**
 * changes.json — schema/changes-1.schema.json as types, plus the one loader
 * and the one writer (STC-322), same pattern as recording.ts.
 *
 * A coarse per-frame, per-cell change grid over a take's display track,
 * written once by a post-recording pass (see `computeChangeDocument` below
 * and `transform/src/change-track.ts` for the browser-dependent half that
 * feeds it decoded frames). Raw change only — no events joined in; the
 * temporal filter (change near an event vs. ambient) is auto-zoom stage 2's
 * job, in the transform, where fixtures can test it.
 */

export interface ChangeFrame {
  /** This frame's PTS, session-relative integer ns — matches Session.frames. */
  t: number;
  /** gridWidth * gridHeight entries, row-major from the top-left. */
  cells: number[];
  changedFraction: number;
}

export interface Changes {
  version: 1;
  gridWidth: number;
  gridHeight: number;
  threshold: number;
  frames: ChangeFrame[];
}

export class ChangesLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangesLoadError";
  }
}

export const CHANGES_VERSIONS: readonly number[] = [1];

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A key nobody declared is refused, not dropped — same reasoning as recording.ts's noExtra. */
function noExtra(v: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new ChangesLoadError(`${what} has a field this version does not know: ${k}`);
  }
}

function frame(v: unknown, i: number, cellCount: number): ChangeFrame {
  const what = `frames[${i}]`;
  if (!isObj(v)) throw new ChangesLoadError(`${what} is not an object`);
  noExtra(v, ["t", "cells", "changedFraction"], what);
  if (!isInt(v.t) || v.t < 0) throw new ChangesLoadError(`${what}.t must be a non-negative integer`);
  if (!Array.isArray(v.cells)) throw new ChangesLoadError(`${what}.cells must be an array`);
  // The schema can only bound array length with a literal, and the length
  // this document must have depends on gridWidth * gridHeight — a
  // cross-field product constraint, same class as recording.ts's endNs >
  // startNs, so the loader checks it rather than the schema.
  if (v.cells.length !== cellCount) {
    throw new ChangesLoadError(`${what}.cells has ${v.cells.length} entries, expected gridWidth * gridHeight = ${cellCount}`);
  }
  const cells = v.cells.map((c, j) => {
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
      throw new ChangesLoadError(`${what}.cells[${j}] must be a number in 0..1`);
    }
    return c;
  });
  if (typeof v.changedFraction !== "number" || !Number.isFinite(v.changedFraction) || v.changedFraction < 0 || v.changedFraction > 1) {
    throw new ChangesLoadError(`${what}.changedFraction must be a number in 0..1`);
  }
  return { t: v.t, cells, changedFraction: v.changedFraction };
}

/**
 * Reads a changes.json. Throws ChangesLoadError, with the field named, on
 * anything it cannot render from; returns a normalised copy (no aliasing of
 * `raw`). Refuses rather than defaults — same reasoning as recording.ts and
 * shot.ts: a sidecar naming a take's change signal that cannot be read is
 * indistinguishable from one that was never computed, and guessing beats
 * nothing only until the guess is wrong.
 */
export function parseChanges(raw: unknown): Changes {
  if (!isObj(raw)) throw new ChangesLoadError("changes.json is not an object");
  noExtra(raw, ["version", "gridWidth", "gridHeight", "threshold", "frames"], "changes.json");
  if (!CHANGES_VERSIONS.includes(raw.version as number)) {
    throw new ChangesLoadError(`changes.json version ${String(raw.version)} is not supported (expected ${CHANGES_VERSIONS.join(", ")})`);
  }
  if (!isInt(raw.gridWidth) || raw.gridWidth < 1) throw new ChangesLoadError("gridWidth must be a positive integer");
  if (!isInt(raw.gridHeight) || raw.gridHeight < 1) throw new ChangesLoadError("gridHeight must be a positive integer");
  if (typeof raw.threshold !== "number" || !Number.isFinite(raw.threshold) || raw.threshold < 0 || raw.threshold > 1) {
    throw new ChangesLoadError("threshold must be a number in 0..1");
  }
  if (!Array.isArray(raw.frames)) throw new ChangesLoadError("frames must be an array");
  const cellCount = raw.gridWidth * raw.gridHeight;
  const frames = raw.frames.map((f, i) => frame(f, i, cellCount));

  // Ordered, strictly increasing PTS — a downstream reader walking frames in
  // array order must see time move forward, same rule Session.frames and
  // recording.ts's segments both hold to.
  for (let i = 1; i < frames.length; i++) {
    if (frames[i]!.t <= frames[i - 1]!.t) {
      throw new ChangesLoadError(`frames[${i}].t (${frames[i]!.t}) does not come after frames[${i - 1}].t (${frames[i - 1]!.t})`);
    }
  }

  return { version: 1, gridWidth: raw.gridWidth, gridHeight: raw.gridHeight, threshold: raw.threshold, frames };
}

/** The document to write. Always the latest version. */
export function changesForWrite(changes: Changes): Changes {
  return parseChanges(JSON.parse(JSON.stringify({ ...changes, version: 1 })));
}

/**
 * The post-recording pass's pure half: given every decoded frame of a take's
 * display track (already-extracted RGBA, in PTS order) and the PTS each was
 * decoded at, computes the whole changes.json document.
 *
 * Deliberately takes `Frame[]` rather than `ImageBitmap[]` — extracting RGBA
 * from a decoded frame needs a canvas (`transform/src/change-track.ts`'s
 * `extractFrames`), which needs a browser; the reduction itself does not,
 * and keeping it Frame-in/Changes-out is what makes this function testable
 * with synthetic buffers in plain Node (see
 * transform/test/change-track.test.ts) and lets it report a real, measured
 * per-frame-pair cost from THIS machine even though nothing here can decode
 * real video (STC-322's finding doc explains why).
 *
 * Frame 0 has no predecessor and gets an all-zero grid rather than being
 * omitted — same convention STC-319's own study page used
 * (`scores = [0] // frame 0 has no predecessor`) — so a consumer can index
 * by frame position without special-casing the first one.
 */
export function computeChangeDocument(
  frames: readonly Frame[],
  framesNs: readonly number[],
  opts: { threshold?: number; gridWidth?: number; gridHeight?: number } = {},
): Changes {
  if (frames.length !== framesNs.length) {
    throw new Error(`frames (${frames.length}) and framesNs (${framesNs.length}) must be the same length`);
  }
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const gridWidth = opts.gridWidth ?? GRID_W;
  const gridHeight = opts.gridHeight ?? GRID_H;
  const cellCount = gridWidth * gridHeight;

  const out: ChangeFrame[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (i === 0) {
      out.push({ t: framesNs[0]!, cells: new Array(cellCount).fill(0), changedFraction: 0 });
      continue;
    }
    const g = changeGrid(frames[i - 1]!, frames[i]!, threshold, gridWidth, gridHeight);
    out.push({ t: framesNs[i]!, cells: Array.from(g.cells), changedFraction: g.changedFraction });
  }
  return { version: 1, gridWidth, gridHeight, threshold, frames: out };
}
