/**
 * What size the main window opens at (STC-560) — pure, no Electron.
 *
 * The library and the Settings window. Both used to open at 520 x 680, a
 * narrow column the grid and the sheet were cramped in. Decisions, Patrick
 * 2026-10-19, and STC-581 for Settings:
 *
 * 1. The library opens at `LIBRARY_SIZE`: four of the grid's 210px columns
 *    (`.libgrid`'s `minmax(210px, 1fr)`, 14px gaps) inside the body's 20px
 *    gutters. Its floor, `LIBRARY_MIN_SIZE`, still fits two.
 * 2. Settings is its own window at `SETTINGS_SIZE` (STC-581: 760 x 560, a
 *    180px sidebar and a 580px pane), fixed in size. It is never remembered.
 * 3. The library remembers where it was (`Settings.libraryWindow`), and only
 *    main writes that. A remembered place is used only while its title bar
 *    is on a connected display, and is pulled fully inside that display's
 *    work area. Otherwise the default is used.
 * 4. Every size is clamped to the work area and centred in it, so a small
 *    display gets a smaller window rather than one that runs off screen.
 */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

export const LIBRARY_SIZE: Size = { width: 960, height: 720 };
export const LIBRARY_MIN_SIZE: Size = { width: 480, height: 420 };
export const SETTINGS_SIZE: Size = { width: 760, height: 560 };

/**
 * How far below a window's top edge its title bar is taken to be. The window
 * is `titleBarStyle: "hidden"`, so this is where the traffic lights and the
 * drag region sit (main.ts's `TRAFFIC_LIGHT_Y_PX` is 24).
 */
const TITLE_BAR_PROBE_PX = 14;

/** `size`, no larger than `area`, centred in it, in whole pixels. */
export function centredIn(size: Size, area: Rect): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width, height,
  };
}

/** `size` no larger than `area` — a minimum size must not exceed the display either. */
export function clampSize(size: Size, area: Rect): Size {
  return { width: Math.min(size.width, area.width), height: Math.min(size.height, area.height) };
}

function contains(area: Rect, px: number, py: number): boolean {
  return px >= area.x && px < area.x + area.width && py >= area.y && py < area.y + area.height;
}

/**
 * Where the library opens. `saved` is the remembered place (or null),
 * `workAreas` every connected display's work area, `here` the work area of
 * the display the window should otherwise appear on (the one under the
 * pointer).
 */
export function libraryBounds(saved: Rect | null, workAreas: readonly Rect[], here: Rect): Rect {
  if (saved) {
    const area = workAreas.find((a) => contains(a, saved.x + saved.width / 2, saved.y + TITLE_BAR_PROBE_PX));
    if (area) {
      const width = Math.min(Math.max(saved.width, LIBRARY_MIN_SIZE.width), area.width);
      const height = Math.min(Math.max(saved.height, LIBRARY_MIN_SIZE.height), area.height);
      const x = Math.min(Math.max(saved.x, area.x), area.x + area.width - width);
      const y = Math.min(Math.max(saved.y, area.y), area.y + area.height - height);
      return { x, y, width, height };
    }
  }
  return centredIn(LIBRARY_SIZE, here);
}

/** Where the Settings window opens. */
export function settingsBounds(here: Rect): Rect {
  return centredIn(SETTINGS_SIZE, here);
}

/**
 * The stored library place, or null. Never half-trusts: anything that is not
 * four finite numbers with a positive size is treated as never stored.
 */
export function cleanWindowBounds(v: unknown): Rect | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (!finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)) return null;
  const bounds = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  return bounds.width > 0 && bounds.height > 0 ? bounds : null;
}
