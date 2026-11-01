import {
  CUSTOM_START_COLOR, LOOKS, applyLook, customBackground, lookOf, lookWrite,
  type LookId, type LookWrite,
} from "@transform/backgrounds";
import { parseShot, type Background, type Redaction, type Shot } from "@transform/shot";
import { decorationForMode } from "@transform/still-decorate";
import { DEFAULT_EXPORT_OPTIONS, stillIsBlocked, type ExportOptions } from "@transform/still-export";
import { normaliseRegion, undoLast } from "@transform/still-redact";
import { composeStill, stillPixelBytes } from "./still-compose.js";

/**
 * The still editor's view (STC-300) — v1's whole job is Redact, moved here
 * from the post-capture panel (`thumbnail-renderer.ts`) because that card's
 * fixed, compact size made placing a box precisely hard. See
 * `still-editor-window.ts`'s module doc for why this is its OWN window
 * rather than a mode of `editor.ts`.
 *
 * The interaction is the panel's old redact mode, unchanged in substance:
 * drag a box, normalise it against the capture, persist it on every change
 * so nothing depends on a "way out" being found later. What is different is
 * the SURFACE — a real, resizable window rather than a fixed
 * `REDACT_SIZE` — so the canvas refits itself on every resize instead of
 * being computed once against a constant.
 *
 * The background picker (STC-599) is the one other thing this window writes:
 * a swatch grid for window shots with alpha, persisted on change like a box.
 * What each swatch MEANS lives in `transform/src/backgrounds.ts`; this file
 * draws the grid, reports the choice, and sends `mode`/`background`/`shadow`
 * to `still:writeShot`, which merges them into the stored document and
 * re-validates it. Display-crop shots cannot wear a window mode (`parseShot`
 * refuses it), so for them the picker stays hidden.
 */

declare global {
  interface Window {
    stillEditor: {
      // Trusted as-is, like `renderer.ts`'s own `getShot` — `library:shot`
      // already ran it through `parseShot` on the main side before this ever
      // crosses the process boundary.
      getShot(dir: string): Promise<Shot>;
      getFrame(dir: string, name: string): Promise<ArrayBuffer>;
      writeShot(dir: string, redactions: unknown, look?: LookWrite): Promise<{ ok: boolean; redactions: number }>;
      exportStill(req: Record<string, unknown>): Promise<any>;
      getSettings(): Promise<{ still: ExportOptions; saveFolder: string | null }>;
    };
  }
}

const $ = (id: string) => document.getElementById(id)!;
const stage = $("stage");
const canvas = $("stagecanvas") as HTMLCanvasElement;
const hint = $("hint");
const undoBtn = $("undo") as HTMLButtonElement;
const doneBtn = $("done") as HTMLButtonElement;
const saveBtn = $("save") as HTMLButtonElement;
const looksBar = $("looks");
const lookGrid = $("lookgrid");
const customFields = $("customcolors");
const customA = $("custom-a") as HTMLInputElement;
const customB = $("custom-b") as HTMLInputElement;

const dir = new URLSearchParams(location.search).get("dir") ?? "";

let shot: Shot | undefined;
let frame: ImageBitmap | undefined;
let composite: HTMLCanvasElement | undefined;
let regions: Redaction[] = [];
/** Where the capture sits inside the view canvas, in view pixels — the same role `thumbnail-renderer.ts`'s `contentInView` played. */
let contentInView: { x: number; y: number; width: number; height: number } | undefined;
let dragFrom: { x: number; y: number } | undefined;

/** The smallest drag that counts as a region, in view pixels — see `thumbnail-renderer.ts`'s identical constant and reasoning. */
const MIN_DRAG_VIEW_PX = 3;

function setHint(text: string): void { hint.textContent = text; }

function regionCountText(): string {
  return regions.length === 0 ? "No boxes." : `${regions.length} ${regions.length === 1 ? "box" : "boxes"}.`;
}

/** STC-443: Undo is disabled with nothing to undo — the one state the icon
 * toolbar's own ticket calls out by name. Called after every change to
 * `regions`, the same way `draw()`/`setHint()` already are. */
function updateUndoState(): void { undoBtn.disabled = regions.length === 0; }

/**
 * The shot as the editor currently describes it: the stored mode, with
 * whatever `regions` now holds. `layoutStill` positions a shot's redaction
 * RECTS from `shot.decoration.redactions` — reading the loaded `shot`
 * directly (as `draw` did in an earlier version of this file) meant a freshly
 * drawn box was sampled for a fill colour and persisted to disk, but never
 * actually reached `layoutStill`, so nothing was ever drawn. One function,
 * the same shape `thumbnail-renderer.ts`'s old `currentShot()` used, because
 * the preview and the write must not be able to disagree about what the
 * document is.
 */
function decoratedShot(): Shot {
  return parseShot({
    ...shot,
    decoration: decorationForMode(shot!.decoration.mode, { ...shot!.decoration, redactions: regions }),
  });
}

async function draw(): Promise<void> {
  if (!shot || !frame) return;
  const decorated = decoratedShot();
  // Always at NATIVE scale: this is the INTERACTIVE view a redaction box gets
  // placed against, and `saveFinished()` composes its own export-scoped
  // canvas separately (STC-465 review, finding D1) — conflating the two would
  // mean placement precision tracks whatever output-scale preference happens
  // to be stored. `composeStill` still applies the shot's own colour space,
  // which this view's context was missing before (the same finding): visible
  // only as a P3 capture's on-screen preview reading slightly wrong, never
  // checked here because nothing compared this window's colours to the
  // panel's.
  const { canvas: out, plan } = composeStill(decorated, frame,
    { ...DEFAULT_EXPORT_OPTIONS, scale: "native" });
  composite = out;

  // Never cropped, unlike the panel's own resting view (STC-426): every edge
  // of the capture has to stay reachable while placing a box over it, so this
  // window always shrinks to FIT rather than filling and cropping.
  const box = { width: stage.clientWidth - 32, height: stage.clientHeight - 32 };
  const fit = Math.min(1, box.width / out.width, box.height / out.height);
  canvas.width = Math.max(1, Math.round(out.width * fit));
  canvas.height = Math.max(1, Math.round(out.height * fit));
  const scale = canvas.width / out.width;
  const c = plan.layout.content;
  contentInView = { x: c.x * scale, y: c.y * scale, width: c.width * scale, height: c.height * scale };
  paintView();
}

function paintView(marquee?: { x: number; y: number; width: number; height: number }): void {
  if (!composite) return;
  const view = canvas.getContext("2d", { alpha: true });
  if (!view) return;
  view.clearRect(0, 0, canvas.width, canvas.height);
  view.drawImage(composite, 0, 0, canvas.width, canvas.height);
  if (!marquee) return;
  view.save();
  view.strokeStyle = "#ffffff";
  view.lineWidth = 1;
  view.setLineDash([4, 3]);
  view.strokeRect(marquee.x + 0.5, marquee.y + 0.5, marquee.width, marquee.height);
  view.restore();
}

/**
 * Persist the regions (STC-297's original reasoning, still true here):
 * written on every change rather than on the way out, because a redaction
 * the user drew must not depend on them finding a "Save" button — Done just
 * closes the window.
 */
async function persistDecoration(): Promise<void> {
  try {
    await window.stillEditor.writeShot(dir, regions);
  } catch (e: any) {
    setHint(`Could not store that: ${e?.message ?? e}`);
  }
}

/** Pointer position in VIEW pixels, the space the marquee is drawn in. */
function viewPoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / (rect.width || 1)),
    y: (e.clientY - rect.top) * (canvas.height / (rect.height || 1)),
  };
}

canvas.addEventListener("pointerdown", (e) => {
  if (!contentInView) return;
  e.preventDefault();
  dragFrom = viewPoint(e);
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (!dragFrom) return;
  const to = viewPoint(e);
  paintView({
    x: Math.min(dragFrom.x, to.x), y: Math.min(dragFrom.y, to.y),
    width: Math.abs(to.x - dragFrom.x), height: Math.abs(to.y - dragFrom.y),
  });
});

canvas.addEventListener("pointerup", (e) => {
  if (!dragFrom || !contentInView) return;
  const from = dragFrom;
  dragFrom = undefined;
  const to = viewPoint(e);
  // Both points made relative to the CAPTURE inside the view, and normalised
  // against it — so padding, the canvas preset and the output scale are all
  // already accounted for, and the region lands on the same pixels whatever
  // this window happens to be sized to right now.
  const region = normaliseRegion(
    { x: from.x - contentInView.x, y: from.y - contentInView.y },
    { x: to.x - contentInView.x, y: to.y - contentInView.y },
    { width: contentInView.width, height: contentInView.height },
    MIN_DRAG_VIEW_PX,
  );
  if (!region) { paintView(); return; }
  regions = [...regions, region];
  void draw();
  void persistDecoration();
  setHint(regionCountText());
  updateUndoState();
});

function undo(): void {
  if (regions.length === 0) return;
  regions = undoLast(regions);
  void draw();
  void persistDecoration();
  setHint(regionCountText());
  updateUndoState();
}

undoBtn.addEventListener("click", undo);

/**
 * Write the finished image to the save folder (STC-446).
 *
 * This editor is the ONLY door to a still already in the library — a library
 * Open comes straight here (`main.ts`'s `still:reopen`), and the tile itself
 * offers no export. Until this button there was no route at all from a kept
 * still to a deliverable: `raw/` is source material under STC-413, never the
 * thing you send someone.
 *
 * The export is composed FRESH, at the real output scale and the shot's own
 * colour space (`composeStill`, `still-compose.ts`) — never the interactive
 * `composite` `draw()` keeps for placing a box, which is deliberately pinned
 * to native scale (see `draw()`'s own doc) and would otherwise write out
 * whatever size the user happened to have been editing at rather than what
 * the output-scale preference actually asks for. That is exactly the STC-318
 * "a way of looking must not change what comes out" rule, and the panel's own
 * `runExport` reads the same way: compose (or reuse a composite already built
 * at the right scale) at export time, never the live view.
 *
 * `planRender`'s format fallback is the panel's, for the panel's reason: a
 * stored JPEG under a mode that carries transparency falls back to PNG
 * rather than flattening onto a guessed colour, because there is no colour
 * picker here either. Everything downstream — destination, filename,
 * capture id, promotion — is `still:export`, the same one funnel every other
 * exit already uses.
 */
async function saveFinished(): Promise<void> {
  if (!shot || !frame) return;
  saveBtn.disabled = true;
  const previous = hint.textContent;
  setHint("Saving…");
  try {
    const settings = (await window.stillEditor.getSettings()).still;
    const decorated = decoratedShot();
    let options: ExportOptions = { ...settings };
    let composed = composeStill(decorated, frame, options);
    let fellBackToPng = false;
    if (stillIsBlocked(composed.plan)) {
      options = { ...options, format: "png" };
      composed = composeStill(decorated, frame, options);
      fellBackToPng = true;
    }

    const { canvas: exportCanvas, plan } = composed;
    const bytes = stillPixelBytes(exportCanvas);

    const r = await window.stillEditor.exportStill({
      bytes, width: exportCanvas.width, height: exportCanvas.height, alpha: plan.alpha,
      colorSpace: shot.display.colorSpace ?? "",
      target: { file: true, clipboard: false },
      options,
      info: { ...(shot.window?.app ? { app: shot.window.app } : {}),
              ...(shot.window?.title ? { title: shot.window.title } : {}),
              mode: decorated.decoration.mode },
      dir,
    });
    if (r?.cancelled) { setHint(previous ?? ""); return; }
    if (!r?.ok) { setHint(`Could not save: ${r?.detail ?? r?.code ?? "unknown error"}`); return; }
    setHint(`Saved ${String(r.file ?? "").split("/").pop() ?? ""}`
            + (fellBackToPng ? " (as PNG — this style needs transparency)" : ""));
  } catch (e: any) {
    setHint(`Could not save: ${String(e?.message ?? e)}`);
  } finally {
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", () => void saveFinished());

doneBtn.addEventListener("click", () => window.close());
// STC-443: each icon button names its shortcut in its own tooltip — this is
// what makes that true rather than decorative. ⌘Z/⌘S are trapped and
// preventDefault'd so they never fall through to a browser-native undo/save
// that has nothing to do with this document.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { window.close(); return; }
  if (!e.metaKey) return;
  const key = e.key.toLowerCase();
  if (key === "z") { e.preventDefault(); undo(); }
  else if (key === "s") { e.preventDefault(); if (!saveBtn.disabled) void saveFinished(); }
});

// ── the background picker (STC-599) ──────────────────────────────────────────

/** A swatch's fill as CSS. Approximate by design: the canvas draws the real one. */
function cssFill(bg: Background | undefined): string {
  const colors = bg?.colors ?? [];
  if (!bg || colors.length === 0) return "";
  if (bg.kind === "solid" || colors.length === 1) return colors[0]!;
  const stops = colors.join(", ");
  return bg.kind === "radial" ? `radial-gradient(circle, ${stops})` : `linear-gradient(${bg.angleDeg ?? 180}deg, ${stops})`;
}

let selectedLook: LookId | undefined;
let writing = false;
/** Writes queue behind each other: a second pick during a write must not read a stale document. */
let writeChain: Promise<void> = Promise.resolve();

const swatches = new Map<LookId, HTMLButtonElement>();

/** The colour fields' current content as a fill, or the reason it is not one. */
function customFromFields() {
  return customBackground(customA.value, customB.value);
}

function paintSwatches(): void {
  for (const [id, el] of swatches) {
    el.setAttribute("aria-checked", String(id === selectedLook));
    if (document.activeElement !== el) el.tabIndex = (selectedLook ?? "window-only") === id ? 0 : -1;
    // aria-disabled, not `disabled`: a disabled button drops the keyboard focus,
    // and a keyboard user would lose their place in the grid on every pick.
    el.setAttribute("aria-disabled", String(writing));
  }
  customFields.hidden = selectedLook !== "custom";
  customA.readOnly = customB.readOnly = writing;
  // The Custom chip shows the fill the fields describe, once they describe one.
  const chip = swatches.get("custom")?.querySelector<HTMLElement>(".chip");
  const c = customFromFields();
  if (chip) chip.style.background = c.ok ? cssFill(c.background) : "";
}

/** The sentence from main, without Electron's "Error invoking remote method" wrapper. */
function reasonOf(e: unknown): string {
  const m = String((e as any)?.message ?? e);
  return m.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");
}

/**
 * Apply a look: the preview first, then the disk. A write that main refuses
 * puts the previous look back and says why in the hint line, so what is shown
 * is always what is stored.
 */
function applyChoice(id: LookId, write: LookWrite): void {
  if (!shot) return;
  const before = { shot, selected: selectedLook };
  try {
    shot = parseShot({ ...shot, decoration: applyLook(shot.decoration, write) });
  } catch (e) {
    setHint(`Could not use that background: ${reasonOf(e)}`);
    return;
  }
  selectedLook = id;
  writing = true;
  paintSwatches();
  void draw();
  const label = LOOKS.find((l) => l.id === id)?.label ?? "Background";
  writeChain = writeChain.then(async () => {
    try {
      await window.stillEditor.writeShot(dir, regions, write);
      setHint(`Background: ${label}.`);
    } catch (e) {
      shot = before.shot;
      selectedLook = before.selected;
      void draw();
      setHint(`Could not store that background: ${reasonOf(e)}`);
    } finally {
      writing = false;
      paintSwatches();
    }
  });
}

function choose(id: LookId): void {
  const look = LOOKS.find((l) => l.id === id);
  if (!look || writing) return;
  if (id === "custom") {
    // Starts from Solid's colour each time (decided on the ticket); a shot that
    // is already Custom keeps the colours it has.
    if (selectedLook !== "custom") {
      customA.value = CUSTOM_START_COLOR;
      customB.value = "";
    }
    const c = customFromFields();
    if (!c.ok) { setHint(c.reason); return; }
    applyChoice("custom", lookWrite(look, c.background));
    return;
  }
  applyChoice(id, lookWrite(look));
}

let customTimer: ReturnType<typeof setTimeout> | undefined;
function onCustomInput(): void {
  const firstOk = customBackground(customA.value).ok;
  const c = customFromFields();
  customA.setAttribute("aria-invalid", String(!firstOk));
  customB.setAttribute("aria-invalid", String(firstOk && !c.ok));
  paintSwatches();
  clearTimeout(customTimer);
  if (!c.ok) { setHint(c.reason); return; }
  customTimer = setTimeout(() => {
    const look = LOOKS.find((l) => l.id === "custom")!;
    const again = customFromFields();
    if (again.ok) applyChoice("custom", lookWrite(look, again.background));
  }, 250);
}
customA.addEventListener("input", onCustomInput);
customB.addEventListener("input", onCustomInput);

/** Arrow keys move the focus around the grid; Enter or Space (a click) picks. */
lookGrid.addEventListener("keydown", (e) => {
  const ids = [...swatches.keys()];
  const at = ids.findIndex((id) => swatches.get(id) === document.activeElement);
  let to: number;
  if (e.key === "Home") to = 0;
  else if (e.key === "End") to = ids.length - 1;
  else if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (at + 1) % ids.length;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (at - 1 + ids.length) % ids.length;
  else return;
  if (at < 0) return;
  e.preventDefault();
  const el = swatches.get(ids[to]!)!;
  for (const s of swatches.values()) s.tabIndex = s === el ? 0 : -1;
  el.focus();
});

function initLooks(): void {
  // A display-crop shot is an opaque rectangle: parseShot refuses every window
  // mode on it, so there is nothing to offer.
  if (!shot || shot.kind !== "window" || !shot.frame.alpha) return;
  for (const look of LOOKS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "look";
    b.dataset.look = look.id;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", look.label);
    b.title = look.label;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = cssFill(look.background);
    const text = document.createElement("span");
    text.textContent = look.label;
    b.append(chip, text);
    b.addEventListener("click", () => choose(look.id));
    swatches.set(look.id, b);
    lookGrid.append(b);
  }
  selectedLook = lookOf(shot.decoration);
  const bg = shot.decoration.background;
  if (selectedLook === "custom" && bg?.colors) {
    customA.value = bg.colors[0] ?? "";
    customB.value = bg.colors[1] ?? "";
  }
  looksBar.hidden = false;
  paintSwatches();
}

// Refit on every resize — the one thing a fixed `REDACT_SIZE` panel never
// needed and a real, resizable window always does.
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void draw(), 60);
});

updateUndoState();

void (async () => {
  shot = await window.stillEditor.getShot(dir);
  regions = [...shot.decoration.redactions];
  updateUndoState();
  const bytes = await window.stillEditor.getFrame(dir, shot.frame.file);
  frame = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  await draw();
  initLooks();
  setHint(regions.length === 0 ? "Drag a box over anything private." : regionCountText());
})();
