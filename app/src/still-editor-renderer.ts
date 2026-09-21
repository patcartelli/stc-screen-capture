import type { Redaction, Shot } from "@transform/shot";
import { layoutStill } from "@transform/still-decorate";
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
    };
  }
}

const $ = (id: string) => document.getElementById(id)!;
const stage = $("stage");
const canvas = $("stagecanvas") as HTMLCanvasElement;
const hint = $("hint");
const undoBtn = $("undo") as HTMLButtonElement;
const doneBtn = $("done") as HTMLButtonElement;

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

async function draw(): Promise<void> {
  if (!shot || !frame) return;
  const layout = layoutStill(shot);

  const out = document.createElement("canvas");
  out.width = layout.canvas.width;
  out.height = layout.canvas.height;
  const ctx = out.getContext("2d", { alpha: true });
  if (!ctx) return;
  // Sampled from the FRAME, not the composite — the frame is what a region
  // is normalised against, and reading the composite would mean reading
  // pixels an earlier fill had already replaced.
  const redactionFills = sampleRedactionFills(frame, shot.frame, regions);
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
