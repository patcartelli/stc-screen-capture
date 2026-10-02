import {
  PIP_PRESETS, PIP_WIDTH_MIN, PIP_WIDTH_MAX, PIP_RADIUS_MAX, PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX,
  DEFAULT_BORDER, type PipEdit, type PipStyle,
} from "@transform/pip-style";

/**
 * The PiP inspector (STC-461), shared by the editor's Camera popover and the
 * Settings sheet — the device-menu-dom.ts precedent: one DOM builder, two hosts.
 * It reports input as `PipEdit`s and draws the style it is handed; what an edit
 * MEANS is pip-style.ts's `editPipStyle`, never decided here.
 *
 * Sliders follow the editor's input/change split: `input` is "live" (repaint),
 * `change` is "commit" (persist).
 */
export interface PipInspectorHost {
  surface: "editor" | "settings";
  /** live = while dragging a slider (repaint only); commit = on change (persist). */
  onEdit(edit: PipEdit, phase: "live" | "commit"): void;
  /** Editor only. */
  onEnabled?(enabled: boolean): void;
  /** Editor only. */
  onReframe?(): void;
  /** Editor only. */
  onUseAsDefault?(): void;
}
export interface PipInspector { render(style: PipStyle, enabled: boolean): void }

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function slider(id: string, label: string, min: number, max: number, step: number) {
  const wrap = el("label", { class: "pip-row" }, label);
  const input = el("input", { id, type: "range", min: String(min), max: String(max), step: String(step) });
  wrap.append(input);
  return { wrap, input };
}

function toggle(id: string, label: string) {
  const wrap = el("label", { class: "pip-row pip-toggle" }, label);
  const input = el("input", { id, type: "checkbox", role: "switch" });
  wrap.prepend(input);
  return { wrap, input };
}

export function buildPipInspector(root: HTMLElement, host: PipInspectorHost): PipInspector {
  root.classList.add("pip-inspector");
  root.replaceChildren();

  const presets = el("div", { class: "pip-presets", role: "group", "aria-label": "Presets" });
  for (const p of PIP_PRESETS) {
    const b = el("button", { type: "button", class: "pip-chip", "data-pip-preset": p.name }, p.label);
    b.addEventListener("click", () => host.onEdit({ kind: "preset", name: p.name }, "commit"));
    presets.append(b);
  }

  const enabled = host.surface === "editor" ? toggle("pipenabled", "Show camera") : null;
  enabled?.input.addEventListener("change", () => host.onEnabled?.(enabled.input.checked));

  const shapes = el("div", { class: "pip-segmented", role: "radiogroup", "aria-label": "Shape" });
  for (const [shape, label] of [["rect", "Rect"], ["square", "Square"], ["circle", "Circle"]] as const) {
    const b = el("button", { type: "button", role: "radio", "data-pip-shape": shape }, label);
    b.addEventListener("click", () => host.onEdit({ kind: "shape", shape }, "commit"));
    shapes.append(b);
  }

  const radius = slider("pipradius", "Corners", 0, PIP_RADIUS_MAX, 0.01);
  const size = slider("pipsize", "Size", PIP_WIDTH_MIN, PIP_WIDTH_MAX, 0.005);
  const border = toggle("pipborder", "Border");
  const borderWidth = slider("pipborderwidth", "Width", PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX, 0.5);
  const borderColor = el("input", { id: "pipbordercolor", type: "color", "aria-label": "Border colour" });
  const shadow = toggle("pipshadow", "Shadow");
  const mirror = toggle("pipmirror", "Mirror");

  const live = (input: HTMLInputElement, make: (v: number) => PipEdit) => {
    input.addEventListener("input", () => host.onEdit(make(Number(input.value)), "live"));
    input.addEventListener("change", () => host.onEdit(make(Number(input.value)), "commit"));
  };
  live(radius.input, (value) => ({ kind: "radius", value }));
  live(size.input, (value) => ({ kind: "size", value }));
  live(borderWidth.input, (pt) => ({ kind: "borderWidth", pt }));
  border.input.addEventListener("change", () => host.onEdit({ kind: "border", on: border.input.checked }, "commit"));
  borderColor.addEventListener("input", () => host.onEdit({ kind: "borderColor", color: borderColor.value }, "live"));
  borderColor.addEventListener("change", () => host.onEdit({ kind: "borderColor", color: borderColor.value }, "commit"));
  shadow.input.addEventListener("change", () => host.onEdit({ kind: "shadow", on: shadow.input.checked }, "commit"));
  mirror.input.addEventListener("change", () => host.onEdit({ kind: "mirror", on: mirror.input.checked }, "commit"));

  const borderRow = el("div", { class: "pip-row pip-border" });
  borderRow.append(border.wrap, borderWidth.wrap, borderColor);

  root.append(presets);
  if (enabled) root.append(enabled.wrap);
  root.append(shapes, radius.wrap, size.wrap, borderRow, shadow.wrap, mirror.wrap);

  if (host.surface === "editor") {
    const actions = el("div", { class: "pip-actions" });
    const reframe = el("button", { type: "button", id: "pipreframe" }, "Reframe…");
    const asDefault = el("button", { type: "button", id: "pipdefault" }, "Use as default");
    reframe.addEventListener("click", () => host.onReframe?.());
    asDefault.addEventListener("click", () => host.onUseAsDefault?.());
    actions.append(reframe, asDefault);
    root.append(actions);
  }

  return {
    render(style, isEnabled) {
      if (enabled) enabled.input.checked = isEnabled;
      for (const b of shapes.querySelectorAll<HTMLButtonElement>("[data-pip-shape]")) {
        b.setAttribute("aria-checked", String(b.dataset.pipShape === style.shape));
      }
      radius.input.value = String(style.cornerRadius);
      radius.input.disabled = style.shape === "circle";
      size.input.value = String(style.width);
      border.input.checked = style.border !== null;
      borderWidth.input.value = String((style.border ?? DEFAULT_BORDER).widthPt);
      borderWidth.input.disabled = style.border === null;
      borderColor.value = (style.border ?? DEFAULT_BORDER).color;
      borderColor.disabled = style.border === null;
      shadow.input.checked = style.shadow;
      mirror.input.checked = style.mirror;
    },
  };
}
