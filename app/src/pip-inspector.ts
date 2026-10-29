import {
  PIP_PRESETS, PIP_ANCHORS, PIP_WIDTH_MIN, PIP_WIDTH_MAX, PIP_RADIUS_MAX, PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX,
  DEFAULT_BORDER, type PipAnchor, type PipEdit, type PipStyle,
} from "@transform/pip-style";

/**
 * The PiP inspector (STC-461): the editor's Camera section. It had a second
 * host in the Settings sheet; the Settings window (STC-581) draws Capture SK
 * 016's own Camera rows instead, so this is the editor's alone. Since STC-604
 * it is the pane's Camera section: groups of rows in the Settings pattern
 * (label left, one control right) instead of a popover.
 * It reports input as `PipEdit`s and draws the style it is handed; what an edit
 * MEANS is pip-style.ts's `editPipStyle`, never decided here.
 *
 * Sliders follow the editor's input/change split: `input` is "live" (repaint),
 * `change` is "commit" (persist).
 */
export interface PipInspectorHost {
  /** live = while dragging a slider (repaint only); commit = on change (persist). */
  onEdit(edit: PipEdit, phase: "live" | "commit"): void;
  onEnabled(enabled: boolean): void;
  /** Pin the PiP to one of the nine places (a commit). */
  onAnchor(anchor: PipAnchor): void;
  /** Whether a drag snaps to those places. A session setting, never saved. */
  onSnap(on: boolean): void;
  onReframe(): void;
  onUseAsDefault(): void;
}

/** What the style alone cannot say: the content rect's width (for the size readout) and where the PiP sits now. */
export interface PipInspectorContext {
  frameWidthPx: number;
  /** The nine-anchor place the centre is on, or null for a dragged-to place. */
  anchor: PipAnchor | null;
}
export interface PipInspector { render(style: PipStyle, enabled: boolean, ctx: PipInspectorContext): void }

const ANCHOR_LABELS: Record<PipAnchor, string> = {
  "top-left": "Top left", top: "Top", "top-right": "Top right",
  left: "Left", center: "Center", right: "Right",
  "bottom-left": "Bottom left", bottom: "Bottom", "bottom-right": "Bottom right",
};
/** The Shape row's three segments, in the Figma frame's order. `rect` is drawn as "Rounded". */
const SHAPES = [["circle", "Circle"], ["rect", "Rounded"], ["square", "Square"]] as const;

/** The one-line summary drawn over the PiP on the stage: "Rounded · 190 · Bottom right". */
export function pipSummary(style: PipStyle, ctx: PipInspectorContext): string {
  const shape = SHAPES.find(([s]) => s === style.shape)![1];
  return `${shape} · ${Math.round(style.width * ctx.frameWidthPx)} · ${ctx.anchor ? ANCHOR_LABELS[ctx.anchor] : "Custom"}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A row: its label on the left (a `<label>` for the control, so a click on it acts), the control(s) on the right. */
function row(label: string, forId: string | null, ...controls: HTMLElement[]): HTMLDivElement {
  const r = el("div", { class: "row" });
  r.append(forId ? el("label", { class: "label", for: forId }, label) : el("span", { class: "label" }, label), ...controls);
  return r;
}

function group(title: string, ...rows: HTMLElement[]): HTMLElement {
  const g = el("div", { class: "pip-group" });
  const card = el("div", { class: "group" });
  card.append(...rows);
  g.append(el("p", { class: "panelabel" }, title), card);
  return g;
}

function slider(id: string, min: number, max: number, step: number, label: string) {
  const input = el("input", { id, type: "range", min: String(min), max: String(max), step: String(step), "aria-label": label });
  const fader = el("div", { class: "fader" });
  fader.append(input);
  const out = el("span", { class: "value mono", id: `${id}-out` });
  return { input, fader, out };
}

function toggle(id: string, label: string) {
  const input = el("input", { id, type: "checkbox", class: "switch", role: "switch", "aria-label": label });
  return { input, row: row(label, id, input) };
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
  const presetRow = el("div", { class: "row pip-presetrow" });
  presetRow.append(presets);

  const enabled = toggle("pipenabled", "Show camera");
  enabled.input.addEventListener("change", () => host.onEnabled(enabled.input.checked));

  const shapes = el("div", { class: "pip-segmented", id: "pipshape", role: "radiogroup", "aria-label": "Shape" });
  for (const [shape, label] of SHAPES) {
    const b = el("button", { type: "button", role: "radio", "data-pip-shape": shape }, label);
    b.addEventListener("click", () => host.onEdit({ kind: "shape", shape }, "commit"));
    shapes.append(b);
  }

  const radius = slider("pipradius", 0, PIP_RADIUS_MAX, 0.01, "Corners");
  const size = slider("pipsize", PIP_WIDTH_MIN, PIP_WIDTH_MAX, 0.005, "Size");
  const border = toggle("pipborder", "Border");
  const borderWidth = slider("pipborderwidth", PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX, 0.5, "Border width");
  const borderColor = el("input", { id: "pipbordercolor", type: "color", "aria-label": "Border colour" });
  const shadow = toggle("pipshadow", "Shadow");
  const mirror = toggle("pipmirror", "Mirror");

  const anchor = el("select", { id: "pipanchor", "aria-label": "Anchor" });
  anchor.append(el("option", { value: "", hidden: "" }, "Custom"));
  for (const a of PIP_ANCHORS) anchor.append(el("option", { value: a }, ANCHOR_LABELS[a]));
  anchor.addEventListener("change", () => { if (anchor.value) host.onAnchor(anchor.value as PipAnchor); });
  const snap = toggle("pipsnap", "Snap to edges");
  snap.input.checked = true;
  snap.input.addEventListener("change", () => host.onSnap(snap.input.checked));

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

  const reframe = el("button", { type: "button", id: "pipreframe", class: "pip-action" }, "Reframe…");
  const asDefault = el("button", { type: "button", id: "pipdefault", class: "pip-action" }, "Use as default");
  reframe.addEventListener("click", () => host.onReframe());
  asDefault.addEventListener("click", () => host.onUseAsDefault());
  const actions = el("div", { class: "row pip-actions" });
  actions.append(reframe, asDefault);

  // What the Figma frame draws is on show; everything the popover also had
  // (presets, corners, border width and colour, shadow, mirror, show camera,
  // reframe, use as default) is one click away behind "More".
  const more = el("details", { class: "more", id: "pipmore" });
  const moreBody = el("div", { class: "morebody" });
  moreBody.append(
    group("Look", presetRow),
    group("Details",
      enabled.row,
      row("Corners", "pipradius", radius.fader, radius.out),
      row("Border width", "pipborderwidth", borderWidth.fader, borderWidth.out),
      row("Border colour", "pipbordercolor", borderColor),
      shadow.row,
      mirror.row),
    group("Framing", actions),
  );
  more.append(el("summary", {}, "More"), moreBody);

  root.append(
    group("Picture", row("Shape", null, shapes), row("Size", "pipsize", size.fader, size.out), border.row),
    group("Position", row("Anchor", "pipanchor", anchor), snap.row),
    more,
  );

  return {
    render(style, isEnabled, ctx) {
      enabled.input.checked = isEnabled;
      for (const b of shapes.querySelectorAll<HTMLButtonElement>("[data-pip-shape]")) {
        b.setAttribute("aria-checked", String(b.dataset.pipShape === style.shape));
      }
      radius.input.value = String(style.cornerRadius);
      radius.input.disabled = style.shape === "circle";
      radius.out.textContent = style.shape === "circle" ? "–" : String(Math.round(style.cornerRadius * 100));
      size.input.value = String(style.width);
      size.out.textContent = String(Math.round(style.width * ctx.frameWidthPx));
      border.input.checked = style.border !== null;
      const b = style.border ?? DEFAULT_BORDER;
      borderWidth.input.value = String(b.widthPt);
      borderWidth.input.disabled = style.border === null;
      borderWidth.out.textContent = `${b.widthPt} pt`;
      borderColor.value = b.color;
      borderColor.disabled = style.border === null;
      shadow.input.checked = style.shadow;
      mirror.input.checked = style.mirror;
      anchor.value = ctx.anchor ?? "";
      // The sliders' fill, as the Audio section's (editor.ts's syncFill).
      for (const r of [radius.input, size.input, borderWidth.input]) {
        const lo = Number(r.min);
        r.style.setProperty("--fill-pct", `${((Number(r.value) - lo) / (Number(r.max) - lo)) * 100}%`);
      }
    },
  };
}
