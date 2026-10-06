/**
 * The menu-bar item's contents and its icon (STC-292) — pure, so the whole
 * thing is decided somewhere `app/test/tray-menu.test.ts` can look at it.
 *
 * There is no Electron API that reads a `Tray` back: once an item is on the
 * menu bar, nothing in a test can enumerate it, read its menu or click it. So
 * the template and the icon are built here, checked here, and handed to
 * `tray.ts`, which does nothing but hand them to Electron. What is left for a
 * human on the runbook is that the item is VISIBLE and legible in both menu-bar
 * appearances — which is exactly the part a test could never have claimed.
 */

import { PRODUCT_NAME } from "./product.js";
import {
  ACTION_LABELS, BINDABLE_ACTIONS,
  type BindableAction, type Shortcuts,
} from "./hotkeys.js";

export type TrayItemId = `action:${BindableAction}` | "library" | "quit" | "separator";

export interface TrayItem {
  id: TrayItemId;
  type?: "separator";
  label?: string;
  /**
   * The Electron accelerator, VERBATIM — not the ⌃⌥⇧⌘ rendering.
   *
   * A tray menu draws an accelerator and never fires it (the global shortcut
   * is what fires, registered separately), and Electron does the glyph
   * substitution itself. Handing it pre-rendered symbols would put a string it
   * cannot parse where it expects a binding.
   */
  accelerator?: string;
  enabled?: boolean;
}

export interface TrayContext {
  shortcuts: Shortcuts;
  /** A shot is already in flight (the overlay is up). Pressing another one
   * would be refused as `overlay-open`, so it is shown as unavailable instead
   * of offered and then declined. */
  busy?: boolean;
  /** A take is running. Record stays live so it can stop it (STC-388). */
  recording?: boolean;
}

/** What the Record item reads mid-take. Exported so the test and the menu
 * cannot hold two different spellings of it. */
export const STOP_RECORDING_LABEL = "Stop Recording";

export const TRAY_TOOLTIP = PRODUCT_NAME;

/**
 * Every bindable action, then the way back to a window, then quit.
 *
 * `BINDABLE_ACTIONS`, not `SHOT_ACTIONS` (STC-388): Record belongs on this menu
 * beside the shots, and it is the only item whose label and enablement depend
 * on whether a take is running — because it is the only one that toggles.
 *
 * Quit is not optional decoration: with the Dock icon hidden while no window
 * is open, this menu is the only way to end the app, and an app a user cannot
 * quit is worse than one with no menu-bar item at all.
 */
export function trayTemplate(ctx: TrayContext): TrayItem[] {
  const items: TrayItem[] = BINDABLE_ACTIONS.map((action) => {
    const accelerator = ctx.shortcuts[action];
    const stopping = action === "record" && ctx.recording === true;
    return {
      id: `action:${action}` as TrayItemId,
      label: stopping ? STOP_RECORDING_LABEL : ACTION_LABELS[action],
      // Mid-take Record is the STOP control, so `busy` must not grey it out —
      // that would leave the menu bar as the one entry point that can start a
      // recording and not end it.
      enabled: stopping ? true : !ctx.busy,
      // Only when there is one: an item showing "—" where a shortcut would be
      // reads as a broken binding rather than as one nobody has set.
      ...(accelerator ? { accelerator } : {}),
    };
  });
  items.push({ id: "separator", type: "separator" });
  items.push({ id: "library", label: "Open Library" });
  items.push({ id: "separator", type: "separator" });
  items.push({ id: "quit", label: `Quit ${PRODUCT_NAME}` });
  return items;
}

// ── the icon ────────────────────────────────────────────────────────────────

/**
 * Menu bar glyph (STC-503): a video camera icon.
 *
 * Drawn from geometry rather than shipped as a PNG, for two reasons. A binary
 * asset is the one thing in this repo a reviewer cannot read in the diff, and
 * a menu-bar icon is small enough that being one pixel off is the whole
 * difference between crisp and smudged — so the shape is a function of the
 * size, and properties that make it legible are tested at both scales.
 *
 * A stylized camera body with a lens, recognizable in both light and dark
 * modes as a template image. Returns one byte of alpha per pixel, row-major.
 * A macOS template image is pure alpha: the system paints it black or white
 * to match the menu bar, which is why no colour is chosen here.
 */
export function marqueeMask(size: number): Uint8Array {
  const mask = new Uint8Array(size * size);

  // Helper: set a pixel symmetrically (both mirror positions at once)
  const setSym = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    mask[y * size + x] = 255;
    // Mirror horizontally and vertically for perfect symmetry
    if (x !== size - 1 - x) mask[y * size + (size - 1 - x)] = 255;
    if (y !== size - 1 - y) mask[(size - 1 - y) * size + x] = 255;
    if (x !== size - 1 - x && y !== size - 1 - y) {
      mask[(size - 1 - y) * size + (size - 1 - x)] = 255;
    }
  };

  const center = Math.floor(size / 2);
  const inset = Math.round(size / 8);

  if (size <= 16) {
    // Small size (16px): EXTREMELY BOLD solid rectangle + large lens
    // Fill entire camera body area heavily
    for (let y = center - 2; y <= center + 2; y++) {
      for (let x = center - 3; x <= center + 3; x++) {
        setSym(x, y);
      }
    }

    // Very large filled lens circle - solid block of pixels
    const lensR = 2;
    for (let dy = -lensR; dy <= lensR; dy++) {
      for (let dx = -lensR; dx <= lensR; dx++) {
        if (dx * dx + dy * dy <= lensR * lensR + 1) {
          setSym(center + dx, center + dy);
        }
      }
    }
  } else {
    // Larger size: camera body outline + lens
    const bodyHalf = Math.round(size * 0.2);
    const lensR = Math.round(size * 0.1);

    // Camera body rectangle outline
    for (let y = center - bodyHalf; y <= center + bodyHalf; y++) {
      for (let x = center - bodyHalf - 1; x <= center + bodyHalf + 1; x++) {
        const isEdge = (y === center - bodyHalf || y === center + bodyHalf ||
                        x === center - bodyHalf - 1 || x === center + bodyHalf + 1);
        if (isEdge) setSym(x, y);
      }
    }

    // Lens (filled circle)
    for (let dy = -lensR; dy <= lensR; dy++) {
      for (let dx = -lensR; dx <= lensR; dx++) {
        if (dx * dx + dy * dy <= lensR * lensR) {
          setSym(center + dx, center + dy);
        }
      }
    }
  }

  return mask;
}

/**
 * A mask → the BGRA buffer `nativeImage.createFromBitmap` takes.
 *
 * Premultiplied, and black: a template image's colour is ignored, but a buffer
 * with colour where alpha is zero is the classic way to get a grey halo out of
 * anything that later ignores the template flag.
 */
export function bgraFromMask(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length * 4);
  for (let i = 0; i < mask.length; i++) out[i * 4 + 3] = mask[i]!;
  return out;
}

/** 1x and 2x, the two representations a menu bar asks for. */
export const TRAY_ICON_SIZE = 16;
export const TRAY_ICON_SIZE_2X = 32;
