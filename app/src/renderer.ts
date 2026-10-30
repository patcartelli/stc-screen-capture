/**
 * The Library window (STC-584): the library, the Settings gear, the helper's
 * diagnostics strip, and anything that went wrong stated plainly.
 */
interface DisplayInfo {
  id: number; main: boolean; name?: string;
  pointW: number; pointH: number; pixelW: number; pixelH: number;
  originX?: number; originY?: number;
}
/** STC-414. Mirrors Watchers.enumerateDevices's own "cameras" shape — name, uid and (STC-479) virtual; no bluetooth. */
interface CameraInfo {
  name: string; uid: string; virtual?: boolean;
}
interface StillSettingsView {
  format: string; quality: number; scale: string;
  stripMetadata: boolean; template: string;
}
interface ThumbnailSettingsView {
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  skip: boolean;
}
interface AppSettings {
  camera: boolean;
  displayId: number | null;
  /** STC-233. null means no mic — never "automatic". */
  micDeviceUid: string | null;
  /** STC-414. null means automatic (the helper's own ranking) — unlike micDeviceUid. */
  cameraDeviceUid: string | null;
  /** STC-418. Off by default; no control until the options bar (PR 4). */
  systemAudio: boolean;
  /** STC-292. */
  shutterSound: boolean;
  /** STC-461: the PiP style new camera takes start with. */
  pipStyle: PipStyle;
  /** STC-391: how long Record and the self-timer count down, ms. */
  countdownMs: number;
  /** STC-293. */
  still: StillSettingsView;
  /** STC-296. */
  thumbnail: ThumbnailSettingsView;
  /** STC-412: where recordings and stills are saved, replacing still.destination. */
  saveFolder: string | null;
  /** STC-412: show diagnostics table. */
  showDiagnostics: boolean;
  /** STC-429: the take library's layout. */
  libraryView: "grid" | "list";
  /** STC-502: where the app's icon lives. */
  iconPlacement: IconPlacement;
  /** STC-444 slice 3: the site folder, moved here from the editor window's
   *  own sharebar — one setting for the whole app, not a per-take one. */
  share: { destination: string | null };
  /** STC-395: what a recording's GIF is converted with. */
  gif: GifSettings;
}
interface Take {
  dir: string; name: string; durationMs: number;
  width: number; height: number; events: number; bytes: number; label?: string;
  camera?: { present: boolean; device?: string; pipStartsAfterMs: number };
}
interface StillResult {
  ok: boolean; cancelled?: boolean; dir?: string; kind?: string;
  file?: string; shot?: any; warning?: string; code?: string; detail?: string;
  source?: string;
}
declare const recorder: {
  getSettings: () => Promise<AppSettings>;
  setSettings: (p: Partial<AppSettings>) => Promise<AppSettings>;
  devices(): Promise<{
    displays?: DisplayInfo[]; mics?: MicInfo[]; cameras?: CameraInfo[];
    stalled?: boolean; detail?: string;
  }>;
  status(): Promise<{ state: string; pid?: number }>;
  takes(): Promise<{ takes: Take[]; invalid: { name: string; reason: string }[] }>;
  library(filter?: string): Promise<LibraryList>;
  writeThumbnail(dir: string, bytes: ArrayBuffer): Promise<boolean>;
  getFrame(dir: string, name: string): Promise<ArrayBuffer>;
  getShot(dir: string): Promise<Shot>;
  reopenStill(dir: string): Promise<{ ok: boolean }>;
  duplicateStill(dir: string): Promise<{ ok: boolean; dir: string }>;
  // STC-413: the file IS the name now. `file` wins when present (a real
  // rename on disk, through `takes.ts`'s `renameCapture`); `dir` alone falls
  // back to the old take.json label, for a bundle with no finished file yet.
  renameCapture(file: string | undefined, dir: string | undefined, name: string): Promise<string>;
  deleteTake(file: string | undefined, dir: string | undefined):
    Promise<{ deleted: boolean; cancelled?: boolean; detail?: string }>;
  // The take player is its own window now (STC-373) — this opens it. Every
  // channel the old in-page player used (`openPreview`, `writeExport`,
  // `publish`, and the rest) moved to `editor-preload.ts`, the only bridge
  // that still calls them.
  // `autoShare` (STC-429) asks the editor to run its own Share flow as soon
  // as the take is open, rather than duplicating share.ts's plumbing here.
  openEditor(dir: string, name: string, autoShare?: boolean): Promise<boolean>;
  captureStill(action?: ShotAction): Promise<StillResult>;
  getShortcuts(): Promise<{ shortcuts: Shortcuts; report: ShortcutReport[] }>;
  chooseStillDestination(): Promise<{ saveFolder: string | null }>;
  /** The resolved save location — never null, never a phrase (STC-412 I1). */
  resolvedSaveFolder(): Promise<string>;
  /** STC-476: re-read the grants; main pushes the same shape on `permissions:changed`. */
  permissions(): Promise<PermissionsState>;
  permissionsAct(grant: Grant, action: RowAction): Promise<PermissionsState>;
  start():Promise<{ ok: boolean; cancelled?: boolean; dir?: string; code?: string; detail?: string }>;
  stop(): Promise<{ ok: boolean; info?: any }>;
  reveal(dir: string): Promise<void>;
  /** STC-592: a saved GIF's bytes, for its tile. Main refuses anything but a top-level .gif. */
  gifBytes(file: string): Promise<Uint8Array<ArrayBuffer>>;
  /** STC-592: a saved GIF's Share — the file itself on the pasteboard. */
  copyFile(file: string): Promise<{ ok: boolean; detail?: string }>;
  /** STC-584: a still's Share copies its image through the panel's own funnel. */
  exportStill(req: Record<string, unknown>): Promise<{ ok: boolean; code?: string; detail?: string }>;
  on(event: string, cb: (p: any) => void): () => void;
  /** STC-412: show a warning via the toast. */
  showToast(message: ToastInput): void;
  /** STC-581: Settings is its own window; main opens (or brings forward) it. */
  openSettings(): Promise<void>;
};

import type { IconPlacement } from "./icon-placement.js";
import {
  formatAccelerator, type BindableAction, type ShotAction, type ShortcutReport, type Shortcuts,
} from "./hotkeys.js";
import {
  renderLibrary, renderControls, renderPlaceholderOnly, showUpdating, installOverflowDismissal,
  type LibraryCallbacks,
} from "./library-view.js";
import {
  placeholderFor, searchPlaceholder, applySearch, countLabel, LOADING_PLACEHOLDER, UPDATING_NOTE,
  UPDATING_SHOW_AFTER_MS,
  type LibraryItem, type LibraryList, type PlaceholderAction, type PlaceholderContext,
} from "./library-items.js";
import { STOP_ANNOUNCING_WARNINGS, TRACK_LOSS_WARNINGS, TRACK_STALL_WARNINGS } from "./stop-copy.js";
import { decorationForMode, layoutStill } from "@transform/still-decorate";
import { renderStill, sampleRedactionFills } from "@transform/still-render";
import { withMeshBackground } from "@transform/still-mesh";
import { colorSpaceFor, stillIsBlocked, type ExportOptions } from "@transform/still-export";
import { composeStill, stillPixelBytes } from "./still-compose.js";
import type { Shot } from "@transform/shot";
import type { GifSettings } from "@transform/gif-options";
import { PERMISSION_ACTION_LABELS, type Grant, type PermissionsState, type RowAction } from "./permissions.js";
import { iconSvg } from "./icons.js";
import type { ToastInput } from "./toast-message.js";
import type { MicInfo } from "./mic-devices.js";
import type { PipStyle } from "@transform/pip-style.js";

const $ = (id: string) => document.getElementById(id)!;

// ---- the title bar (STC-584) ---------------------------------------------
//
// Settings is its own window (STC-581): the gear asks main to open it,
// through the same function the menu bar and the record bar use. The glyph is
// the record bar's own Settings icon.
const settingsBtn = $("settings") as HTMLButtonElement;
settingsBtn.innerHTML = iconSvg("settings");
settingsBtn.addEventListener("click", () => void recorder.openSettings());

// Reduce Transparency turns the glass bar opaque. Main reads macOS's own
// setting (`nativeTheme`), because Chromium may not report the media query.
const reduceTransparency = (on: boolean) => document.body.classList.toggle("reduce-transparency", on);
reduceTransparency(new URLSearchParams(location.search).get("reduceTransparency") === "1");
recorder.on("library:reduced-transparency", (on: boolean) => reduceTransparency(!!on));

// ---- required grants (STC-476) ---------------------------------------------
//
// Draws what main decided (`permissions.ts`) and reports which button was
// pressed; decides nothing. Shown exactly while a state says something is
// still needed, with no way to close it (VM pass, 2026-10-08). Re-read on
// focus, which is how it notices a change made in System Settings without a
// restart.
const permSheet = $("permissionsheet");
const permRows = $("permissionrows");
const permIntro = $("permissionintro");

function renderPermissions(s: PermissionsState): void {
  permSheet.classList.toggle("open", s.needed);
  if (s.intro) permIntro.textContent = s.intro;
  permRows.replaceChildren(...s.rows.map((row) => {
    const el = document.createElement("div");
    el.className = "permrow";
    el.dataset.grant = row.grant;
    el.dataset.status = row.status;
    const title = document.createElement("div");
    title.className = "permtitle";
    title.textContent = row.title;
    const status = document.createElement("span");
    status.className = "permstatus";
    status.textContent = row.statusText;
    title.append(status);
    const why = document.createElement("p");
    why.className = "permwhy";
    why.textContent = row.why;
    const actions = document.createElement("div");
    actions.className = "permactions";
    for (const action of row.actions) {
      const b = document.createElement("button");
      b.textContent = PERMISSION_ACTION_LABELS[action];
      b.dataset.action = action;
      b.addEventListener("click", async () => {
        b.disabled = true;
        try { renderPermissions(await recorder.permissionsAct(row.grant, action)); }
        finally { b.disabled = false; }
      });
      actions.append(b);
    }
    el.append(title, why, actions);
    return el;
  }));
}
recorder.on("permissions:changed", (s: PermissionsState) => renderPermissions(s));
window.addEventListener("focus", () => {
  if (permSheet.classList.contains("open")) void recorder.permissions().then(renderPermissions);
});
void recorder.permissions().then(renderPermissions);

function alertUser(message: ToastInput): void { recorder.showToast(message); }

// A capture that started somewhere else (a global hotkey, the menu bar, a
// panel): the shot is on disk whether or not anyone is watching, and this
// keeps an open library from showing a stale list. Its refusals and warnings
// are main's to announce (STC-465 review), so this says nothing itself.
recorder.on("still:captured", (r: StillResult) => { if (r.ok) void refreshTakes(); });

recorder.on("helper:ready", (l) => {
  $("pid").textContent = String(l.pid ?? "—");
});

recorder.on("helper:stats", (s) => {
  // The heartbeat runs from boot, not just while recording — that is the whole
  // point of it, so surface it. An idle helper that has stopped beating is a
  // wedged helper, and the panel should not look identical either way.
  $("alive").textContent = s.state ?? "—";
  $("frames").textContent = s.frames ?? "—";
  $("dropped").textContent = s.dropped ?? "—";
  $("events").textContent = s.events ?? "—";
  // STC-309: shape changes are counted inside `events` too; shown apart so a
  // take with no pointer motion still reads as one.
  $("cursorEvents").textContent = s.cursorEvents ?? "—";
  // STC-539: absent until the camera has opened, and on a take without one.
  $("cameraFrames").textContent = s.cameraFrames ?? "—";
  $("elapsed").textContent = s.elapsedMs != null ? `${(s.elapsedMs / 1000).toFixed(1)}s` : "—";
});

recorder.on("helper:recording-lost", (i) => {
  // STC-530: a recovered take is up as its own panel, with the reason on it — no toast
  // (STC-505: toasts are for events with no take to attach to). One that could not be
  // recovered is still on disk, untouched, and the next launch offers it.
  if (!i.recovered) alertUser("The recorder quit while recording, and the take couldn't be recovered.");
});

recorder.on("helper:gave-up", () => { alertUser("The recorder keeps failing to start. Restart the app."); });

/**
 * Another window wrote a preference: Settings, a slider at a time (STC-581),
 * or the record bar. The grid lists the save folder, and its empty state
 * names the keys, so it is re-listed only when one of those moved.
 */
recorder.on("settings:changed", () => {
  void (async () => {
    const listing = await listingInputs();
    if (listing !== listedFor) await refreshTakes();
    listedFor = listing;
  })();
});
/** The save folder and the shortcuts, which the grid and its empty state are drawn from. */
async function listingInputs(): Promise<string> {
  let shortcuts = "";
  try { shortcuts = JSON.stringify((await recorder.getShortcuts()).shortcuts); } catch { /* unread: no re-list for it */ }
  return JSON.stringify([(await recorder.getSettings()).saveFolder, shortcuts]);
}
/** What the grid was last drawn for, as `settings:changed` compares it. */
let listedFor: string | undefined;
void listingInputs().then((l) => { listedFor ??= l; }, () => {});

/**
 * Camera failures the user must actually see. Every one of these was already
 * being emitted and silently dropped: the handler below matched exactly one
 * code and ignored the rest, so a camera that could not open, or that opened
 * and delivered nothing, looked identical to one that worked.
 */
const CAMERA_FAULTS: Record<string, string> = {
  "camera-failed": "The camera could not be opened, so this take has no picture-in-picture.",
  "virtual-camera-only":
    "Only a virtual camera was available. It was not used, so this take has no " +
    "picture-in-picture — connect a real camera and record again.",
  // STC-286. The one that looked exactly like success: the camera opens,
  // reports its name, and delivers nothing. Confirmed in clamshell on real
  // hardware — camera-started with "FaceTime HD Camera", then a 0-byte
  // camera.mp4. Until this warning existed the app showed the device name for
  // the whole take and only admitted the truth afterwards, in the library.
  "camera-no-frames":
    "The camera opened but is not sending any frames, so this take will have no " +
    "picture-in-picture. A closed laptop lid, a covered lens, or another app using " +
    "the camera all look like this.",
  // STC-414: the picker showed a real device at some point, and it is gone by the
  // time the take actually opens it — the same shape as mic-not-found, and the
  // same rule (refuse that device, never silently substitute another).
  "camera-not-found": "The chosen camera is no longer available, so this take has no picture-in-picture.",
  // `camera-disconnected` (a mid-take unplug; video keeps recording, STC-433) is not a
  // toast since STC-237: it is one of `stop-copy.ts`'s TRACK_LOSS_WARNINGS, said on the
  // pill while the take runs and on the panel after.
};

/**
 * STC-233: the mic's own failures, same shape as CAMERA_FAULTS and the same
 * reason — every one of these was already emitted by the helper and would
 * otherwise be silently dropped by the generic handler below.
 */
const MIC_FAULTS: Record<string, string> = {
  "mic-not-found": "The chosen microphone is no longer available, so this take has no microphone audio.",
  "mic-not-authorized": "Microphone access is not authorized, so this take has no microphone audio.",
  "mic-format-unavailable": "The chosen microphone reported no usable audio format, so this take has no microphone audio.",
  "mic-device-input-failed": "The microphone could not be opened, so this take has no microphone audio.",
  "mic-input-refused": "The microphone could not be opened, so this take has no microphone audio.",
  "mic-writer-failed": "Recording the microphone failed, so this take has no microphone audio.",
  "mic-no-frames":
    "The microphone opened but is not sending any audio, so this take will have no " +
    "microphone audio. Another app holding the device is the usual cause.",
  // `mic-disconnected` (STC-433) and `mic-format-mismatch` (STC-485's guard) end the
  // mic track while the take keeps recording. Not toasts since STC-237: they are
  // `stop-copy.ts`'s TRACK_LOSS_WARNINGS, said on the pill and then the panel.
};

/**
 * Warnings that are not about the camera but still decide whether a take is
 * what the user thinks it is.
 *
 * `event-tap-unavailable` used to be the entry that mattered most here and is
 * deliberately NOT one any more: since STC-315 a take that cannot record the
 * cursor does not start, so the helper answers the `start` request with that
 * code instead of warning about a recording already underway. Its wording
 * lives in START_FAULTS (`refusals.ts`), where it can say "nothing was recorded" — which is
 * the fact a warning phrased for a live take could not state. Leaving a copy
 * here would be a message that can no longer fire, describing a take that can
 * no longer exist.
 *
 * `stream-stopped` is a display stream that died mid-take. It used to leave the
 * helper in "recording" with frames simply stopping until Stop was pressed;
 * since STC-306 the helper ends the take itself, so this warning is followed
 * by a `recording-ended` with the same reason.
 */
const RECORDING_FAULTS: Record<string, string> = {
  // `stream-stopped` used to have a sentence here. Since STC-531 it is one of
  // `STOP_ANNOUNCING_WARNINGS`: the pill and the panel say it.
  "av-runtime-error": "A capture device reported an error during the recording.",
};

/**
 * Emitted by the helper's watchers whenever ANY display changes, recording or
 * not — alone it is not worth an alert. A take the display change ENDS says so
 * through `helper:recording-ended` and the take's panel (`stop-copy.ts`'s `display-reconfigured`
 * / `region-out-of-bounds`); one it survives (STC-235) sends `display-refit`,
 * which is news, not a problem: the recording continues. The helper used to
 * send a separate `display-change-during-recording` warning before every such
 * stop; since STC-235 it does not, and the stop's own reason is the one
 * message.
 */
const INFORMATIONAL_WARNINGS = new Set(["display-reconfigured", "display-refit", "display-refit-rect-mismatch", "frames-dropped"]);

recorder.on("helper:warning", (l) => {
  const code = String(l.code);
  // STC-559: `device-disconnected` is no longer a warning. The helper tells a take's own
  // mic and camera by `mic-disconnected` / `camera-disconnected`; any other device
  // (headphones, a headset) is not news about the take.
  // STC-553: a camera that stalled. The pill says it and the panel says it after. No toast.
  if (TRACK_STALL_WARNINGS.has(code)) {
    console.info(`[helper] ${code}`, JSON.stringify(l));
    return;
  }
  // STC-237: a mic or camera lost while the take keeps recording. The pill says it
  // for a moment (pill-window.ts, from main) and the panel says it after. No toast.
  if (TRACK_LOSS_WARNINGS.has(code)) {
    console.info(`[helper] ${code}`, JSON.stringify(l));
    return;
  }
  // STC-531: the helper is about to stop the take itself, and the pill and the
  // panel will say why. A toast here would be the same news a third time.
  if (STOP_ANNOUNCING_WARNINGS.has(code)) {
    console.info(`[helper] ${code}`, JSON.stringify(l));
    return;
  }
  if (INFORMATIONAL_WARNINGS.has(code)) {
    // A refit is otherwise invisible: it is not a toast, and nothing writes
    // helper warnings to disk. Its payload (`path` update/restart/record,
    // `startNs`, `display`, `contentRect`) is the only record of HOW a take
    // survived a display change, which runbook §1/§2 ask about. So it goes to
    // the DevTools console. An idle `display-reconfigured` stays silent: it
    // fires on every monitor change and says nothing about a take.
    // `frames-dropped` (STC-238) is the same kind of record: a hole the writer
    // could not fill (`startNs`..`endNs`, `count` frames) in a take that kept
    // going. A loaded machine can produce several, so never a toast.
    if (code === "display-refit" || code === "display-refit-rect-mismatch" || code === "frames-dropped") {
      console.info(`[helper] ${code}`, JSON.stringify(l));
    }
    return;
  }
  const camera = CAMERA_FAULTS[code];
  if (camera) {
    // A silent failure is what this whole table exists to remove. The camera
    // and mic rows that also said it left this window with STC-584 (Patrick,
    // 2026-10-27: the toast is enough); after the take, its panel and its
    // library badge say it again.
    alertUser(l.detail ? `${camera}\n\n${l.detail}` : camera);
    return;
  }
  const mic = MIC_FAULTS[code];
  if (mic) {
    alertUser(l.detail ? `${mic}\n\n${l.detail}` : mic);
    return;
  }
  // Everything else is shown too. This handler used to match a handful of
  // codes and drop the rest, which is how a take with no cursor track looked
  // like a good one; a warning the helper thought worth a reliable-channel
  // line is not one the UI gets to discard.
  const text = RECORDING_FAULTS[code] ?? `The recorder reported a problem: ${code}`;
  alertUser(l.detail ? `${text}\n\n${l.detail}` : text);
});

const fmtDuration = (ms: number) => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const fmtSize = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;

// ---- still capture preferences ---------------------------------------------
//
// What used to be the still panel (STC-293) is gone: the decorated still
// itself — style picker, redact, copy, save — is the floating thumbnail's own
// compact window now (STC-296, "the whole still UI in v1";
// app/renderer/thumbnail.html, app/src/thumbnail-renderer.ts). What remains
// here is the two things that are genuinely PREFERENCES rather than per-shot
// controls: the destination folder, and where the thumbnail shows itself.
// STC-392 removed the third one, how long it waited before closing itself —
// it does not any more. Both are read through the same `recorder:getSettings`
// / `recorder:setSettings` every other preference in this window uses.

// The diagnostics strip follows the Settings window's Show diagnostics (STC-584
// moved it from a table above the library to a strip pinned under it). Main
// tells this window when another window wrote a preference.
const diagnosticsStrip = $("diagnostics");
async function refreshDiagnosticsVisibility(): Promise<void> {
  const on = (await recorder.getSettings()).showDiagnostics;
  diagnosticsStrip.hidden = !on;
  // Room under the last row, so the strip never covers it.
  document.body.classList.toggle("diagnostics", on);
}
void refreshDiagnosticsVisibility().catch(() => {});
recorder.on("settings:changed", () => { void refreshDiagnosticsVisibility().catch(() => {}); });

// ---- library -------------------------------------------------------------

/** Which kind filter is showing. The adapter validates it; this only remembers it. */
let libraryFilter = "all";

/** Which layout the library draws in (STC-429) — read from settings at boot, below. */
let libraryViewMode: "grid" | "list" = "grid";

/**
 * The longest edge a cached library thumbnail is rendered at.
 *
 * A thumbnail is a PREVIEW, and downscaling it is fine — the rule that nothing
 * in the still path resamples the capture is about the EXPORT, where a
 * resampled premultiplied edge is the dark fringe the whole still path exists
 * to avoid. Here the alternative is caching a 4K PNG per tile.
 */
const THUMB_MAX_EDGE = 480;

/**
 * Draw one still's decorated result into `img`, and cache it beside the shot.
 *
 * Through the SAME `layoutStill` + `renderStill` the panel and the export use.
 * A second rendering path is what STC-293's Note forbids and would be the
 * quiet way for the grid to show something the export does not produce — the
 * ticket's own wording is that thumbnails render *"the decorated result, not
 * the raw capture, so the grid shows what the user will get"*, which is only
 * true if it is literally the same code.
 */
async function renderThumbnail(item: LibraryItem, img: HTMLImageElement): Promise<void> {
  // A "render" thumbnail only ever exists for a still WITH a bundle —
  // `library-items.ts`'s `stillItem` is the only place that sets
  // `thumbnail.source === "render"`, and it only runs for bundle-backed
  // stills. Structural, not a possibility this function has to weigh.
  const dir = item.dir;
  if (!dir) throw new Error("a rendered thumbnail needs a bundle directory");
  const shot = await recorder.getShot(dir);
  const bytes = await recorder.getFrame(dir, shot.frame.file);
  const frame = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  try {
    // The stored decoration, filled in from the mode's presets exactly as the
    // panel does — so a shot never opened since capture still shows what it
    // would export.
    const decorated = { ...shot, decoration: decorationForMode(shot.decoration.mode, shot.decoration) };
    const layout = layoutStill(decorated);
    const fit = Math.min(1, THUMB_MAX_EDGE / Math.max(layout.canvas.width, layout.canvas.height));

    const full = document.createElement("canvas");
    full.width = layout.canvas.width;
    full.height = layout.canvas.height;
    const ctx = full.getContext("2d", {
      alpha: true, colorSpace: colorSpaceFor(shot.display.colorSpace) as never,
    });
    if (!ctx) throw new Error("no 2d context for a thumbnail");
    // Sampled from the FRAME, not the composite: the regions are normalised
    // against the frame, and reading the composite would read pixels a
    // previous fill had already replaced.
    const fills = sampleRedactionFills(frame, shot.frame, decorated.decoration.redactions);
    withMeshBackground(layout.background, full.width, full.height, (background) =>
      renderStill(ctx as never, { frame, redactionFills: fills, background }, layout));

    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(full.width * fit));
    small.height = Math.max(1, Math.round(full.height * fit));
    small.getContext("2d")!.drawImage(full, 0, 0, small.width, small.height);

    const blob = await new Promise<Blob | null>((res) => small.toBlob(res, "image/png"));
    if (!blob) throw new Error("could not encode a thumbnail");
    img.src = URL.createObjectURL(blob);
    // Cached AFTER it is on screen: a failed write costs the cache, never the
    // picture the user is already looking at.
    try { await recorder.writeThumbnail(dir, await blob.arrayBuffer()); }
    catch { /* an uncached tile simply renders again next time */ }
  } finally {
    // ~30 MB at 4K, and 500 of them is the tab-killer this repo already
    // documents. Closed on every path, including the failing one.
    frame.close();
  }
}

/**
 * An animated thumbnail (STC-592, Patrick 2026-10-27): the first frame at
 * rest, the animation while the pointer is over the item, and only the first
 * frame under Reduce Motion.
 *
 * The bytes are fetched for the first frame and dropped; a hover fetches them
 * again and leaving releases them. Holding every GIF's bytes for as long as
 * its tile exists would cost a library of GIFs their total size in renderer
 * memory, for animations nobody is pointing at.
 */
async function showAnimatedThumbnail(item: LibraryItem, img: HTMLImageElement): Promise<void> {
  const file = item.file;
  if (!file) throw new Error("an animated thumbnail is the item's own file");
  const gif = async () => new Blob([await recorder.gifBytes(file)], { type: "image/gif" });
  // createImageBitmap on a GIF decodes its first frame.
  const first = await createImageBitmap(await gif());
  let still: string;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = first.width; canvas.height = first.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context for a thumbnail");
    ctx.drawImage(first, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("could not encode a thumbnail");
    still = URL.createObjectURL(blob);
  } finally { first.close(); }
  img.src = still;

  const host = img.closest<HTMLElement>("[data-id]") ?? img;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  let playing: string | undefined;
  let hovered = false;
  host.addEventListener("pointerenter", () => {
    hovered = true;
    if (reduce.matches || playing) return;
    void gif().then((b) => {
      if (!hovered || playing) return;
      playing = URL.createObjectURL(b);
      img.src = playing;
    }).catch((e) => console.error(`[library] could not play ${item.id}:`, e));
  });
  host.addEventListener("pointerleave", () => {
    hovered = false;
    if (!playing) return;
    img.src = still;
    URL.revokeObjectURL(playing);
    playing = undefined;
  });
}

/** Show a cached thumbnail, decoding it in the main process's stead. */
async function showCachedThumbnail(item: LibraryItem, img: HTMLImageElement,
                                   file: string): Promise<void> {
  // A cached "file" thumbnail lives INSIDE the take directory (rule 5,
  // library-items.ts), so this too only ever runs for a bundle-backed still.
  const dir = item.dir;
  if (!dir) throw new Error("a cached thumbnail lives inside a bundle directory");
  const bytes = await recorder.getFrame(dir, file);
  img.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

const libraryCallbacks: LibraryCallbacks = {
  async act(id, item) {
    try {
      // Dispatch by ACTION, never by kind — the ticket's fourth acceptance
      // criterion. Which actions an item offers was decided by the adapter, so
      // an id that cannot apply to this item never reaches here.
      if (id === "open") await openItem(item);
      else if (id === "copy-image") await copyStillImage(item);
      else if (id === "copy-file") {
        // A saved GIF's Share (STC-592): the file IS what gets shared.
        const file = item.file;
        if (!file) throw new Error("nothing to copy");
        const r = await recorder.copyFile(file);
        if (!r?.ok) throw new Error(`Could not copy the file: ${r?.detail ?? "unknown error"}`);
        alertUser(`Copied “${item.label ?? item.id}” to the clipboard.`);
      }
      else if (id === "share") {
        // A recording's Share: open the take editor and let IT run the Share
        // flow, rather than a second one here. A still's Share is
        // "copy-image", a different action with its own id.
        const dir = item.dir;
        if (!dir) throw new Error("share needs a bundle directory");
        try {
          await recorder.openEditor(dir, item.id, true);
        } catch (e: any) {
          alertUser(`Could not open "${item.label ?? item.id}" to share it.\n${e?.message ?? e}`);
        }
      }
      else if (id === "duplicate") {
        // Bundle-only, same reason "open" is: the adapter never offers this
        // id for an item with no `dir` (rule: an action needing a bundle
        // must not be offered without one).
        const dir = item.dir;
        if (!dir) throw new Error("duplicate needs a bundle directory");
        await recorder.duplicateStill(dir); await refreshTakes();
      }
      else if (id === "reveal") {
        // Reveal has no bundle-only requirement — a plain finished file is
        // just as revealable as a directory, so this falls back to `file`
        // rather than refusing. `dir` still wins when both exist, unchanged
        // from before this item could ever lack one.
        const target = item.dir ?? item.file;
        if (!target) throw new Error("nothing to reveal");
        await recorder.reveal(target);
      }
      else if (id === "delete") {
        // STC-413: BOTH halves go, not one or the other — a matched item is
        // a finished file at the top level and its source bundle in `raw/`,
        // and main trashes whichever of the two it is actually given rather
        // than this view picking one the way the old `dir ?? file` fallback
        // did (which silently left the other half behind).
        if (!item.file && !item.dir) throw new Error("nothing to delete");
        // A take the editor has open is handled main-side (STC-373): deleting
        // it clears main's own per-window `openTake` entry for that path, so
        // an open editor window's writes correctly start refusing rather than
        // landing in a directory `take:delete` just trashed.
        const r = await recorder.deleteTake(item.file, item.dir);
        // STC-413 review round 1: refresh on any NON-CANCELLED outcome, not
        // only full success. A PARTIAL failure (one half trashed, the other
        // not) still changed the filesystem — the old code's `if (r.deleted)`
        // left this tile's `file`/`dir` stale after exactly that, so a retry
        // re-sent the ALREADY-TRASHED half's path and (before main's own
        // fix) threw before ever reaching the half still there. A Cancel is
        // the one outcome that legitimately changes nothing
        // (`trashWithConfirmation`'s own rule), so it alone skips this.
        if (!r.cancelled) {
          await refreshTakes();
          // A REAL failure used to reach nobody: this action's own `detail`
          // was discarded before STC-300's revision removed the only other
          // door (the post-capture panel's "confirm" Trash) that ever
          // surfaced one.
          if (!r.deleted) alertUser(r.detail ?? "Could not delete this take.");
        }
      }
    } catch (e: any) { alertUser(String(e?.message ?? e)); }
  },
  async rename(item, label) {
    // STC-413: rename does not need a bundle any more, so both `file` and
    // `dir` are handed through unresolved and main decides — `file` wins
    // (a real rename on disk) when there is one, `dir` alone falls back to
    // the old take.json label, and neither refuses loudly rather than doing
    // nothing silently, which is what this replaced (Task 8's
    // `looseFileItem` offers "rename" on an item with no bundle at all, and
    // the old handler here dropped that click on the floor).
    try {
      if (!item.file && !item.dir) throw new Error("nothing to rename");
      await recorder.renameCapture(item.file, item.dir, label);
      await refreshTakes();
    } catch (e: any) { alertUser(String(e?.message ?? e)); }
  },
  async setFilter(id) { libraryFilter = id; await refreshTakes(); },
  async setView(mode) {
    // Remembered (STC-584, Patrick 2026-10-27): the library opens in the
    // last view used, Grid the first time (settings.ts's default).
    libraryViewMode = mode;
    drawLibrary();
    await recorder.setSettings({ libraryView: mode });
  },
  async paintThumbnail(item, img) {
    if (item.thumbnail.source === "file") {
      await showCachedThumbnail(item, img, item.thumbnail.file);
    } else if (item.thumbnail.source === "render") {
      await renderThumbnail(item, img);
    } else if (item.thumbnail.source === "animated") {
      await showAnimatedThumbnail(item, img);
    }
  },
};

/**
 * A still's Share (STC-584, Patrick 2026-10-27): put the decorated image on
 * the clipboard, at export scale and in the shot's own colour space, exactly
 * as the panel's Copy does. The same `composeStill` + `still:export` funnel,
 * never a second render path; `target.file: false` is what keeps a copy from
 * counting as a save.
 */
async function copyStillImage(item: LibraryItem): Promise<void> {
  const dir = item.dir;
  if (!dir) throw new Error("a still's image needs its bundle directory");
  const shot = await recorder.getShot(dir);
  const bytes = await recorder.getFrame(dir, shot.frame.file);
  const frame = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  try {
    const decorated = { ...shot, decoration: decorationForMode(shot.decoration.mode, shot.decoration) };
    let options: ExportOptions = { ...(await recorder.getSettings()).still } as ExportOptions;
    let composed = composeStill(decorated, frame, options);
    // A stored JPEG under a style with transparency: PNG, as the panel does.
    if (stillIsBlocked(composed.plan)) {
      options = { ...options, format: "png" };
      composed = composeStill(decorated, frame, options);
    }
    const { canvas, plan } = composed;
    const r = await recorder.exportStill({
      bytes: stillPixelBytes(canvas), width: canvas.width, height: canvas.height, alpha: plan.alpha,
      colorSpace: shot.display.colorSpace ?? "",
      target: { file: false, clipboard: true },
      options,
      info: { ...(shot.window?.app ? { app: shot.window.app } : {}),
              ...(shot.window?.title ? { title: shot.window.title } : {}),
              mode: decorated.decoration.mode },
      dir,
    });
    if (!r?.ok) throw new Error(`Could not copy the image: ${r?.detail ?? r?.code ?? "unknown error"}`);
    alertUser(`Copied “${item.label ?? item.id}” to the clipboard.`);
  } finally {
    frame.close();
  }
}

/**
 * Open whatever this item is.
 *
 * Both kinds go to an editor window now — a recording to `editor.ts`
 * (STC-373), a still to the still editor (STC-300 revision; `main.ts`'s
 * `still:reopen` used to re-present the post-capture panel instead). Which
 * window is still a MAIN-process decision, not a view's: the view asked for
 * "open" and does not know which happened.
 *
 * Told apart by what the adapter said the item HAS — a still is the thing with
 * a thumbnail to render or cached — rather than by its kind. That reads as a
 * dodge and is not: the criterion is that the presentation layer must not
 * encode kind rules, and "the ones with pictures open in the picture window"
 * is a rule about the interface, which is where it is allowed to live.
 */
async function openItem(item: LibraryItem): Promise<void> {
  // "open" is never offered by the adapter for an item with no bundle — both
  // branches below need the raw materials (or shot.json) that only a
  // directory carries, so this is a structural guard, not a UI decision.
  const dir = item.dir;
  if (!dir) return;
  if (item.thumbnail.source === "none") {
    // The take player is the editor's own window now (STC-373).
    try {
      await recorder.openEditor(dir, item.id);
    } catch (e: any) {
      alertUser(`Could not open "${item.label ?? item.id}".\n${e?.message ?? e}`);
    }
    return;
  }
  await recorder.reopenStill(dir);
}

/** What the empty library says — read only when it is about to be shown. */
async function placeholderContext(): Promise<PlaceholderContext> {
  let shortcuts: Awaited<ReturnType<typeof recorder.getShortcuts>>["shortcuts"] | undefined;
  try { shortcuts = (await recorder.getShortcuts()).shortcuts; } catch { /* unbound reads as no hint */ }
  const key = (a: "display" | "record") => (shortcuts?.[a] ? formatAccelerator(shortcuts[a]) : null);
  return { folder: await recorder.resolvedSaveFolder(), shotKey: key("display"), recordKey: key("record") };
}

async function onPlaceholderAction(a: PlaceholderAction): Promise<void> {
  if (a === "choose-folder") await recorder.chooseStillDestination();
  await refreshTakes();
}

// STC-521: the first paint shows "loading" instead of an empty page, and a
// later refresh that outlasts UPDATING_SHOW_AFTER_MS says the grid is catching
// up. A fast refresh shows neither.
let libraryDrawn = false;

async function refreshTakes(): Promise<void> {
  const host = $("takes");
  let slow: ReturnType<typeof setTimeout> | undefined;
  if (!libraryDrawn) renderPlaceholderOnly(host, LOADING_PLACEHOLDER);
  else slow = setTimeout(() => showUpdating(host, UPDATING_NOTE), UPDATING_SHOW_AFTER_MS);
  let list: LibraryList;
  try {
    list = await recorder.library(libraryFilter);
  } finally {
    clearTimeout(slow);
  }
  libraryFilter = list.filter;
  lastList = list;
  const empty = !list.items.length && !list.invalid.length && !(list.folder && list.folder.state !== "ok");
  emptyContext = empty && list.filter === "all"
    ? await placeholderContext()
    : { folder: "", shotKey: null, recordKey: null };
  libraryDrawn = true;
  drawLibrary();
}

/** The last list main sent, so a search keystroke redraws without a rescan. */
let lastList: LibraryList | undefined;
let emptyContext: PlaceholderContext = { folder: "", shotKey: null, recordKey: null };

/**
 * Draw `lastList` through the search box (STC-584). A search narrows what is
 * already listed; it never rescans the folder, so typing stays instant on a
 * library of 500.
 */
function drawLibrary(): void {
  const list = lastList;
  if (!list) return;
  const query = searchBox.value;
  const items = applySearch(list.items, query);
  const shown: LibraryList = { ...list, items };
  const placeholder = items.length === 0 && list.items.length > 0
    ? searchPlaceholder(query)
    : placeholderFor(shown, emptyContext);
  const folderLost = list.folder?.state === "missing" || list.folder?.state === "unreadable";
  $("libcount").textContent = folderLost ? "" : countLabel(items.length, list.items.length);
  renderControls($("libcontrols"), list, libraryViewMode, libraryCallbacks, folderLost);
  searchBox.hidden = folderLost;
  renderLibrary($("takes"), shown, libraryCallbacks, libraryViewMode, placeholder,
                (a) => void onPlaceholderAction(a));
}

const searchBox = $("libsearch") as HTMLInputElement;
searchBox.addEventListener("input", () => drawLibrary());
searchBox.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && searchBox.value) { e.stopPropagation(); searchBox.value = ""; drawLibrary(); }
});
installOverflowDismissal($("scroller"));


// STC-519: main promoted a take into the library (a panel's Save or Edit).
recorder.on("library:changed", () => { void refreshTakes(); });

recorder.status().then((s) => {
  if (s.pid) $("pid").textContent = String(s.pid);
  // A helper that could not be spawned at all fails in milliseconds — every
  // restart the supervisor allows has already been used up before this page
  // exists, so the gave-up event above was emitted to nobody. Read the state
  // instead of relying on having been there when it changed.
  if (s.state === "failed") alertUser("The recorder keeps failing to start. Restart the app.");
});
// The layout preference (STC-429) has to be known before the first render —
// a bare `refreshTakes()` here would draw the grid once, then again in
// whatever view the user actually chose, a visible flash on every launch.
void (async () => {
  libraryViewMode = (await recorder.getSettings()).libraryView;
  await refreshTakes();
})();
