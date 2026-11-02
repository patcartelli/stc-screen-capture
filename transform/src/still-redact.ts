import type { Redaction } from "./shot.js";
import type { Point, Size } from "./spaces.js";
import { pixelsToUvRect } from "./spaces.js";

/**
 * Redaction's decisions (STC-297): what colour a fill is, and what a drag means.
 *
 * The same split every other still module keeps — this decides, `still-render.ts`
 * draws, and `app/src/thumbnail-renderer.ts` supplies the pointer. Nothing here
 * touches a canvas, so the whole of it is exercised by
 * `transform/test/still-redact.test.ts` without a browser.
 *
 * ## v1 is solid fill, and that is a security decision rather than a taste one
 *
 * The ticket's reasoning, kept here because it is the thing most likely to be
 * "improved" later: blur and pixelate both LOOK safe while being recoverable —
 * a light gaussian over 8pt text can be undone, and mosaic over a known font is
 * worse. A solid fill is the only treatment that is obviously irreversible to
 * the person sharing AND to the person receiving. Blur comes back only with an
 * adversarial test attached (sharpen, upscale, assert nothing is legible).
 *
 * ## Near-black is not "95% black"
 *
 * The ticket forbids partial alpha in as many words, and this does not use any:
 * every fill is drawn at alpha 1, so the covered pixels are REPLACED, not
 * shaded. What is "near" about near-black is the COLOUR, not the opacity — a
 * pure `#000` rectangle on a light screenshot reads as a rendering failure or a
 * missing image, while a hair off black reads as ink someone chose to put
 * there. Irreversibility is a property of the alpha; legibility as a deliberate
 * act is a property of the hue. They do not trade against each other.
 */

/** Near-black, for a fill sitting on light content. */
export const REDACTION_FILL_ON_LIGHT = "#0b0b0c";
/** Near-white, for a fill sitting on dark content. */
export const REDACTION_FILL_ON_DARK = "#f2f2f3";

/**
 * Mean luminance at or above this reads as "light content", so the fill goes
 * dark. Exactly 0.5 counts as light: a mid-grey is more often a light UI's
 * chrome than a dark one's, and the tie has to fall somewhere stated.
 */
export const REDACTION_LUMINANCE_THRESHOLD = 0.5;

/**
 * The smallest drag that counts as a region, in CAPTURE pixels.
 *
 * A bare click is not a redaction — it is how someone dismisses a menu or
 * checks that the panel has focus, the same rule `selection.ts` applies to the
 * overlay's marquee. Callers dragging on a scaled-down preview should pass
 * their own minimum in capture pixels (a few preview pixels' worth), because
 * four capture pixels of a 4K shot is a fraction of one preview pixel and
 * would let a click through.
 */
export const MIN_REDACTION_PX = 4;

export type { Point, Size } from "./spaces.js";

/**
 * Mean relative luminance of an RGBA buffer, 0..1, weighted by alpha.
 *
 * Rec. 709 coefficients on the GAMMA-ENCODED values rather than linearised
 * ones, deliberately: the answer this feeds is a binary "is the content under
 * this box light or dark", and the extra pass to linearise buys nothing a
 * threshold can see. It is the same weighted sum every "is this background
 * light?" check uses.
 *
 * Alpha WEIGHTS rather than being ignored, which matters for the transparent
 * modes: a window capture's rounded corner is `rgba(0,0,0,0)`, and counting
 * those as black would drag a region near a corner toward "dark content" and
 * put a near-white box on a light window. A region that is entirely
 * transparent has no content to judge, and reports 1 — light — so it takes the
 * near-black fill, which is the one that reads as deliberate against the
 * checkerboard a transparent PNG is usually shown on.
 */
export function meanLuminance(rgba: ArrayLike<number>): number {
  let sum = 0;
  let weight = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = (rgba[i + 3] as number) / 255;
    if (a === 0) continue;
    const l = (0.2126 * (rgba[i] as number)
             + 0.7152 * (rgba[i + 1] as number)
             + 0.0722 * (rgba[i + 2] as number)) / 255;
    sum += l * a;
    weight += a;
  }
  return weight === 0 ? 1 : sum / weight;
}

/** The fill for content of a given mean luminance. */
export function fillForLuminance(luminance: number): string {
  return luminance >= REDACTION_LUMINANCE_THRESHOLD
    ? REDACTION_FILL_ON_LIGHT : REDACTION_FILL_ON_DARK;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Two drag points in CAPTURE pixels → a normalised region, or undefined for a
 * drag too small to be one.
 *
 * Normalised (0..1 of the frame) because that is what `shot.json` stores and
 * what makes the ticket's "fill regions move with the content when the crop
 * changes, not with the canvas" true by construction rather than by
 * arithmetic: `layoutStill` multiplies these by the CONTENT rect, so padding,
 * a canvas preset and an output scale all move the box with the picture.
 *
 * A drag that leaves the capture CLAMPS rather than being refused — dragging
 * off the edge to cover something at the margin is the normal way to redact
 * something at the margin, and refusing it would be the panel declining to do
 * the obvious thing.
 */
export function normaliseRegion(a: Point, b: Point, frame: Size,
                                minPx = MIN_REDACTION_PX): Redaction | undefined {
  if (frame.width <= 0 || frame.height <= 0) return undefined;
  const x0 = clamp(Math.min(a.x, b.x), 0, frame.width);
  const x1 = clamp(Math.max(a.x, b.x), 0, frame.width);
  const y0 = clamp(Math.min(a.y, b.y), 0, frame.height);
  const y1 = clamp(Math.max(a.y, b.y), 0, frame.height);
  if (x1 - x0 < minPx || y1 - y0 < minPx) return undefined;
  // Capture pixels -> UV over the capture. The clamp above is policy; the
  // division is spaces.ts's (STC-314), so this cannot drift from the
  // conversion that reads the region back out.
  return pixelsToUvRect(
    { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    { x: 0, y: 0, width: frame.width, height: frame.height },
  );
}

/**
 * Undo the last region. A whole editing model is not needed at this size (the
 * ticket says so); what is needed is that a mis-drag costs one gesture rather
 * than the shot.
 */
export function undoLast(regions: readonly Redaction[]): Redaction[] {
  return regions.slice(0, -1);
}

// ── the keyboard path (STC-576) ──────────────────────────────────────────────
//
// A box can be placed, moved, resized and deleted without a pointer. The
// canvas takes the focus (Tab reaches it), and these keys act on it:
//
//   Return / Space        place a new box, centred, and select it
//   ] / [                 select the next / previous box
//   arrows                move the selected box (⇧: a bigger step)
//   ⌥ + arrows            resize it from its bottom-right corner (⇧: bigger)
//   Delete / ⌫            delete it
//
// Tab is never taken: it must still leave the canvas. Escape is the window's
// (it closes, STC-443), so it stays untouched here too.
//
// Steps are fractions of the CAPTURE, never view pixels: a step has to mean
// the same thing at every window size, the same reason regions are stored
// normalised. A box always stays inside the frame and never shrinks under
// `MIN_REDACTION_PX` on either side, so no key can make a box a click would
// not have made.

/** A new box's size, as a fraction of the capture. Big enough to see at once, small enough to move. */
export const KEYBOARD_REDACTION_SIZE = { width: 0.2, height: 0.1 } as const;
/** One arrow press, as a fraction of the capture: 1%. */
export const REDACTION_STEP = 0.01;
/** One ⇧-arrow press: 10%. */
export const REDACTION_STEP_LARGE = 0.1;

/** A new box, centred on the capture. */
export function placeRegion(): Redaction {
  const { width, height } = KEYBOARD_REDACTION_SIZE;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

/** Moved by (dx, dy), kept whole and inside the frame. */
export function moveRegion(r: Redaction, dx: number, dy: number): Redaction {
  return {
    x: clamp(r.x + dx, 0, 1 - r.width),
    y: clamp(r.y + dy, 0, 1 - r.height),
    width: r.width, height: r.height,
  };
}

/**
 * Grown (or shrunk) by (dw, dh) from its bottom-right corner: never past the
 * frame's edge, never under `minPx` capture pixels on a side.
 */
export function resizeRegion(r: Redaction, dw: number, dh: number, frame: Size,
                             minPx = MIN_REDACTION_PX): Redaction {
  const minW = frame.width > 0 ? Math.min(1, minPx / frame.width) : 0;
  const minH = frame.height > 0 ? Math.min(1, minPx / frame.height) : 0;
  return {
    x: r.x, y: r.y,
    width: clamp(r.width + dw, minW, 1 - r.x),
    height: clamp(r.height + dh, minH, 1 - r.y),
  };
}

/** The canvas's whole keyboard state: the boxes, and which one the keys act on. */
export interface RedactKeyState {
  regions: readonly Redaction[];
  /** Index into `regions`, or undefined when none is selected. */
  selected: number | undefined;
}

/** The parts of a `KeyboardEvent` this reads, so a test needs no DOM. */
export interface RedactKey {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export interface RedactKeyResult extends RedactKeyState {
  /** The boxes changed, so they must be redrawn and stored. A selection alone is not a change. */
  changed: boolean;
}

/** After a box is gone, the selection moves to the one before it, or none is left. */
export function selectionAfterDelete(deleted: number, remaining: number): number | undefined {
  return remaining === 0 ? undefined : Math.min(Math.max(0, deleted - 1), remaining - 1);
}

/**
 * What a key does on the focused canvas, or undefined when it is not the
 * canvas's key: the caller then leaves the event alone, so ⌘Z, ⌘S, Tab and
 * Escape keep doing what they did.
 */
export function decideRedactKey(k: RedactKey, s: RedactKeyState, frame: Size): RedactKeyResult | undefined {
  // Every command shortcut is the window's; ⌥ is ours (resize).
  if (k.metaKey || k.ctrlKey) return undefined;
  const regions = s.regions;
  const selected = s.selected !== undefined && s.selected >= 0 && s.selected < regions.length
    ? s.selected : undefined;

  if (k.key === "Enter" || k.key === " ") {
    const next = [...regions, placeRegion()];
    return { regions: next, selected: next.length - 1, changed: true };
  }
  if (k.key === "]" || k.key === "[") {
    if (regions.length === 0) return { regions: [...regions], selected: undefined, changed: false };
    const n = regions.length;
    const to = selected === undefined
      ? (k.key === "]" ? 0 : n - 1)
      : (selected + (k.key === "]" ? 1 : n - 1)) % n;
    return { regions: [...regions], selected: to, changed: false };
  }
  if (k.key === "Delete" || k.key === "Backspace") {
    if (selected === undefined) return { regions: [...regions], selected: undefined, changed: false };
    const next = regions.filter((_, i) => i !== selected);
    return { regions: next, selected: selectionAfterDelete(selected, next.length), changed: true };
  }
  const arrow = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as
    Record<string, [number, number]>)[k.key];
  if (!arrow) return undefined;
  if (selected === undefined) return { regions: [...regions], selected: undefined, changed: false };
  const step = k.shiftKey ? REDACTION_STEP_LARGE : REDACTION_STEP;
  const [ax, ay] = arrow;
  const r = regions[selected]!;
  const moved = k.altKey
    ? resizeRegion(r, ax * step, ay * step, frame)
    : moveRegion(r, ax * step, ay * step);
  const next = regions.map((x, i) => (i === selected ? moved : x));
  const changed = moved.x !== r.x || moved.y !== r.y || moved.width !== r.width || moved.height !== r.height;
  return { regions: next, selected, changed };
}
