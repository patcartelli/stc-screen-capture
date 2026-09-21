import { parseShot, type Shot } from "@transform/shot";
import { layoutStill, pxPerPointOf } from "@transform/still-decorate";
import { renderStill, sampleRedactionFills } from "@transform/still-render";
import { withTimeout } from "@transform/timeout";
import {
  classifyDrag, discardDirection, isDiscardSwipe, parseCorner, swipeOffset,
  SETTLE_READY_MS, PANEL_SIZE, type Size,
} from "./thumbnail.js";
import { colorSpaceFor, planRender, stillIsBlocked, type ExportOptions } from "@transform/still-export";
import {
  actionsFor, closesPanel, type PanelAction, type PanelTake,
} from "./panel-actions.js";

/**
 * The floating thumbnail's view (STC-296, rebuilt on `panel-actions.ts` by
 * STC-392). It draws the take and reports clicks; every DECISION about what
 * an action DOES to the panel or the take is `panel-actions.ts`'s
 * (`closesPanel`), `still-decorate.ts` / `still-export.ts`'s (what a Copy
 * produces) or `main.ts`'s (`panel:save`/`panel:edit`/`panel:trash` — what
 * happens to the take itself), the same split every other view in this app
 * keeps.
 *
 * ## One card, five actions, four keyboard paths (STC-392)
 *
 * There is no collapsed/expanded distinction any more: the window is fixed
 * at `PANEL_SIZE` (`thumbnail-window.ts`) and every control this take has is
 * on the card from the moment it paints. `perform()` is the one place an
 * action's rules are written — see its own doc — so a keyboard Save, a
 * clicked Save and a menu Save cannot drift apart.
 *
 * ## Redact moved to a still editor; the Style picker is just gone (STC-300, STC-426 revision)
 *
 * This card used to grow into a REDACT_SIZE window and let a drag here CREATE
 * a redaction, with a Style `<select>` choosing the decoration mode alongside
 * it — "there is no still editor, so this IS one" was the reasoning at the
 * time. Once a real (if minimal) still editor existed, `Edit`
 * (`panel-actions.ts`'s `actionsFor`, now available for a shot too) opens
 * `still-editor-renderer.ts` on the promoted take, which owns drawing a NEW
 * redaction and the Undo/Done pair — this file no longer creates either. The
 * Style picker was not moved anywhere; it was simply redundant in a card this
 * small and is gone, with no control anywhere yet for changing a shot's
 * decoration mode after capture.
 *
 * What is LEFT here is read-only: `shot.decoration` (mode and any redactions
 * already saved from a previous Edit session) is composited into every
 * preview and export exactly as stored, because Copy/Save/drag-out must
 * still hand over the take as it currently looks. There is no mutable
 * `regions`/`currentMode`/`redacting` state left to manage — `shot` itself
 * is the single source once nothing here can change it.
 */

declare global {
  interface Window {
    thumb: {
      getFrame(dir: string, name: string): Promise<ArrayBuffer>;
      getSettings(): Promise<{ still: ExportOptions & { destination: string | null } }>;
      exportStill(req: Record<string, unknown>): Promise<{
        ok: boolean; file?: string; bytes?: number; clipboard?: string[];
        code?: string; detail?: string;
        /** The user closed the Save As panel without choosing. */
        cancelled?: boolean;
        /** Present when the take moved out of temp storage into the library (STC-393). */
        dir?: string;
      }>;
      menu(ctx: { take: PanelTake; busy: boolean }): Promise<string | null>;
      revealShot(dir: string): Promise<boolean>;
      /** The three actions that CHANGE where a take lives (STC-392) — see `panel-actions.ts`. */
      save(dir: string): Promise<{ ok: boolean; dir?: string; detail?: string }>;
      edit(dir: string): Promise<{ ok: boolean; detail?: string }>;
      trash(dir: string): Promise<{
        ok: boolean; detail?: string;
        /** A library-origin take's confirm dialog was declined (STC-392 D1's
         * "confirm" style, `trashWithConfirmation`) — a decision, not a
         * fault (STC-392 review, I5). */
        cancelled?: boolean;
      }>;
      dragFile(req: Record<string, unknown>): Promise<{ ok: boolean; file?: string; detail?: string }>;
      startDrag(file: string): void;
      reveal(): Promise<boolean>;
      event(ev: { kind: "painted" | "discarding" | "done" | "showOverflow" }): void;
      /** The overflow badge's count (Task 5b / STC-392 D7) — see `thumbnail-preload.ts`. */
      onHiddenCount(cb: (n: number) => void): () => void;
    };
  }
}

const $ = (id: string) => document.getElementById(id)!;
const card = $("card");
const canvas = $("thumbcanvas") as HTMLCanvasElement;
const statusEl = $("status");
const overflowBtn = $("overflow") as HTMLButtonElement;

const params = new URLSearchParams(location.search);
/**
 * The shot's own directory — temp storage until an action promotes it to the
 * library (STC-393), `let` rather than `const` for exactly that reason: every
 * later call (reveal, discard) reads this same variable, and a stale
 * reference to a directory `promoteTake` has already moved would fail.
 */
let dir = params.get("dir") ?? "";
/**
 * What this panel is showing — `panel-actions.ts`'s own type, parsed back out
 * of the query `thumbnail-window.ts` built it from. A malformed or absent
 * value defaults to a fresh shot (the widest set of the four actions minus
 * Edit) rather than throwing and leaving the panel with no buttons at all —
 * the same defensive default `main.ts`'s `thumbnail:menu` handler uses for
 * the identical field.
 */
function parseTake(v: string | null): PanelTake {
  try {
    const parsed = JSON.parse(v ?? "null");
    if (parsed && (parsed.kind === "shot" || parsed.kind === "recording")
        && (parsed.origin === "fresh" || parsed.origin === "library")) {
      return parsed as PanelTake;
    }
  } catch { /* falls through to the default below */ }
  return { kind: "shot", origin: "fresh" };
}
const take: PanelTake = parseTake(params.get("take"));
// A recording has no picture in v1 (D2) — `#takecard` stands in for the
// canvas (`thumbnail.html`'s own markup comment). Nothing presents one of
// these today (`main.ts` only ever sends `kind: "shot"`), so this is the
// whole of that wiring: no recording-specific frame fetch exists to guard.
if (take.kind === "recording") {
  ($("takecard") as HTMLElement).hidden = false;
  ($("thumbwrap") as HTMLElement).hidden = true;
}
const shot: Shot = parseShot(JSON.parse(params.get("shot") ?? "null"));
/**
 * The "skip the panel" preference (STC-296): this window is never shown at
 * all, so it composites and copies itself the instant it can rather than
 * waiting on a "painted" round trip through main first — there is nothing to
 * animate into, so nothing to wait for.
 */
const silent = params.get("silent") === "1";
/** Which way this panel leaves the screen — see `discardDirection`. */
const corner = parseCorner(params.get("corner"));

/**
 * The canvas's own box, in CSS px — derived from `PANEL_SIZE` (the WINDOW,
 * `thumbnail.ts`) rather than tuned on its own. Two independently-guessed
 * box sizes for one card was the old collapsed/expanded shape (STC-392
 * removed it); `CARD_CHROME` is the one number that says how much of the
 * fixed window is NOT canvas — the card's own inset (`#card { inset: 8px }`
 * in thumbnail.html, both sides), `#thumbwrap`'s own padding, and the space
 * `#controls` (the style row, the actions row, the status line) takes below
 * it — so the window and the box it draws inside cannot drift apart the way
 * the old fixed sizes and `COLLAPSED_BOX`/`EXPANDED_BOX` already had.
 */
const CARD_CHROME: Size = { width: 40, height: 100 };
const CARD_BOX: Size = {
  width: PANEL_SIZE.width - CARD_CHROME.width,
  height: PANEL_SIZE.height - CARD_CHROME.height,
};

let frame: ImageBitmap | undefined;
/** The full-resolution composite, kept apart from the (scaled-down) view canvas. */
let composite: HTMLCanvasElement | undefined;
/**
 * An action is in flight — set for the whole of `perform()`, not merely the
 * network round trip inside it, so a second click cannot start a SECOND
 * action on the same take while the first is still deciding its outcome.
 */
let busy = false;
/**
 * The source rectangle of `composite` the view is cropped to, so the canvas
 * fills its pane instead of a smaller picture letterboxed inside it
 * (STC-426 revision).
 */
let cropRect: { x: number; y: number; width: number; height: number } | undefined;

function setStatus(text: string): void { statusEl.textContent = text; }

async function draw(): Promise<void> {
  if (!frame) return;
  // `shot` directly, not a recomposed copy: the panel no longer creates
  // redactions or changes the mode (STC-300 moved both to the still editor),
  // so there is nothing left here that could diverge from the stored
  // document. Reading it fresh on open already picks up whatever a previous
  // Edit session saved.
  const layout = layoutStill(shot);
  const pxPerPoint = pxPerPointOf(shot);
  const settings = (await window.thumb.getSettings()).still;
  const plan = planRender(settings, { layout, pxPerPoint });

  const out = document.createElement("canvas");
  // `plan.layout`, not `layout`: `planRender` SCALES the layout for a 1x export
  // of a 2x capture, and sizing the canvas from the unscaled one left the
  // picture drawn into the top-left corner of a canvas twice as big — an
  // export padded with empty space, and (once regions exist) a drag that maps
  // to the wrong pixels. Invisible at the default `native` scale, which is why
  // it survived STC-296.
  out.width = plan.layout.canvas.width;
  out.height = plan.layout.canvas.height;
  const ctx = out.getContext("2d", { alpha: true, colorSpace: colorSpaceFor(shot.display.colorSpace) as never });
  if (!ctx) return;
  // The fills are sampled from the FRAME, not from the composite: the frame is
  // what a region is normalised against, and reading the composite would mean
  // reading pixels an earlier fill had already replaced. These are whatever
  // the shot ALREADY carries — the panel cannot draw a new one any more, only
  // show what a previous Edit session saved.
  const redactionFills = sampleRedactionFills(frame, shot.frame, shot.decoration.redactions);
  renderStill(ctx as never, { frame, redactionFills }, plan.layout);
  composite = out;

  // Fill the pane rather than shrinking to fit inside it (STC-426 revision):
  // the canvas is exactly `CARD_BOX`, and the composite is CROPPED to that
  // aspect ratio rather than letterboxed — a resting card is the picture, not
  // a smaller picture surrounded by the card's own background.
  canvas.width = CARD_BOX.width;
  canvas.height = CARD_BOX.height;
  const coverScale = Math.max(CARD_BOX.width / out.width, CARD_BOX.height / out.height);
  const cropWidth = CARD_BOX.width / coverScale;
  const cropHeight = CARD_BOX.height / coverScale;
  cropRect = {
    x: (out.width - cropWidth) / 2, y: (out.height - cropHeight) / 2,
    width: cropWidth, height: cropHeight,
  };
  paintView();
}

/** Put the composite on the visible canvas, cropped to fill it (STC-426). */
function paintView(): void {
  if (!composite || !cropRect) return;
  const view = canvas.getContext("2d", { alpha: true });
  if (!view) return;
  view.clearRect(0, 0, canvas.width, canvas.height);
  view.drawImage(composite, cropRect.x, cropRect.y, cropRect.width, cropRect.height,
                  0, 0, canvas.width, canvas.height);
}

/**
 * `settings` read once per export — not cached — so a preference changed in
 * the main window's own settings block between shots is honoured.
 *
 * Only the FORMAT is ever overridden here, and only to keep pixels rather
 * than to fill them: a stored format that cannot carry this mode's
 * transparency (JPEG under `window-only`/`window-shadow`) falls back to PNG
 * rather than flattening onto a guessed colour — this panel has no colour
 * picker, and "keep everything, in a format that can" needs no guess at all.
 */
/**
 * `save-as` is a save that asks first. It is a panel FACILITY rather than one
 * of `panel-actions.ts`'s four take actions (`copy`/`save`/`edit`/`trash`):
 * "save" there means "keep this take in the library" (`panel:save` promotes
 * it, and writes no file of its own — the library renders the decoration
 * from the stored shot document, same as any other library tile). Save As
 * still goes through `still:export` like Copy, because it produces an actual
 * FILE at a place the user chooses, which promoting a directory does not.
 */
type ExportAction = "copy" | "save-as";

async function runExport(action: ExportAction): Promise<boolean> {
  if (!composite) return false;
  const settings = (await window.thumb.getSettings()).still;
  let options: ExportOptions = { ...settings };
  const layout = layoutStill(shot);
  const pxPerPoint = pxPerPointOf(shot);
  let plan = planRender(options, { layout, pxPerPoint });
  let fellBackToPng = false;
  if (stillIsBlocked(plan)) {
    options = { ...options, format: "png" };
    plan = planRender(options, { layout, pxPerPoint });
    fellBackToPng = true;
  }

  const ctx = composite.getContext("2d", { alpha: true });
  const data = ctx!.getImageData(0, 0, composite.width, composite.height).data;
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

  const r = await window.thumb.exportStill({
    bytes, width: composite.width, height: composite.height, alpha: plan.alpha,
    colorSpace: shot.display.colorSpace ?? "",
    target: {
      file: action !== "copy",
      clipboard: action === "copy",
      // main puts the panel up and keeps the path it gets back; this side only
      // ever says that a choice was wanted (STC-296's right-click menu).
      ...(action === "save-as" ? { saveAs: true } : {}),
    },
    options,
    info: { ...(shot.window?.app ? { app: shot.window.app } : {}),
            ...(shot.window?.title ? { title: shot.window.title } : {}),
            mode: shot.decoration.mode },
    dir,
  });
  // Cancelling the save panel is a decision, not a fault. Saying "Could not
  // save as: undefined" to someone who pressed Cancel would be the app
  // reporting their own answer back to them as an error.
  if (r.cancelled) { setStatus(""); return false; }
  if (!r.ok) {
    setStatus(`Could not ${action === "copy" ? "copy" : "save"}: ${r.detail ?? r.code ?? "unknown error"}`);
    return false;
  }
  // The shot just moved out of temp storage (STC-393) — every later call in
  // this session (reveal, discard) must use its new home.
  if (r.dir) dir = r.dir;
  setStatus((action === "copy" ? "Copied" : `Saved ${r.file?.split("/").pop() ?? ""}`)
    + (fellBackToPng ? " (as PNG — this style needs transparency)" : ""));
  return true;
}

// ---- the four take actions (STC-392) ---------------------------------------

/** This take's own actions, in the order `panel-actions.ts` lays them out. */
const available = new Set(actionsFor(take));

/**
 * Disable (or re-enable) every VISIBLE `#actions` button — everything on the
 * card that can change what `composite` IS while an action is reading it.
 *
 * Not per-button: while ANY of the four is deciding an outcome, none of the
 * others may start a second one on the same take — two actions racing each
 * other is exactly the shape of bug `busy` exists to rule out. Hidden buttons
 * (this take does not have the action) are left alone; there is nothing to
 * show as disabled.
 */
function setActionsEnabled(on: boolean): void {
  // `[data-action]` — not every button in `#actions`: the overflow badge
  // (Task 5b / STC-392 D7) lives in this same row and carries no
  // `data-action`, since it is not one of `panel-actions.ts`'s four take
  // actions. Left enabled deliberately — expanding the stack to look at a
  // waiting take is not an action ON this one, so an in-flight Save/Edit/
  // Trash on THIS take has no reason to block it.
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#actions button[data-action]")) {
    if (!btn.hidden) btn.disabled = !on;
  }
}

/**
 * Bounded wait for the panel's first composite (SETTLE_READY_MS,
 * `thumbnail.ts`) — only Copy reads `composite` (`runExport`); Save, Edit and
 * Trash never touch it. See `SETTLE_READY_MS`'s own doc for why this bound
 * exists even though the ordering elsewhere in this file means it never
 * actually waits today.
 */
let markReady!: () => void;
const ready = new Promise<void>((res) => { markReady = res; });

async function awaitComposite(): Promise<boolean> {
  try {
    await withTimeout(ready, SETTLE_READY_MS, "the panel did not composite in time");
    return true;
  } catch {
    return false;
  }
}

/**
 * Perform one action, and do to the panel whatever `panel-actions.ts` says
 * that action does to it.
 *
 * ONE function for all four, rather than a handler each, because the rule
 * that differs between them — whether the panel closes — is not written here.
 * Four handlers each remembering to close (or not) is four chances for Copy to
 * grow a close nobody asked for, which is precisely the behaviour this ticket
 * exists to remove. Returns whether the action succeeded, so a caller with its
 * own visual state to restore on failure (`discard`'s slide-out) can tell.
 */
async function perform(action: PanelAction): Promise<boolean> {
  if (busy) return false;
  busy = true;
  setActionsEnabled(false);
  try {
    const ok = await run(action);
    // Only a SUCCESSFUL action closes. A failed Save leaves the panel exactly
    // as it was, with the reason in the status line — the same rule `discard`
    // already followed for a failed trash, and the reason it is safe for the
    // panel to be the only place this take exists.
    if (ok && closesPanel(action)) window.thumb.event({ kind: "done" });
    return ok;
  } finally {
    busy = false;
    setActionsEnabled(true);
  }
}

async function run(action: PanelAction): Promise<boolean> {
  if (action === "copy") {
    setStatus("Copying…");
    if (!(await awaitComposite())) { setStatus("Could not prepare the shot in time."); return false; }
    return runExport("copy");
  }
  if (action === "save") {
    setStatus("Saving…");
    const r = await window.thumb.save(dir);
    if (!r.ok) { setStatus(`Could not save: ${r.detail ?? "unknown error"}`); return false; }
    // The take has moved out of temp storage — every later call in this window
    // (reveal, trash) must use its new home. Same reason `dir` is a `let`.
    if (r.dir) dir = r.dir;
    setStatus("Saved");
    return true;
  }
  if (action === "edit") {
    const r = await window.thumb.edit(dir);
    if (!r.ok) setStatus(`Could not open the editor: ${r.detail ?? "unknown error"}`);
    return r.ok;
  }
  // trash
  window.thumb.event({ kind: "discarding" });
  const r = await window.thumb.trash(dir);
  // Cancelling the confirm dialog (a library-origin take, D1) is a decision,
  // not a fault (STC-392 review, I5) — the same rule `runExport`'s Save As
  // cancel already follows, checked before the generic failure branch so a
  // Cancel never reads as "Could not delete: cancelled".
  if (r.cancelled) { setStatus(""); return false; }
  if (!r.ok) { setStatus(`Could not delete: ${r.detail ?? "unknown error"}`); return false; }
  return true;
}

/**
 * Hide the actions this take does not have — see `panel-actions.ts`'s two
 * absences. Scoped to `[data-action]` for the same reason `setActionsEnabled`
 * is: the overflow badge sits in this row, is not one of the four take
 * actions, and must not be run through `available.has(undefined)` (always
 * false) or bound to `perform()`, which only understands `PanelAction`.
 */
for (const btn of document.querySelectorAll<HTMLButtonElement>("#actions button[data-action]")) {
  const action = btn.dataset.action as PanelAction;
  btn.hidden = !available.has(action);
  btn.addEventListener("click", (e) => { e.stopPropagation(); void perform(action); });
}

/**
 * The `+N` overflow badge (Task 5b / STC-392 D7) — hidden when nothing is
 * hidden. `n` is `thumbnail.ts`'s `hiddenCount`, computed once in
 * `thumbnail-window.ts`'s `restack` and handed to this window over
 * `onHiddenCount`; nothing here derives its own count (ruling 2 — one owner).
 */
window.thumb.onHiddenCount((n) => {
  overflowBtn.hidden = n <= 0;
  overflowBtn.textContent = `+${n}`;
});

/**
 * Clicking it asks main to bring every hidden panel back — "clicking expands
 * a list of waiting takes with the same actions" (the ticket's own words).
 * The hidden panels ARE that list; there is no second list UI here, only
 * this one event (`showAllOverflow`, `thumbnail-window.ts`).
 */
overflowBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  window.thumb.event({ kind: "showOverflow" });
});

// ---- keyboard paths (STC-392 focus rule 4) ----------------------------------

/**
 * Every action has a keyboard path (STC-392 focus rule 4).
 *
 * The accelerators are the system's own for these verbs — ⌘C, ⌘S, ⌘E — and
 * **⌘⌫ for the ✕, never a bare Delete or Backspace** (the spec's own guard,
 * decided 2026-09-16). This panel takes focus the instant it appears, over
 * whatever the user was typing into a moment earlier; a bare ⌫ bound to a
 * destructive action means a stray keystroke aimed at another app's text
 * field deletes a capture. ⌘⌫ is also what the Finder actually uses for
 * "move to Trash" — the bare key there deletes *text*, not files.
 *
 * Dispatched through `perform`, so a keyboard Save and a clicked Save are the
 * same code path and cannot disagree about whether the panel closes.
 *
 * Escape no longer closes the panel. It used to settle-and-close, which was
 * the timeout's manual equivalent; with no "close without deciding" in the
 * action table and Redact moved to the still editor (STC-300), Escape has no
 * job left here at all.
 */
const KEYS: ReadonlyArray<[PanelAction, (e: KeyboardEvent) => boolean]> = [
  ["copy",  (e) => e.metaKey && e.key.toLowerCase() === "c"],
  ["save",  (e) => e.metaKey && e.key.toLowerCase() === "s"],
  ["edit",  (e) => e.metaKey && e.key.toLowerCase() === "e"],
  // ⌘⌫, never bare — see the block comment above. Both key names, because
  // Backspace is what the laptop keyboard sends and Delete is the full-size one.
  ["trash", (e) => e.metaKey && (e.key === "Backspace" || e.key === "Delete")],
];

/**
 * How long after paint this panel starts accepting keys.
 *
 * The panel takes focus the instant it appears (focus rule 1), over whatever
 * the user was typing into. Keystrokes already in flight when it grabbed the
 * keyboard were aimed at the previous app and land here instead — so the first
 * `SETTLE_KEYS_MS` of the panel's life ignore input entirely. The spec calls
 * for "~300ms"; it is a constant rather than a literal because it is a
 * duration with a reason, and a second copy of it in a test would be the
 * defect this repo names five ways.
 *
 * Note this is a settling window, not a debounce: it starts once, at paint,
 * and never re-arms. A panel the user has been looking at for a minute must
 * not swallow a keystroke.
 */
const SETTLE_KEYS_MS = 300;
let keysLiveAt = Number.POSITIVE_INFINITY;   // set to `performance.now() + SETTLE_KEYS_MS` at paint

document.addEventListener("keydown", (e) => {
  if (performance.now() < keysLiveAt) return;
  for (const [action, matches] of KEYS) {
    if (!matches(e) || !available.has(action)) continue;
    e.preventDefault();
    void perform(action);
    return;
  }
});

// ---- swipe to discard (STC-296 follow-up) ----------------------------------

/** The gesture in progress, in client pixels. */
let swipeFrom: { x: number; y: number } | undefined;
/**
 * The decorated file a drag would hand over, written AHEAD of the gesture.
 *
 * It has to exist before `startDrag` is called, and the export is not fast
 * enough to happen inside one: measured, the 33 MB RGBA scratch write alone —
 * before any IPC or any encode — is around a quarter of a second, and a drag
 * that began by freezing for that long is not a drag. So it is written in the
 * background while the panel sits there, which is time the app is doing
 * nothing anyway.
 *
 * `undefined` means not ready. A drag that starts before it is REFUSES rather
 * than handing over something else: the acceptance criterion is that a drop
 * produces the decorated file, and an undecorated one would satisfy the
 * gesture while failing the requirement — the worst of the two failures,
 * because it looks like it worked.
 */
let dragFile: string | undefined;
/** Bumped by every change that invalidates the file above. */
let dragGeneration = 0;

/**
 * Write (or rewrite) the file a drag would carry.
 *
 * Every preset change and every redaction makes the previous one wrong, so
 * this runs again on each — and the generation counter is what stops a slow
 * earlier render landing after a fast later one and handing over the shot as
 * it used to look. Redaction makes that concrete: a stale file is one with
 * somebody's address still legible in it.
 */
async function refreshDragFile(): Promise<void> {
  if (!composite) return;
  const mine = ++dragGeneration;
  dragFile = undefined;
  const layout = layoutStill(shot);
  const plan = planRender({ ...(await window.thumb.getSettings()).still },
                          { layout, pxPerPoint: pxPerPointOf(shot) });
  const ctx = composite.getContext("2d", { alpha: true });
  const data = ctx!.getImageData(0, 0, composite.width, composite.height).data;
  const r = await window.thumb.dragFile({
    bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    width: composite.width, height: composite.height, alpha: plan.alpha,
    colorSpace: shot.display.colorSpace ?? "",
    options: {},
    info: { ...(shot.window?.app ? { app: shot.window.app } : {}),
            ...(shot.window?.title ? { title: shot.window.title } : {}),
            mode: shot.decoration.mode },
  });
  if (mine !== dragGeneration) return;
  if (r.ok && r.file) dragFile = r.file;
}

card.addEventListener("pointerdown", (e) => {
  // Only when nothing is already deciding an outcome for this take — the same
  // guard `perform` itself uses, so a swipe cannot start mid-Save any more
  // than a second click could.
  if (busy) return;
  // Not on a control. Every button needs its own click to reach it untouched
  // — `card.setPointerCapture` below redirects EVERY later pointer event on
  // this gesture to `card`, buttons included, which is exactly the
  // regression a real pointer click on Copy/Save/Edit/Trash hit the moment
  // the old collapsed/expanded split (where only the bare thumbnail, never a
  // button, could start a swipe) went away with STC-392's one-card panel.
  // Found by an E2E `panel.click()` failing while `.click()` in the page
  // succeeded — the same pointer-vs-programmatic gap a hidden BrowserWindow
  // cannot surface any other way.
  if ((e.target as HTMLElement).closest("button")) return;
  swipeFrom = { x: e.clientX, y: e.clientY };
  // Transition off while the card tracks the pointer; back on for the release
  // so both outcomes animate. See `#card.dragging` in thumbnail.html.
  card.classList.add("dragging");
  card.setPointerCapture(e.pointerId);
});

card.addEventListener("pointermove", (e) => {
  if (!swipeFrom) return;
  const dx = e.clientX - swipeFrom.x;
  const dy = e.clientY - swipeFrom.y;
  if (classifyDrag(dx, dy, corner) === "drag-out") {
    // The OS takes the pointer from here, so this gesture is over as far as
    // the panel is concerned — released or dropped, no pointerup will mean
    // anything to us.
    const file = dragFile;
    swipeFrom = undefined;
    card.classList.remove("dragging");
    card.style.transform = "";
    card.style.opacity = "";
    // Not ready yet: say so rather than dragging the wrong picture. See
    // `dragFile`'s note — an undecorated file would look like success.
    if (!file) { setStatus("Still preparing — try again in a moment."); return; }
    window.thumb.startDrag(file);
    return;
  }
  const off = swipeOffset(dx, dy, corner);
  // Follows the pointer only outward; a drag the wrong way leaves it put, so
  // "you cannot discard in that direction" needs no explaining.
  card.style.transform = off === 0 ? "" : `translateX(${off * discardDirection(corner)}px)`;
  // Fading as it goes is what makes the threshold legible without a number on
  // screen: by the time it is faint, releasing will throw it away.
  card.style.opacity = off === 0 ? "" : String(Math.max(0.25, 1 - off / 260));
});

card.addEventListener("pointerup", (e) => {
  const from = swipeFrom;
  if (!from) return;
  swipeFrom = undefined;
  card.classList.remove("dragging");
  const dx = e.clientX - from.x;
  const dy = e.clientY - from.y;
  if (!isDiscardSwipe(dx, dy, corner)) {
    // Short of the threshold: back to its corner.
    card.style.transform = "";
    card.style.opacity = "";
    return;
  }
  void discard();
});

// A cancelled pointer (another window taking it, the panel being hidden for a
// capture) is not a release: put the panel back rather than leaving it
// stranded mid-gesture with no pointerup ever coming.
card.addEventListener("pointercancel", () => {
  if (!swipeFrom) return;
  swipeFrom = undefined;
  card.classList.remove("dragging");
  card.style.transform = "";
  card.style.opacity = "";
});

/**
 * Throw the shot away — the swipe's outcome, and the same thing the
 * right-click Delete, the ⌘⌫ key and the ✕ button do: `perform("trash")`, so
 * all four agree by construction rather than by four separate authors
 * remembering the same rule.
 *
 * The slide-out animation is this function's own — `perform` has no opinion
 * about the card's transform — so it is applied before the call and undone
 * if the trash did not succeed, the same restore-on-failure the old direct
 * `deleteShot` call made.
 */
async function discard(): Promise<void> {
  card.style.transform = `translateX(${420 * discardDirection(corner)}px)`;
  card.style.opacity = "0";
  const ok = await perform("trash");
  if (!ok) {
    // Nothing was thrown away, so the panel comes back rather than vanishing
    // and leaving the user to guess whether the shot survived. The reason is
    // already in the status line — `run`'s trash branch set it.
    card.style.transform = "";
    card.style.opacity = "";
  }
}

/**
 * The right-click menu (STC-296's follow-up, rebuilt on `panel-actions.ts` by
 * STC-392).
 *
 * The menu is built and popped up by MAIN — `thumbnail-menu.ts` decides its
 * contents, `main.ts` turns them into a real `Menu`. This side reports the
 * gesture and performs whichever id comes back: the four take actions go
 * through the SAME `perform` the buttons and the keyboard use, so the menu
 * cannot drift from them either.
 *
 * "Copy it and get on with what I was doing" is worth most exactly when
 * nothing else has been touched yet.
 */
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  void (async () => {
    const id = await window.thumb.menu({ take, busy });
    if (id === null) return;
    if (id === "copy" || id === "save" || id === "edit" || id === "trash") {
      void perform(id);
      return;
    }
    if (id === "save-as") {
      if (busy) return;
      busy = true;
      setActionsEnabled(false);
      setStatus("Saving…");
      const ok = await runExport("save-as");
      busy = false;
      setActionsEnabled(true);
      // Same rule Save follows: a successful save ends the interaction.
      // Cancelling the panel returns false, so it correctly does not close.
      if (ok) window.thumb.event({ kind: "done" });
      return;
    }
    if (id === "reveal") {
      // The shot's own directory, not `still:reveal`'s last SAVED file: a take
      // still in temp storage has never been exported anywhere else, and
      // revealing some earlier shot instead would be worse than doing nothing.
      if (!await window.thumb.revealShot(dir)) setStatus("Nothing to show yet.");
    }
  })();
});

void (async () => {
  const bytes = await window.thumb.getFrame(dir, shot.frame.file);
  frame = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  await draw();
  markReady();
  // A silent panel is never shown, so there is nothing to paint FOR: it
  // copies to the clipboard the instant it can (`PresentOptions.silent`'s own
  // doc, `thumbnail-window.ts`) and reports "done" itself, since Copy alone
  // never closes a panel that has controls to click — this one has none.
  //
  // `skip` means "never show me the panel, copy it and get out of my way" —
  // it does NOT mean "never keep it". A silent panel has no Save button this
  // take could ever reach, so if the copy succeeds this is the one place
  // that promotes it, through the same `panel:save` channel the button uses
  // rather than a second promote path. Copy itself still never promotes
  // (`run`'s "copy" branch, unchanged) — that rule is pinned by
  // `panel-waits.e2e.test.ts` and stands; without this call, though, a skip
  // capture would sit in temp storage until the 7-day purge, nagging from
  // the crash-recovery dialog the whole time, because it is the one
  // preference whose entire point is "copy it and get on with it".
  if (silent) {
    if (await run("copy")) await window.thumb.save(dir);
    window.thumb.event({ kind: "done" });
    return;
  }
  // Painted — safe to show without a flash of empty content, and the moment
  // this panel starts accepting keys (after `SETTLE_KEYS_MS` — see the block
  // comment above the keydown listener).
  requestAnimationFrame(() => {
    keysLiveAt = performance.now() + SETTLE_KEYS_MS;
    // Published on the card, in this page's own `performance.now()` clock, so
    // a test that reaches this panel AFTER it painted can tell whether it is
    // still inside the settle window rather than assuming (STC-427: on a
    // loaded CI runner the assumption was wrong, the press was honoured, and
    // "ignores a key inside the window" read as a product failure).
    card.dataset.keysLiveAt = String(keysLiveAt);
    card.classList.add("in");
    window.thumb.event({ kind: "painted" });
  });
  // Only NOW, and deliberately not awaited: the panel is on screen and idle
  // until a person acts, so the drag file that a drag-out would otherwise
  // have to wait for happens in time nobody is using. Nothing downstream
  // waits on it — a drag that beats it is refused rather than served the
  // wrong file.
  void refreshDragFile();
})();
