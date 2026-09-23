import { parseShot, type Redaction, type Shot } from "@transform/shot";
import { decorationForMode, layoutStill, pxPerPointOf } from "@transform/still-decorate";
import { planRender, stillIsBlocked, type ExportOptions } from "@transform/still-export";
import { renderStill, sampleRedactionFills } from "@transform/still-render";
import { normaliseRegion, undoLast } from "@transform/still-redact";

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
 * There is no decoration-mode picker here: the Style `<select>` was not
 * moved, it was removed as redundant in the compact panel, so `shot.decoration
 * .mode` is read once and never changes — this window's whole write path is
 * `writeShot(dir, regions)`, redactions only.
 */

declare global {
  interface Window {
    stillEditor: {
      // Trusted as-is, like `renderer.ts`'s own `getShot` — `library:shot`
      // already ran it through `parseShot` on the main side before this ever
      // crosses the process boundary.
      getShot(dir: string): Promise<Shot>;
      getFrame(dir: string, name: string): Promise<ArrayBuffer>;
      writeShot(dir: string, redactions: unknown): Promise<{ ok: boolean; redactions: number }>;
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
  const layout = layoutStill(decorated);

  const out = document.createElement("canvas");
  out.width = layout.canvas.width;
  out.height = layout.canvas.height;
  const ctx = out.getContext("2d", { alpha: true });
  if (!ctx) return;
  // Sampled from the FRAME, not the composite — the frame is what a region
  // is normalised against, and reading the composite would mean reading
  // pixels an earlier fill had already replaced.
  const redactionFills = sampleRedactionFills(frame, shot.frame, decorated.decoration.redactions);
  renderStill(ctx as never, { frame, redactionFills }, layout);
  composite = out;

  // Never cropped, unlike the panel's own resting view (STC-426): every edge
  // of the capture has to stay reachable while placing a box over it, so this
  // window always shrinks to FIT rather than filling and cropping.
  const box = { width: stage.clientWidth - 32, height: stage.clientHeight - 32 };
  const fit = Math.min(1, box.width / out.width, box.height / out.height);
  canvas.width = Math.max(1, Math.round(out.width * fit));
  canvas.height = Math.max(1, Math.round(out.height * fit));
  const scale = canvas.width / out.width;
  const c = layout.content;
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
});

undoBtn.addEventListener("click", () => {
  if (regions.length === 0) return;
  regions = undoLast(regions);
  void draw();
  void persistDecoration();
  setHint(regionCountText());
});

/**
 * Write the finished image to the save folder (STC-446).
 *
 * This editor is the ONLY door to a still already in the library — a library
 * Open comes straight here (`main.ts`'s `still:reopen`), and the tile itself
 * offers no export. Until this button there was no route at all from a kept
 * still to a deliverable: `raw/` is source material under STC-413, never the
 * thing you send someone.
 *
 * The composite is the FULL-RESOLUTION one `draw()` already built, never the
 * view canvas — that is fitted to the window and would write out whatever
 * size the user happened to have dragged it to, which is STC-318's "a way of
 * looking must not change what comes out" in a second window.
 *
 * `planRender`'s format fallback is the panel's, for the panel's reason: a
 * stored JPEG under a mode that carries transparency falls back to PNG
 * rather than flattening onto a guessed colour, because there is no colour
 * picker here either. Everything downstream — destination, filename,
 * capture id, promotion — is `still:export`, the same one funnel every other
 * exit already uses.
 */
async function saveFinished(): Promise<void> {
  if (!shot || !composite) return;
  saveBtn.disabled = true;
  const previous = hint.textContent;
  setHint("Saving…");
  try {
    const settings = (await window.stillEditor.getSettings()).still;
    const decorated = decoratedShot();
    let options: ExportOptions = { ...settings };
    const layout = layoutStill(decorated);
    const pxPerPoint = pxPerPointOf(decorated);
    let plan = planRender(options, { layout, pxPerPoint });
    let fellBackToPng = false;
    if (stillIsBlocked(plan)) {
      options = { ...options, format: "png" };
      plan = planRender(options, { layout, pxPerPoint });
      fellBackToPng = true;
    }

    const ctx = composite.getContext("2d", { alpha: true });
    if (!ctx) { setHint("Could not read the image."); return; }
    const data = ctx.getImageData(0, 0, composite.width, composite.height).data;
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

    const r = await window.stillEditor.exportStill({
      bytes, width: composite.width, height: composite.height, alpha: plan.alpha,
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
document.addEventListener("keydown", (e) => { if (e.key === "Escape") window.close(); });

// Refit on every resize — the one thing a fixed `REDACT_SIZE` panel never
// needed and a real, resizable window always does.
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void draw(), 60);
});

void (async () => {
  shot = await window.stillEditor.getShot(dir);
  regions = [...shot.decoration.redactions];
  const bytes = await window.stillEditor.getFrame(dir, shot.frame.file);
  frame = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  await draw();
  setHint(regions.length === 0 ? "Drag a box over anything private." : regionCountText());
})();
