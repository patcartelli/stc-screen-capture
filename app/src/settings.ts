import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHOT_ACTIONS, DEFAULT_SHORTCUTS, parseAccelerator, type Shortcuts,
} from "./hotkeys.js";
import { clampCountdownMs, DEFAULT_COUNTDOWN_MS } from "./countdown.js";
import {
  DEFAULT_EXPORT_OPTIONS, DEFAULT_FILENAME_TEMPLATE, clampQuality, parseFormat, parseScale,
  type ExportOptions,
} from "@transform/still-export.js";
import {
  DEFAULT_CORNER, parseCorner,
  type Corner,
} from "./thumbnail.js";
import {
  DEFAULT_EMBED_TEMPLATE,
} from "./share.js";
import { profileById } from "@transform/recording-profile.js";

/**
 * User preferences, owned by the main process.
 *
 * The camera preference decides whether a physical camera LED comes on, so it
 * is not the renderer's to hold: the renderer proposes a change, main stores it
 * and is the single source of truth when `start` is issued. That also keeps the
 * flag out of the IPC payload for `recorder:start`, where it would be a second
 * place the answer could come from.
 *
 * Electron-free on purpose — it takes a directory rather than calling
 * `app.getPath("userData")` — so it is testable without launching an app, the
 * same arrangement HelperClient and HelperSupervisor use.
 */

export interface Settings {
  /** Opt-in, default off, sticky (camera PiP design spec). */
  camera: boolean;
  /**
   * Which display to record (STC-247), as the helper's CGDirectDisplayID, or
   * null for "whichever the helper lists first" — the phase-1 behaviour and
   * the only one a single-display machine ever sees. Sticky, like the camera:
   * a picked display stays picked across launches. If that display is gone at
   * `start`, the helper refuses with `display-not-found` rather than quietly
   * recording another one; the UI shows the stale choice as such.
   */
  displayId: number | null;
  /**
   * Which microphone to record (STC-233), as the helper's
   * `AVCaptureDevice.uniqueID`, or null for no mic at all.
   *
   * UNLIKE `displayId`, null is not "automatic" — there is no automatic mic.
   * The settled decision (phase 0) is that this app must never take the
   * default audio input, or any input, without the user having named it
   * explicitly: auto-grabbing a Bluetooth mic once stalled capture and
   * wedged CoreAudio system-wide. So null means the picker shows "Off" and
   * `start` sends no mic request at all, exactly the way it means "no
   * camera" for the boolean above — except there the off state IS the
   * default and here it is the ONLY safe one. Sticky like `displayId`: a
   * picked mic stays picked across launches, and if it is gone at `start`
   * the helper refuses that device (never falls back to another) the same
   * way a stale `displayId` is refused rather than silently swapped.
   */
  micDeviceUid: string | null;
  /**
   * The global capture shortcuts (STC-292), as Electron accelerators. `null`
   * for an action the user deliberately unbound — which is a preference like
   * any other, and must survive a restart rather than springing back to the
   * default the next time the file is read.
   */
  shortcuts: Shortcuts;
  /**
   * Whether a completed still capture makes the system shutter noise
   * (STC-292). On by default, because macOS's own screenshot does.
   *
   * It only ever SILENCES: with this ticked the sound still follows the Mac's
   * "Play user interface sound effects" setting and its alert volume. There is
   * no combination that makes a noise the system was told not to make.
   */
  shutterSound: boolean;
  /**
   * How long the countdown runs, in milliseconds (STC-391) — for Record, and
   * for a still capture started with the self-timer.
   *
   * A preference rather than a constant, and the ticket's own Open item:
   * answered 3s, stored here so the number can move without a code change.
   * There is deliberately NO control for it in this ticket. `0` is "off" and
   * is a legitimate value — Record then starts immediately, which is what it
   * did before this ticket existed. `countdown.ts` owns the clamp, so the
   * bound and the constant it clamps to cannot drift apart.
   */
  countdownMs: number;
  /**
   * How a still leaves the app (STC-293), and the one place those answers
   * live. The ticket's Note: "One encoder, one filename template, one
   * destination setting; no second implementation hiding in the thumbnail."
   * The post-capture thumbnail (STC-296) reads THIS, and so does the preview's
   * frame grab — neither carries its own default.
   */
  still: StillSettings;
  /**
   * The post-capture floating thumbnail (STC-296) — where it sits, how long it
   * waits, and what "ignoring it" does. Its own block rather than folded into
   * `still`, because these answer "what happens to the panel", not "what does
   * an export look like" — `still` is read from inside the panel same as
   * everywhere else, never duplicated by it.
   */
  thumbnail: ThumbnailSettings;
  /**
   * Where an exported take goes when it is shared (STC-242) — the folder in
   * the site repo, the slug it lands under, and the snippet to paste.
   *
   * Its own block rather than folded into an export setting, for the same
   * reason `thumbnail` is separate from `still`: these answer "where does this
   * video go when it leaves", not "what does the encode look like".
   */
  share: ShareSettings;
  /**
   * What a RECORDING captures (STC-370's region/window capability, wired to
   * the window's scope picker by STC-374): the whole display named by
   * `displayId` above, a region of one, or a single window. Its own block
   * rather than a fourth top-level field, because a region and a window each
   * carry more than one value and "source stays a separate control from the
   * profile" (the ticket's own words) still means scope and source are one
   * idea together.
   *
   * Sticky, the same as `displayId`: a chosen window or area stays chosen
   * across launches and across `kind` changes, so flipping the scope picker
   * back and forth does not forget what was picked. `start` refuses rather
   * than silently falling back to the whole display when `kind` asks for a
   * region or window and nothing has been picked yet — the same rule STC-247
   * already set for a stale `displayId`.
   */
  scope: ScopeSettings;
  /**
   * Where recordings and stills are saved, or null for "not chosen yet" —
   * which resolves to the same default takesRoot() always computed
   * (env.STC_RECORDINGS_DIR || ~/Desktop/stc), so an untouched install
   * behaves identically to before this field existed, and an E2E fixture's
   * STC_RECORDINGS_DIR isolation never gets baked into a persisted
   * settings.json. Replaces StillSettings.destination and the "beside the
   * shot" concept (STC-412): there is one save location, not a per-still
   * override.
   */
  saveFolder: string | null;
  /**
   * Whether the diagnostics table (helper pid, frame counts, event counts,
   * …) is shown on the main window (STC-412). Off by default — developer
   * instrumentation, not something a normal user needs in view.
   */
  showDiagnostics: boolean;
  /**
   * The optional recording profile (STC-447), as a `RecordingProfile.id`, or
   * null for "no preference" — the only behaviour that existed before this
   * field did: a fresh take's `project.json` opens at the capture's own
   * size. Sticky, like `displayId`/`scope`: a chosen profile stays chosen
   * across launches and across takes, until cleared from the bar's own
   * picker. Never required to start a recording — `recorder:start` does not
   * read this field at all; it is applied once, after the fact, by
   * `main.ts`'s `recording-ended` handler seeding a fresh take's
   * `project.json` from it, the same door `defaultProject` would otherwise
   * open with the capture's own size.
   */
  recordingProfileId: string | null;
}

export interface ScopeRegion {
  /** display-local points, resolved against THIS display — the same shape
   * `capture-still`'s own crop carries, and the same reason: a region means
   * nothing without knowing which display it is local to. */
  displayId: number;
  x: number; y: number; width: number; height: number;
}

export interface ScopeSettings {
  kind: "display" | "region" | "window";
  /** Set only when `kind` is "region". */
  region: ScopeRegion | null;
  /** Set only when `kind` is "window", as a CGWindowID. */
  windowId: number | null;
  /**
   * Cosmetic only — never sent to the helper. A window can close or another
   * app can retitle it between now and the next `start`; this is what the
   * source control shows until the user re-picks, not a claim that the
   * window still exists.
   */
  windowLabel: string | null;
}

export const DEFAULT_SCOPE_SETTINGS: ScopeSettings = {
  kind: "display", region: null, windowId: null, windowLabel: null,
};

export interface ShareSettings {
  /**
   * The folder in the site repo that holds the video, or null until the user
   * picks one.
   *
   * Null rather than a guessed path: this app cannot know where someone keeps
   * their site checkout, and a wrong default would write a file into a
   * directory nobody asked about. `planPublish` refuses rather than defaulting.
   */
  destination: string | null;
  /** The paste-able embed, as a template. Provisional; see `DEFAULT_EMBED_TEMPLATE`. */
  embedTemplate: string;
}

/**
 * `slug` lived here until STC-444 slice 3 moved it onto each take's own
 * project (`Project.slug`, `transform/src/types.ts`) — one global name could
 * not serve more than one demo at a time. `cleanShare` below still accepts
 * and drops an old stored `slug` rather than refusing the whole settings
 * file over it, the same "a field this build does not have is not this
 * build's problem" rule the rest of this parser follows.
 */
export const DEFAULT_SHARE_SETTINGS: ShareSettings = {
  destination: null, embedTemplate: DEFAULT_EMBED_TEMPLATE,
};

export interface ThumbnailSettings {
  corner: Corner;
  /**
   * "Some days you take twenty shots and want none of this" (the ticket's own
   * words). When set, a capture never shows the panel at all and goes straight
   * to the clipboard — the one settle action that needs no destination folder
   * and leaves nothing for the user to clean up.
   */
  skip: boolean;
}

export const DEFAULT_THUMBNAIL_SETTINGS: ThumbnailSettings = {
  corner: DEFAULT_CORNER, skip: false,
};

export interface StillSettings extends ExportOptions {
}

export const DEFAULT_STILL_SETTINGS: StillSettings = {
  ...DEFAULT_EXPORT_OPTIONS,
};

export const DEFAULT_SETTINGS: Settings = {
  camera: false, displayId: null, micDeviceUid: null, shortcuts: { ...DEFAULT_SHORTCUTS },
  shutterSound: true, countdownMs: DEFAULT_COUNTDOWN_MS,
  still: { ...DEFAULT_STILL_SETTINGS },
  thumbnail: { ...DEFAULT_THUMBNAIL_SETTINGS },
  share: { ...DEFAULT_SHARE_SETTINGS },
  scope: { ...DEFAULT_SCOPE_SETTINGS },
  saveFolder: null, showDiagnostics: false,
  recordingProfileId: null,
};

/**
 * Never throws, and never half-trusts.
 *
 * Each field is validated on its own terms — an unknown format becomes the
 * default rather than reaching ImageIO as a string it will refuse.
 * `flattenColor` is deliberately NOT persisted with a default: it is the
 * answer to a question the user was asked (STC-293's "having said so first"),
 * and a stored default would silently answer it for them next time.
 */
function cleanStill(v: unknown): StillSettings {
  const d = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const template = typeof d.template === "string" && d.template.trim()
    ? d.template : DEFAULT_FILENAME_TEMPLATE;
  return {
    format: parseFormat(d.format),
    quality: clampQuality(d.quality),
    scale: parseScale(d.scale),
    stripMetadata: d.stripMetadata === true,
    template,
  };
}

/**
 * Same rule as every other block here: an unknown shape falls back whole, and
 * each field is validated on its own terms rather than half-trusted.
 */
function cleanThumbnail(v: unknown): ThumbnailSettings {
  const d = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return {
    corner: parseCorner(d.corner),
    skip: d.skip === true,
  };
}

/**
 * `slug` is read from `d` for nothing — see `DEFAULT_SHARE_SETTINGS`'s own
 * comment. A document written before STC-444 slice 3 still has one sitting
 * in `share.slug`; this simply does not carry it into `ShareSettings`, the
 * same "a field this build does not have is not this build's problem" rule
 * every other stray key in a settings file already follows.
 */
function cleanShare(v: unknown): ShareSettings {
  const d = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const destination = typeof d.destination === "string" && d.destination.startsWith("/")
    ? d.destination : null;
  const embedTemplate = typeof d.embedTemplate === "string" && d.embedTemplate.trim()
    ? d.embedTemplate : DEFAULT_EMBED_TEMPLATE;
  return { destination, embedTemplate };
}

/** A display id is a positive integer; anything else is "automatic". */
function cleanDisplayId(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * An absolute path is trusted; anything else (relative, missing, garbage)
 * is null — "not chosen" — never resolved against the process's cwd.
 */
export function cleanSaveFolder(v: unknown): string | null {
  return typeof v === "string" && v.startsWith("/") ? v : null;
}

/**
 * A mic uid is a non-empty string; anything else is "no mic" — never a
 * fallback to some other device. See `Settings.micDeviceUid`'s own doc
 * comment for why null here is not the same shape as a null `displayId`.
 */
function cleanMicDeviceUid(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A CGWindowID is a non-negative integer. */
function cleanWindowId(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * A stored id is trusted only as far as `profileById` still recognises it —
 * same rule as `cleanShortcuts`: a file written by an older or newer build
 * (a profile since renamed or removed) falls back to "no profile" rather
 * than being carried as a string nothing can resolve.
 */
function cleanRecordingProfileId(v: unknown): string | null {
  return typeof v === "string" ? profileById(v)?.id ?? null : null;
}

/**
 * A region needs a display to be local to AND four finite, positive-sized
 * numbers — same shape and same rule `parseRect` enforces on the helper side.
 * Any other shape is "nothing picked" rather than a half-trusted rectangle.
 */
function cleanScopeRegion(v: unknown): ScopeRegion | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  const displayId = cleanDisplayId(d.displayId);
  const { x, y, width, height } = d;
  if (displayId == null) return null;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return { displayId, x: x as number, y: y as number, width: width as number, height: height as number };
}

/**
 * Same rule as every other block here: an unknown shape falls back whole.
 *
 * `kind` is kept even when its target is not — "window scope, nothing picked
 * yet" is a real, showable state (the source control renders "Choose
 * window…"), not an error to paper over here. `recorder:start` is where a
 * scope with no target is refused, not this function.
 */
function cleanScope(v: unknown): ScopeSettings {
  const d = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const kind = d.kind === "region" || d.kind === "window" ? d.kind : "display";
  return {
    kind,
    region: cleanScopeRegion(d.region),
    windowId: cleanWindowId(d.windowId),
    windowLabel: typeof d.windowLabel === "string" ? d.windowLabel : null,
  };
}

/**
 * A stored binding is trusted only as far as it still parses.
 *
 * Absent means "never set" and takes the default; explicit `null` means
 * unbound and is kept. Anything else that no longer parses — a hand-edited
 * file, or a binding written by a version with a different grammar — falls
 * back to the default rather than to nothing, on the same rule as every other
 * field here: a corrupt preferences file must not silently cost the user the
 * feature.
 */
function cleanShortcuts(v: unknown): Shortcuts {
  const raw = (v && typeof v === "object" && !Array.isArray(v))
    ? v as Record<string, unknown> : {};
  const out = {} as Shortcuts;
  for (const action of SHOT_ACTIONS) {
    const stored = raw[action];
    if (stored === null) { out[action] = null; continue; }
    const parsed = typeof stored === "string" ? parseAccelerator(stored) : undefined;
    // Stored NORMALISED, so what preferences shows and what the menu bar draws
    // is the same string the registration used.
    out[action] = parsed?.ok ? parsed.accelerator : DEFAULT_SHORTCUTS[action];
  }
  return out;
}

const FILE = "settings.json";

/**
 * Never throws.
 *
 * A corrupt or unreadable preferences file must not cost a recording — the same
 * rule `parseProject` follows for a mangled project.json. An unknown shape is
 * treated as absent rather than half-trusted, so one bad field cannot smuggle
 * itself in as a preference.
 */
export function readSettings(dir: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const doc = raw as Record<string, unknown>;
  return {
    camera: typeof doc.camera === "boolean" ? doc.camera : DEFAULT_SETTINGS.camera,
    displayId: cleanDisplayId(doc.displayId),
    micDeviceUid: cleanMicDeviceUid(doc.micDeviceUid),
    shortcuts: cleanShortcuts(doc.shortcuts),
    shutterSound: typeof doc.shutterSound === "boolean"
      ? doc.shutterSound : DEFAULT_SETTINGS.shutterSound,
    countdownMs: clampCountdownMs(doc.countdownMs),
    still: cleanStill(doc.still),
    thumbnail: cleanThumbnail(doc.thumbnail),
    share: cleanShare(doc.share),
    scope: cleanScope(doc.scope),
    saveFolder: cleanSaveFolder(doc.saveFolder),
    showDiagnostics: typeof doc.showDiagnostics === "boolean"
      ? doc.showDiagnostics : DEFAULT_SETTINGS.showDiagnostics,
    recordingProfileId: cleanRecordingProfileId(doc.recordingProfileId),
  };
}

/**
 * Merges `patch` over what is stored and writes the result. Also never throws:
 * a preference is not worth crashing the app over, and the in-memory value the
 * caller just set still applies for this session.
 *
 * Only known keys are written, so a typo cannot quietly persist a field nothing
 * reads and turn the file into a place wrong things accumulate.
 */
export function writeSettings(dir: string, patch: Partial<Settings>): Settings {
  const current = readSettings(dir);
  // `still` is merged one level deeper than the rest: a caller changing only
  // the format must not drop the destination folder the user chose months ago.
  // A shallow spread would, and the shape of that bug is a preference that
  // resets whenever an unrelated one is touched.
  const merged: Settings = {
    ...current, ...patch,
    still: { ...current.still, ...(patch.still ?? {}) },
    thumbnail: { ...current.thumbnail, ...(patch.thumbnail ?? {}) },
    share: { ...current.share, ...(patch.share ?? {}) },
    scope: { ...current.scope, ...(patch.scope ?? {}) },
  };
  const clean: Settings = {
    camera: merged.camera === true,
    displayId: cleanDisplayId(merged.displayId),
    micDeviceUid: cleanMicDeviceUid(merged.micDeviceUid),
    shortcuts: cleanShortcuts(merged.shortcuts),
    still: cleanStill(merged.still),
    thumbnail: cleanThumbnail(merged.thumbnail),
    share: cleanShare(merged.share),
    scope: cleanScope(merged.scope),
    // Not `=== true`: the default is ON, so an absent or malformed value must
    // fall back to on rather than to silence. The camera's `=== true` is the
    // opposite case for the opposite reason — it defaults off because it turns
    // on a physical LED.
    shutterSound: merged.shutterSound !== false,
    countdownMs: clampCountdownMs(merged.countdownMs),
    saveFolder: cleanSaveFolder(merged.saveFolder),
    showDiagnostics: typeof merged.showDiagnostics === "boolean"
      ? merged.showDiagnostics : DEFAULT_SETTINGS.showDiagnostics,
    recordingProfileId: cleanRecordingProfileId(merged.recordingProfileId),
  };
  try {
    writeFileSync(join(dir, FILE), JSON.stringify(clean, null, 2));
  } catch {
    /* preferences are not worth a crash */
  }
  return clean;
}
