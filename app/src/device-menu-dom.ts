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
import type { MenuRow } from "./device-picker.js";

export function buildMenuRow(r: MenuRow, onPick?: (row: MenuRow) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.key = r.key;
  // A toggle (Include System Audio) is a switch, not a pick: it flips in place
  // and keeps the menu open (STC-583). A choice is a radio you can also clear.
  row.setAttribute("role", r.toggle ? "switch" : "menuitemradio");
  row.setAttribute("aria-checked", String(r.checked));
  const trailing = r.toggle ? `<span class="sw" aria-hidden="true"><i></i></span>` : iconSvg("check", "check");
  row.innerHTML = `${iconSvg(r.icon)}<span class="label"></span>${trailing}`;
  if (r.toggle) row.classList.add("toggle");
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
    // click — without this a pick on any row (a toggle, "Include
    // System Audio") would flip and then be closed anyway by that listener.
    row.addEventListener("click", (e) => { e.stopPropagation(); onPick(r); });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onPick(r); }
    });
  }
  return row;
}
