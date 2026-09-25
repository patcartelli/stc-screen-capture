import type { NarrationCleanup, Pip, Project, Trim, Zoom, ZoomOverride } from "./types.js";
import { DEFAULT_ZOOM_PRESET, ZOOM_PRESET_NAMES } from "./zoom.js";
import { DEFAULT_TEXT_PT } from "./legibility.js";
import { isProjectVersion } from "./project-version.js";
import { TRANSFORM_VERSION } from "./transform-version.js";

const NS_PER_S = 1_000_000_000;

/**
 * GPU raster, no hash: 11.0 ms/frame at 4K (PHASE-2 increment 0). The UI
 * export also hashes, so this is an underestimate — better than inventing a
 * second number the gates do not measure.
 */
export const EXPORT_MS_PER_FRAME = 11;

/** One 60 fps output frame, matching export's `tickTimeNs(2)` step. */
export function minTrimNs(fps: number): number {
  return Math.ceil(NS_PER_S / fps);
}

export function availableFrames(durationNs: number, fps: number): number {
  return Math.max(1, Math.floor((durationNs * fps) / NS_PER_S) + 1);
}

export function clampTrim(startNs: number, endNs: number, durationNs: number, fps: 60 = 60): Trim {
  const min = minTrimNs(fps);
  const dur = Math.max(0, durationNs);
  if (dur <= min) return { startNs: 0, endNs: dur };
  const start = Math.max(0, Math.min(Math.round(startNs), dur - min));
  const end = Math.max(start + min, Math.min(Math.round(endNs), dur));
  return { startNs: start, endNs: end };
}

export function isFullTake(project: Project, durationNs: number): boolean {
  if (!project.trim) return true;
  return project.trim.startNs === 0 && project.trim.endNs === durationNs;
}

/**
 * Convert a project trim into the (fromFrame, maxFrames) window export already
 * understands. Inclusive of the 60 fps frame at endNs.
 */
export function exportWindow(
  project: Project,
  durationNs: number,
): { fromFrame: number; maxFrames: number; startNs: number; endNs: number } {
  const fps = project.output.fps;
  const available = availableFrames(durationNs, fps);
  const trim = project.trim
    ? clampTrim(project.trim.startNs, project.trim.endNs, durationNs, fps)
    : { startNs: 0, endNs: durationNs };
  const fromFrame = Math.max(0, Math.min(Math.floor((trim.startNs * fps) / NS_PER_S), available - 1));
  const endFrame = Math.max(fromFrame, Math.min(Math.floor((trim.endNs * fps) / NS_PER_S), available - 1));
  return { fromFrame, maxFrames: endFrame - fromFrame + 1, startNs: trim.startNs, endNs: trim.endNs };
}

export function estimateExportMs(maxFrames: number): number {
  return maxFrames * EXPORT_MS_PER_FRAME;
}

/**
 * The PiP a camera take gets when its own project does not say otherwise.
 *
 * Matches `fixtures/pip/project.json`'s geometry so the fixture and the app
 * agree about what "default" means.
 */
export const DEFAULT_PIP: Pip = {
  enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32,
};

/**
 * Full level (STC-418). system.m4a is recorded at full level and this is the
 * gain preview and export apply to it; 1 is "nobody has said otherwise", so a
 * take at 1 never needs project-9 to say so.
 */
export const DEFAULT_SYSTEM_AUDIO_LEVEL = 1;

/**
 * Narration cleanup's default (STC-455): OFF, at the strength Patrick chose
 * by ear on 2026-09-25 (~50 of the round-2 chain). Off is what every take
 * did before project-10 existed, so a take at this default needs no v10.
 */
/** The mic as recorded (STC-454 part 2): a take at 1 never needs project-11. */
export const DEFAULT_MIC_LEVEL = 1;
/** +12 dB — `audio-mix.ts`'s `MIC_LEVEL_MAX`, restated because this file must not import the mixer. */
const MIC_LEVEL_LIMIT = 10 ** (12 / 20);

export const DEFAULT_NARRATION_CLEANUP: Readonly<NarrationCleanup> = Object.freeze({ enabled: false, strength: 0.5 });

export function defaultProject(
  width: number, height: number, trim?: Trim, hasCamera = false,
): Project {
  const project: Project = {
    // v3: `transform` lives in project-3 alongside `pip` and `trim`. Emitting
    // an older version would produce a document carrying a field its own
    // schema does not declare.
    version: 3,
    output: { fps: 60, width, height },
    cursor: { style: "default", scale: 1 },
    transform: { version: TRANSFORM_VERSION },
    // In the DEFAULT and not only in `parseProject`, so every path out of this
    // file returns the same shape — `parseProject(null)` takes an early return
    // that a field added in the parse body would never reach.
    zoom: { ...DEFAULT_ZOOM },
    textPt: DEFAULT_TEXT_PT,
    // Always an array, never undefined — the same "no consumer has to tell
    // 'none' from 'older document'" reasoning `zoom` already follows
    // (STC-295 first stated it for `decoration.annotations`).
    overrides: [],
    // Same reasoning again (project-8, STC-444 slice 4).
    bookmarks: [],
    systemAudioLevel: DEFAULT_SYSTEM_AUDIO_LEVEL,
    narrationCleanup: { ...DEFAULT_NARRATION_CLEANUP },
    micLevel: DEFAULT_MIC_LEVEL,
    micMuted: false,
    systemAudioMuted: false,
  };
  // A recorded camera track is part of the take, so a take that has one shows
  // its PiP without needing an edit document to say so.
  //
  // Without this, every take the app records with the camera on previews with
  // an INVISIBLE PiP: nothing writes a project.json at record time, so
  // parseProject falls back to a default, the default had no pip, render()
  // returned pip: null, and composite() drew nothing — next to a perfectly good
  // camera.mp4. The first real hardware take needed a project written by hand
  // before anything appeared.
  if (hasCamera) project.pip = { ...DEFAULT_PIP };
  if (trim) project.trim = trim;
  return project;
}

/**
 * A corrupt sidecar must not cost the recording. Unknown versions, missing
 * fields and non-integer times fall back to a default project for this take.
 */
export function parseProject(
  raw: unknown, width: number, height: number, durationNs: number, hasCamera = false,
): Project {
  const fallback = defaultProject(width, height, undefined, hasCamera);
  if (!raw || typeof raw !== "object") return fallback;
  const doc = raw as Record<string, any>;
  // v1, v2 and v3 all load: v1 documents predate trim and pip and simply have
  // neither; v2 predates the transform stamp. Refusing an older version here
  // would discard every project written before the change and silently
  // replace it with a default.
  if (!isProjectVersion(doc.version)) return fallback;

  const outW = Number.isInteger(doc.output?.width) ? doc.output.width : width;
  const outH = Number.isInteger(doc.output?.height) ? doc.output.height : height;
  const scale = typeof doc.cursor?.scale === "number" && doc.cursor.scale > 0 ? doc.cursor.scale : 1;
  // Anything but the one other style the schema names is the default pointer:
  // an older document, or a hand edit that misspelt it, must still render.
  const style = doc.cursor?.style === "circle" ? "circle" : "default";
  const project = defaultProject(outW, outH, undefined, hasCamera);
  project.cursor = { style, scale };
  // The document's own stamp is carried, so a caller can tell an edit authored
  // against an older transform from one authored against this one. A document
  // with no stamp is rendered by the current transform either way, and that is
  // what it is recorded as.
  const tv = doc.transform?.version;
  project.transform = { version: Number.isInteger(tv) && tv >= 1 ? tv : TRANSFORM_VERSION };

  // Same reasoning as projectForWrite: anything this parser does not copy is
  // lost on the next write. `pip` is validated by the schema, so it is carried
  // as-is rather than re-derived here.
  if (doc.pip && typeof doc.pip === "object") project.pip = doc.pip;

  const t = doc.trim;
  if (t && Number.isInteger(t.startNs) && Number.isInteger(t.endNs) && t.startNs >= 0 && t.endNs >= 0) {
    project.trim = clampTrim(t.startNs, t.endNs, durationNs, 60);
  }
  project.zoom = cleanZoom(doc.zoom);
  // A stored size out of range is a document with no opinion, not a crash —
  // the rule every field in this parser follows.
  project.textPt = typeof doc.textPt === "number" && doc.textPt > 0 && doc.textPt <= 144
    ? doc.textPt : DEFAULT_TEXT_PT;
  project.overrides = cleanOverrides(doc.overrides);
  // project-7 (STC-444 slice 3): carried as-is when it is a non-empty string.
  // NOT validated against share.ts's SLUG_PATTERN here — that module is in
  // `app/src`, and this one has no business depending on it (the dependency
  // runs the other way, transform -> nothing app-specific). A slug that
  // fails validation is still carried through rather than dropped, the same
  // "corrupt sidecar loses the recording, never invents a fix" rule every
  // other field here follows; planPublish is where an unusable one is
  // actually refused, at the moment it would matter.
  if (typeof doc.slug === "string" && doc.slug.length > 0) project.slug = doc.slug;
  // project-8 (STC-444 slice 4): each entry on its own terms, the same rule
  // every other array field in this parser follows — one bad value must not
  // cost every other bookmark. Clamped to the take (a document from a
  // re-take, or hand-edited past the end, is not a crash) and de-duplicated
  // + sorted so `scrubber.ts`'s ArrowUp/ArrowDown never has to.
  project.bookmarks = cleanBookmarks(doc.bookmarks, durationNs);
  // project-9 (STC-418). Out of range is "no opinion", not a clamp: a stored
  // 1.4 is a document this build did not write, and guessing it meant 1 is
  // the same guess the default already makes.
  project.systemAudioLevel = typeof doc.systemAudioLevel === "number"
    && doc.systemAudioLevel >= 0 && doc.systemAudioLevel <= 1
    ? doc.systemAudioLevel : DEFAULT_SYSTEM_AUDIO_LEVEL;
  // project-10 (STC-455). Each field on its own terms, like every other
  // block here: a bad strength must not also turn a deliberate "on" off.
  project.narrationCleanup = cleanNarrationCleanup(doc.narrationCleanup);
  // project-11 (STC-454 part 2). Out of range is "no opinion", the same rule
  // systemAudioLevel follows: a stored 9 is a document this build did not write.
  project.micLevel = typeof doc.micLevel === "number"
    && doc.micLevel >= 0 && doc.micLevel <= MIC_LEVEL_LIMIT
    ? doc.micLevel : DEFAULT_MIC_LEVEL;
  // project-12 (STC-454 part 3). Only a real `true` mutes: anything else is
  // "no opinion", and silencing a track on a guess would lose sound the user
  // never asked to lose.
  project.micMuted = doc.micMuted === true;
  project.systemAudioMuted = doc.systemAudioMuted === true;
  return project;
}

function cleanNarrationCleanup(v: unknown): NarrationCleanup {
  const out = { ...DEFAULT_NARRATION_CLEANUP };
  if (!v || typeof v !== "object") return out;
  const { enabled, strength } = v as Record<string, unknown>;
  if (typeof enabled === "boolean") out.enabled = enabled;
  if (typeof strength === "number" && strength >= 0 && strength <= 1) out.strength = strength;
  return out;
}

function isDefaultNarrationCleanup(n: NarrationCleanup | undefined): boolean {
  return !n || (n.enabled === DEFAULT_NARRATION_CLEANUP.enabled && n.strength === DEFAULT_NARRATION_CLEANUP.strength);
}

function cleanBookmarks(v: unknown, durationNs: number): number[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<number>();
  for (const raw of v) {
    if (Number.isInteger(raw) && raw >= 0 && raw <= durationNs) out.add(raw as number);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * What a take does when nobody has said otherwise: zoom ON, full intensity,
 * standard easing.
 *
 * ON is safe TODAY and only today — stage 2 is stubbed, so the crop is the
 * whole frame and `composite` keeps the same five-argument `drawImage`, which
 * is why #108 could ship the derivation without moving a pixel. **STC-326 must
 * revisit this**: the moment the crop has a target, this default decides
 * whether every existing take suddenly zooms, and that is a product decision
 * rather than a parser's.
 */
export const DEFAULT_ZOOM: Zoom = {
  enabled: true, intensity: 1, preset: DEFAULT_ZOOM_PRESET,
};

/**
 * Each field on its own terms, the rule every parser in this repo follows.
 *
 * A preset that is no longer one of `ZOOM_PRESET_NAMES` falls back rather than
 * being repaired: a document naming an easing this build does not have is a
 * document from a different build, and guessing which of the three it meant
 * would render something nobody chose.
 */
function cleanZoom(v: unknown): Zoom {
  const d = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const intensity = typeof d.intensity === "number" && d.intensity >= 0 && d.intensity <= 1
    ? d.intensity : DEFAULT_ZOOM.intensity;
  const preset = ZOOM_PRESET_NAMES.includes(d.preset as never)
    ? d.preset as Zoom["preset"] : DEFAULT_ZOOM.preset;
  return {
    // `typeof === "boolean"`, and NOT `=== true`: the latter turns a nonsense
    // `enabled: "yes"` into FALSE, which is a third answer — neither what the
    // document said nor the default every other field here falls back to, and
    // the only one of the three that silently disables a feature.
    enabled: typeof d.enabled === "boolean" ? d.enabled : DEFAULT_ZOOM.enabled,
    intensity, preset,
  };
}

/**
 * The MINIMUM version that can express the document — the shot-1/shot-2 rule
 * (STC-295).
 *
 * A project whose zoom is exactly the default says nothing project-4 can say,
 * so it stays v3 and a build without project-4 still reads it. Change any zoom
 * field and it becomes v4; change it back and it returns.
 */
function isDefaultZoom(z: Zoom): boolean {
  return z.enabled === DEFAULT_ZOOM.enabled && z.intensity === DEFAULT_ZOOM.intensity
    && z.preset === DEFAULT_ZOOM.preset;
}

/**
 * A rect's own fields, on their own terms. `undefined` is a real answer —
 * the caller drops the whole entry, the same "one bad entry must not cost
 * every other tuned window" rule `cleanOverrides` follows for its other
 * fields.
 */
function cleanOverrideRect(r: unknown): Extract<ZoomOverride, { kind: "geometry" }>["rect"] | undefined {
  if (!r || typeof r !== "object") return undefined;
  const rd = r as Record<string, unknown>;
  if (![rd.x, rd.y, rd.width, rd.height].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  return { x: rd.x as number, y: rd.y as number, width: rd.width as number, height: rd.height as number };
}

/**
 * Each override's own fields, on their own terms — the same rule `cleanZoom`
 * follows. An entry missing a required field, or naming a `kind` this build
 * does not know (a later phase's variant, read by an OLDER build than wrote
 * it), is dropped rather than crashing the whole array: one bad entry must
 * not cost every other tuned window.
 *
 * The four variants (STC-330's `geometry`, STC-331's `manual`, STC-329's
 * `removed`/`retime`) are cleaned on their own terms rather than sharing one
 * code path: `easing`, on `geometry`, is OPTIONAL and validated against
 * `ZOOM_PRESET_NAMES` (dropped alone, not the entry, if it does not match —
 * the same "a name this build does not have is a build nobody chose"
 * reasoning `zoom.preset` already follows); on `manual` it is REQUIRED —
 * there is no derived window or project default for it to fall back to, so
 * a `manual` entry naming a bogus or missing easing is dropped whole rather
 * than silently defaulted, unlike every other field in this parser.
 * `startNs`/`endNs` are validated like `trim`'s own (non-negative integers)
 * but NOT ordered against each other here — `endNs <= startNs` produces a
 * window `inWindow` never reports true for, which is a harmless no-op
 * rather than a crash, so enforcing the order is not worth a third way for
 * this parser to drop an otherwise well-formed entry. `removed` and
 * `retime` carry no `rect` at all — unlike the other two, requiring one
 * would refuse a well-formed entry rather than a malformed one — and
 * `retime` drops an entry naming NEITHER bound, since an override that
 * shifts nothing is not malformed so much as pointless, and a parser that
 * kept it would be carrying a no-op forward on every future write.
 */
function cleanOverrides(v: unknown): ZoomOverride[] {
  if (!Array.isArray(v)) return [];
  const out: ZoomOverride[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const d = raw as Record<string, unknown>;
    if (d.kind === "geometry") {
      const rect = cleanOverrideRect(d.rect);
      if (!rect) continue;
      if (typeof d.windowId !== "string" || !d.windowId) continue;
      const entry: ZoomOverride = { kind: "geometry", windowId: d.windowId, rect };
      if (ZOOM_PRESET_NAMES.includes(d.easing as never)) entry.easing = d.easing as Zoom["preset"];
      out.push(entry);
    } else if (d.kind === "manual") {
      const rect = cleanOverrideRect(d.rect);
      if (!rect) continue;
      if (typeof d.id !== "string" || !d.id) continue;
      if (!Number.isInteger(d.startNs) || (d.startNs as number) < 0) continue;
      if (!Number.isInteger(d.endNs) || (d.endNs as number) < 0) continue;
      if (!ZOOM_PRESET_NAMES.includes(d.easing as never)) continue;
      out.push({
        kind: "manual", id: d.id, startNs: d.startNs as number, endNs: d.endNs as number,
        rect, easing: d.easing as Zoom["preset"],
      });
    } else if (d.kind === "removed") {
      if (typeof d.windowId !== "string" || !d.windowId) continue;
      out.push({ kind: "removed", windowId: d.windowId });
    } else if (d.kind === "retime") {
      if (typeof d.windowId !== "string" || !d.windowId) continue;
      const hasStart = Number.isInteger(d.startNs) && (d.startNs as number) >= 0;
      const hasEnd = Number.isInteger(d.endNs) && (d.endNs as number) >= 0;
      if (!hasStart && !hasEnd) continue;
      const entry: ZoomOverride = { kind: "retime", windowId: d.windowId };
      if (hasStart) entry.startNs = d.startNs as number;
      if (hasEnd) entry.endNs = d.endNs as number;
      out.push(entry);
    }
    // any other kind: a later phase's variant, read by an older build — skipped.
  }
  return out;
}

function versionFor(project: Project): 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 {
  // Highest first: a document needing v12 needs it whatever its mic level,
  // cleanup, levels, bookmarks, slug, overrides, zoom or textPt say.
  if (project.micMuted || project.systemAudioMuted) return 12;
  if (project.micLevel !== undefined && project.micLevel !== DEFAULT_MIC_LEVEL) return 11;
  if (!isDefaultNarrationCleanup(project.narrationCleanup)) return 10;
  if (project.systemAudioLevel !== undefined && project.systemAudioLevel !== DEFAULT_SYSTEM_AUDIO_LEVEL) return 9;
  if (project.bookmarks && project.bookmarks.length > 0) return 8;
  if (project.slug !== undefined) return 7;
  if (project.overrides && project.overrides.length > 0) return 6;
  if (project.textPt !== undefined && project.textPt !== DEFAULT_TEXT_PT) return 5;
  const z = project.zoom;
  if (!z) return 3;
  return isDefaultZoom(z) ? 3 : 4;
}

export function projectForWrite(project: Project, durationNs: number): Project {
  const version = versionFor(project);
  const out: Project = {
    version,
    output: project.output,
    cursor: project.cursor,
    // Re-stamped, not carried: what is written is what the CURRENT transform
    // will render, and the manifest of any export made from it says the same.
    transform: { version: TRANSFORM_VERSION },
  };
  // Carried, not rebuilt from scratch. This function predates `pip`, and a
  // document reconstructed from a fixed field list silently drops anything
  // added since — so a take with a PiP would lose it on the next save.
  if (project.pip) out.pip = project.pip;
  if (!isFullTake(project, durationNs) && project.trim) out.trim = project.trim;
  // Only when it says something v3 cannot: writing the default block into
  // every document would push every take to v4 for a setting nobody touched.
  // v5 through v8 are each supersets of what came before: a document that
  // needs v8 for its bookmarks must still carry whatever slug, non-default
  // overrides, zoom or textPt it has, or that setting is silently dropped by
  // the very write that promoted the version — `>=`, not `===`, is the fix
  // STC-444 slice 4 made to the slug line below for exactly this reason
  // (found by this same lesson when v7 was minted for `overrides`).
  if (version >= 4 && project.zoom && !isDefaultZoom(project.zoom)) out.zoom = project.zoom;
  if (version >= 5) out.textPt = project.textPt;
  if (version >= 6) out.overrides = project.overrides;
  if (version >= 7) out.slug = project.slug;
  if (version >= 8) out.bookmarks = project.bookmarks;
  if (version >= 9) out.systemAudioLevel = project.systemAudioLevel;
  if (version >= 10) out.narrationCleanup = { ...project.narrationCleanup! };
  if (version >= 11) out.micLevel = project.micLevel;
  if (version >= 12) {
    out.micMuted = !!project.micMuted;
    out.systemAudioMuted = !!project.systemAudioMuted;
  }
  return out;
}
