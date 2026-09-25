import { pixelSize, rectContains, type DisplayInfo, type Point, type Rect } from "./selection.js";
import { micLabel, type MicInfo } from "./mic-devices.js";

/**
 * The options bar's decisions (STC-388), with no DOM and no Electron.
 *
 * Same arrangement `selection.ts` has for the marquee and `overlay-hittest.ts`
 * for its handles: everything that DECIDES — where the bar sits, what is in it,
 * which control a press lands on, what the mic menu offers — lives here and is
 * exercised by `app/test/record-options.test.ts` without a screen, a pointer or
 * an app. `overlay.ts` draws it; it does not repeat the reasoning.
 *
 * Every rect here is in GLOBAL points, the same space `selection.ts` works in,
 * so the bar and the marquee can be compared without conversion and a bar on a
 * second display needs no special case.
 */

export type ControlId = "size" | "expand" | "mic" | "camera" | "record";

/** Left to right, as drawn. The readout first because it is the thing being
 * confirmed; Record last because it is the thing being committed to. */
export const CONTROL_IDS: readonly ControlId[] = ["size", "expand", "mic", "camera", "record"];

export interface OptionsState {
  /** Sticky (`Settings.micDeviceUid`); null is "no mic", never "the default". */
  micDeviceUid: string | null;
  /** Sticky (`Settings.camera`). */
  camera: boolean;
  /** What the mic menu can offer. Empty disables the control outright. */
  mics: readonly MicInfo[];
  /**
   * Set by the `expand` control, NEVER inferred from the marquee's geometry.
   *
   * `SelectionOutcome` has only `region` and `window` kinds, so "the whole
   * display" has no representation in it — and the two candidate encodings are
   * not equivalent downstream: `{ displayId, region }` covering the full screen
   * takes the helper's crop path, a bare `{ displayId }` takes its full-display
   * path. Deriving this from "does the rect equal the display bounds" would be
   * a second rule for one answer, and would silently reclassify someone who
   * happened to drag to the edges.
   */
  fullDisplay: boolean;
  micMenuOpen: boolean;
}

// ── the bar's geometry ──────────────────────────────────────────────────────

export const BAR_HEIGHT = 44;
/** Between the marquee's edge and the bar. */
export const BAR_GAP = 12;
/** The closest the bar or its menu may come to a display edge. */
export const BAR_MARGIN = 8;
const BAR_PADDING = 10;
const CONTROL_GAP = 8;

/** Each control's width. The bar's width is DERIVED from these, so a control
 * cannot be widened into a bar that has no room for it. */
const CONTROL_WIDTHS: Record<ControlId, number> = {
  size: 104, expand: 36, mic: 88, camera: 36, record: 92,
};
const CONTROL_HEIGHT = BAR_HEIGHT - BAR_PADDING;

/** The one place the bar's width is decided — never a literal. */
export function barWidth(): number {
  const controls = CONTROL_IDS.reduce((n, id) => n + CONTROL_WIDTHS[id], 0);
  return BAR_PADDING * 2 + controls + CONTROL_GAP * (CONTROL_IDS.length - 1);
}

export interface BarLayout {
  rect: Rect;
  /**
   * `inside` is the fallback, not a preference: a marquee covering the whole
   * display leaves nowhere that does not overlap it, so "never overlaps" cannot
   * be absolute. Named rather than silent so the view can style it.
   */
  placement: "below" | "above" | "inside";
  controls: readonly { id: ControlId; rect: Rect }[];
}

const clamp = (v: number, lo: number, hi: number): number =>
  hi < lo ? lo : Math.min(Math.max(v, lo), hi);

/**
 * Where the bar sits for a given marquee, in global points.
 *
 * Below, else above, else inside — and the choice is reported rather than
 * inferred from the numbers, so a caller cannot arrive at a different answer
 * from the same rect.
 */
export function barLayout(selection: Rect, display: DisplayInfo): BarLayout {
  const b = display.bounds;
  const width = barWidth();
  const minX = b.x + BAR_MARGIN;
  const maxX = b.x + b.width - BAR_MARGIN - width;
  const x = clamp(selection.x + selection.width / 2 - width / 2, minX, maxX);

  const below = selection.y + selection.height + BAR_GAP;
  const above = selection.y - BAR_GAP - BAR_HEIGHT;
  let y: number;
  let placement: BarLayout["placement"];
  if (below + BAR_HEIGHT <= b.y + b.height - BAR_MARGIN) {
    y = below; placement = "below";
  } else if (above >= b.y + BAR_MARGIN) {
    y = above; placement = "above";
  } else {
    // Anchored to the bottom inner edge: the marquee's own bottom is where the
    // eye already is after a drag, and it is the edge least likely to cover
    // what the user was pointing at.
    y = clamp(selection.y + selection.height - BAR_MARGIN - BAR_HEIGHT,
              b.y + BAR_MARGIN, b.y + b.height - BAR_MARGIN - BAR_HEIGHT);
    placement = "inside";
  }

  const rect: Rect = { x, y, width, height: BAR_HEIGHT };
  const controls: { id: ControlId; rect: Rect }[] = [];
  let cx = x + BAR_PADDING;
  for (const id of CONTROL_IDS) {
    const w = CONTROL_WIDTHS[id];
    controls.push({
      id, rect: { x: cx, y: y + (BAR_HEIGHT - CONTROL_HEIGHT) / 2, width: w, height: CONTROL_HEIGHT },
    });
    cx += w + CONTROL_GAP;
  }
  return { rect, placement, controls };
}

/** Which control a press landed on, or undefined for the bar's own padding
 * and everything outside it. */
export function controlAt(p: Point, layout: BarLayout): ControlId | undefined {
  if (!rectContains(layout.rect, p)) return undefined;
  return layout.controls.find((c) => rectContains(c.rect, p))?.id;
}

/**
 * A control with nothing behind it is shown disabled rather than hidden: a bar
 * that changes width depending on the machine would move Record out from under
 * the pointer between one take and the next.
 */
export function controlEnabled(id: ControlId, s: OptionsState): boolean {
  if (id === "mic") return s.mics.length > 0;
  return true;
}

// ── the mic menu ────────────────────────────────────────────────────────────

const MIC_ITEM_HEIGHT = 28;
const MIC_MENU_WIDTH = 220;

export interface MicMenuLayout {
  rect: Rect;
  items: readonly { uid: string | null; label: string; rect: Rect }[];
}

/**
 * The open mic menu, or undefined when it is closed or has nothing to list.
 *
 * Drawn by the overlay rather than opened as a native menu: this is a
 * transparent always-on-top panel, and a native popup would take key focus off
 * it — the failure 5850e4f cost us once already on the countdown.
 */
export function micMenuLayout(layout: BarLayout, s: OptionsState,
                              display: DisplayInfo): MicMenuLayout | undefined {
  if (!s.micMenuOpen || s.mics.length === 0) return undefined;
  const anchor = layout.controls.find((c) => c.id === "mic");
  if (!anchor) return undefined;

  // "Off" first, and always present: null is a real choice here, not an
  // absence — there is no automatic mic (settings.ts), so the list has to be
  // able to say so.
  const entries: { uid: string | null; label: string }[] =
    [{ uid: null, label: "Off" },
     ...s.mics.map((m) => ({ uid: m.uid, label: micLabel(m) }))];

  const b = display.bounds;
  const height = entries.length * MIC_ITEM_HEIGHT;
  const x = clamp(anchor.rect.x, b.x + BAR_MARGIN, b.x + b.width - BAR_MARGIN - MIC_MENU_WIDTH);
  // Above the bar when the bar is low, below it otherwise — the menu follows
  // the bar's own reasoning rather than inventing a second one.
  const belowBar = layout.rect.y + layout.rect.height + 4;
  const y = belowBar + height <= b.y + b.height - BAR_MARGIN
    ? belowBar
    : clamp(layout.rect.y - 4 - height, b.y + BAR_MARGIN, b.y + b.height - BAR_MARGIN - height);

  return {
    rect: { x, y, width: MIC_MENU_WIDTH, height },
    items: entries.map((e, i) => ({
      ...e,
      rect: { x, y: y + i * MIC_ITEM_HEIGHT, width: MIC_MENU_WIDTH, height: MIC_ITEM_HEIGHT },
    })),
  };
}

export function micItemAt(p: Point, menu: MicMenuLayout): { uid: string | null } | undefined {
  const hit = menu.items.find((i) => rectContains(i.rect, p));
  return hit ? { uid: hit.uid } : undefined;
}

// ── what the controls mean ──────────────────────────────────────────────────

/** What `expand` selects: the display's own bounds, in global points. */
export function expandedSelection(display: DisplayInfo): Rect {
  return { ...display.bounds };
}

/**
 * The W×H readout, in PIXELS.
 *
 * Points are what the marquee is drawn in; pixels are what the file will be,
 * and are the number anyone checks against a spec. `pixelSize` is the overlay's
 * existing conversion — used rather than re-derived, so the bar and the
 * selection chip cannot disagree about one rect.
 */
export function sizeLabel(selection: Rect, display: DisplayInfo): string {
  const { width, height } = pixelSize(selection, display);
  return `${width} × ${height}`;
}
