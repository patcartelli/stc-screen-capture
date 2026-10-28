/**
 * The Settings window (STC-581): five panes in a sidebar window, built to
 * Capture SK 016's Settings frames. Every control here was in the library
 * window's slide-over sheet before; what each one writes, and through which
 * handler, is unchanged. Only where it lives and how it looks moved.
 *
 * Decides nothing about the values themselves: the option lists come from the
 * modules that own their validators (countdown.ts, gif-options.ts,
 * icon-placement.ts, hotkeys.ts), and what a camera control MEANS is
 * pip-style.ts's `editPipStyle`.
 */
import { COUNTDOWN_OPTIONS } from "./countdown.js";
import { ICON_PLACEMENTS, ICON_PLACEMENT_LABELS, cleanIconPlacement, type IconPlacement } from "./icon-placement.js";
import {
  ACTION_LABELS, BINDABLE_ACTIONS, OUTCOME_LABELS, acceleratorFromKeyStroke, explainShortcut, explainVariant,
  formatAccelerator, parseAccelerator,
  type BindableAction, type ShortcutReport, type Shortcuts,
} from "./hotkeys.js";
import { type GifSettings, GIF_FPS_OPTIONS, GIF_WIDTH_OPTIONS } from "@transform/gif-options";
import {
  editPipStyle, pipRect, pipSize, snapCenter, PIP_SNAP_THRESHOLD_SCREEN_PX, PIP_SHADOW,
  PIP_RADIUS_MAX, PIP_WIDTH_MIN, PIP_WIDTH_MAX, type PipEdit, type PipStyle,
} from "@transform/pip-style.js";
import type { ToastInput } from "./toast-message.js";
import { buildDropdown } from "./settings-dropdown.js";

interface SettingsView {
  shutterSound: boolean;
  pipStyle: PipStyle;
  countdownMs: number;
  thumbnail: { corner: "top-left" | "top-right" | "bottom-left" | "bottom-right"; skip: boolean };
  showDiagnostics: boolean;
  iconPlacement: IconPlacement;
  share: { destination: string | null };
  gif: GifSettings;
}
type ShortcutState = { shortcuts: Shortcuts; report: ShortcutReport[] };

declare const settingsBridge: {
  getSettings(): Promise<SettingsView>;
  setSettings(p: Partial<SettingsView>): Promise<SettingsView>;
  getShortcuts(): Promise<ShortcutState>;
  setShortcut(action: BindableAction, accelerator: string | null): Promise<ShortcutState>;
  resetShortcuts(): Promise<ShortcutState>;
  chooseStillDestination(): Promise<unknown>;
  chooseShareDestination(): Promise<unknown>;
  resolvedSaveFolder(): Promise<string>;
  reclaimSpace(): Promise<unknown>;
  showToast(message: ToastInput): void;
  on(event: string, cb: (p: any) => void): () => void;
};

const $ = (id: string) => document.getElementById(id)!;
const bridge = settingsBridge;
const alertUser = (message: string) => bridge.showToast(message);

/**
 * Write one preference. A control may already show the new value; if the write
 * fails, say so and draw every control from what main actually holds again.
 */
async function save(what: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (e) {
    alertUser(`Could not save ${what}: ${String(e)}`);
    await loadSettings().catch(() => {});
  }
}

// ---- panes ------------------------------------------------------------------

const PANES = ["capture", "camera", "shortcuts", "output", "advanced"] as const;
type Pane = (typeof PANES)[number];
const PANE_TITLES: Record<Pane, string> = {
  capture: "Capture", camera: "Camera", shortcuts: "Shortcuts", output: "Output", advanced: "Advanced",
};
const isPane = (v: unknown): v is Pane => typeof v === "string" && (PANES as readonly string[]).includes(v);

function showPane(pane: Pane): void {
  for (const p of PANES) $(`pane-${p}`).hidden = p !== pane;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#sidebar button")) {
    const current = b.dataset.pane === pane;
    if (current) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
    // One Tab stop, on the pane being shown (STC-595); the arrows do the rest.
    b.tabIndex = current ? 0 : -1;
  }
  $("titlebar").textContent = PANE_TITLES[pane];
  document.title = `${PANE_TITLES[pane]} – Settings`;
  $("panes").scrollTop = 0;
  if (pane === "camera") drawPip();
}
for (const b of document.querySelectorAll<HTMLButtonElement>("#sidebar button")) {
  b.addEventListener("click", () => { if (isPane(b.dataset.pane)) showPane(b.dataset.pane); });
}
/**
 * ↑/↓ move through the sidebar and show each pane as they reach it, as a
 * macOS sidebar does (STC-595, Patrick 2026-10-28); Home and End go to the
 * first and last. It stops at either end rather than wrapping.
 */
$("sidebar").addEventListener("keydown", (e) => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("#sidebar button")];
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
  const to = e.key === "ArrowDown" ? Math.min(i + 1, buttons.length - 1)
    : e.key === "ArrowUp" ? Math.max(i - 1, 0)
      : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -1;
  if (to < 0) return;
  e.preventDefault();
  const b = buttons[to]!;
  if (isPane(b.dataset.pane)) showPane(b.dataset.pane);
  b.focus();
});
const params = new URLSearchParams(location.search);
showPane("capture");

// Reduce Transparency (STC-586): main reads nativeTheme and says so.
document.body.classList.toggle("reduce-transparency", params.get("reduceTransparency") === "1");
bridge.on("settings:reduced-transparency", (on: boolean) => {
  document.body.classList.toggle("reduce-transparency", on === true);
});

// ---- small controls -----------------------------------------------------------

/**
 * A segmented control's buttons, `data-value` keyed. Draws the selection, and
 * makes the group one Tab stop on the chosen button (the radio pattern,
 * STC-587); with nothing chosen the first takes the stop.
 */
function markSegment(group: HTMLElement, value: string): void {
  const buttons = [...group.querySelectorAll<HTMLButtonElement>("button")];
  for (const b of buttons) {
    b.setAttribute("aria-checked", String((b.dataset.value ?? b.dataset.pipShape) === value));
  }
  const stop = buttons.find((b) => b.getAttribute("aria-checked") === "true") ?? buttons[0];
  for (const b of buttons) b.tabIndex = b === stop ? 0 : -1;
}

/**
 * Arrow keys move through a segmented control and choose as they go, as
 * native radios do; Home and End go to either end. Choosing is the button's
 * own click, so the keyboard and the pointer take one path.
 */
function wireSegmentKeys(group: HTMLElement): void {
  group.addEventListener("keydown", (e) => {
    const buttons = [...group.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % buttons.length
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + buttons.length) % buttons.length
        : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -1;
    const to = buttons[next];
    if (!to) return;
    e.preventDefault();
    to.focus();
    to.click();
  });
}

// ---- Capture pane -------------------------------------------------------------

const iconPlacementSel = buildDropdown($("iconplacement") as HTMLButtonElement,
  ICON_PLACEMENTS.map((value) => ({ value, label: ICON_PLACEMENT_LABELS[value] })),
  async (picked) => {
    try {
      // Show what was stored, not what was picked. Main applies it at once.
      iconPlacementSel.set((await bridge.setSettings({ iconPlacement: cleanIconPlacement(picked) })).iconPlacement);
    } catch (e) {
      alertUser(`Could not save where the icon shows: ${String(e)}`);
    }
  });

/** Every control here changes ONE field; the rest of `thumbnail` is read fresh and kept. */
async function patchThumbnail(patch: Partial<SettingsView["thumbnail"]>): Promise<void> {
  const current = (await bridge.getSettings()).thumbnail;
  await bridge.setSettings({ thumbnail: { ...current, ...patch } });
}
const afterShot = $("aftershot");
afterShot.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  markSegment(afterShot, b.dataset.value!);
  void save("what happens after a shot", () => patchThumbnail({ skip: b.dataset.value === "clipboard" }));
});
markSegment(afterShot, "");
wireSegmentKeys(afterShot);
const CORNERS: readonly { value: SettingsView["thumbnail"]["corner"]; label: string }[] = [
  { value: "bottom-right", label: "Bottom right" }, { value: "bottom-left", label: "Bottom left" },
  { value: "top-right", label: "Top right" }, { value: "top-left", label: "Top left" },
];
const thumbCornerSel = buildDropdown($("thumbcorner") as HTMLButtonElement, CORNERS, (picked) => {
  void save("the panel corner", () => patchThumbnail({ corner: picked as SettingsView["thumbnail"]["corner"] }));
});

/**
 * Whether a capture makes a noise. Here rather than only in System Settings
 * because a hotkey capture is the one the sound exists for. It only silences:
 * on, the sound still follows the Mac's own setting and alert volume.
 */
const shutterBox = $("shuttersound") as HTMLInputElement;
shutterBox.addEventListener("change", async () => {
  try {
    shutterBox.checked = (await bridge.setSettings({ shutterSound: shutterBox.checked })).shutterSound;
  } catch (e) {
    shutterBox.checked = !shutterBox.checked;
    alertUser(`Could not save the shutter sound setting: ${String(e)}`);
  }
});

// The countdown: Off (0, which is what the countdown already treats as off,
// STC-391 rule 6) and countdown.ts's own options, never hand-listed.
const countdownGroup = $("countdownms");
for (const { ms } of [{ ms: 0 }, ...COUNTDOWN_OPTIONS]) {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "radio");
  b.dataset.value = String(ms);
  b.textContent = ms === 0 ? "Off" : `${ms / 1000} s`;
  countdownGroup.append(b);
}
countdownGroup.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  await save("the countdown", async () => {
    markSegment(countdownGroup, String((await bridge.setSettings({ countdownMs: Number(b.dataset.value) })).countdownMs));
  });
});
markSegment(countdownGroup, "");
wireSegmentKeys(countdownGroup);

// ---- Output pane --------------------------------------------------------------

/** The resolved save folder: main's own `takesRoot`, never re-derived here (STC-412 I1). */
async function refreshDestination(): Promise<void> {
  const path = await bridge.resolvedSaveFolder();
  $("stilldest").textContent = path;
  $("stilldest").title = path;
}
/** `share.destination` has no fallback: null really is "not chosen yet". */
async function refreshSiteDestination(): Promise<void> {
  const { share } = await bridge.getSettings();
  $("sitedest").textContent = share.destination ?? "Not set";
  $("sitedest").title = share.destination ?? "";
}
$("stillchoosedest").addEventListener("click", async () => {
  // Re-read rather than trust the picker's reply: a cancel answers with the
  // stored value, null on an untouched install.
  await bridge.chooseStillDestination();
  await refreshDestination();
});
$("sitechoosedest").addEventListener("click", async () => {
  await bridge.chooseShareDestination();
  await refreshSiteDestination();
});
$("reclaimspace").addEventListener("click", async () => {
  // Disabled for the round trip: the find before main's sheet is not modal,
  // and a second press would be swallowed by main's guard with no feedback.
  const btn = $("reclaimspace") as HTMLButtonElement;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try { await bridge.reclaimSpace(); } finally { btn.disabled = false; btn.removeAttribute("aria-busy"); }
});

async function patchGif(patch: Partial<GifSettings>): Promise<void> {
  const current = (await bridge.getSettings()).gif;
  await bridge.setSettings({ gif: { ...current, ...patch } });
}
const gifFpsSel = buildDropdown($("giffps") as HTMLButtonElement,
  GIF_FPS_OPTIONS.map((fps) => ({ value: String(fps), label: `${fps} fps` })),
  (v) => void save("the GIF frame rate", () => patchGif({ fps: Number(v) as GifSettings["fps"] })));
const gifWidthSel = buildDropdown($("gifwidth") as HTMLButtonElement,
  GIF_WIDTH_OPTIONS.map((w) => ({ value: String(w), label: w === "original" ? "Original" : `${w} px` })),
  (v) => void save("the GIF width", () => patchGif({ maxWidth: (v === "original" ? "original" : Number(v)) as GifSettings["maxWidth"] })));

// ---- Advanced pane ------------------------------------------------------------

const showDiagnosticsBox = $("showdiagnostics") as HTMLInputElement;
showDiagnosticsBox.addEventListener("change", () => {
  // The library window shows or hides its table when main tells it this changed.
  void save("Show diagnostics", () => bridge.setSettings({ showDiagnostics: showDiagnosticsBox.checked }));
});

// ---- Camera pane (STC-461's default PiP) --------------------------------------
//
// The preview is a sample screen with the stored default drawn on it, through
// the same `pipRect` `render()` uses. The sample screen is 16:9 at 1920 x
// 1080, so a place or size set here is the one a 1080p take records. No camera
// is opened to set a preference; framing is per take, so no Reframe.

const MOCK_CAM = { width: 1280, height: 720 };
let pipDefault: PipStyle | null = null;
const stage = $("pipscreen");
const pipBox = $("pipbox");
const radiusIn = $("pipradius") as HTMLInputElement;
const sizeIn = $("pipsize") as HTMLInputElement;
Object.assign(radiusIn, { min: "0", max: String(PIP_RADIUS_MAX), step: "0.01" });
Object.assign(sizeIn, { min: String(PIP_WIDTH_MIN), max: String(PIP_WIDTH_MAX), step: "0.005" });

/** The sample screen's output size. The screen is drawn at this aspect. */
const MOCK_OUT = { width: 1920, height: 1080 };
const mockOut = () => MOCK_OUT;

function drawPip(): void {
  if (!pipDefault) return;
  const s = pipDefault;
  markSegment($("pipshape"), s.shape);
  radiusIn.value = String(s.cornerRadius);
  radiusIn.disabled = s.shape === "circle";
  $("pipradius-out").textContent = s.shape === "circle" ? "–" : String(Math.round(s.cornerRadius * 100));
  sizeIn.value = String(s.width);
  for (const input of [radiusIn, sizeIn]) {
    const min = Number(input.min), max = Number(input.max);
    input.style.setProperty("--fill-pct", `${((Number(input.value) - min) / (max - min)) * 100}%`);
  }
  $("pipsize-out").textContent = `${Math.round(s.width * 100)}%`;
  ($("pipborder") as HTMLInputElement).checked = s.border !== null;
  ($("pipshadow") as HTMLInputElement).checked = s.shadow;
  ($("pipmirror") as HTMLInputElement).checked = s.mirror;

  const frame = stage.getBoundingClientRect();
  if (frame.width === 0) return; // the pane is hidden; drawn again when shown
  const out = mockOut();
  const k = frame.width / out.width;
  const r = pipRect(s, out, MOCK_CAM);
  const short = Math.min(r.width, r.height);
  // The border's widthPt x 2 x k assumes a 2x display, close enough for a preview.
  Object.assign(pipBox.style, {
    left: `${r.x * k}px`, top: `${r.y * k}px`, width: `${r.width * k}px`, height: `${r.height * k}px`,
    borderRadius: s.shape === "circle" ? "50%" : `${s.cornerRadius * short * k}px`,
    border: s.border ? `${s.border.widthPt * k * 2}px solid ${s.border.color}` : "none",
    boxShadow: s.shadow
      ? `0 ${PIP_SHADOW.offsetYFraction * short * k}px ${PIP_SHADOW.blurFraction * short * k}px ${PIP_SHADOW.color}` : "none",
  });
  (pipBox.firstElementChild as HTMLElement).style.transform = s.mirror ? "scaleX(-1)" : "";
}

/** live = repaint only (a slider mid-drag); commit = persist, then show what was stored. */
async function editPip(edit: PipEdit, phase: "live" | "commit"): Promise<void> {
  if (!pipDefault) return;
  pipDefault = editPipStyle(pipDefault, edit, MOCK_CAM);
  drawPip();
  if (phase !== "commit") return;
  try {
    pipDefault = (await bridge.setSettings({ pipStyle: pipDefault })).pipStyle;
  } catch (e) {
    alertUser(`Could not save the camera default: ${String(e)}`);
  }
  drawPip();
}
$("pipshape").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-pip-shape]");
  if (b) void editPip({ kind: "shape", shape: b.dataset.pipShape as PipStyle["shape"] }, "commit");
});
markSegment($("pipshape"), "");
wireSegmentKeys($("pipshape"));
for (const [input, make] of [
  [radiusIn, (value: number): PipEdit => ({ kind: "radius", value })],
  [sizeIn, (value: number): PipEdit => ({ kind: "size", value })],
] as const) {
  input.addEventListener("input", () => void editPip(make(Number(input.value)), "live"));
  input.addEventListener("change", () => void editPip(make(Number(input.value)), "commit"));
}
for (const [id, kind] of [["pipborder", "border"], ["pipshadow", "shadow"], ["pipmirror", "mirror"]] as const) {
  const box = $(id) as HTMLInputElement;
  box.addEventListener("change", () => void editPip({ kind, on: box.checked }, "commit"));
}

// Drag the PiP on the preview to place it, snapping to the frame's guides.
let pipDrag: { dx: number; dy: number } | null = null;
pipBox.addEventListener("pointerdown", (e) => {
  if (!pipDefault) return;
  const frame = stage.getBoundingClientRect();
  const out = mockOut();
  const k = frame.width / out.width;
  pipDrag = {
    dx: (e.clientX - frame.left) / k - pipDefault.center.x * out.width,
    dy: (e.clientY - frame.top) / k - pipDefault.center.y * out.height,
  };
  pipBox.setPointerCapture(e.pointerId);
});
pipBox.addEventListener("pointermove", (e) => {
  if (!pipDrag || !pipDefault) return;
  const frame = stage.getBoundingClientRect();
  const out = mockOut();
  const k = frame.width / out.width;
  const raw = {
    x: ((e.clientX - frame.left) / k - pipDrag.dx) / out.width,
    y: ((e.clientY - frame.top) / k - pipDrag.dy) / out.height,
  };
  const c = snapCenter(raw, pipSize(pipDefault, out, MOCK_CAM), out, PIP_SNAP_THRESHOLD_SCREEN_PX / k);
  void editPip({ kind: "move", center: c }, "live");
});
pipBox.addEventListener("pointerup", () => {
  if (!pipDrag || !pipDefault) return;
  pipDrag = null;
  void editPip({ kind: "move", center: pipDefault.center }, "commit");
});

/**
 * The keyboard's way to place it (STC-587): arrow keys move it 1% of the
 * frame, 10% with Shift, kept wholly inside the frame, and snapped to the same
 * guides a drag snaps to. Each press repaints; the key's release saves, as a
 * drag's release does.
 */
const PIP_NUDGE = 0.01;
const PIP_NUDGE_SHIFT = 0.1;
pipBox.addEventListener("keydown", (e) => {
  const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
  if (!dir || !pipDefault) return;
  e.preventDefault();
  const out = mockOut();
  const size = pipSize(pipDefault, out, MOCK_CAM);
  const step = e.shiftKey ? PIP_NUDGE_SHIFT : PIP_NUDGE;
  const halfX = size.width / 2 / out.width, halfY = size.height / 2 / out.height;
  const within = (v: number, half: number) => Math.min(1 - half, Math.max(half, v));
  const raw = {
    x: within(pipDefault.center.x + dir[0] * step, halfX),
    y: within(pipDefault.center.y + dir[1] * step, halfY),
  };
  const k = stage.getBoundingClientRect().width / out.width || 1;
  void editPip({ kind: "move", center: snapCenter(raw, size, out, PIP_SNAP_THRESHOLD_SCREEN_PX / k) }, "live");
});
pipBox.addEventListener("keyup", (e) => {
  if (!e.key.startsWith("Arrow") || !pipDefault) return;
  void editPip({ kind: "move", center: pipDefault.center }, "commit");
});

// ---- Shortcuts pane (STC-292) -------------------------------------------------
//
// A shortcut that did not bind must SAY so. The grammar, the reserved list and
// every sentence live in hotkeys.ts; this draws the answer and records keys.

let shortcutState: ShortcutState | undefined;
/** Which row is waiting for a keystroke, if any. */
let listening: BindableAction | undefined;

function shortcutRow(action: BindableAction): HTMLElement {
  const row = document.createElement("div");
  row.className = "row shortcut";
  const label = document.createElement("div");
  label.className = "label";
  const name = document.createElement("span");
  name.className = "name";
  name.id = `shortcutname-${action}`;
  name.textContent = ACTION_LABELS[action];
  label.append(name);

  const r = shortcutState?.report.find((x) => x.action === action);
  // The shot's variants (STC-415), read-only, as the row's helper line.
  for (const v of r?.variants ?? []) {
    const line = document.createElement("span");
    line.className = "helper variant";
    const vname = document.createElement("span");
    vname.textContent = `${OUTCOME_LABELS[v.outcome]}  `;
    const vkeys = document.createElement("span");
    vkeys.className = "keys";
    vkeys.id = `shortcut-${action}-${v.outcome}`;
    vkeys.textContent = formatAccelerator(v.accelerator);
    // Why the variant did not bind, when it did not. `data-state` says which
    // either way: the frame draws nothing for a key that is live.
    const vmessage = explainVariant(v);
    const vwhy = document.createElement("span");
    vwhy.className = "why";
    vwhy.id = `shortcutwhy-${action}-${v.outcome}`;
    vwhy.dataset.state = vmessage ? "problem" : "registered";
    if (vmessage) { vwhy.textContent = vmessage; line.classList.add("warn"); }
    line.append(vname, vkeys, vwhy);
    label.append(line);
  }
  // Why the main key did not bind, when it did not. Nothing when it did.
  const why = document.createElement("span");
  why.className = "helper warn why";
  why.id = `shortcutwhy-${action}`;
  const message = r ? explainShortcut(r) : undefined;
  why.dataset.state = message ? "problem" : r?.registered ? "registered" : "unknown";
  if (message) why.textContent = message; else why.hidden = true;
  label.append(why);

  const control = document.createElement("div");
  control.className = "control";
  const keys = document.createElement("button");
  keys.type = "button";
  keys.className = "keycap";
  keys.id = `shortcut-${action}`;
  const bound = shortcutState?.shortcuts[action] ?? null;
  keys.textContent = listening === action ? "Press keys…" : formatAccelerator(bound);
  keys.classList.toggle("listening", listening === action);
  // Named by its action as well as its keys (STC-587): "Shot Area ⌥⌘1".
  keys.setAttribute("aria-labelledby", `${name.id} ${keys.id}`);
  keys.setAttribute("aria-pressed", String(listening === action));
  keys.addEventListener("click", () => {
    listening = listening === action ? undefined : action;
    renderShortcuts();
  });
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn clear";
  clear.textContent = "Clear";
  clear.disabled = bound == null;
  clear.addEventListener("click", () => { void applyShortcut(action, null); });
  control.append(keys, clear);

  row.append(label, control);
  return row;
}

function renderShortcuts(): void {
  // The rows are rebuilt, so the focused control goes with them. Put the
  // keyboard back on the same one (STC-587), or a Return on a keycap would
  // leave focus on the page and the next Tab would start from the top.
  const focused = document.activeElement?.closest("#pane-shortcuts") ? document.activeElement.id : "";
  // Shots, then Recording: Record is the one motion action (STC-581).
  $("shortcuts-shots").replaceChildren(...BINDABLE_ACTIONS.filter((a) => a !== "record").map(shortcutRow));
  $("shortcuts-recording").replaceChildren(shortcutRow("record"));
  if (!focused) return;
  const again = document.getElementById(focused) as HTMLButtonElement | null;
  // A Clear that just emptied its row is disabled now; its keycap takes the focus.
  (again && !again.disabled ? again : again?.parentElement?.querySelector<HTMLElement>(".keycap"))?.focus();
}

async function applyShortcut(action: BindableAction, accelerator: string | null): Promise<void> {
  listening = undefined;
  try {
    shortcutState = await bridge.setShortcut(action, accelerator);
  } catch (e) {
    alertUser(`Could not set that shortcut: ${String(e)}`);
  }
  renderShortcuts();
}

/**
 * Records the chord. Capture phase and `stopImmediatePropagation`, so nothing
 * else on the page sees a key meant for the field. `code` rather than `key`:
 * on macOS ⌥⇧1 arrives as an unrelated glyph. A press of modifiers alone is
 * not an answer yet; the field keeps waiting.
 */
document.addEventListener("keydown", (e) => {
  if (!listening) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.code === "Escape") { listening = undefined; renderShortcuts(); return; }
  const accelerator = acceleratorFromKeyStroke({
    code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey,
  });
  if (accelerator === null) return;
  const action = listening;
  // Checked here as well as in main, so the field can refuse at once.
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

($("resetshortcuts") as HTMLButtonElement).addEventListener("click", async () => {
  listening = undefined;
  try {
    shortcutState = await bridge.resetShortcuts();
  } catch (e) {
    alertUser(`Could not restore the default shortcuts: ${String(e)}`);
  }
  renderShortcuts();
});

// ---- loading ------------------------------------------------------------------

async function loadSettings(): Promise<void> {
  const s = await bridge.getSettings();
  iconPlacementSel.set(s.iconPlacement);
  markSegment(afterShot, s.thumbnail.skip ? "clipboard" : "panel");
  thumbCornerSel.set(s.thumbnail.corner);
  shutterBox.checked = s.shutterSound;
  // A stored value that is not offered (a number typed into the file) leaves
  // nothing selected rather than misreporting itself.
  markSegment(countdownGroup, String(s.countdownMs));
  gifFpsSel.set(String(s.gif.fps));
  gifWidthSel.set(String(s.gif.maxWidth));
  showDiagnosticsBox.checked = s.showDiagnostics;
  pipDefault = s.pipStyle;
  drawPip();
  // LAST: a second round trip each, so a failure here leaves the rest set.
  await refreshDestination();
  await refreshSiteDestination();
}

void loadSettings().catch((e) => alertUser(`Could not read the settings: ${String(e)}`));
void (async () => {
  try { shortcutState = await bridge.getShortcuts(); } catch { shortcutState = undefined; }
  renderShortcuts();
})();
// Another window wrote a preference (the editor's "Use as default", the record
// bar's options): re-read, so this window never edits from a stale copy.
bridge.on("settings:changed", () => { void loadSettings().catch(() => {}); });
window.addEventListener("resize", drawPip);
