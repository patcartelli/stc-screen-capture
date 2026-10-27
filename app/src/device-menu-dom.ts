/**
 * The device menu's row markup (STC-456) — one DOM builder for every surface
 * that draws `device-picker.ts`'s `MenuRow`: the Record options bar's overlay
 * menu (`overlay.ts`) and the main window's `#devicestate` popover
 * (`renderer.ts`). Node-free, so both renderer windows can import it — the
 * same reason `device-picker.ts` itself has no DOM in it.
 *
 * Before this, `overlay.ts`'s `renderMenu` built this exact markup inline;
 * a second copy for the main window's popover is the drift this repo keeps
 * paying for (`library-seam.test.ts`'s own finding, `spaces.ts`'s "one place
 * to get it" rule), so `overlay.ts` was switched to this too rather than
 * kept as a second implementation.
 *
 * `onPick`, when given, wires the row for direct interaction — a click, and
 * Enter/Space while it holds keyboard focus (`tabIndex = 0`) — mirroring the
 * old `#devicepopover button` rows' own keyboard reachability. The overlay's
 * menu does NOT pass it: its rows are pressed through one delegated
 * `pointerdown` handler on `window` instead, ahead of `barPress`'s own
 * ordering rules (STC-456 Review Focus 1) — wiring a second, per-row listener
 * there would be a second path to the same pick, and the two could disagree.
 */
import { iconSvg } from "./icons.js";
import type { MenuIcon } from "./device-picker.js";

/**
 * What a row needs to be drawn. `device-picker.ts`'s `MenuRow` is one; the
 * Settings window's dropdown (STC-581, `settings-dropdown.ts`) builds its own,
 * with no icon: an option like "Bottom right" has none to show.
 */
export interface MenuRowView {
  key: string;
  label: string;
  secondary?: string;
  icon?: MenuIcon;
  checked: boolean;
  closesMenu: boolean;
}

export function buildMenuRow<R extends MenuRowView>(r: R, onPick?: (row: R) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.key = r.key;
  // A toggle (Include System Audio) is a switch, not a pick: it flips in place
  // and keeps the menu open (STC-583). A choice is a radio you can also clear.
  row.setAttribute("role", r.closesMenu ? "menuitemradio" : "switch");
  row.setAttribute("aria-checked", String(r.checked));
  const trailing = r.closesMenu ? iconSvg("check", "check") : `<span class="sw" aria-hidden="true"><i></i></span>`;
  row.innerHTML = `${r.icon ? iconSvg(r.icon) : ""}<span class="label"></span>${trailing}`;
  if (!r.closesMenu) row.classList.add("toggle");
  row.querySelector(".label")!.textContent = r.label;
  if (r.secondary) {
    const tag = document.createElement("span");
    tag.className = "secondary";
    tag.textContent = r.secondary;
    row.querySelector(".label")!.after(tag);
  }
  if (onPick) {
    row.tabIndex = 0;
    // Stopped here, not left to bubble: the main window's popover closes on
    // any outside click (renderer.ts), and a row press is not an outside
    // click — without this a toggle row (`closesMenu === false`, "Include
    // System Audio") would flip and then be closed anyway by that listener.
    row.addEventListener("click", (e) => { e.stopPropagation(); onPick(r); });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onPick(r); }
    });
  }
  return row;
}
