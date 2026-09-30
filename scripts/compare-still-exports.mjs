#!/usr/bin/env node
/**
 * Do the panel's export and the still editor's export of ONE shot agree?
 * (STC-477, `docs/STC-477-RUNBOOK.md`.)
 *
 * The bug was two copies of "composite, then export" that had drifted: the
 * editor ignored the output-scale preference and composited on an untagged
 * (sRGB) canvas while the file was still tagged Display P3. Both show up as a
 * DIFFERENCE between two files that should be the same picture — so this
 * compares them, rather than asking an eye whether one looks "a bit
 * saturated". The eye check in the runbook is corroboration, not the test.
 *
 * Usage:
 *   node scripts/compare-still-exports.mjs <panel.png> <editor.png> [--shot <take dir | shot.json>]
 *   node scripts/compare-still-exports.mjs --dir <folder the two saves landed in> [--shot ...]
 *
 * `--dir` takes the two most recently modified PNGs in that folder (not
 * recursive, `frame.png` ignored): the OLDER is the panel's, the NEWER the
 * editor's — the order the runbook saves them in. Without `--shot` it reads
 * `shot.json` from that folder if one is there, and otherwise from the newest
 * still bundle under its `raw/` — which, pointed at a save folder, is the shot
 * the two saves came from.
 *
 * Exit codes follow `ticket-check.mjs`: 0 the two agree, 1 they do not (the
 * finding), 3 the check could not run — a missing file, a PNG this reader does
 * not handle. Never 1 for "could not run": a broken check that reads as a
 * finding is as useless as a pass that means nothing.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { inflateSync } from "node:zlib";

/** Largest per-channel difference still called "the same pixel": encoder rounding, nothing more. */
export const CHANNEL_TOLERANCE = 1;

/**
 * The rule that decides, and why it is not just CHANNEL_TOLERANCE.
 *
 * The first real run at `1x` (2026-09-29) had the panel and the editor agree
 * on every swatch centre exactly, and still differ in 8,647 of 727,800
 * pixels, by up to 82. Every difference above 4 sat on an EDGE (a swatch
 * border, text); no pixel in a flat area differed by more than 4. That is two
 * canvases in two windows resampling a 2x downscale slightly differently —
 * Chromium does not promise bit-identical scaling across contexts — and the
 * same pair at native scale (no resampling) agreed to 0 pixels.
 *
 * The colour-space bug is the opposite shape: it moves FLAT colour — a whole
 * swatch interior shifts by tens of levels. So:
 *
 * - a FLAT pixel (its panel-side 3x3 neighbourhood never steps by more than
 *   EDGE_STEP) must agree within FLAT_TOLERANCE, always;
 * - an EDGE pixel may differ by more, but edge differences above
 *   FLAT_TOLERANCE must stay under EDGE_BUDGET of all pixels — resampling
 *   noise is a thin line along edges (0.17% measured), not a different
 *   picture that happens to be busy.
 */
export const FLAT_TOLERANCE = 4;
export const EDGE_STEP = 24;
export const EDGE_BUDGET = 0.01;

class CannotRun extends Error {}

/** IHDR, the ICC profile's name, and the unfiltered pixels. 8-bit RGB/RGBA, non-interlaced only. */
export function readPng(buf, label = "file") {
  if (buf.subarray(0, 8).toString("latin1") !== "\x89PNG\r\n\x1a\n") throw new CannotRun(`${label}: not a PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  // Anything else and the unfilter below would read the wrong shape — refuse
  // rather than report plausible nonsense. `export-still` writes 8-bit RGB or
  // RGBA (StillEncode.swift), so this is not expected to fire.
  if (bitDepth !== 8) throw new CannotRun(`${label}: ${bitDepth}-bit channels; this reader handles 8`);
  if (interlace !== 0) throw new CannotRun(`${label}: interlaced`);
  if (colorType !== 2 && colorType !== 6) throw new CannotRun(`${label}: PNG colour type ${colorType}; this reader handles 2 and 6`);
  const channels = colorType === 6 ? 4 : 3;

  let profile = null;
  let srgbChunk = false;
  const idat = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString("latin1");
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === "IDAT") idat.push(body);
    // iCCP: a Latin-1 profile name, NUL, compression method, the profile.
    if (type === "iCCP") profile = body.subarray(0, body.indexOf(0)).toString("latin1");
    if (type === "sRGB") srgbChunk = true;
    if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels] : 0;
      const x = line[i];
      out[y * stride + i] =
        filter === 0 ? x
        : filter === 1 ? (x + a) & 255
        : filter === 2 ? (x + b) & 255
        : filter === 3 ? (x + ((a + b) >> 1)) & 255
        : (x + paeth(a, b, c)) & 255;
    }
  }
  return { width, height, channels, profile: profile ?? (srgbChunk ? "sRGB (chunk)" : null), data: out };
}

/**
 * The verdict, as data: every problem found, not just the first — "wrong size
 * AND wrong colour" is two bugs, and saying only one sends someone to fix half.
 */
export function compareExports(panel, editor, shotColorSpace) {
  const problems = [];
  const notes = [];
  const wantsP3 = typeof shotColorSpace === "string" && /p3/i.test(shotColorSpace);
  if (shotColorSpace === undefined) {
    notes.push("no shot.json read: the colour check below cannot tell whether P3 was expected");
  } else if (shotColorSpace === null) {
    // What every real capture looked like on 2026-09-29: frame.png tagged
    // Display P3, shot.json with no colour space at all, so both exports are
    // sRGB and agree. "Capture on a P3 display" would be the wrong advice.
    notes.push("shot.json records no colour space (STC-478: the helper drops it when the captured image's "
      + "colour space has no name), so both exports were treated as sRGB — a pass here says nothing about "
      + "the colour-space bug, whatever display it was captured on");
  } else if (!wantsP3) {
    notes.push(`the shot's colour space is "${shotColorSpace}", not P3 — on this display the colour-space bug `
      + "cannot show, so a pass here says nothing about it. Capture on a P3 display.");
  }

  if (panel.width !== editor.width || panel.height !== editor.height) {
    const ratio = (editor.width / panel.width).toFixed(2);
    problems.push(`size: panel ${panel.width}x${panel.height}, editor ${editor.width}x${editor.height} `
      + `(editor is ${ratio}x the panel — the scale bug if the preference is 1x)`);
  }
  if (panel.profile !== editor.profile) {
    problems.push(`profile: panel "${panel.profile ?? "none"}", editor "${editor.profile ?? "none"}"`);
  }
  if (wantsP3) {
    for (const [who, f] of [["panel", panel], ["editor", editor]]) {
      if (!f.profile || !/p3/i.test(f.profile)) problems.push(`${who}: expected a Display P3 profile, found "${f.profile ?? "none"}"`);
    }
  }

  let differing = 0;
  let maxDelta = 0;
  let flatOver = 0;
  let flatMax = 0;
  let edgeOver = 0;
  let compared = false;
  if (panel.width === editor.width && panel.height === editor.height) {
    compared = true;
    const W = panel.width, H = panel.height, n = W * H;
    const at = (f, x, y, c) => f.data[(y * W + x) * f.channels + c];
    const alphaAt = (f, x, y) => (f.channels === 4 ? f.data[(y * W + x) * 4 + 3] : 255);
    const isEdge = (x, y) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        for (let c = 0; c < 3; c++) if (Math.abs(at(panel, X, Y, c) - at(panel, x, y, c)) > EDGE_STEP) return true;
      }
      return false;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      // RGB, and alpha where both have it: an opaque RGB file and an RGBA one
      // whose alpha is all 255 are the same picture.
      let d = Math.abs(alphaAt(panel, x, y) - alphaAt(editor, x, y));
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(at(panel, x, y, c) - at(editor, x, y, c)));
      if (d > CHANNEL_TOLERANCE) differing++;
      if (d > maxDelta) maxDelta = d;
      if (d <= FLAT_TOLERANCE) continue;
      if (isEdge(x, y)) edgeOver++;
      else { flatOver++; if (d > flatMax) flatMax = d; }
    }
    if (flatOver > 0) {
      problems.push(`pixels: ${flatOver} in FLAT areas differ by more than ${FLAT_TOLERANCE} `
        + `(largest ${flatMax}) — solid colour moved, which is what the colour-space bug looks like`);
    }
    if (edgeOver > EDGE_BUDGET * n) {
      problems.push(`pixels: ${edgeOver} of ${n} EDGE pixels differ by more than ${FLAT_TOLERANCE} `
        + `(over the ${EDGE_BUDGET * 100}% resampling allowance) — more than scaling noise`);
    }
  }
  return { ok: problems.length === 0, problems, notes, compared, differing, maxDelta, flatOver, edgeOver };
}

function newestPngs(dir) {
  const pngs = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".png") && f !== "frame.png")
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t);
  if (pngs.length < 2) throw new CannotRun(`${dir}: found ${pngs.length} exported PNG(s), need two (the panel's Save, then the editor's)`);
  const [older, newer] = pngs.slice(-2);
  return [older.f, newer.f];
}

/**
 * A save folder keeps its bundles in `raw/<stamp>/` (takes.ts, STC-413) and
 * its finished files at the top — so the shot behind two fresh saves is the
 * newest bundle there holding a `shot.json` (a recording's holds anchors.json).
 */
function newestStillBundle(dir) {
  const raw = join(dir, "raw");
  if (!existsSync(raw)) return undefined;
  const bundles = readdirSync(raw)
    .map((d) => join(raw, d))
    .filter((d) => existsSync(join(d, "shot.json")))
    .sort((a, b) => statSync(join(a, "shot.json")).mtimeMs - statSync(join(b, "shot.json")).mtimeMs);
  return bundles.at(-1);
}

function readShotColorSpace(path) {
  const file = path.endsWith(".json") ? path : join(path, "shot.json");
  if (!existsSync(file)) throw new CannotRun(`${file}: no shot.json there`);
  const shot = JSON.parse(readFileSync(file, "utf8"));
  // null, not a placeholder string: "no colour space recorded" is its own
  // finding (STC-478), not an unusual colour space.
  return typeof shot?.display?.colorSpace === "string" ? shot.display.colorSpace : null;
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (!v) throw new CannotRun(`${flag} needs a value`);
    args.splice(i, 2);
    return v;
  };
  const dir = take("--dir");
  let shotPath = take("--shot");
  let panelPath, editorPath;
  if (dir) {
    [panelPath, editorPath] = newestPngs(dir);
    if (!shotPath && existsSync(join(dir, "shot.json"))) shotPath = dir;
    if (!shotPath) {
      shotPath = newestStillBundle(dir);
      if (shotPath) console.log(`shot: ${shotPath} (the newest still bundle under raw/; pass --shot to choose another)`);
    }
  } else {
    [panelPath, editorPath] = args;
    if (!panelPath || !editorPath) {
      throw new CannotRun("usage: compare-still-exports.mjs <panel.png> <editor.png> [--shot <dir|shot.json>]\n"
        + "   or: compare-still-exports.mjs --dir <folder> [--shot <dir|shot.json>]");
    }
    if (!shotPath && existsSync(join(dirname(panelPath), "shot.json"))) shotPath = dirname(panelPath);
  }
  const shotColorSpace = shotPath ? readShotColorSpace(shotPath) : undefined;
  for (const p of [panelPath, editorPath]) if (!existsSync(p)) throw new CannotRun(`${p}: no such file`);

  const panel = readPng(readFileSync(panelPath), "panel");
  const editor = readPng(readFileSync(editorPath), "editor");
  const r = compareExports(panel, editor, shotColorSpace);

  console.log(`panel : ${basename(panelPath)}  ${panel.width}x${panel.height}  profile ${panel.profile ?? "none"}`);
  console.log(`editor: ${basename(editorPath)}  ${editor.width}x${editor.height}  profile ${editor.profile ?? "none"}`);
  if (shotColorSpace !== undefined) console.log(`shot colour space: ${shotColorSpace ?? "(none recorded)"}`);
  if (r.compared) {
    console.log(`pixels differing by more than ${CHANNEL_TOLERANCE}: ${r.differing} (largest channel difference ${r.maxDelta})`);
    console.log(`  over ${FLAT_TOLERANCE} in flat areas: ${r.flatOver} (must be 0); on edges: ${r.edgeOver} `
      + `(resampling noise, allowed up to ${Math.floor(EDGE_BUDGET * panel.width * panel.height)})`);
  }
  for (const n of r.notes) console.log(`note: ${n}`);
  if (r.ok) {
    console.log("PASS — the panel and the editor exported the same picture");
    return 0;
  }
  for (const p of r.problems) console.log(`FAIL — ${p}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof CannotRun ? `could not run: ${e.message}` : `could not run: ${e?.stack ?? e}`);
    code = 3;
  }
  process.exit(code);
}
