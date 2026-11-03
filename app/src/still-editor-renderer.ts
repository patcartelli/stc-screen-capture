import {
  CUSTOM_START_COLOR, LOOKS, applyLook, customBackground, lookOf, lookWrite, wallpaperLookWrite,
  type LookId, type LookWrite,
} from "@transform/backgrounds";
import { parseShot, type Background, type Redaction, type Shot } from "@transform/shot";
import { decorationForMode } from "@transform/still-decorate";
import { DEFAULT_EXPORT_OPTIONS, stillIsBlocked, type ExportOptions } from "@transform/still-export";
import { decideRedactKey, normaliseRegion, undoLast } from "@transform/still-redact";
import { iconSvg } from "./icons.js";
import { cssFill, mountLookGrid, type LookGrid } from "./look-grid.js";
import { composeStill, loadShotBackground, stillPixelBytes } from "./still-compose.js";

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
      writeShot(dir: string, redactions: unknown, look?: LookWrite, remember?: boolean): Promise<{ ok: boolean; redactions: number }>;
      exportStill(req: Record<string, unknown>): Promise<any>;
      getSettings(): Promise<{ still: ExportOptions; saveFolder: string | null }>;
      fetchWallpaper(dir: string): Promise<{ ok: true; file: string } | { ok: false; notice: string }>;
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
/** The image/wallpaper file behind the shot's background (STC-628), and the name it was read from. */
let background: ImageBitmap | undefined;
let backgroundFile: string | undefined;
/** An object URL of the wallpaper's bytes, for the Wallpaper swatch's chip. Revoked when replaced. */
let wallpaperUrl: string | undefined;
let composite: HTMLCanvasElement | undefined;
let regions: Redaction[] = [];
/** Where the capture sits inside the view canvas, in view pixels — the same role `thumbnail-renderer.ts`'s `contentInView` played. */
let contentInView: { x: number; y: number; width: number; height: number } | undefined;
let dragFrom: { x: number; y: number } | undefined;
/**
 * The box the keyboard acts on (STC-576), an index into `regions`. Shown only
 * while the canvas has the focus, because only then do the keys reach it.
 */
let selected: number | undefined;

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
    { ...DEFAULT_EXPORT_OPTIONS, scale: "native" }, background);
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
  paintSelection(view);
  if (!marquee) return;
  view.save();
  view.strokeStyle = "#ffffff";
  view.lineWidth = 1;
  view.setLineDash([4, 3]);
  view.strokeRect(marquee.x + 0.5, marquee.y + 0.5, marquee.width, marquee.height);
  view.restore();
}

/**
 * The selected box's outline (STC-576), in the shared `--focus` colour, drawn
 * only while the canvas holds the focus. A canvas has no DOM for its boxes, so
 * this is the focus ring a box would otherwise have. Solid, never animated.
 */
function paintSelection(view: CanvasRenderingContext2D): void {
  if (selected === undefined || !contentInView || document.activeElement !== canvas) return;
  const r = regions[selected];
  if (!r) return;
  const c = contentInView;
  view.save();
  view.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--focus").trim() || "#4c8dff";
  view.lineWidth = 2;
  view.strokeRect(c.x + r.x * c.width - 1, c.y + r.y * c.height - 1, r.width * c.width + 2, r.height * c.height + 2);
  view.restore();
}

/**
 * Persist the regions (STC-297's original reasoning, still true here):
 * written on every change rather than on the way out, because a redaction
 * the user drew must not depend on them finding a "Save" button — Done just
 * closes the window.
 *
 * Coalesced (STC-576): a held arrow key changes the boxes many times a
 * second, so while one write is out the next waits, and only the newest
 * `regions` is written after it. Every change still reaches the disk; only
 * the ones a later change replaced before they were sent are skipped.
 */
let persisting: Promise<void> | undefined;
let persistAgain = false;
function persistDecoration(): Promise<void> {
  if (persisting) { persistAgain = true; return persisting; }
  persisting = (async () => {
    do {
      persistAgain = false;
      try {
        await window.stillEditor.writeShot(dir, regions);
      } catch (e: any) {
        setHint(`Could not store that: ${e?.message ?? e}`);
      }
    } while (persistAgain);
  })().finally(() => { persisting = undefined; });
  return persisting;
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
  // A drawn box is the one the keys act on next, as a placed one is.
  selected = regions.length - 1;
  void draw();
  void persistDecoration();
  setHint(regionCountText());
  updateUndoState();
});

// ── the keyboard path (STC-576) ──────────────────────────────────────────────
// The canvas is a Tab stop. `decideRedactKey` decides what a key does; a key it
// does not claim (⌘Z, ⌘S, Tab, Escape) falls through to the document handler
// below untouched.

/** What the keys can do right now, for the hint line (polite live region). */
function keyboardHint(): string {
  if (regions.length === 0) return "Return places a box.";
  if (selected === undefined) return `${regionCountText()} ] selects one, Return places another.`;
  return `Box ${selected + 1} of ${regions.length}. Arrows move it, ⌥ arrows resize, Delete removes, ] next.`;
}

canvas.addEventListener("keydown", (e) => {
  if (!shot || !contentInView) return;
  // The capture's own size: a resize's floor is MIN_REDACTION_PX CAPTURE
  // pixels, whatever size this window shows it at.
  const r = decideRedactKey(e, { regions, selected }, { width: shot.frame.width, height: shot.frame.height });
  if (!r) return;
  e.preventDefault();
  regions = [...r.regions];
  selected = r.selected;
  if (r.changed) {
    void draw();
    void persistDecoration();
    updateUndoState();
  } else {
    paintView();
  }
  setHint(keyboardHint());
});
canvas.addEventListener("focus", () => { paintView(); setHint(keyboardHint()); });
canvas.addEventListener("blur", () => { paintView(); setHint(regionCountText()); });

function undo(): void {
  if (regions.length === 0) return;
  regions = undoLast(regions);
  if (selected !== undefined && selected >= regions.length) selected = regions.length ? regions.length - 1 : undefined;
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
    let composed = composeStill(decorated, frame, options, background);
    let fellBackToPng = false;
    if (stillIsBlocked(composed.plan)) {
      options = { ...options, format: "png" };
      composed = composeStill(decorated, frame, options, background);
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

let selectedLook: LookId | undefined;
let writing = false;
/** Writes queue behind each other: a second pick during a write must not read a stale document. */
let writeChain: Promise<void> = Promise.resolve();

let grid: LookGrid | undefined;

/** The colour fields' current content as a fill, or the reason it is not one. */
function customFromFields() {
  return customBackground(customA.value, customB.value);
}

function paintSwatches(): void {
  grid?.setSelected(selectedLook);
  grid?.setDisabled(writing);
  customFields.hidden = selectedLook !== "custom";
  customA.readOnly = customB.readOnly = writing;
  // The Custom chip shows the fill the fields describe, once they describe one.
  const chip = grid?.element.querySelector<HTMLElement>('[data-look="custom"] .chip');
  const c = customFromFields();
  if (chip) chip.style.background = c.ok ? cssFill(c.background) : "";
  // The Wallpaper chip shows the picture once one is loaded, the glyph before.
  const wchip = grid?.element.querySelector<HTMLElement>('[data-look="wallpaper"] .chip');
  if (wchip) {
    wchip.style.backgroundImage = wallpaperUrl ? `url("${wallpaperUrl}")` : "";
    wchip.classList.toggle("has-image", Boolean(wallpaperUrl));
  }
}

/** The sentence from main, without Electron's "Error invoking remote method" wrapper. */
function reasonOf(e: unknown): string {
  const m = String((e as any)?.message ?? e);
  return m.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");
}

/**
 * Load the shot's background file again if `background.file` is not the one
 * already decoded, or when `force` and there is a file (STC-628). Closes the
 * bitmap it replaces. Never throws. True when the bitmap changed.
 */
async function refreshBackground(force = false): Promise<boolean> {
  if (!shot) return false;
  const file = shot.decoration.background?.file;
  // `force` is a stored look write: a wallpaper pick re-fetches into the SAME
  // name (`wallpaper.jpg`), so the name alone cannot say the bytes are new.
  if (file === backgroundFile && !(force && file)) return false;
  let bytes: ArrayBuffer | undefined;
  const next = await loadShotBackground(shot, async (name) => (bytes = await window.stillEditor.getFrame(dir, name)));
  background?.close();
  background = next;
  backgroundFile = file;
  if (wallpaperUrl) URL.revokeObjectURL(wallpaperUrl);
  wallpaperUrl = next && bytes && shot.decoration.background?.kind === "wallpaper"
    ? URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })) : undefined;
  paintSwatches();
  return true;
}

/** True when the look was stored; false when it was refused or the write failed (the hint says why). */
async function storeLook(id: LookId, write: LookWrite, remember = true): Promise<boolean> {
  if (!shot) return false;
  const before = { shot, selected: selectedLook };
  try {
    shot = parseShot({ ...shot, decoration: applyLook(shot.decoration, write) });
  } catch (e) {
    setHint(`Could not use that background: ${reasonOf(e)}`);
    return false;
  }
  selectedLook = id;
  paintSwatches();
  void draw();
  const label = LOOKS.find((l) => l.id === id)?.label ?? "Background";
  try {
    await window.stillEditor.writeShot(dir, regions, write, remember);
    // The write is what puts a wallpaper's file in the bundle, so it is read
    // only now; until then the draw above shows the colour.
    if (await refreshBackground(true)) void draw();
    setHint(`Background: ${label}.`);
    return true;
  } catch (e) {
    shot = before.shot;
    selectedLook = before.selected;
    await refreshBackground(true);
    void draw();
    setHint(`Could not store that background: ${reasonOf(e)}`);
    return false;
  }
}

/** Run `job` behind every earlier write, with the swatches `aria-disabled` for its whole length. */
function queueWrite(job: () => Promise<void>): void {
  writing = true;
  paintSwatches();
  writeChain = writeChain.then(job).finally(() => {
    writing = false;
    paintSwatches();
  });
}

/**
 * Apply a look: the preview first, then the disk. A write that main refuses
 * puts the previous look back and says why in the hint line, so what is shown
 * is always what is stored.
 */
function applyChoice(id: LookId, write: LookWrite): void {
  if (!shot) return;
  queueWrite(async () => { await storeLook(id, write); });
}

/**
 * Wallpaper (STC-628). A shot that already wears one just selects it; any
 * other shot first has main read the desktop into its folder. A read that
 * fails writes Clean and says so; one that throws leaves the look as it was.
 */
function chooseWallpaper(): void {
  if (!shot) return;
  const stored = shot.decoration.background;
  if (stored?.kind === "wallpaper" && stored.file && background) {
    applyChoice("wallpaper", wallpaperLookWrite(stored.file));
    return;
  }
  queueWrite(async () => {
    let fetched;
    try {
      fetched = await window.stillEditor.fetchWallpaper(dir);
    } catch (e) {
      setHint(`Could not read your wallpaper: ${reasonOf(e)}`);
      return;
    }
    if (fetched.ok) { await storeLook("wallpaper", wallpaperLookWrite(fetched.file)); return; }
    // remember = false: the user never picked Clean, so it must not become the
    // next "Capture background" shot's look.
    const stored = await storeLook("clean", lookWrite(LOOKS.find((l) => l.id === "clean")!), false);
    // main's WALLPAPER_NOTICE, not retyped here. A Clean write that failed keeps
    // its own hint, with the notice after it.
    setHint(stored ? fetched.notice : `${hint.textContent} ${fetched.notice}`);
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
  if (id === "wallpaper") { chooseWallpaper(); return; }
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

function initLooks(): void {
  // A display-crop shot is an opaque rectangle: parseShot refuses every window
  // mode on it, so there is nothing to offer.
  if (!shot || shot.kind !== "window" || !shot.frame.alpha) return;
  grid = mountLookGrid(lookGrid, LOOKS.map((look) => ({
    id: look.id,
    label: look.label,
    fill: cssFill(look.background),
    ...(look.id === "wallpaper" ? { glyph: iconSvg("display", "glyph") } : {}),
    ...(look.id === "window-only" ? { chip: "window" as const } : {}),
    ...(look.id === "window-shadow" ? { chip: "window-shadow" as const } : {}),
  })), (id) => choose(id as LookId));
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
  // Through the chain like every later load, so a look picked meanwhile cannot
  // be overtaken by this one's bitmap.
  writeChain = writeChain.then(async () => { await refreshBackground(); });
  await writeChain;
  await draw();
  initLooks();
  setHint(regions.length === 0 ? "Drag a box over anything private." : regionCountText());
})();
