/** UI: a record button, live telemetry, and anything that went wrong stated plainly. */
interface DisplayInfo {
  id: number; main: boolean; name?: string;
  pointW: number; pointH: number; pixelW: number; pixelH: number;
  originX?: number; originY?: number;
}
/** STC-233. Mirrors Watchers.enumerateDevices's own "mics" shape. */
interface MicInfo {
  name: string; uid: string; bluetooth: boolean;
}
interface StillSettingsView {
  format: string; quality: number; scale: string;
  stripMetadata: boolean; template: string;
}
interface ThumbnailSettingsView {
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  skip: boolean;
}
interface ScopeSettingsView {
  kind: "display" | "region" | "window";
  region: { displayId: number; x: number; y: number; width: number; height: number } | null;
  windowId: number | null;
  windowLabel: string | null;
}
interface AppSettings {
  camera: boolean;
  displayId: number | null;
  /** STC-233. null means no mic — never "automatic". */
  micDeviceUid: string | null;
  /** STC-292. */
  shutterSound: boolean;
  /** STC-391: how long Record and the self-timer count down, ms. */
  countdownMs: number;
  /** STC-293. */
  still: StillSettingsView;
  /** STC-296. */
  thumbnail: ThumbnailSettingsView;
  /** STC-370/STC-374: what a recording captures. */
  scope: ScopeSettingsView;
  /** STC-412: where recordings and stills are saved, replacing still.destination. */
  saveFolder: string | null;
  /** STC-412: show diagnostics table. */
  showDiagnostics: boolean;
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
  devices(): Promise<{ displays?: DisplayInfo[]; mics?: MicInfo[]; stalled?: boolean; detail?: string }>;
  status(): Promise<{ state: string; pid?: number }>;
  takes(): Promise<{ takes: Take[]; invalid: { name: string; reason: string }[] }>;
  library(filter?: string): Promise<LibraryList>;
  writeThumbnail(dir: string, bytes: ArrayBuffer): Promise<boolean>;
  getFrame(dir: string, name: string): Promise<ArrayBuffer>;
  getShot(dir: string): Promise<Shot>;
  reopenStill(dir: string): Promise<{ ok: boolean }>;
  duplicateStill(dir: string): Promise<{ ok: boolean; dir: string }>;
  labelTake(dir: string, label: string): Promise<boolean>;
  deleteTake(file: string | undefined, dir: string | undefined):
    Promise<{ deleted: boolean; cancelled?: boolean; detail?: string }>;
  // The take player is its own window now (STC-373) — this opens it. Every
  // channel the old in-page player used (`openPreview`, `writeExport`,
  // `publish`, and the rest) moved to `editor-preload.ts`, the only bridge
  // that still calls them.
  openEditor(dir: string, name: string): Promise<boolean>;
  captureStill(action?: ShotAction): Promise<StillResult>;
  getShortcuts(): Promise<{ shortcuts: Shortcuts; report: ShortcutReport[] }>;
  setShortcut(action: ShotAction, accelerator: string | null):
    Promise<{ shortcuts: Shortcuts; report: ShortcutReport[] }>;
  resetShortcuts(): Promise<{ shortcuts: Shortcuts; report: ShortcutReport[] }>;
  chooseStillDestination(): Promise<{ saveFolder: string | null }>;
  /** The resolved save location — never null, never a phrase (STC-412 I1). */
  resolvedSaveFolder(): Promise<string>;
  start(): Promise<{ ok: boolean; cancelled?: boolean; dir?: string; code?: string; detail?: string }>;
  pickCaptureTarget(kind: "region" | "window"):
    Promise<{ ok: boolean; cancelled?: boolean; scope?: ScopeSettingsView }>;
  stop(): Promise<{ ok: boolean; info?: any }>;
  reveal(dir: string): Promise<void>;
  on(event: string, cb: (p: any) => void): () => void;
  /** STC-375: the pill's measured content width, fire-and-forget. */
  reportPillWidth(px: number): void;
  /** STC-412: show a warning via the toast. */
  showToast(text: string): void;
};

import { COUNTDOWN_OPTIONS } from "./countdown.js";
import {
  ACTION_LABELS, SHOT_ACTIONS, acceleratorFromKeyStroke, explainShortcut,
  formatAccelerator, parseAccelerator,
  type ShotAction, type ShortcutReport, type Shortcuts,
} from "./hotkeys.js";
import { renderLibrary, type LibraryCallbacks } from "./library-view.js";
import type { LibraryItem, LibraryList } from "./library-items.js";
import { formatElapsedTimer } from "./pill.js";
import { decorationForMode, layoutStill } from "@transform/still-decorate";
import { renderStill, sampleRedactionFills } from "@transform/still-render";
import { colorSpaceFor } from "@transform/still-export";
import type { Shot } from "@transform/shot";
import { MODEL_CODE } from "./product.js";

const $ = (id: string) => document.getElementById(id)!;
const recordBtn = $("record") as HTMLButtonElement;
const stillBtn = $("capturestill") as HTMLButtonElement;
const cameraBox = $("camera") as HTMLInputElement;
let recording = false;

// STC-399: the strip's own model plate — the bare code, no version (that is
// the About panel and the export stamp's job). Static, so no boot IIFE needed.
$("modelcode").textContent = MODEL_CODE;

// STC-375: the pill. It is only ever shown (body.pill-collapsed) while
// recording, and its one job is to be the only thing that can stop that
// recording — see index.html's #pill comment for why it must be a button.
// Sharing #record's own click handler, rather than reimplementing start/stop
// here, is what keeps there being exactly one place that decides what a
// click on "the recording is running, end it" does.
const pillBtn = $("pill") as HTMLButtonElement;
const pillTimer = $("pill-timer");
pillBtn.addEventListener("click", () => recordBtn.click());
// #pill stays laid out off-screen even while not collapsed (index.html) so
// its real content width is always measurable — this is what lets the
// window collapse to the pill's actual content-width (pill-window.ts's
// getContentWidthPx) instead of a fixed guess. Only its own content
// (the timer digit count) can change that width; a ResizeObserver reports
// it exactly when it does, rather than main polling for it.
new ResizeObserver(() => {
  recorder.reportPillWidth(Math.ceil(pillBtn.getBoundingClientRect().width));
}).observe(pillBtn);

/**
 * Opt-in, default off, sticky. The stored preference is the authority — main
 * reads it again at `start`, so this control only proposes changes.
 *
 * Disabled while recording: the helper opens the device at start and closes it
 * at stop, so a mid-take flip would misdescribe what is being recorded.
 */
void (async () => {
  try {
    cameraBox.checked = (await recorder.getSettings()).camera;
  } catch {
    cameraBox.checked = false;
  }
})();

cameraBox.addEventListener("change", async () => {
  try {
    const saved = await recorder.setSettings({ camera: cameraBox.checked });
    // Show what was actually stored, not what was clicked.
    cameraBox.checked = saved.camera;
  } catch (e) {
    cameraBox.checked = !cameraBox.checked;
    alertUser(`Could not save the camera setting: ${String(e)}`);
  }
});

/**
 * Which display to record (STC-247). "Automatic" is the phase-1 behaviour —
 * whichever display the helper lists first — and the only choice a
 * single-display machine ever needs. The list comes from the helper's own
 * `devices` enumeration, so what is offered is exactly what it can capture;
 * it is refreshed when the helper comes up and whenever a display is plugged
 * in or out while idle. A stored choice whose display is gone is shown as
 * such rather than silently dropped: `start` would then be refused with
 * `display-not-found`, and the user should see why before pressing Record.
 */
const displaySel = $("display") as HTMLSelectElement;
let storedDisplayId: number | null = null;

function displayLabel(d: DisplayInfo): string {
  const name = d.name ?? `Display ${d.id}`;
  return `${name} ${Math.round(d.pointW)}×${Math.round(d.pointH)}${d.main ? " (main)" : ""}`;
}

async function refreshDisplays(): Promise<void> {
  let displays: DisplayInfo[] = [];
  try {
    const r = await recorder.devices();
    displays = Array.isArray(r.displays) ? r.displays : [];
  } catch {
    displays = [];
  }
  const wanted = storedDisplayId;
  displaySel.replaceChildren();
  const auto = document.createElement("option");
  auto.value = ""; auto.textContent = "Automatic";
  displaySel.append(auto);
  for (const d of displays) {
    const o = document.createElement("option");
    o.value = String(d.id); o.textContent = displayLabel(d);
    displaySel.append(o);
  }
  if (wanted != null && !displays.some((d) => d.id === wanted)) {
    const o = document.createElement("option");
    o.value = String(wanted); o.textContent = `Display ${wanted} (not connected)`;
    displaySel.append(o);
  }
  displaySel.value = wanted == null ? "" : String(wanted);
}

void (async () => {
  try {
    storedDisplayId = (await recorder.getSettings()).displayId;
  } catch {
    storedDisplayId = null;
  }
  await refreshDisplays();
})();

displaySel.addEventListener("change", async () => {
  const chosen = displaySel.value === "" ? null : Number(displaySel.value);
  try {
    const saved = await recorder.setSettings({ displayId: chosen });
    // Show what was actually stored, not what was clicked.
    storedDisplayId = saved.displayId;
  } catch (e) {
    alertUser(`Could not save the display setting: ${String(e)}`);
  }
  await refreshDisplays();
});

/**
 * Which microphone to record (STC-233). "Off" is the default AND the only
 * automatic choice — unlike the display picker's "Automatic", there is no
 * safe "whichever mic is default": the settled decision (phase 0) forbids
 * taking one without the user naming it explicitly, because auto-grabbing a
 * Bluetooth mic once stalled capture and wedged CoreAudio system-wide. A
 * stored uid whose device is gone is shown as such, the same "(not
 * connected)" treatment the display picker already gives a missing display —
 * `start` would refuse that device (mic-not-found) rather than silently
 * recording another one, and the picker should not hide that before Record
 * is even pressed.
 */
const micSel = $("mic") as HTMLSelectElement;
let storedMicUid: string | null = null;

function micLabel(m: MicInfo): string {
  return m.bluetooth ? `${m.name} (Bluetooth)` : m.name;
}

async function refreshMics(): Promise<void> {
  let mics: MicInfo[] = [];
  try {
    const r = await recorder.devices();
    mics = Array.isArray(r.mics) ? r.mics : [];
  } catch {
    mics = [];
  }
  const wanted = storedMicUid;
  micSel.replaceChildren();
  const off = document.createElement("option");
  off.value = ""; off.textContent = "Off";
  micSel.append(off);
  for (const m of mics) {
    const o = document.createElement("option");
    o.value = m.uid; o.textContent = micLabel(m);
    micSel.append(o);
  }
  if (wanted != null && !mics.some((m) => m.uid === wanted)) {
    const o = document.createElement("option");
    o.value = wanted; o.textContent = "Mic (not connected)";
    micSel.append(o);
  }
  micSel.value = wanted ?? "";
}

void (async () => {
  try {
    storedMicUid = (await recorder.getSettings()).micDeviceUid;
  } catch {
    storedMicUid = null;
  }
  await refreshMics();
})();

micSel.addEventListener("change", async () => {
  const chosen = micSel.value === "" ? null : micSel.value;
  try {
    const saved = await recorder.setSettings({ micDeviceUid: chosen });
    storedMicUid = saved.micDeviceUid;
  } catch (e) {
    alertUser(`Could not save the mic setting: ${String(e)}`);
  }
  await refreshMics();
});

/**
 * What a recording captures (STC-370's region/window capability, wired to the
 * window by STC-374): Screen (the existing display picker), Window, or Area.
 * Source is a genuinely separate control from Profile — the ticket's own
 * words — but it is also separate from the SCOPE picker's own persistence:
 * changing scope never forgets a previously chosen window or area, so
 * flipping back and forth does not mean re-picking.
 */
const scopeSel = $("scope") as HTMLSelectElement;
const displayLabelEl = $("display-label");
const windowSourceEl = $("window-source");
const regionSourceEl = $("region-source");
const windowSourceLabel = $("window-source-label");
const regionSourceLabel = $("region-source-label");
const pickWindowBtn = $("pickwindow") as HTMLButtonElement;
const pickRegionBtn = $("pickregion") as HTMLButtonElement;
const clearWindowBtn = $("clearwindow") as HTMLButtonElement;
const clearRegionBtn = $("clearregion") as HTMLButtonElement;

let currentScope: ScopeSettingsView = { kind: "display", region: null, windowId: null, windowLabel: null };

/** A region or window scope with nothing picked yet cannot start a take
 * (`recorder:start` refuses it as `no-capture-target`) — reflected here too,
 * so the button is not an invitation to press it and read the refusal. */
function scopeHasTarget(): boolean {
  if (currentScope.kind === "window") return currentScope.windowId != null;
  if (currentScope.kind === "region") return currentScope.region != null;
  return true;
}

/** Shows exactly the source control the current scope needs, and keeps the
 * Record button honest about whether pressing it would do anything. */
function renderScope(): void {
  const kind = currentScope.kind;
  displayLabelEl.hidden = kind !== "display";
  windowSourceEl.hidden = kind !== "window";
  regionSourceEl.hidden = kind !== "region";
  windowSourceLabel.textContent = currentScope.windowLabel ?? "No window chosen";
  regionSourceLabel.textContent = currentScope.region
    ? `${Math.round(currentScope.region.width)} × ${Math.round(currentScope.region.height)}`
    : "No area chosen";
  // Clearing an already-empty pick is a no-op the button should not invite —
  // the STC-374 runbook's finding was that there was no way BACK to this
  // state at all, not that the button needed to always be live.
  if (!recording) {
    clearWindowBtn.disabled = currentScope.windowId == null;
    clearRegionBtn.disabled = currentScope.region == null;
    recordBtn.disabled = !scopeHasTarget();
  }
}

/** Forgets a chosen window or area without opening the picker — the gap the
 * STC-374 runbook found: `kind` stays put (Window/Area scope does not fall
 * back to Screen), only the target and its cosmetic label reset. */
async function clearSource(kind: "region" | "window"): Promise<void> {
  const patch = kind === "region"
    ? { region: null }
    : { windowId: null, windowLabel: null };
  try {
    const saved = await recorder.setSettings({ scope: { ...currentScope, ...patch } });
    currentScope = saved.scope;
  } catch (e) {
    alertUser(`Could not clear the ${kind === "region" ? "area" : "window"}: ${String(e)}`);
  }
  renderScope();
}
clearWindowBtn.addEventListener("click", () => void clearSource("window"));
clearRegionBtn.addEventListener("click", () => void clearSource("region"));

scopeSel.addEventListener("change", async () => {
  const kind = scopeSel.value as ScopeSettingsView["kind"];
  try {
    const saved = await recorder.setSettings({ scope: { ...currentScope, kind } });
    currentScope = saved.scope;
  } catch (e) {
    alertUser(`Could not save the scope: ${String(e)}`);
  }
  scopeSel.value = currentScope.kind;
  renderScope();
});

/**
 * Opens the same overlay `capture-still`'s region/window actions use, but to
 * PICK what a recording will scope to rather than to capture anything —
 * confirming stores the choice as a sticky preference (main-side) and this
 * only reflects what came back.
 */
async function pickSource(kind: "region" | "window"): Promise<void> {
  const btn = kind === "region" ? pickRegionBtn : pickWindowBtn;
  btn.disabled = true;
  try {
    const r = await recorder.pickCaptureTarget(kind);
    if (r.ok && r.scope) currentScope = r.scope;
  } catch (e: any) {
    alertUser(`Could not choose a ${kind === "region" ? "area" : "window"}: ${e?.message ?? e}`);
  } finally {
    btn.disabled = false;
    renderScope();
  }
}
pickWindowBtn.addEventListener("click", () => void pickSource("window"));
pickRegionBtn.addEventListener("click", () => void pickSource("region"));

void (async () => {
  try {
    currentScope = (await recorder.getSettings()).scope;
  } catch {
    // The default (display, automatic) already applies.
  }
  scopeSel.value = currentScope.kind;
  renderScope();
})();

/** The camera, display and scope are fixed at start and released at stop, so
 * none may look changeable mid-take. */
function lockSettings(locked: boolean): void {
  cameraBox.disabled = locked;
  displaySel.disabled = locked;
  micSel.disabled = locked;
  scopeSel.disabled = locked;
  pickWindowBtn.disabled = locked;
  pickRegionBtn.disabled = locked;
  // Locked, these stay disabled outright; unlocked, renderScope() puts them
  // back to whatever "is there something to clear" actually says.
  if (locked) { clearWindowBtn.disabled = true; clearRegionBtn.disabled = true; }
  else renderScope();
}
// ---- profile sheet (STC-374) ------------------------------------------------
//
// "A panel inside this window, not a fourth window" — still-capture
// preferences and the shortcuts editor moved here from the main flow.
// Escape closing it is safe alongside the shortcuts editor's own Escape
// handling below: that handler runs in the CAPTURE phase and calls
// `stopImmediatePropagation` whenever a shortcut is being listened for, so
// this bubble-phase listener never sees the keystroke in that case.
const profileBtn = $("settings") as HTMLButtonElement;
const profileSheet = $("profilesheet");
const profileCloseBtn = $("profileclose") as HTMLButtonElement;

function setProfileOpen(open: boolean): void {
  profileSheet.classList.toggle("open", open);
}
profileBtn.addEventListener("click", () => setProfileOpen(!profileSheet.classList.contains("open")));
profileCloseBtn.addEventListener("click", () => setProfileOpen(false));
document.addEventListener("keydown", (e) => {
  if (e.code === "Escape") setProfileOpen(false);
});

let currentDir: string | undefined;

function setState(text: string): void { $("state").textContent = text; }
function alertUser(text: string): void { recorder.showToast(text); }
function stillStatus(text?: string): void {
  const el = $("stillstatus");
  if (!text) { el.setAttribute("hidden", ""); el.textContent = ""; return; }
  el.textContent = text;
  el.removeAttribute("hidden");
}

const KIND_WORDS: Record<string, string> = {
  region: "area", window: "window", display: "full display",
};

/**
 * Say what a capture did, wherever it came from.
 *
 * Shared by the button and by `still:captured`, which is how a hotkey or
 * menu-bar capture reaches an open window (STC-292). One function because the
 * two must not drift: a shot taken by hotkey is the same shot, and reporting it
 * differently would make the window's account of the take library depend on
 * which door the user came through.
 */
async function reportStill(r: StillResult): Promise<void> {
  if (r.cancelled) return;
  if (!r.ok) {
    alertUser(r.code === "no-displays"
      ? "Screen Recording permission is required.\nGrant it in System Settings › Privacy & Security › Screen & System Audio Recording, then try again."
      : r.code === "still-unsupported"
      ? "Shots need macOS 14 or newer."
      : r.code === "overlay-open"
      ? "A shot is already in progress."
      : `Could not take the shot: ${r.code}\n${r.detail ?? ""}`);
    return;
  }
  const px = r.shot?.frame ? `${r.shot.frame.width} × ${r.shot.frame.height}` : "";
  stillStatus(`Shot ${KIND_WORDS[r.kind ?? ""] ?? ""} ${px} → ${r.dir?.split("/").pop() ?? ""}`.replace(/\s+/g, " "));
  if (r.warning) alertUser(r.warning);
  await refreshTakes();
  // The floating thumbnail (STC-296) is presented from the MAIN process, not
  // from here: a capture from the global hotkey or the menu bar has no window
  // waiting on this function at all, and the panel has to appear either way.
  // This function's job is only to keep an OPEN window's own account (the
  // status line, the take list) truthful about a capture it did not ask for.
}

/**
 * Capture a still (STC-290). The overlay owns the whole interaction, so there
 * is nothing to do here but ask for it and say what came back.
 *
 * The button is disabled for the duration: the overlay is modal in effect —
 * it covers every display — and a second press behind it would queue a second
 * capture the user cannot see themselves asking for. Cancelling is a normal
 * outcome and says nothing, the way dismissing macOS's own crosshair does.
 */
stillBtn.addEventListener("click", async () => {
  stillBtn.disabled = true;
  stillStatus();
  try {
    await reportStill(await recorder.captureStill("region"));
  } catch (e: any) {
    alertUser(`Could not take the shot: ${e?.message ?? e}`);
  } finally {
    stillBtn.disabled = false;
  }
});

// A capture that started somewhere this window was not: a global hotkey or the
// menu bar. The shot is on disk whether or not anyone is watching — this only
// keeps an open window from showing a stale take list and no explanation.
recorder.on("still:captured", (r: StillResult) => { void reportStill(r); });

/**
 * Why a take did not start, said in terms of what it costs and what to do.
 *
 * A map rather than the ternary chain this replaced: there are two permission
 * refusals now, they read almost identically to a user ("something about
 * privacy settings"), and they send you to DIFFERENT panes. A chain that grows
 * one arm per grant is how the second one ends up phrased as an afterthought
 * of the first.
 *
 * Neither says "try again" without saying what to change first — a start that
 * refused for a missing grant will refuse identically until the grant exists,
 * and inviting a retry is how someone presses Record four times and concludes
 * the app is broken.
 */
const START_FAULTS: Record<string, string> = {
  // Belt to `scopeHasTarget`'s brace: the button is disabled whenever this
  // would fire, so reaching it at all means something else changed the scope
  // between disabling and pressing — still worth a real message rather than
  // a raw error code.
  "no-capture-target": "Choose a window or an area to record before pressing Record.",
  // STC-391: a shot is mid-flight — most likely a self-timer, which
  // now spends seconds waiting with this window still live and pressable.
  "capture-in-flight":
    "A shot is already in progress. Finish or cancel it, then press Record.",
  "no-displays":
    "Screen Recording permission is required.\nGrant it in System Settings › " +
    "Privacy & Security › Screen & System Audio Recording, then try again.",
  // STC-315. This used to be a WARNING, arriving after the take was already
  // running: the recording went ahead with no cursor track at all, and since
  // the pixels never carry a pointer (the transform draws it from events.json)
  // the resulting file looked like every other take and had no cursor
  // anywhere. It is a refusal now — nothing was recorded — so the sentence has
  // to say that first, before the fix, or a user reads "grant this" and
  // assumes the take they just made is fine.
  //
  // The wording changed once macOS was WATCHED doing this (2026-09-09, on
  // hardware after `tccutil reset ListenEvent`). Two things were wrong with
  // the first draft, and both were guesses this file could not check from
  // Linux:
  //
  // (1) It assumed `tapCreate` fails SILENTLY and sent the reader to System
  //     Settings. It does not — macOS raises its own Input Monitoring prompt.
  //     So the first refusal a user ever sees usually has a dialog on screen
  //     next to it, and a message that ignores that sends them hunting through
  //     Settings for something they could have answered in place.
  //
  // (2) That prompt says "receive KEYSTROKES from any application". This app
  //     has never recorded a keypress — the tap's mask is mouse-only, and
  //     STC-327 exists precisely because nothing here captures keyboard input
  //     — but macOS's dialog is generic and cannot say so. Somebody reading
  //     that for a screen recorder has every reason to click Deny, and until
  //     now nothing told them otherwise. Naming the discrepancy is not
  //     reassurance for its own sake: it is the difference between a grant
  //     that gets given and one that gets refused for a sound reason.
  //
  // "Quit and reopen" rather than "press Record again", deliberately. Input
  // Monitoring commonly needs the granted process restarted, and that has NOT
  // been observed for THIS app: the runs that established the prompt went
  // through the terminal (which is the granted identity for a directly-spawned
  // helper), and `npm run app:start` makes the app a child of the terminal and
  // resolves to its grants too — STC-292's runbook already records that trap.
  // Only a bundle launched via `open` can settle it. So the instruction is the
  // one that is sufficient in EITHER case rather than the shorter one that
  // might send someone in a circle.
  "event-tap-unavailable":
    "Nothing was recorded — the take did not start.\n\nThe recorder could not " +
    "watch your mouse, and the cursor is never captured in the video itself: it " +
    "is drawn afterwards from what the tap records. A take without it would have " +
    "no cursor at all, so it is refused rather than made.\n\nmacOS may have just " +
    "asked to allow this — its dialog says \"keystrokes\", but this app records " +
    "mouse movement and clicks only, and never what you type.\n\nAllow it, or " +
    "tick the recorder under System Settings › Privacy & Security › Input " +
    "Monitoring. Then quit and reopen the recorder and press Record.",
};

recordBtn.addEventListener("click", async () => {
  recordBtn.disabled = true;
  try {
    if (!recording) {
      const r = await recorder.start();
      // STC-391: Escape (or Cancel) during the countdown. Not a failure and
      // not an alert — the user asked for nothing to happen, and telling them
      // so would be the app arguing with them. Same reasoning a cancelled
      // still selection has never produced a message.
      if (!r.ok && r.cancelled) {
        setState("idle");
      } else if (!r.ok) {
        alertUser(START_FAULTS[String(r.code)] ?? `Could not start: ${r.code}\n${r.detail ?? ""}`);
        setState("idle");
      } else {
        recording = true;
        // Reset per take, and say "opening…" rather than "—": the camera opens
        // off the critical path, so there IS a window where it is neither
        // absent nor live, and that window is the whole complaint (STC-287).
        setCamera(cameraBox.checked ? "opening…" : "off");
        setMic(storedMicUid != null ? "opening…" : "off");
      // The device is opened at start and closed at stop, so the setting must
      // not appear changeable mid-take — it would misdescribe the recording.
      lockSettings(true);
        currentDir = r.dir;
        recordBtn.textContent = "Stop";
        setState("recording");
      }
    } else {
      await recorder.stop();
      recording = false;
      lockSettings(false);
      recordBtn.textContent = "Record";
      setState("idle");
      await refreshTakes();
    }
  } catch (e: any) {
    alertUser(String(e?.message ?? e));
  } finally {
    recordBtn.disabled = false;
  }
});

recorder.on("helper:ready", (l) => {
  $("pid").textContent = String(l.pid ?? "—");
  // A (re)started helper can enumerate; a respawned one may see a different
  // set of displays (or mics) than the last one did.
  void refreshDisplays();
  void refreshMics();
  if (!recording) setState("idle");
  // Not unconditionally `false`: a window or area scope with nothing picked
  // yet must stay disabled through a helper respawn, the same as it is on
  // first load.
  if (!recording) recordBtn.disabled = !scopeHasTarget();
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
  $("elapsed").textContent = s.elapsedMs != null ? `${(s.elapsedMs / 1000).toFixed(1)}s` : "—";
  // The pill's own timer (STC-375) — same heartbeat, same elapsedMs, just
  // formatted the way a small always-on-top strip needs rather than the
  // debug table's one-decimal seconds. Harmless to update while #pill is
  // off-screen: it is what makes "digit count changed" something the
  // ResizeObserver above can ever see.
  if (s.elapsedMs != null) pillTimer.textContent = formatElapsedTimer(s.elapsedMs);
});

/**
 * Why the helper ended a take on its own, in the user's terms. Anything not
 * named here is shown by its reason code rather than dropped.
 */
const ENDED_BY_HELPER: Record<string, string> = {
  "display-reconfigured": "Display configuration changed, so the recording was stopped.",
  // STC-306: SCStream reported itself dead under a live take. The helper
  // stops cleanly rather than sitting in "recording" with no frames arriving.
  "stream-stopped": "The display capture stopped unexpectedly, so the recording was stopped.",
};

recorder.on("helper:recording-ended", (i) => {
  // The helper stopped by itself — a display change, or a display stream that
  // died. The file is valid; what would be wrong is leaving the button saying
  // "Stop".
  recording = false;
  recordBtn.textContent = "Record";
  setState("idle");
  refreshTakes();
  const why = ENDED_BY_HELPER[String(i.reason)] ?? `Recording stopped by the recorder (${i.reason}).`;
  alertUser(`${why}\nWhat was captured up to that point was saved.`);
  if (i.dir) recorder.reveal(i.dir);
});

recorder.on("helper:recording-lost", (i) => {
  recording = false;
  recordBtn.textContent = "Record";
  setState("idle");
  alertUser(`The recorder quit while recording — that take was not saved.\n${i.dir ?? ""}`);
});

/**
 * STC-287: the camera's whole lifecycle used to be invisible.
 *
 * It opens off the critical path (Capture.swift, deliberately — startRunning()
 * blocks and must not delay every `started` reply), so it goes live roughly a
 * second after recording begins. Measured across five real takes, the PiP is
 * absent for 1.26–1.39 s of playback.
 *
 * The helper has always announced this — `camera-started` with the device name,
 * and warnings for every failure. Nothing listened. So a user who ticked Camera
 * got no confirmation it worked, no notice when it did NOT, and a PiP that
 * appeared a beat late and read as a glitch. The gap is inherent; being unable
 * to tell a working camera from a broken one was not.
 *
 * `#camera-state` (and `#mic-state`) live OUTSIDE `#diagnostics` in
 * `index.html` for exactly that reason — STC-412 Task 4 put the debug table
 * behind a preference that is off by default, and these two rows were never
 * debug output: they are the persistent half of the pair described at
 * `helper:warning` below, and the only thing left on screen once the warning
 * toast has taken itself away.
 */
function setCamera(text: string): void { $("camera-state").textContent = text; }

recorder.on("helper:camera-started", (l) => {
  setCamera(String(l.device ?? "live"));
});

/** STC-233: the mic's own lifecycle readout, same reasoning as the camera's. */
function setMic(text: string): void { $("mic-state").textContent = text; }

recorder.on("helper:mic-started", (l) => {
  setMic(String(l.device ?? "live"));
});

recorder.on("helper:respawned", () => setState("recovered — helper restarted"));
recorder.on("helper:gave-up", () => { recordBtn.disabled = true; alertUser("The recorder keeps failing to start. Restart the app."); });

// STC-375: the window just collapsed to the pill, or restored from it. With
// no listener the page never learns its own window shrank, and lays out the
// full instrument UI into a 26px viewport — visibly clipped controls, not a
// pill. `body.pill-collapsed` (index.html) hides everything in favour of a
// plain dark strip.
recorder.on("pill:state", (s: { collapsed: boolean }) => {
  document.body.classList.toggle("pill-collapsed", s.collapsed);
});
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
  "device-disconnected": "A capture device was disconnected during the recording.",
  // STC-286. The one that looked exactly like success: the camera opens,
  // reports its name, and delivers nothing. Confirmed in clamshell on real
  // hardware — camera-started with "FaceTime HD Camera", then a 0-byte
  // camera.mp4. Until this warning existed the app showed the device name for
  // the whole take and only admitted the truth afterwards, in the library.
  "camera-no-frames":
    "The camera opened but is not sending any frames, so this take will have no " +
    "picture-in-picture. A closed laptop lid, a covered lens, or another app using " +
    "the camera all look like this.",
};

/**
 * STC-233: the mic's own failures, same shape as CAMERA_FAULTS and the same
 * reason — every one of these was already emitted by the helper and would
 * otherwise be silently dropped by the generic handler below.
 */
const MIC_FAULTS: Record<string, string> = {
  "mic-not-found": "The chosen microphone is no longer available, so this take has no audio.",
  "mic-not-authorized": "Microphone access is not authorized, so this take has no audio.",
  "mic-format-unavailable": "The chosen microphone reported no usable audio format, so this take has no audio.",
  "mic-device-input-failed": "The microphone could not be opened, so this take has no audio.",
  "mic-input-refused": "The microphone could not be opened, so this take has no audio.",
  "mic-writer-failed": "Recording the microphone failed, so this take has no audio.",
  "mic-no-frames":
    "The microphone opened but is not sending any audio, so this take will have no " +
    "sound. Another app holding the device is the usual cause.",
};

/**
 * Warnings that are not about the camera but still decide whether a take is
 * what the user thinks it is.
 *
 * `event-tap-unavailable` used to be the entry that mattered most here and is
 * deliberately NOT one any more: since STC-315 a take that cannot record the
 * cursor does not start, so the helper answers the `start` request with that
 * code instead of warning about a recording already underway. Its wording
 * lives in START_FAULTS, where it can say "nothing was recorded" — which is
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
  "stream-stopped":
    "The display capture stopped unexpectedly, so the recording is being stopped. " +
    "What was captured up to this point is kept.",
  "av-runtime-error": "A capture device reported an error during the recording.",
};

/**
 * Emitted by the helper's watchers whenever ANY display changes, recording or
 * not. While recording it is accompanied by display-change-during-recording,
 * which is the one that says what happened to the take; alone it is an idle
 * machine's monitor being plugged in, and not worth an alert.
 */
const INFORMATIONAL_WARNINGS = new Set(["display-reconfigured"]);

recorder.on("helper:warning", (l) => {
  const code = String(l.code);
  if (code === "display-change-during-recording") {
    alertUser("Display configuration changed — the recording was stopped.");
    return;
  }
  if (INFORMATIONAL_WARNINGS.has(code)) {
    // An idle display change is not an alert, but it is a new list of
    // displays; the picker must not go on offering one that was unplugged.
    if (code === "display-reconfigured") void refreshDisplays();
    return;
  }
  const camera = CAMERA_FAULTS[code];
  if (camera) {
    // Both: the row is the at-a-glance state, the alert is the thing that
    // cannot be missed. A silent failure is what this whole change exists to
    // remove. "no frames" is not the same as "failed to open", and the row
    // said the device name right up until this fired. Name the state, not
    // just the code.
    //
    // The two halves are now more different than they were, which is why the
    // row has to be always-visible (STC-412 final review, I2): the alert is a
    // toast that dismisses itself, so the row is the ONLY thing that still
    // says "this take had no camera" a minute later.
    setCamera(code === "camera-no-frames" ? "no frames" : `failed — ${code}`);
    alertUser(l.detail ? `${camera}\n\n${l.detail}` : camera);
    return;
  }
  const mic = MIC_FAULTS[code];
  if (mic) {
    setMic(code === "mic-no-frames" ? "no frames" : `failed — ${code}`);
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

/**
 * The save location, as a real path — always, whether or not one was ever
 * chosen (STC-412 final review, I1).
 *
 * This used to be `showDestination(dest ?? "beside the shot")`, reading
 * `saveFolder` straight off the settings and rendering null as a phrase. Both
 * halves were wrong once STC-412 unified the setting: "beside the shot"
 * described `still.destination`'s per-shot fallback, which no longer exists,
 * and a null `saveFolder` is not "nowhere chosen yet" — it resolves to a real
 * directory this process is already writing takes into. So it is asked for
 * rather than derived: main answers with `takesRoot`'s own output, the same
 * function that decides where the files actually go.
 */
async function refreshDestination(): Promise<void> {
  $("stilldest").textContent = await recorder.resolvedSaveFolder();
}

const thumbCornerSel = $("thumbcorner") as HTMLSelectElement;
const thumbSkipBox = $("thumbskip") as HTMLInputElement;
const showDiagnosticsBox = $("showdiagnostics") as HTMLInputElement;
const diagnosticsTable = $("diagnostics") as HTMLTableElement;
const countdownSel = $("countdownms") as HTMLSelectElement;

// Built from the module that owns the clamp, never hand-listed in the markup
// (STC-391) — an option the stored value could not hold would otherwise look
// like a control that silently snaps back.
for (const { ms, label } of COUNTDOWN_OPTIONS) {
  const opt = document.createElement("option");
  opt.value = String(ms);
  opt.textContent = label;
  countdownSel.append(opt);
}

async function loadStillPreferences(): Promise<void> {
  const { thumbnail, countdownMs, showDiagnostics } = await recorder.getSettings();
  thumbCornerSel.value = thumbnail.corner;
  thumbSkipBox.checked = thumbnail.skip;
  showDiagnosticsBox.checked = showDiagnostics;
  diagnosticsTable.hidden = !showDiagnostics;
  // A stored value that is not one of the offered options — 0, or a number
  // someone typed into the file — leaves the select showing nothing rather
  // than silently misreporting itself as 3 seconds.
  countdownSel.value = COUNTDOWN_OPTIONS.some((o) => o.ms === countdownMs)
    ? String(countdownMs) : "";
  // LAST, and deliberately: this one is a second IPC round trip rather than a
  // field of the settings already in hand, and the whole function is called
  // as `void … .catch(() => {})`. Put first, a failure here would leave every
  // control below it unset for a reason that has nothing to do with them.
  await refreshDestination();
}

/** Every control here changes ONE field; the rest of `thumbnail` is read fresh and kept. */
async function patchThumbnail(patch: Partial<AppSettings["thumbnail"]>): Promise<void> {
  const current = (await recorder.getSettings()).thumbnail;
  await recorder.setSettings({ thumbnail: { ...current, ...patch } });
}

$("stillchoosedest").addEventListener("click", async () => {
  // The picker's own reply is deliberately not what is displayed: a cancel
  // answers with the CURRENT `saveFolder`, which is null on an untouched
  // install, and re-deriving a path from that here is the second computation
  // of the default `refreshDestination` exists to avoid.
  await recorder.chooseStillDestination();
  await refreshDestination();
});
thumbCornerSel.addEventListener("change", () => {
  void patchThumbnail({ corner: thumbCornerSel.value as AppSettings["thumbnail"]["corner"] });
});
thumbSkipBox.addEventListener("change", () => void patchThumbnail({ skip: thumbSkipBox.checked }));
showDiagnosticsBox.addEventListener("change", async () => {
  diagnosticsTable.hidden = !showDiagnosticsBox.checked;
  await recorder.setSettings({ showDiagnostics: showDiagnosticsBox.checked });
});
countdownSel.addEventListener("change", () => {
  // `countdownMs` is a top-level preference rather than a block, so it needs
  // no read-merge-write the way `thumbnail` does — `writeSettings` merges it
  // over what is stored and clamps it on the way in.
  const ms = Number(countdownSel.value);
  if (Number.isFinite(ms)) void recorder.setSettings({ countdownMs: ms });
});

// ---- library -------------------------------------------------------------

/** Which kind filter is showing. The adapter validates it; this only remembers it. */
let libraryFilter = "all";

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
    renderStill(ctx as never, { frame, redactionFills: fills }, layout);

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
        if (r.deleted) { await refreshTakes(); }
        // A Cancel is a decision, not a fault (`trashWithConfirmation`'s own
        // rule) — say nothing. A REAL failure used to reach nobody: this
        // action's own `detail` was discarded before STC-300's revision
        // removed the only other door (the post-capture panel's "confirm"
        // Trash) that ever surfaced one.
        else if (!r.cancelled) alertUser(r.detail ?? "Could not delete this take.");
      }
    } catch (e: any) { alertUser(String(e?.message ?? e)); }
  },
  async rename(item, label) {
    // Renaming a FILE (Task 13) is not built yet — for now the adapter only
    // ever offers "rename" on an item with a bundle (`take.json` needs a
    // directory to live beside), so this is a structural guard, not a
    // feature gap this task is meant to close.
    const dir = item.dir;
    if (!dir) return;
    try { await recorder.labelTake(dir, label); await refreshTakes(); }
    catch (e: any) { alertUser(String(e?.message ?? e)); }
  },
  async setFilter(id) { libraryFilter = id; await refreshTakes(); },
  async paintThumbnail(item, img) {
    if (item.thumbnail.source === "file") {
      await showCachedThumbnail(item, img, item.thumbnail.file);
    } else if (item.thumbnail.source === "render") {
      await renderThumbnail(item, img);
    }
  },
};

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

async function refreshTakes(): Promise<void> {
  const list = await recorder.library(libraryFilter);
  libraryFilter = list.filter;
  renderLibrary($("takes"), list, libraryCallbacks);
}


recorder.status().then((s) => {
  setState(s.state);
  if (s.pid) $("pid").textContent = String(s.pid);
  // A helper that could not be spawned at all fails in milliseconds — every
  // restart the supervisor allows has already been used up before this page
  // exists, so the gave-up event above was emitted to nobody. Read the state
  // instead of relying on having been there when it changed.
  if (s.state === "failed") {
    recordBtn.disabled = true;
    alertUser("The recorder keeps failing to start. Restart the app.");
  }
});
refreshTakes();

// ---- capture shortcuts (STC-292) ------------------------------------------
//
// Rebinding, and the one thing the ticket asks for that a silent failure would
// ruin: a shortcut that did not bind must SAY so. The grammar, the reserved
// list and the wording all live in `hotkeys.ts` — this draws the answer and
// records keystrokes, and decides nothing on its own.

const shortcutList = $("shortcuts");
let shortcutState: { shortcuts: Shortcuts; report: ShortcutReport[] } | undefined;
/** Which row is waiting for a keystroke, if any. */
let listening: ShotAction | undefined;

function reportFor(action: ShotAction): ShortcutReport | undefined {
  return shortcutState?.report.find((r) => r.action === action);
}

function renderShortcuts(): void {
  shortcutList.replaceChildren();
  for (const action of SHOT_ACTIONS) {
    const row = document.createElement("div");
    row.className = "shortcut";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = ACTION_LABELS[action];

    const keys = document.createElement("button");
    keys.className = "keys";
    keys.id = `shortcut-${action}`;
    const bound = shortcutState?.shortcuts[action] ?? null;
    keys.textContent = listening === action ? "Press keys…" : formatAccelerator(bound);
    if (listening === action) keys.classList.add("listening");
    keys.addEventListener("click", () => {
      listening = listening === action ? undefined : action;
      renderShortcuts();
    });

    const clear = document.createElement("button");
    clear.className = "clear";
    clear.textContent = "Clear";
    clear.disabled = bound == null;
    clear.addEventListener("click", () => { void applyShortcut(action, null); });

    const why = document.createElement("span");
    why.className = "why";
    why.id = `shortcutwhy-${action}`;
    const r = reportFor(action);
    const message = r ? explainShortcut(r) : undefined;
    if (message) why.textContent = message;
    else if (r?.registered) { why.textContent = "Active"; why.classList.add("ok"); }

    row.append(name, keys, clear, why);
    shortcutList.append(row);
  }
}

async function applyShortcut(action: ShotAction, accelerator: string | null): Promise<void> {
  listening = undefined;
  try {
    shortcutState = await recorder.setShortcut(action, accelerator);
  } catch (e) {
    alertUser(`Could not set that shortcut: ${String(e)}`);
  }
  renderShortcuts();
}

/**
 * Records the chord.
 *
 * Capture phase and `stopImmediatePropagation` because the preview's own
 * ⌘⇧C / ⌘⇧S bindings are listening on the same document, and a user binding a
 * capture shortcut must not also trigger one. `code` rather than `key`: on
 * macOS ⌥⇧1 arrives as an unrelated glyph, so a layout-independent name is the
 * only one that can be replayed as an accelerator.
 *
 * A press that is only modifiers is not an answer — the chord is still being
 * pressed — so the field keeps waiting rather than binding ⌘ on its own.
 */
document.addEventListener("keydown", (e) => {
  if (!listening) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.code === "Escape") { listening = undefined; renderShortcuts(); return; }
  const accelerator = acceleratorFromKeyStroke({
    code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey,
    altKey: e.altKey, shiftKey: e.shiftKey,
  });
  if (accelerator === null) return;
  const action = listening;
  // Checked here as well as in main so the field can refuse instantly, without
  // a round trip that would briefly show the binding as accepted.
  const parsed = parseAccelerator(accelerator);
  if (!parsed.ok) {
    listening = undefined;
    shortcutState = shortcutState && {
      shortcuts: shortcutState.shortcuts,
      report: shortcutState.report.map((r) => r.action === action
        ? { ...r, accelerator, problem: parsed.problem, registered: false,
            ...(parsed.token ? { token: parsed.token } : {}) }
        : r),
    };
    renderShortcuts();
    return;
  }
  void applyShortcut(action, parsed.accelerator);
}, true);

/**
 * Whether a capture makes a noise.
 *
 * Here rather than only in System Settings because a capture started by a
 * hotkey is the one the sound exists for, and someone who wants it quiet
 * should not have to know that macOS keeps the switch under "Play user
 * interface sound effects". It only ever silences: ticked, the sound still
 * follows the Mac's own setting and alert volume.
 */
const shutterBox = $("shuttersound") as HTMLInputElement;

void (async () => {
  try {
    shutterBox.checked = (await recorder.getSettings()).shutterSound;
  } catch {
    // The default is ON, so a failed read must not present as silence.
    shutterBox.checked = true;
  }
})();

shutterBox.addEventListener("change", async () => {
  try {
    // Show what was actually stored, not what was clicked.
    shutterBox.checked = (await recorder.setSettings({ shutterSound: shutterBox.checked })).shutterSound;
  } catch (e) {
    shutterBox.checked = !shutterBox.checked;
    alertUser(`Could not save the shutter sound setting: ${String(e)}`);
  }
});

($("resetshortcuts") as HTMLButtonElement).addEventListener("click", async () => {
  listening = undefined;
  try {
    shortcutState = await recorder.resetShortcuts();
  } catch (e) {
    alertUser(`Could not restore the default shortcuts: ${String(e)}`);
  }
  renderShortcuts();
});

void (async () => {
  try {
    shortcutState = await recorder.getShortcuts();
  } catch {
    shortcutState = undefined;
  }
  renderShortcuts();
})();

void loadStillPreferences().catch(() => {});
