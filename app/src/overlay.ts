import type {
  DisplayInfo, Handle, Point, Rect, SelectionOutcome, SelectionState, WindowInfo,
} from "./selection.js";
import { pixelSize, rectContains } from "./selection.js";
import { HANDLES, handleAt, handlePoint } from "./overlay-hittest.js";
import {
  barContains, barPress, controlAt, controlEnabled, parseDimension, sizeLabel,
  type BarLayout, type ControlId, type MenuAnchor, type OptionsState,
} from "./record-options.js";
import type { MenuRow } from "./device-picker.js";
import { iconSvg, type Glyph } from "./icons.js";
import { buildMenuRow } from "./device-menu-dom.js";

/**
 * The overlay's view (STC-290). It draws state and reports input; it decides
 * nothing.
 *
 * Every gesture is sent to the main process as a GLOBAL point and comes back as
 * a state to draw, so the marquee is the same object on every display and a
 * drag can cross a bezel. The one thing this file is allowed to work out for
 * itself is hit-testing — whether a press landed on a resize handle, inside the
 * marquee, or on bare desktop — because that is a question about what is on
 * screen, which is exactly what a view knows and the reducer does not.
 */

declare global {
  interface Window {
    overlay: {
      send(event: unknown): void;
      onState(cb: (payload: OverlayPayload) => void): () => void;
    };
  }
}

interface OverlayPayload {
  display?: DisplayInfo;
  displays: DisplayInfo[];
  windows: WindowInfo[];
  state: SelectionState;
  /** What would be captured right now, so the readout can show the truth. */
  preview?: SelectionOutcome;
  /** STC-388 — absent on a shot overlay, which never leaves "select". */
  phase?: "select" | "options";
  options?: OptionsState;
  bar?: BarLayout;
  /**
   * STC-388 — the bar's anchor rect, in GLOBAL points: the marquee in region
   * mode, the picked window's own bounds in window mode (`anchorRectFor`,
   * overlay-session.ts). The size readout reads THIS, never `state.rect`
   * directly — that is undefined for a window pick, which was the bug.
   */
  anchor?: Rect;
  /** STC-456 — the open device menu: where it opens and what it lists. */
  menu?: { anchor: MenuAnchor; rows: MenuRow[] };
}

const $ = (id: string) => document.getElementById(id)!;
const marquee = $("marquee"), highlight = $("highlight");
const sizeChip = $("size"), titleChip = $("title"), legend = $("legend");
const bar = $("bar"), pane = $("pane"), menuEl = $("menu");
const sizeW = $("size-w") as HTMLInputElement, sizeH = $("size-h") as HTMLInputElement;
/** Every `ControlId` has a `#ctl-<id>` in overlay.html (STC-456). */
const ctl = (id: ControlId) => $(`ctl-${id}`);

// Glyphs (STC-456): the markup names them, `icons.ts` holds the one copy of
// every path. Swapped in once at startup.
for (const el of document.querySelectorAll<HTMLElement>("[data-icon]")) {
  el.outerHTML = iconSvg(el.dataset.icon as Glyph, el.dataset.class ?? "");
}

/** Where this window's display sits in the global space. Set on first state. */
let origin: Point = { x: 0, y: 0 };
let current: OverlayPayload | undefined;
/** The active window-to-display expansion, if any. A new draw invalidates an
 * older animation so a late animation frame cannot put the marquee back where
 * it was. */
let expandAnimation = 0;
const handles = new Map<Handle, HTMLElement>();

for (const h of HANDLES) {
  const el = document.createElement("div");
  el.className = `handle ${h}`;
  el.style.display = "none";
  document.body.appendChild(el);
  handles.set(h, el);
}

const toGlobal = (e: { clientX: number; clientY: number }): Point =>
  ({ x: origin.x + e.clientX, y: origin.y + e.clientY });
const toLocal = (r: Rect): Rect =>
  ({ x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height });

const send = (event: unknown) => window.overlay.send(event);
const mods = (e: PointerEvent | KeyboardEvent) => ({ shift: e.shiftKey, alt: e.altKey });

function place(el: HTMLElement, r: Rect): void {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
  el.style.display = "block";
}

/**
 * Make the one discontinuous selection change legible: Expand changes a
 * picked window into its containing display, and an instant replacement made
 * it look as though the control had done nothing. Ordinary marquee updates
 * remain direct; only this explicit window-to-display action animates.
 */
function expandMarquee(from: Rect, to: Rect): void {
  const id = ++expandAnimation;
  marquee.classList.remove("expand-transition");
  place(marquee, from);
  // Commit the start rectangle before enabling the transition. Without this
  // layout read Chromium is allowed to coalesce both placements into one
  // paint, which is precisely the invisible state change this is for.
  void marquee.offsetWidth;
  marquee.classList.add("expand-transition");
  requestAnimationFrame(() => {
    if (id === expandAnimation) place(marquee, to);
  });
  window.setTimeout(() => {
    if (id === expandAnimation) marquee.classList.remove("expand-transition");
  }, 220);
}

function placeMarquee(rect: Rect): void {
  expandAnimation += 1;
  marquee.classList.remove("expand-transition");
  place(marquee, rect);
}

/**
 * Keep a chip on screen. A readout that runs off the edge of the display is
 * the one case where the number the user is trying to read is the number they
 * cannot see, so it flips to the inside near an edge rather than being clipped.
 */
function placeChip(el: HTMLElement, x: number, y: number, below: boolean): void {
  el.style.display = "block";
  const w = el.offsetWidth, h = el.offsetHeight;
  const margin = 8;
  let left = x, top = below ? y + margin : y - h - margin;
  if (top < margin) top = y + margin;
  if (top + h > window.innerHeight - margin) top = Math.max(margin, y - h - margin);
  left = Math.min(Math.max(margin, left), window.innerWidth - w - margin);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function hide(...els: HTMLElement[]): void {
  for (const el of els) el.style.display = "none";
}

function renderLegend(mode: string, phase: OverlayPayload["phase"]): void {
  if (phase === "options") {
    // "Click", not "Return": in the options phase Return re-confirms the
    // selection (selection.ts `confirm` → nextPhase "options"), it does not
    // start the take. The ↵ on the button is decorative (STC-456).
    legend.innerHTML = `Adjust selection <span class="sep">·</span>` +
      `Click <b>Capture Video</b> <span class="sep">·</span><kbd>Esc</kbd> cancel`;
  } else {
    legend.innerHTML = mode === "window"
      ? `<kbd>Click</kbd> select window <span class="sep">·</span>` +
        `<kbd>Space</kbd> region <span class="sep">·</span><kbd>Esc</kbd> cancel`
      : `<kbd>Drag</kbd> region <span class="sep">·</span>` +
        `<kbd>Space</kbd> window <span class="sep">·</span><kbd>Esc</kbd> cancel`;
  }
  legend.style.bottom = "48px";
  legend.style.display = "block";
}

function placeAt(el: HTMLElement, r: Rect): void {
  el.style.left = `${r.x}px`; el.style.top = `${r.y}px`;
  el.style.width = `${r.width}px`; el.style.height = `${r.height}px`;
}

/** Swap a trigger's leading glyph, only when it actually changes. */
function setLeadingGlyph(el: HTMLElement, g: Glyph): void {
  if (el.dataset.glyph === g) return;
  el.dataset.glyph = g;
  el.querySelector("svg")!.outerHTML = iconSvg(g);
}

/**
 * Draw the options bar (STC-388; STC-456's pane over a capture button). Every
 * rect comes from the payload already decided by `record-options.ts`; this
 * converts global points to this window's local space and sets state, and
 * does no geometry of its own — the menu's size is the one exception, since
 * only the DOM knows how wide its labels are.
 */
function renderBar(p: OverlayPayload): void {
  if (p.phase !== "options" || !p.bar || !p.options || !p.display) {
    bar.hidden = true; menuEl.hidden = true; return;
  }
  bar.hidden = false;
  placeAt(pane, toLocal(p.bar.pane));
  for (const c of p.bar.controls) {
    const el = ctl(c.id);
    placeAt(el, toLocal(c.rect));
    el.dataset.enabled = controlEnabled(c.id, p.options) ? "1" : "0";
  }
  // The anchor, not `p.state.rect` — the latter is undefined for a window
  // pick (selection.ts never sets one), which used to leave this reading "—"
  // for every window take. `p.anchor` is the SAME rect `barLayout` above was
  // built from (overlay-session.ts's `push`), so the readout cannot disagree
  // with the bar it is drawn inside of.
  //
  // The fields show the live size unless the user is editing the PAIR: a
  // broadcast mid-edit (every pointermove sends one) must not overwrite what
  // they have typed so far — including the width they typed before Tabbing
  // to the height, which is not the focused field any more but is still
  // uncommitted.
  const px = p.anchor ? pixelSize(p.anchor, p.display) : undefined;
  const editing = document.activeElement === sizeW || document.activeElement === sizeH;
  if (!editing) {
    sizeW.value = px ? String(px.width) : "";
    sizeH.value = px ? String(px.height) : "";
  }
  // `data-label` is the readout as one string — what the e2e suite reads now
  // that the element holds two inputs rather than text.
  ctl("size").dataset.label = p.anchor ? sizeLabel(p.anchor, p.display) : "—";
  ctl("expand").dataset.on = p.options.fullDisplay ? "1" : "0";
  const micOn = p.options.micDeviceUid != null;
  ctl("mic").dataset.on = micOn ? "1" : "0";
  ctl("camera").dataset.on = p.options.camera ? "1" : "0";
  // The trigger's glyph follows the state: mic-off when muted, camera-off when off.
  setLeadingGlyph(ctl("mic"), micOn ? "mic" : "mic-off");
  setLeadingGlyph(ctl("camera"), p.options.camera ? "camera" : "camera-off");
  renderMenu(p.menu);
}

/**
 * The open device menu (STC-456). Rows come from `device-picker.ts`, the same
 * model the main window's popover draws. It drops below its trigger and over
 * the capture button, or rises above the trigger when `menuAnchor` said the
 * display's bottom is too close; `anchor.y` is the NEAR edge either way.
 */
function renderMenu(m: { anchor: MenuAnchor; rows: MenuRow[] } | undefined): void {
  if (!m) { menuEl.hidden = true; menuEl.replaceChildren(); return; }
  // No `onPick` — this menu's rows are pressed through the delegated
  // `pointerdown` handler below (`barPress`'s ordering rules), not their own
  // listeners. See device-menu-dom.ts's header for why.
  menuEl.replaceChildren(...m.rows.map((r) => buildMenuRow(r)));
  menuEl.hidden = false;
  const a = { x: m.anchor.x - origin.x, y: m.anchor.y - origin.y };
  const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
  const top = m.anchor.side === "below" ? a.y : a.y - h;
  menuEl.style.left = `${Math.max(8, Math.min(a.x, window.innerWidth - w - 8))}px`;
  menuEl.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
}

function render(p: OverlayPayload): void {
  const previous = current;
  current = p;
  // The last state this window was told to draw, for a failing test to report.
  // A selection that cannot be confirmed makes Return a no-op and the overlay
  // hangs open (selection.ts, `reduce`); without this the only evidence is an
  // empty string in the main window fifteen seconds later, which is what made
  // the two master failures unreadable. Diagnostic only — nothing reads it.
  (window as unknown as Record<string, unknown>).__overlayState = {
    mode: p.state.mode, rect: p.state.rect, pointer: p.state.pointer,
    hoveredWindowId: p.state.hoveredWindowId,
    confirmable: p.preview !== undefined,
    displays: p.displays.map((d) => ({ id: d.id, bounds: d.bounds })),
  };
  if (p.display) origin = { x: p.display.bounds.x, y: p.display.bounds.y };
  const { state } = p;
  document.body.classList.toggle("window-mode", state.mode === "window");
  document.body.classList.toggle("has-selection", state.rect !== undefined);
  renderLegend(state.mode, p.phase);
  renderBar(p);

  if (state.mode === "window") {
    hide(marquee, sizeChip, ...handles.values());
    const w = p.windows.find((x) => x.id === state.hoveredWindowId);
    if (!w) { hide(highlight, titleChip); return; }
    const local = toLocal(w.bounds);
    place(highlight, local);
    // Not fully visible (STC-380): still shown, so the target does not just
    // vanish, but styled apart and captioned instead of measured — the size
    // readout would be true and still misleading, since a click here will not
    // capture it.
    highlight.classList.toggle("not-fully-visible", !w.fullyVisible);
    const name = [w.app, w.title].filter(Boolean).join(" — ") || "Window";
    if (w.fullyVisible) {
      const display = p.displays.find((d) => rectContains(d.bounds, {
        x: w.bounds.x + w.bounds.width / 2, y: w.bounds.y + w.bounds.height / 2,
      }));
      const px = pixelSize(w.bounds, display);
      titleChip.textContent = `${name}   ${px.width} × ${px.height}`;
    } else {
      titleChip.textContent = `${name} — not fully visible, choose another window`;
    }
    placeChip(titleChip, local.x, local.y, false);
    return;
  }

  hide(highlight, titleChip);
  if (!state.rect) { hide(marquee, sizeChip, ...handles.values()); return; }

  const local = toLocal(state.rect);
  // Only the display that owns both bars performs this animation. Other
  // overlay windows receive the shared state too, but have no visible source
  // window to expand from.
  const animateWindowExpand = p.phase === "options" && p.options?.fullDisplay
    && p.bar !== undefined && previous?.phase === "options"
    && previous.state.mode === "window" && previous.anchor !== undefined
    && previous.bar !== undefined;
  if (animateWindowExpand) expandMarquee(toLocal(previous.anchor!), local);
  else placeMarquee(local);
  for (const h of HANDLES) {
    const el = handles.get(h)!;
    // Handles only while the gesture is over: they are for adjusting a
    // finished marquee, and drawing them mid-drag puts eight squares under the
    // pointer at exactly the moment the user is watching the edge.
    if (state.drag) { el.style.display = "none"; continue; }
    const c = handlePoint(local, h);
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
    el.style.display = "block";
  }

  // The readout names what would actually be captured, which after clipping to
  // one display is not always what was drawn — see `dominantDisplay`.
  const preview = p.preview;
  if (preview && preview.kind === "region") {
    const display = p.displays.find((d) => d.id === preview.displayId);
    const px = pixelSize(preview.crop, display);
    const clipped = preview.global.width !== state.rect.width
                 || preview.global.height !== state.rect.height;
    sizeChip.textContent = `${px.width} × ${px.height}${clipped ? "  (clipped to one display)" : ""}`;
    placeChip(sizeChip, local.x, local.y + local.height, true);
  } else {
    hide(sizeChip);
  }
}

// ── input ───────────────────────────────────────────────────────────────────

/**
 * Whether this window listens to REAL pointer and key input.
 *
 * Off when the session was opened with synthetic input (`?synthetic=1`), which
 * only the E2E suite does. That suite drives the overlay through
 * `window.overlay.send` — the same bridge these handlers use — and the window
 * server was driving it at the same time: a real `pointermove` at whatever
 * coordinate the cursor happened to occupy would land between an injected
 * pointermove and its pointerup and rewrite the marquee from under it.
 *
 * That is the whole of the flake. Caught locally as a crop 540 wide instead of
 * 200, where 540 is exactly the distance from the drag's anchor to the middle
 * of the screen — the parked cursor. On CI it landed the other way: the
 * polluted rect confirmed to nothing, `reduce` made Return a no-op, the
 * overlay never settled, and the assertion read `expected '' to contain
 * 'macOS 14'` fifteen seconds later with nothing to say (master #209, #213).
 *
 * These handlers are not what the E2E covers either way — it already calls the
 * bridge directly, so the translation below (hit-testing a handle, `toGlobal`)
 * was never exercised by it and is not exercised by it now. What is lost is
 * nothing; what is gained is that the test's input is the only input.
 */
const SYNTHETIC_INPUT = new URLSearchParams(location.search).get("synthetic") === "1";

// ── the size field (STC-456) ────────────────────────────────────────────────

/** Set while a size input is blurred by code that has already decided what the
 * blur means — Escape (a revert) or `commitAndLeaveField` (already committed)
 * — so the blur handler does not commit a second time. */
let skipBlurCommit = false;

/** Commit the typed size NOW, then leave the field without a second commit. */
function commitAndLeaveField(): void {
  commitSize();
  skipBlurCommit = true;
  try { (document.activeElement as HTMLElement | null)?.blur(); } finally { skipBlurCommit = false; }
}

/** Send the typed size in PIXELS; anything unparseable reverts to the live one. */
function commitSize(): void {
  const w = parseDimension(sizeW.value), h = parseDimension(sizeH.value);
  if (w === undefined || h === undefined) { if (current) render(current); return; }
  // Unchanged is not a resize: a click in and out of the field must not
  // re-centre the marquee through a points round trip, or clear `fullDisplay`.
  const now = current?.anchor && current.display ? pixelSize(current.anchor, current.display) : undefined;
  if (now && now.width === w && now.height === h) return;
  send({ t: "size", width: w, height: h });
}

for (const f of [sizeW, sizeH]) {
  // Numbers only, as typed: strip anything else the moment it lands (a paste included).
  f.addEventListener("input", () => { f.value = f.value.replace(/\D+/g, "").slice(0, 5); });
  f.addEventListener("focus", () => f.select());
  // Leaving the PAIR commits; Tab from W to H does not.
  f.addEventListener("blur", (ev) => {
    if (skipBlurCommit) return;
    const to = ev.relatedTarget;
    if (to !== sizeW && to !== sizeH) commitSize();
  });
}

if (!SYNTHETIC_INPUT) installRealInput();

function installRealInput(): void {
window.addEventListener("pointerdown", (e) => {
  // The bar sits over the scrim, so a press on it must not also start a new
  // marquee underneath. First refusal, then the selection as before.
  if (current?.phase === "options" && current.bar) {
    // Focus moves (and the committing blur fires) only AFTER this handler, so
    // a typed size is committed here, ahead of anything this press sends —
    // see `barPress` rule 1.
    const fieldFocused = document.activeElement === sizeW || document.activeElement === sizeH;
    const onField = e.target === sizeW || e.target === sizeH;
    // A menu row first: the menu drops OVER the capture button, so the bar's
    // own hit test would read a press on a row as a press on Capture.
    const row = (e.target as Element).closest?.("#menu .row") as HTMLElement | null;
    if (row && current.menu) {
      if (fieldFocused) commitAndLeaveField();
      const picked = current.menu.rows.find((r) => r.key === row.dataset.key);
      if (picked) send({ t: "menuPick", pick: picked.pick });
      return;
    }
    const g = toGlobal(e);
    const hit = controlAt(g, current.bar);
    // Every decision is `barPress`'s (record-options.ts, unit tested); this
    // only carries out its actions in the order given.
    const { actions, swallow } = barPress({
      fieldFocused, onField, menuOpen: current.menu !== undefined, hit,
      inBar: barContains(g, current.bar),
      enabled: hit !== undefined && controlEnabled(hit, current.options!),
    });
    for (const a of actions) {
      if (a.t === "commitSize") commitAndLeaveField();
      else send(a);
    }
    if (swallow) return;
  }
  const state = current?.state;
  const at = toGlobal(e);
  let handle: Handle | undefined;
  let onMarquee = false;
  if (state?.mode === "region" && state.rect) {
    const local = toLocal(state.rect);
    const p = { x: e.clientX, y: e.clientY };
    handle = handleAt(local, p);
    if (!handle) onMarquee = rectContains(local, p);
  }
  // Capture the pointer so a drag that leaves this display keeps arriving
  // here — the coordinates simply go outside the window, which converts to a
  // global point perfectly well. Without it the gesture would die at the bezel.
  try { (e.target as Element)?.setPointerCapture?.(e.pointerId); } catch { /* not fatal */ }
  send({ t: "pointerdown", at, mods: mods(e), handle, onMarquee });
});

window.addEventListener("pointermove", (e) => {
  send({ t: "pointermove", at: toGlobal(e), mods: mods(e) });
});

window.addEventListener("pointerup", (e) => {
  try { (e.target as Element)?.releasePointerCapture?.(e.pointerId); } catch { /* not fatal */ }
  send({ t: "pointerup", at: toGlobal(e), mods: mods(e) });
});

window.addEventListener("keydown", (e) => {
  // The size fields own their keys (STC-456, Review Focus 1): digits, arrows,
  // Space, Return and Escape typed there are editing, not selection gestures.
  const t = e.target as HTMLElement;
  if (t === sizeW || t === sizeH) {
    if (e.key === "Enter") {
      // Leaving the pair is the commit (the blur handler), so Return is just
      // "leave" — one path, one `size` event.
      e.preventDefault();
      t.blur();
    } else if (e.key === "Escape") {
      // Revert, and do NOT cancel the overlay. Blur fires synchronously inside
      // `blur()`, and its handler would commit the half-typed value — the flag
      // is what tells it this blur is a revert.
      e.preventDefault();
      skipBlurCommit = true;
      try { t.blur(); } finally { skipBlurCommit = false; }
      if (current) render(current);
    }
    return;   // nothing typed in the field reaches the selection reducer
  }
  if (e.key === "Escape" && current?.menu) {
    // First Escape closes the open menu; the next one cancels, as before.
    e.preventDefault();
    send({ t: "menuClose" });
    return;
  }
  // Space and the arrows both scroll a document by default, and Escape can be
  // swallowed; the overlay wants all of them verbatim.
  if ([" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Enter"].includes(e.key)) {
    e.preventDefault();
  }
  send({ t: "key", key: e.key, mods: mods(e) });
});

// A modifier pressed or released mid-drag changes the marquee without the
// pointer moving — Shift squaring a drag that has stopped, say. Replaying the
// last position keeps the picture honest.
for (const type of ["keydown", "keyup"] as const) {
  window.addEventListener(type, (e) => {
    if (e.key !== "Shift" && e.key !== "Alt") return;
    const p = current?.state.pointer;
    if (!p || !current?.state.drag) return;
    send({ t: "pointermove", at: p, mods: { shift: e.shiftKey, alt: e.altKey } });
  });
}
}

window.overlay.onState(render);
