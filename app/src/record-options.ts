import { MIN_SELECTION_POINTS, pixelSize, rectContains, type DisplayInfo, type Point, type Rect } from "./selection.js";
import type { MicInfo } from "./mic-devices.js";
import type { DeviceLike, DeviceSelection } from "./device-picker.js";

/**
 * The options bar's decisions (STC-388, then STC-456's two-row pane), with no
 * DOM and no Electron.
 *
 * Same arrangement `selection.ts` has for the marquee and `overlay-hittest.ts`
 * for its handles: everything that DECIDES — where the bar sits, what is in it,
 * which control a press lands on, where a menu opens — lives here and is
 * exercised by `app/test/record-options.test.ts` without a screen, a pointer or
 * an app. `overlay.ts` draws it; it does not repeat the reasoning.
 *
 * Every rect here is in GLOBAL points, the same space `selection.ts` works in,
 * so the bar and the marquee can be compared without conversion and a bar on a
 * second display needs no special case.
 */

export type ControlId =
  | "size" | "expand" | "crop" | "settings" | "mic" | "camera" | "keys" | "clicks" | "record";

/** Row 1, then row 2, then the capture button (STC-456, Capture SK 016 Frame 9). */
export const CONTROL_IDS: readonly ControlId[] =
  ["size", "expand", "crop", "settings", "mic", "camera", "keys", "clicks", "record"];

export type MenuId = "mic" | "camera";

export interface OptionsState extends DeviceSelection {
  /**
   * What the mic menu can offer. The mic trigger is ALWAYS enabled, even when
   * this is empty — a Mac mini/Studio with no mic attached, or a stalled
   * enumeration (`devicesForBar` returning `mics: []`), must still reach
   * Include System Audio and Mute External, both of which live in this menu
   * now and neither of which needs a mic to exist (STC-456 review).
   */
  mics: readonly MicInfo[];
  /** What the camera menu can offer. Empty still offers No Camera / Automatic. */
  cameras: readonly DeviceLike[];
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
  /** Record keyboard commands this take (STC-419). Sticky via settings.recordKeys. */
  keys: boolean;
  /**
   * The bar's Show Clicks toggle (STC-420). ON by default: the highlight
   * existed before the control did. Reaches the take through its project.json
   * (main.ts), never through a live setting the sinks read.
   */
  showClicks: boolean;
  /** Which menu is open, if any. One at a time. */
  openMenu: MenuId | null;
}

// ── the bar's geometry ──────────────────────────────────────────────────────

/** Between the marquee's edge and the bar. */
export const BAR_GAP = 12;
/** The closest the bar or its menu may come to a display edge. */
export const BAR_MARGIN = 8;

// Given by Patrick (2026-09-28): the pane and its padding.
export const PANE_WIDTH = 340;
export const PANE_HEIGHT = 108;
export const PANE_PADDING = 16;
// Measured from the frame, not given. Tune here, nowhere else.
const ROW_HEIGHT = 32;
const ROW_GAP = 12;
const ICON_CONTROL = 32;
const CARET_CONTROL = 48;          // icon + ▾
export const CAPTURE_GAP = 8;
export const CAPTURE_HEIGHT = 36;
export const MENU_GAP = 4;
/**
 * The device menu's own row metrics (STC-456 fix round, Finding 7) —
 * `device-menu.css`'s `.device-menu .row { height: 44px }` and its
 * `padding: 4px 0`, named here rather than re-guessed. `menuHeight` is the
 * ONE place a row count becomes a pixel height; a fixed `MENU_MAX_HEIGHT`
 * guess (280, sized for 6 rows) under-counted a real 7-row menu by about
 * 36px, which could pick "below" when the menu actually ran off the
 * display's bottom. The view still SIZES the menu (only the DOM knows a
 * label's actual width), but the below/above decision needs this estimate
 * before the DOM exists.
 */
export const MENU_ROW_HEIGHT = 44;
export const MENU_VERTICAL_PADDING = 8; // 4px top + 4px bottom
export function menuHeight(rowCount: number): number {
  return rowCount * MENU_ROW_HEIGHT + MENU_VERTICAL_PADDING;
}

/** The whole block the placement rules move: pane + gap + capture button. */
export const BAR_HEIGHT = PANE_HEIGHT + CAPTURE_GAP + CAPTURE_HEIGHT;

const ROW2: readonly { id: ControlId; w: number }[] = [
  { id: "settings", w: ICON_CONTROL }, { id: "mic", w: CARET_CONTROL },
  { id: "camera", w: CARET_CONTROL }, { id: "keys", w: ICON_CONTROL }, { id: "clicks", w: ICON_CONTROL },
];

function paneControls(pane: Rect): { id: ControlId; rect: Rect }[] {
  const inner = { x: pane.x + PANE_PADDING, y: pane.y + PANE_PADDING,
                  width: PANE_WIDTH - PANE_PADDING * 2 };
  const y1 = inner.y, y2 = inner.y + ROW_HEIGHT + ROW_GAP;
  const right = inner.x + inner.width;
  const crop = { x: right - ICON_CONTROL, y: y1, width: ICON_CONTROL, height: ROW_HEIGHT };
  const expand = { x: crop.x - 8 - ICON_CONTROL, y: y1, width: ICON_CONTROL, height: ROW_HEIGHT };
  // 16 before expand: room for the hairline divider the view draws there.
  const size = { x: inner.x, y: y1, width: expand.x - 16 - inner.x, height: ROW_HEIGHT };
  const used = ROW2.reduce((n, c) => n + c.w, 0);
  const gap = (inner.width - used) / (ROW2.length - 1);
  let x = inner.x;
  const row2 = ROW2.map((c) => {
    const r = { id: c.id, rect: { x, y: y2, width: c.w, height: ROW_HEIGHT } };
    x += c.w + gap;
    return r;
  });
  return [{ id: "size", rect: size }, { id: "expand", rect: expand }, { id: "crop", rect: crop }, ...row2];
}

export interface BarLayout {
  rect: Rect;
  pane: Rect;
  capture: Rect;
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
  const width = PANE_WIDTH;
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

  const pane: Rect = { x, y, width: PANE_WIDTH, height: PANE_HEIGHT };
  const capture: Rect = { x, y: y + PANE_HEIGHT + CAPTURE_GAP, width: PANE_WIDTH, height: CAPTURE_HEIGHT };
  const controls = [...paneControls(pane), { id: "record" as const, rect: capture }];
  return { rect: { x, y, width: PANE_WIDTH, height: BAR_HEIGHT }, pane, capture, placement, controls };
}

/** A press the bar swallows: on the pane (padding included) or the capture
 * button, never the gap between them, which is the user's screen. */
export function barContains(p: Point, layout: BarLayout): boolean {
  return rectContains(layout.pane, p) || rectContains(layout.capture, p);
}

export function controlAt(p: Point, layout: BarLayout): ControlId | undefined {
  if (!barContains(p, layout)) return undefined;
  return layout.controls.find((c) => rectContains(c.rect, p))?.id;
}

/**
 * Keys (STC-419) and clicks (STC-420) are both live; nothing on the bar is a
 * disabled slot any more.
 *
 * The mic control is ALWAYS enabled (STC-456 review, Finding 1) — its menu
 * holds Include System Audio and Mute External, neither of which needs a mic
 * to exist, so a machine with zero mics (or a stalled enumeration) must still
 * be able to open it. No state is consulted for any control any more, so this
 * takes none.
 */
export function controlEnabled(id: ControlId): boolean {
  return true;
}

/** What one press in the options phase sends, in ORDER. */
export type BarPressAction =
  | { t: "commitSize" }
  | { t: "menuClose" }
  | { t: "control"; id: ControlId };

export interface BarPress {
  /** A size input has focus right now (a typed value may be uncommitted). */
  fieldFocused: boolean;
  /** The press landed ON one of the size inputs. */
  onField: boolean;
  menuOpen: boolean;
  /** `controlAt` for the press, undefined off every control. */
  hit: ControlId | undefined;
  /** `barContains` for the press: pane padding and capture button included. */
  inBar: boolean;
  /** `controlEnabled(hit)`; ignored when `hit` is undefined. */
  enabled: boolean;
}

/**
 * The options-phase pointerdown, decided (STC-456 fix round 1). No DOM.
 *
 * 1. A typed size is committed FIRST. The browser only moves focus (and fires
 *    the blur that would commit it) after pointerdown has run, so without this
 *    a press on Capture Video sent `control:record` before `size` and the take
 *    started at the old size. The session handles IPC in order, so committing
 *    here puts `size` ahead of whatever follows.
 * 2. With a menu open, a press only closes it — the capture button's edges
 *    either side of a menu are a dismiss target, not a start button. The two
 *    triggers are the exception: their own `control` switches or closes the
 *    menu in one step.
 * 3. Otherwise an enabled control acts; the size field acts by taking focus.
 *
 * `swallow` says the press stops here rather than reaching the selection
 * reducer: anything on the bar, and any press that closed a menu.
 */
export function barPress(p: BarPress): { actions: BarPressAction[]; swallow: boolean } {
  const actions: BarPressAction[] = [];
  if (p.fieldFocused && !p.onField) actions.push({ t: "commitSize" });
  const trigger = p.hit === "mic" || p.hit === "camera";
  if (p.menuOpen && !trigger) {
    actions.push({ t: "menuClose" });
    return { actions, swallow: true };
  }
  if (p.hit && p.hit !== "size" && p.enabled) actions.push({ t: "control", id: p.hit });
  return { actions, swallow: p.hit !== undefined || p.inBar };
}

export interface MenuAnchor { menu: MenuId; x: number; y: number; side: "below" | "above"; }

/**
 * Where a menu opens: dropping from its trigger's bottom-left and OVER the
 * capture button (Patrick, 2026-09-28). Flipped above the trigger whenever
 * trigger-bottom + `MENU_GAP` + `menuHeight(rowCount)` would cross the
 * display's bottom minus `BAR_MARGIN` — NOT only when the bar itself sits at
 * the bottom edge (an earlier doc's claim): a bar in ordinary `below`
 * placement, with the trigger far enough down the pane, crosses that same
 * line for a menu with enough rows, and flips for exactly the same reason.
 * `rowCount` lets this be precise instead of a fixed guess (Finding 7): a
 * short 2-row mic menu and a full 7-row camera list do not need the same
 * clearance. `y` is the menu's NEAR edge: its top when below, its bottom when
 * above. The view still clamps the menu horizontally, since only it knows the
 * rendered width.
 */
export function menuAnchor(layout: BarLayout, menu: MenuId, display: DisplayInfo,
                           rowCount: number): MenuAnchor {
  const trig = layout.controls.find((c) => c.id === menu)!.rect;
  const b = display.bounds;
  const below = trig.y + trig.height + MENU_GAP;
  if (below + menuHeight(rowCount) <= b.y + b.height - BAR_MARGIN) {
    return { menu, side: "below", x: trig.x, y: below };
  }
  return { menu, side: "above", x: trig.x, y: trig.y - MENU_GAP };
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

/** A typed dimension: digits only, positive. Anything else is "not a number
 * yet", and the field reverts rather than guessing. */
export function parseDimension(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n > 0 ? n : undefined;
}

/**
 * The marquee after the user types a size in PIXELS (the unit the readout
 * shows, `sizeLabel`), in global POINTS. Centred on the old anchor, whole
 * points, at least MIN_SELECTION_POINTS, at most the display, then shifted
 * (never shrunk) to sit inside it.
 */
export function resizeToPixels(anchor: Rect, display: DisplayInfo,
                               widthPx: number, heightPx: number): Rect {
  const b = display.bounds;
  const s = display.scaleFactor > 0 ? display.scaleFactor : 1;
  const w = clamp(Math.round(widthPx / s), MIN_SELECTION_POINTS, b.width);
  const h = clamp(Math.round(heightPx / s), MIN_SELECTION_POINTS, b.height);
  const cx = anchor.x + anchor.width / 2, cy = anchor.y + anchor.height / 2;
  const x = clamp(Math.round(cx - w / 2), b.x, b.x + b.width - w);
  const y = clamp(Math.round(cy - h / 2), b.y, b.y + b.height - h);
  return { x, y, width: w, height: h };
}
