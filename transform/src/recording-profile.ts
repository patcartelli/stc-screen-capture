import type { Size } from "./spaces.js";
import { outputSizeFor } from "./output-size.js";

/**
 * Named recording profiles (STC-447) — an OPTIONAL preference, picked before
 * Record, that decides what output size this take's `project.json` opens
 * with once the recording ends, rather than the capture's own size (today's
 * only behaviour, and still what "no profile" means).
 *
 * A profile is a target WIDTH, the exact shape `output-size.ts`'s embed
 * presets already are (`outputSizeFor`, same aspect-preserving, even-
 * dimensions, never-silently-upscaled math) — not a second size calculation,
 * and not a capture-side crop. Nothing about WHAT gets captured changes: the
 * scope picker (STC-370) still decides that. This only pre-selects the
 * export size a fresh take is offered at, the same value the editor's own
 * export-size `<select>` (`editor.ts`'s `#outsize`) would otherwise default
 * to (the capture size) and that a person would set by hand afterward.
 *
 * The two seeded here are the ticket's own example. Both are widths, so both
 * are one call to `outputSizeFor` away from a real `Size` — see
 * `outputSizeForProfile` below, the one place that conversion happens.
 */
export interface RecordingProfile {
  /** Stable across renders; the UI's value and `Settings.recordingProfileId`'s. */
  id: string;
  label: string;
  /** Fed to `outputSizeFor` exactly as `EMBED_CSS_WIDTH` already is. */
  targetWidthPx: number;
}

/**
 * Instagram's own documented delivery width for feed video (1080 px) — a
 * device pixel width, not a CSS one like `EMBED_CSS_WIDTH`, because this
 * output is watched at its own size on a phone, never scaled by a page.
 */
export const INSTAGRAM_WIDTH_PX = 1080;

/**
 * The settled capture ceiling (CLAUDE.md → "Capture resolution: ≤3840×2160")
 * — a case-study take wants full resolution, so this profile is "no
 * rescale, whatever the capture size" for anything at or under that ceiling,
 * and clamps (rather than upscales) anything captured smaller.
 */
export const CASE_STUDY_WIDTH_PX = 3840;

export const RECORDING_PROFILES: readonly RecordingProfile[] = [
  { id: "instagram", label: "Instagram", targetWidthPx: INSTAGRAM_WIDTH_PX },
  { id: "case-study", label: "4K case study", targetWidthPx: CASE_STUDY_WIDTH_PX },
];

/** `null`/an unknown id both mean "no profile" — the same "fall back to the default" rule every other stored id in this app follows. */
export function profileById(id: string | null | undefined): RecordingProfile | null {
  if (id == null) return null;
  return RECORDING_PROFILES.find((p) => p.id === id) ?? null;
}

/**
 * The output size a profile resolves to for a given capture. Reuses
 * `outputSizeFor` so a profile can never compute a size disagreeing with the
 * export dialog's own presets — one aspect-ratio/evening rule, not two.
 *
 * The target is capped to the capture's own width first, UNLIKE
 * `outputOptions`'s embed presets: those are offered with `upscales: true`
 * so a person can see why they're disabled, but this size is applied with
 * nobody watching — there is no UI moment to show a disabled option in, so
 * silently upscaling is not an option either. Capping instead of refusing
 * outright keeps `case-study` meaning "full resolution, whatever the
 * capture size" exactly as its own doc comment already claims, rather than
 * leaving a smaller capture with no seeded size at all.
 */
export function outputSizeForProfile(profile: RecordingProfile, capture: Size): Size {
  return outputSizeFor(capture, Math.min(profile.targetWidthPx, capture.width));
}

/**
 * The name of the small hint file `main.ts` drops beside a fresh take when a
 * profile is selected, and `editor.ts` reads once, on first open.
 *
 * NOT a `project.json`: main.ts (the Electron main process, under
 * `tsconfig.node.json`'s no-DOM pass) cannot build a real `Project` without
 * importing `trim.ts`'s `defaultProject`/`projectForWrite` — which chains
 * through `transform-version.ts` into `cursor-art.ts`'s Canvas types and
 * fails that pass outright (see `docs/CORRECTNESS-TRAPS.md`, the identical
 * trap `project-version.ts` was split out to avoid for the same reason). So
 * main only ever writes two plain numbers here; `editor.ts` — already safely
 * importing `trim.ts` under `tsconfig.browser.json`, which HAS DOM — is the
 * one place that turns them into an actual `defaultProject` call, exactly
 * where it already builds one from the capture's own size. Both sides import
 * this constant from here rather than each hand-writing the filename, so it
 * cannot drift between the writer and the reader.
 */
export const PROFILE_HINT_FILE = "profile-hint.json";
