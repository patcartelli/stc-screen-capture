/**
 * The Settings window's dropdown (STC-581): the record bar's menu, on a
 * Settings trigger. "5 or more options: dropdown, the record bar component"
 * (Capture SK 016, Row pattern spec), so the menu is `device-menu.css`'s
 * `.device-menu` and its rows come from `device-menu-dom.ts`'s
 * `buildMenuRow`, the same builder the record bar and the library's device
 * popover use. A row here has no icon: an option like "Bottom right" has none.
 *
 * One menu element serves every dropdown in the window, so two can never be
 * open at once. It closes on a pick, Escape, a press outside it, a scroll of
 * the panes, or the window losing focus. ArrowUp/ArrowDown move between rows;
 * Enter and Space pick (the row builder's own keyboard wiring).
 *
 * The trigger is a button carrying its value in `data-value` and its label as
 * text, so a page reads and tests it like any control. `placeMenu` is the one
 * decision here with arithmetic in it, and is pure.
 */
import { buildMenuRow, type MenuRowView } from "./device-menu-dom.js";

export interface DropdownOption { value: string; label: string }

export interface Dropdown {
  /** Show `value` as chosen. A value that is not an option shows no label. */
  set(value: string): void;
  readonly value: string;
}

/** Room left between the menu and the trigger, and the menu and the window edge. */
export const MENU_GAP = 6;

/**
 * Where the menu goes: below the trigger, or above it when below would run
 * past the bottom of the window and above has more room. Left-aligned with
 * the trigger, pulled back inside the window's right edge. Pure.
 */
export function placeMenu(
  trigger: { left: number; top: number; bottom: number },
  menu: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number; above: boolean } {
  const below = trigger.bottom + MENU_GAP;
  const fitsBelow = below + menu.height <= view.height - MENU_GAP;
  const above = !fitsBelow && trigger.top - MENU_GAP - menu.height >= MENU_GAP;
  const top = above ? trigger.top - MENU_GAP - menu.height : below;
  const left = Math.max(MENU_GAP, Math.min(trigger.left, view.width - MENU_GAP - menu.width));
  return { left, top, above };
}

let menu: HTMLDivElement | undefined;
let openFor: HTMLButtonElement | undefined;

function menuElement(): HTMLDivElement {
  if (menu) return menu;
  menu = document.createElement("div");
  menu.className = "device-menu settings-menu";
  menu.id = "settings-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);
  // Close on a press anywhere but the menu or the trigger that owns it.
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (!openFor || menu!.contains(t) || openFor.contains(t)) return;
    closeMenu(false);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!openFor) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = [...menu!.querySelectorAll<HTMLElement>(".row")];
      const i = rows.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      rows[i < 0 ? 0 : next]?.focus();
    }
  }, true);
  window.addEventListener("blur", () => closeMenu(false));
  document.getElementById("panes")?.addEventListener("scroll", () => closeMenu(false));
  return menu;
}

function closeMenu(refocus: boolean): void {
  if (!openFor || !menu) return;
  const trigger = openFor;
  openFor = undefined;
  menu.hidden = true;
  menu.replaceChildren();
  trigger.setAttribute("aria-expanded", "false");
  if (refocus) trigger.focus();
}

export function buildDropdown(
  trigger: HTMLButtonElement,
  options: readonly DropdownOption[],
  onPick: (value: string) => void,
): Dropdown {
  let value = "";
  const labelEl = document.createElement("span");
  labelEl.className = "value";
  trigger.replaceChildren(labelEl);
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");

  const show = (v: string) => {
    value = v;
    trigger.dataset.value = v;
    labelEl.textContent = options.find((o) => o.value === v)?.label ?? "";
  };

  const open = () => {
    const m = menuElement();
    if (openFor === trigger) { closeMenu(true); return; }
    closeMenu(false);
    const rows: (MenuRowView & { value: string })[] = options.map((o) => ({
      key: o.value, value: o.value, label: o.label, checked: o.value === value, toggle: false,
    }));
    m.replaceChildren(...rows.map((r) => buildMenuRow(r, (row) => {
      closeMenu(true);
      if (row.value === value) return;
      show(row.value);
      onPick(row.value);
    })));
    const t = trigger.getBoundingClientRect();
    m.style.minWidth = `${t.width}px`;
    m.hidden = false;
    const r = m.getBoundingClientRect();
    const at = placeMenu(t, { width: r.width, height: r.height }, { width: innerWidth, height: innerHeight });
    m.style.left = `${at.left}px`;
    m.style.top = `${at.top}px`;
    openFor = trigger;
    trigger.setAttribute("aria-expanded", "true");
    (m.querySelector<HTMLElement>('.row[aria-checked="true"]') ?? m.querySelector<HTMLElement>(".row"))?.focus();
  };

  trigger.addEventListener("click", open);
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && openFor !== trigger) { e.preventDefault(); open(); }
  });

  return {
    set: show,
    get value() { return value; },
  };
}
