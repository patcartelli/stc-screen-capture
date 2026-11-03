// The background swatch grid (STC-608): ONE component for the still editor and
// the video editor, so a look has one place to be drawn, focused and chosen.
// It draws a radio group of swatches and reports a pick; what a pick MEANS (a
// shot write, a project edit) stays in the window that mounted it.
//
// DOM-touching, so it is a renderer module: listed in tsconfig.browser.json and
// excluded from tsconfig.node.json, as device-menu-dom.ts is. `cssFill` and
// `nextSwatchIndex` touch no DOM and are unit tested in node.
//
// The rules, each from the still editor's STC-599 grid:
//   1. role="radio" buttons in a group; one is aria-checked.
//   2. ONE tab stop: the selected swatch, else the first. Arrow keys, Home and
//      End move the focus (and the stop) without picking; Enter/Space picks.
//   3. aria-disabled, never `disabled`: a disabled button drops the keyboard
//      focus, and a keyboard user would lose their place on every pick.

export interface LookSwatch {
  id: string;
  label: string;
  /** CSS background for the chip. "" leaves the chip to its CSS (the window-only chips). */
  fill: string;
  /** SVG markup drawn over the chip (the wallpaper's display glyph). */
  glyph?: string;
  /** Draws the chip as a window on the page's own colour; "window-shadow" adds the shadow. */
  chip?: "window" | "window-shadow";
}

export interface LookGrid {
  setSelected(id: string | undefined): void;
  setDisabled(disabled: boolean): void;
  element: HTMLElement;
}

/** Either editor's background shape: the still's `{kind, colors, angleDeg}` or the video's `{kind, color}`. */
export interface FillLike {
  kind: string;
  colors?: readonly string[];
  color?: string;
  angleDeg?: number;
}

/** A swatch's fill as CSS. Approximate by design: the canvas draws the real one. */
export function cssFill(fill: FillLike | undefined): string {
  const colors = fill?.colors ?? (fill?.color === undefined ? [] : [fill.color]);
  if (!fill || colors.length === 0) return "";
  if (fill.kind === "solid" || colors.length === 1) return colors[0]!;
  const stops = colors.join(", ");
  return fill.kind === "radial" ? `radial-gradient(circle, ${stops})` : `linear-gradient(${fill.angleDeg ?? 180}deg, ${stops})`;
}

/** Where a key moves the focus from `at` across `count` swatches; undefined for any other key. Wraps. */
export function nextSwatchIndex(key: string, at: number, count: number): number | undefined {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return (at + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (at - 1 + count) % count;
  return undefined;
}

export function mountLookGrid(
  container: HTMLElement,
  swatches: readonly LookSwatch[],
  onChoose: (id: string) => void,
): LookGrid {
  const buttons = new Map<string, HTMLButtonElement>();
  for (const s of swatches) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "look";
    b.dataset.look = s.id;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", s.label);
    b.title = s.label;
    const chip = document.createElement("span");
    chip.className = "chip";
    if (s.chip) chip.dataset.chip = s.chip;
    chip.style.background = s.fill;
    if (s.glyph) chip.innerHTML = s.glyph;
    const text = document.createElement("span");
    text.textContent = s.label;
    b.append(chip, text);
    b.addEventListener("click", () => onChoose(s.id));
    buttons.set(s.id, b);
    container.append(b);
  }

  let selected: string | undefined;
  const paint = (): void => {
    const stop = selected !== undefined && buttons.has(selected) ? selected : swatches[0]?.id;
    for (const [id, el] of buttons) {
      el.setAttribute("aria-checked", String(id === selected));
      // The focused swatch keeps the tab stop it was given: a pick must not move it under the user.
      if (document.activeElement !== el) el.tabIndex = id === stop ? 0 : -1;
    }
  };
  paint();

  /** Arrow keys move the focus around the grid; Enter or Space (a click) picks. */
  container.addEventListener("keydown", (e) => {
    const ids = [...buttons.keys()];
    const at = ids.findIndex((id) => buttons.get(id) === document.activeElement);
    const to = nextSwatchIndex(e.key, at, ids.length);
    if (to === undefined || at < 0) return;
    e.preventDefault();
    const el = buttons.get(ids[to]!)!;
    for (const b of buttons.values()) b.tabIndex = b === el ? 0 : -1;
    el.focus();
  });

  return {
    element: container,
    setSelected(id) { selected = id; paint(); },
    setDisabled(disabled) {
      for (const el of buttons.values()) el.setAttribute("aria-disabled", String(disabled));
    },
  };
}
