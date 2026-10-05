# STC-461 — Customizable PiP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person choose the camera PiP's shape, size, position, border, shadow, mirror and framing — per take in the editor, and as a sticky default in Settings — with preview and export agreeing byte for byte.

**Architecture:** A new pure module `transform/src/pip-style.ts` owns every PiP decision (validation, geometry, snapping, edits, presets). `project-15` adds an optional `pip.style`; `render()` turns it into a fully resolved `PipState.draw` and the compositor only draws it. A shared DOM inspector (`app/src/pip-inspector.ts`) is hosted by the editor (Camera popover + on-stage drag/resize/reframe) and by the Settings sheet; Settings' style reaches a new take through `take-project.ts`'s seed.

**Tech Stack:** TypeScript, vitest (Node), Ajv (schema tests), Playwright-Electron (e2e), Canvas 2D (`OffscreenCanvasRenderingContext2D.roundRect`/`clip`/`shadowBlur`), esbuild.

**Spec:** `docs/superpowers/specs/2026-10-02-stc-461-pip-customize-design.md` (read it; it carries three "Amended while planning" notes this plan implements).

## Global Constraints

- `render(project, session, t)` stays pure: no wall clock, no live setting, no DOM. Every PiP number the compositor uses is computed in `render()`.
- A document with no `pip.style` renders **exactly** as on `master`: same `PipState` rect, same single 5-argument `drawImage`. `fixtures/pip/` is FROZEN — never edit it.
- `projectForWrite` emits the MINIMUM version that can express a document: `pip.style` present → 15; otherwise unchanged.
- Loaders fall back, never crash: `parseProject` drops an invalid style; `settings.ts` falls back to `DEFAULT_PIP_STYLE`. The `main.ts` write gate REFUSES an invalid style (throws).
- `transform/src/pip-style.ts` imports ONLY from `./spaces.js` (it must be importable from `app/src/main.ts`, `settings.ts` and `take-project.ts` under `tsconfig.node.json`). Never import `trim.ts` from app main-process code.
- Ranges (one source, `pip-style.ts`; the schema mirrors them and a test holds them equal): `width` 0.05–0.5 (UV of output width), `cornerRadius` 0–0.5 (of the short side), `center.x/y` 0–1, `framing.x/y` 0–1, `framing.zoom` 1–3, `border.widthPt` 0.5–12, `border.color` `^#[0-9a-fA-F]{6}$`.
- Snap margin = 32 output px (= `DEFAULT_PIP.marginPx`); snap threshold = 12 SCREEN px, converted by the caller.
- Branch: `accounts/stc-461-customize-pip-webcam-image` (worktree `.claude/worktrees/stc-461-pip-customize`). Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run `npm run typecheck` (all three tsc passes) before every commit that touches `app/` or `transform/src/`.
- E2E runs in the VM first (`docs/VM-TESTING.md`); local e2e is disruptive.

## Review Focus

1. **A take whose output size changed after the PiP was placed** (export at a smaller size): the PiP must stay fully inside the frame — `pipRect` clamps. Pinned in Task 1 (`pipRect` clamp test at a centre of 0.99).
2. **Mirror + reframe together:** dragging the framing window right must move the visible picture the way the hand moved, mirrored or not. Pinned in Task 2 (`panFraming` sign test with `mirror: true`).
3. **Switching shape after reframing** (rect → circle keeps x/y/zoom): the crop must stay inside the camera frame for the new aspect. Pinned in Task 1 (`framingSource` clamp after shape change).
4. **A Settings default set, then a take recorded with the camera OFF:** no `pip` must be seeded. Pinned in Task 6 (`recordTimeProject` / main wiring test with `camera: false`).
5. **A hand-edited `project.json` with a bad style** (e.g. `"color": "white"`): the editor must still open the take, rendering the old corner. Pinned in Task 3 (`parseProject` drop test).

---

## File Map

| File | Responsibility |
|---|---|
| `transform/src/pip-style.ts` (new) | Types, constants, presets, `cleanPipStyle`, geometry (`pipSize`, `pipRect`, `framingSource`, `clampFraming`, `styleFromFixedCorner`), edits (`editPipStyle`, `snapCenter`, `resizeFromCorner`, `panFraming`), `isDefaultPipStyle` |
| `transform/test/pip-style.test.ts` (new) | Node tests for all of the above |
| `schema/project-15.schema.json` (new) | project-14 + `pip.style` |
| `transform/test/pip-project.test.ts` (new) | v15 write/parse/schema round trip + schema-vs-constants drift guard |
| `transform/src/{types,trim,project-version}.ts` | `Pip.style`, version 15, parse/write |
| `transform/src/{render,compositor,transform-version,spaces}.ts` | `PipState.draw`, styled drawing, TRANSFORM_VERSION 14, header note |
| `transform/test/{render,compositor,transform-version}.test.ts` | styled render/draw tests, re-pinned fingerprint |
| `fixtures/pip-styled/project.json` (new) + `.github/workflows/ci.yml` | gate:identity on the styled path |
| `app/src/{take-project,settings,main}.ts` | seed, sticky default, write gate, take-end wiring |
| `app/test/{take-project,settings}.test.ts` | seed + settings tests |
| `app/src/pip-inspector.ts` + `app/renderer/pip-inspector.css` (new) | shared inspector DOM |
| `app/src/{editor,editor-preload}.ts`, `app/renderer/editor.html` | Camera popover, `#pipoverlay`, `#pipframing`, Use as default |
| `app/src/renderer.ts`, `app/renderer/index.html` | Settings sheet Camera subsection |
| `app/test/pip-editor.e2e.test.ts`, `app/test/pip-settings.e2e.test.ts` (new) | e2e |
| `docs/STC-461-RUNBOOK.md`, `CLAUDE.md`, `docs/TICKET-LOG.md` | docs |

---

### Task 1: `pip-style.ts` — types, validation, geometry

**Files:**
- Create: `transform/src/pip-style.ts`
- Create: `transform/test/pip-style.test.ts`
- Modify: `transform/src/trim.ts:67-69` (DEFAULT_PIP becomes a re-export of the one value)

**Interfaces:**
- Consumes: `fixedCornerPipUv`, `uvRectToPixels`, `outputRect`, types `Point`, `Size`, `Rect` from `./spaces.js`.
- Produces:
  - `type PipShape = "rect" | "square" | "circle"`
  - `interface PipFraming { x: number; y: number; zoom: number }`
  - `interface PipBorder { widthPt: number; color: string }`
  - `interface PipStyle { shape; cornerRadius; center: Point; width; framing?: PipFraming; mirror: boolean; border: PipBorder | null; shadow: boolean }`
  - constants `PIP_WIDTH_MIN=0.05, PIP_WIDTH_MAX=0.5, PIP_RADIUS_MAX=0.5, PIP_FRAMING_ZOOM_MAX=3, PIP_BORDER_PT_MIN=0.5, PIP_BORDER_PT_MAX=12, PIP_SNAP_MARGIN_PX=32, PIP_SNAP_THRESHOLD_SCREEN_PX=12, PIP_COLOR_PATTERN`, `DEFAULT_FRAMING`, `PIP_SHADOW`, `DEFAULT_PIP_FIXED`, `DEFAULT_PIP_STYLE`
  - `cleanPipStyle(v: unknown): PipStyle | null`
  - `pipSize(style, output: Size, camera: Size): Size`
  - `pipRect(style, output: Size, camera: Size): Rect` (integers, inside output)
  - `framingSource(style, camera: Size): Rect` (camera px)
  - `clampFraming(framing, shape, camera): PipFraming`
  - `styleFromFixedCorner(pip: { widthPct: number; marginPx: number }, output, camera): PipStyle`
  - `isDefaultPipStyle(s: PipStyle): boolean`, `pipStylesEqual(a, b): boolean`

- [ ] **Step 1: Write the failing tests**

`transform/test/pip-style.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import {
  cleanPipStyle, pipSize, pipRect, framingSource, clampFraming, styleFromFixedCorner,
  isDefaultPipStyle, pipStylesEqual, DEFAULT_PIP_STYLE, DEFAULT_PIP_FIXED, DEFAULT_FRAMING,
  PIP_WIDTH_MAX, PIP_FRAMING_ZOOM_MAX, type PipStyle,
} from "../src/pip-style.js";
import { fixedCornerPipUv, uvRectToPixels, outputRect, roundRect } from "../src/spaces.js";
import { DEFAULT_PIP } from "../src/trim.js";

const CAM = { width: 1280, height: 720 };
const style = (over: Partial<PipStyle> = {}): PipStyle => ({ ...DEFAULT_PIP_STYLE, ...over });

describe("cleanPipStyle — the one validator", () => {
  test("accepts the default and a full style", () => {
    expect(cleanPipStyle(DEFAULT_PIP_STYLE)).toEqual(DEFAULT_PIP_STYLE);
    const full = style({ shape: "circle", border: { widthPt: 2, color: "#FFffFF" }, shadow: true,
      mirror: true, framing: { x: 0.4, y: 0.6, zoom: 2 } });
    expect(cleanPipStyle(full)).toEqual(full);
  });
  test("never corrects a value — the colour's case is kept", () => {
    expect(cleanPipStyle(style({ border: { widthPt: 2, color: "#FFffFF" } }))!.border!.color).toBe("#FFffFF");
  });
  test.each([
    ["not an object", 7],
    ["unknown shape", { ...DEFAULT_PIP_STYLE, shape: "hexagon" }],
    ["radius above 0.5", { ...DEFAULT_PIP_STYLE, cornerRadius: 0.6 }],
    ["width below min", { ...DEFAULT_PIP_STYLE, width: 0.01 }],
    ["width above max", { ...DEFAULT_PIP_STYLE, width: PIP_WIDTH_MAX + 0.01 }],
    ["centre off 0..1", { ...DEFAULT_PIP_STYLE, center: { x: 1.2, y: 0.5 } }],
    ["NaN centre", { ...DEFAULT_PIP_STYLE, center: { x: NaN, y: 0.5 } }],
    ["named colour", { ...DEFAULT_PIP_STYLE, border: { widthPt: 2, color: "white" } }],
    ["border too thick", { ...DEFAULT_PIP_STYLE, border: { widthPt: 13, color: "#ffffff" } }],
    ["zoom below 1", { ...DEFAULT_PIP_STYLE, framing: { x: 0.5, y: 0.5, zoom: 0.9 } }],
    ["zoom above max", { ...DEFAULT_PIP_STYLE, framing: { x: 0.5, y: 0.5, zoom: PIP_FRAMING_ZOOM_MAX + 0.1 } }],
    ["mirror not boolean", { ...DEFAULT_PIP_STYLE, mirror: "yes" }],
  ])("refuses: %s", (_name, v) => {
    expect(cleanPipStyle(v)).toBeNull();
  });
});

describe("pipRect", () => {
  const outputs = [{ width: 640, height: 360 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 },
    { width: 1080, height: 1920 }, { width: 1279, height: 721 }];
  const cams = [CAM, { width: 640, height: 480 }, { width: 1920, height: 1080 }];
  for (const output of outputs) for (const cam of cams) for (const shape of ["rect", "square", "circle"] as const) {
    test(`integer and inside the frame — ${output.width}x${output.height}, cam ${cam.width}x${cam.height}, ${shape}`, () => {
      for (const cx of [0, 0.01, 0.5, 0.99, 1]) for (const cy of [0, 0.5, 1]) {
        const r = pipRect(style({ shape, width: 0.3, center: { x: cx, y: cy } }), output, cam);
        for (const v of [r.x, r.y, r.width, r.height]) expect(Number.isInteger(v)).toBe(true);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(output.width);
        expect(r.y + r.height).toBeLessThanOrEqual(output.height);
      }
    });
  }
  test("square and circle are 1:1; rect follows the camera aspect", () => {
    const out = { width: 1920, height: 1080 };
    expect(pipSize(style({ shape: "circle", width: 0.2 }), out, CAM)).toEqual({ width: 384, height: 384 });
    expect(pipSize(style({ shape: "square", width: 0.2 }), out, CAM)).toEqual({ width: 384, height: 384 });
    expect(pipSize(style({ shape: "rect", width: 0.2 }), out, CAM)).toEqual({ width: 384, height: 216 });
  });
});

describe("styleFromFixedCorner — the first edit must not make the PiP jump", () => {
  for (const output of [{ width: 640, height: 360 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 1279, height: 719 }])
    for (const cam of [CAM, { width: 640, height: 480 }, { width: 1080, height: 1920 }]) {
      test(`${output.width}x${output.height}, cam ${cam.width}x${cam.height}`, () => {
        const fixed = roundRect(uvRectToPixels(fixedCornerPipUv(DEFAULT_PIP, output, cam), outputRect(output)));
        expect(pipRect(styleFromFixedCorner(DEFAULT_PIP, output, cam), output, cam)).toEqual(fixed);
      });
    }
});

describe("framingSource", () => {
  test("absent framing = the largest crop of the shape's aspect, centred", () => {
    expect(framingSource(style({ shape: "rect" }), CAM)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(framingSource(style({ shape: "circle" }), CAM)).toEqual({ x: 280, y: 0, width: 720, height: 720 });
  });
  test("zoom 2 halves the crop around the framing centre", () => {
    expect(framingSource(style({ shape: "square", framing: { x: 0.5, y: 0.5, zoom: 2 } }), CAM))
      .toEqual({ x: 460, y: 180, width: 360, height: 360 });
  });
  test("a centre at the edge is clamped inside the camera frame", () => {
    const s = framingSource(style({ shape: "circle", framing: { x: 1, y: 0, zoom: 1 } }), CAM);
    expect(s).toEqual({ x: 560, y: 0, width: 720, height: 720 });
  });
  test("switching rect -> circle after reframing keeps the crop inside the camera (Review Focus 3)", () => {
    const f = { x: 0.05, y: 0.5, zoom: 1.2 };
    for (const shape of ["rect", "square", "circle"] as const) {
      const s = framingSource(style({ shape, framing: f }), CAM);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x + s.width).toBeLessThanOrEqual(CAM.width + 1e-9);
      expect(s.y + s.height).toBeLessThanOrEqual(CAM.height + 1e-9);
    }
  });
  test("clampFraming stores the same clamp the render applies", () => {
    const f = clampFraming({ x: 1, y: 0, zoom: 1 }, "circle", CAM);
    expect(framingSource(style({ shape: "circle", framing: f }), CAM))
      .toEqual(framingSource(style({ shape: "circle", framing: { x: 1, y: 0, zoom: 1 } }), CAM));
    expect(f.x).toBeCloseTo((560 + 360) / 1280, 12);
    expect(f.y).toBeCloseTo(0.5, 12);
  });
});

describe("defaults", () => {
  test("DEFAULT_PIP is the one fixed-corner value", () => {
    expect(DEFAULT_PIP).toEqual(DEFAULT_PIP_FIXED);
  });
  test("isDefaultPipStyle / pipStylesEqual", () => {
    expect(isDefaultPipStyle({ ...DEFAULT_PIP_STYLE, center: { ...DEFAULT_PIP_STYLE.center } })).toBe(true);
    expect(isDefaultPipStyle(style({ shadow: true }))).toBe(false);
    expect(pipStylesEqual(style({ framing: DEFAULT_FRAMING }), style({ framing: { ...DEFAULT_FRAMING } }))).toBe(true);
    expect(pipStylesEqual(style({ border: { widthPt: 2, color: "#ffffff" } }), style({ border: null }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run transform/test/pip-style.test.ts`
Expected: FAIL — `Failed to load url ../src/pip-style.js`.

- [ ] **Step 3: Implement `transform/src/pip-style.ts`**

```ts
import { fixedCornerPipUv, outputRect, uvRectToPixels, type Point, type Rect, type Size } from "./spaces.js";

/**
 * Every decision about a customised PiP (STC-461) — no DOM, no canvas, no clock.
 *
 * ## What lives here and what does not
 *
 * `render.ts` asks this module where the PiP goes and what part of the camera it
 * shows; `compositor.ts` draws the answer and decides nothing. The editor and the
 * Settings sheet ask it what a drag, a slider or a preset MEANS (`editPipStyle`,
 * `snapCenter`, `resizeFromCorner`, `panFraming`) and only report input.
 *
 * ## Why it imports nothing but spaces.ts
 *
 * `main.ts` (the write gate), `settings.ts` and `take-project.ts` validate a style
 * too, under `tsconfig.node.json`, which refuses anything that reaches the
 * DOM-typed `cursor-art.ts` — `trim.ts` does. So the fixed-corner default lives
 * here and `trim.ts` re-exports it, not the other way round.
 *
 * ## Absent style = the old PiP
 *
 * A project whose `pip` has no `style` renders through `fixedCornerPipUv` exactly
 * as before this module existed; `styleFromFixedCorner` is how the first edit
 * picks up from there without the PiP jumping.
 */

export type PipShape = "rect" | "square" | "circle";

/** Which part of the camera shows: a centre in UV over the CAMERA frame and a zoom
 * over the largest crop of the shape's aspect. A rect never appears here, so a
 * framing can never disagree with its shape. */
export interface PipFraming { x: number; y: number; zoom: number }

export interface PipBorder { widthPt: number; color: string }

/** Mirrors `pip.style` in schema/project-15.schema.json. */
export interface PipStyle {
  shape: PipShape;
  /** Fraction of the PiP's SHORT side, 0..0.5. Ignored for a circle. */
  cornerRadius: number;
  /** UV over the OUTPUT. A centre that would put the PiP off-frame is clamped at render. */
  center: Point;
  /** UV: fraction of the output width. Height is derived from the shape. */
  width: number;
  /** Absent = `DEFAULT_FRAMING`. Per take: Settings never stores one. */
  framing?: PipFraming;
  mirror: boolean;
  /** Width in display POINTS, scaled to output pixels the way the cursor is. */
  border: PipBorder | null;
  shadow: boolean;
}

export const PIP_WIDTH_MIN = 0.05;
export const PIP_WIDTH_MAX = 0.5;
export const PIP_RADIUS_MAX = 0.5;
/** 720p camera vs a ~480 px PiP at 4K: zoom 3 is the most the oversampling covers. */
export const PIP_FRAMING_ZOOM_MAX = 3;
export const PIP_BORDER_PT_MIN = 0.5;
export const PIP_BORDER_PT_MAX = 12;
export const PIP_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** Output pixels — the fixed corner's own margin, so a snapped corner is where the old PiP sat. */
export const PIP_SNAP_MARGIN_PX = 32;
/** SCREEN pixels; the caller converts into output pixels for its own zoom level. */
export const PIP_SNAP_THRESHOLD_SCREEN_PX = 12;

export const DEFAULT_FRAMING: Readonly<PipFraming> = Object.freeze({ x: 0.5, y: 0.5, zoom: 1 });

/** The one drop shadow. Sizes are fractions of the PiP's short side, so it scales with the PiP. */
export const PIP_SHADOW = Object.freeze({ color: "rgba(0, 0, 0, 0.35)", blurFraction: 0.08, offsetYFraction: 0.03 });

/** The fixed-corner PiP every camera take gets when its project says nothing (STC-232). */
export const DEFAULT_PIP_FIXED = Object.freeze({
  enabled: true as boolean, corner: "bottom-right" as const, widthPct: 0.125, marginPx: PIP_SNAP_MARGIN_PX,
});

/** What Settings holds until someone changes it. Equal to it = nothing is seeded into a take. */
export const DEFAULT_PIP_STYLE: Readonly<PipStyle> = Object.freeze({
  shape: "rect", cornerRadius: 0, center: Object.freeze({ x: 0.9, y: 0.86 }), width: 0.125,
  mirror: false, border: null, shadow: false,
}) as Readonly<PipStyle>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const inRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * The style, or null. Never corrects a value: the write gate refuses on null and
 * the loaders fall back on it, and both need to know the document said something
 * this build did not write.
 */
export function cleanPipStyle(v: unknown): PipStyle | null {
  if (!isObj(v)) return null;
  const { shape, cornerRadius, center, width, framing, mirror, border, shadow } = v;
  if (shape !== "rect" && shape !== "square" && shape !== "circle") return null;
  if (!inRange(cornerRadius, 0, PIP_RADIUS_MAX)) return null;
  if (!isObj(center) || !inRange(center.x, 0, 1) || !inRange(center.y, 0, 1)) return null;
  if (!inRange(width, PIP_WIDTH_MIN, PIP_WIDTH_MAX)) return null;
  if (typeof mirror !== "boolean" || typeof shadow !== "boolean") return null;
  let cleanBorder: PipBorder | null = null;
  if (border !== null) {
    if (!isObj(border) || !inRange(border.widthPt, PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX)
        || typeof border.color !== "string" || !PIP_COLOR_PATTERN.test(border.color)) return null;
    cleanBorder = { widthPt: border.widthPt, color: border.color };
  }
  const out: PipStyle = {
    shape, cornerRadius, center: { x: center.x, y: center.y }, width, mirror, border: cleanBorder, shadow,
  };
  if (framing !== undefined) {
    if (!isObj(framing) || !inRange(framing.x, 0, 1) || !inRange(framing.y, 0, 1)
        || !inRange(framing.zoom, 1, PIP_FRAMING_ZOOM_MAX)) return null;
    out.framing = { x: framing.x, y: framing.y, zoom: framing.zoom };
  }
  return out;
}

/** Output pixels. Width rounds FIRST and height derives from the rounded width —
 * the same order `fixedCornerPipUv` uses, so `styleFromFixedCorner` is exact. */
export function pipSize(style: PipStyle, output: Size, camera: Size): Size {
  const width = Math.round(output.width * style.width);
  const height = style.shape === "rect" ? Math.round((width * camera.height) / camera.width) : width;
  return { width, height };
}

/** Where the PiP lands, in whole output pixels, always inside the frame. Rounded
 * because it places a DECODED FRAME (render.ts's pipStateAt says why). */
export function pipRect(style: PipStyle, output: Size, camera: Size): Rect {
  const { width, height } = pipSize(style, output, camera);
  const x = clamp(Math.round(style.center.x * output.width - width / 2), 0, Math.max(0, output.width - width));
  const y = clamp(Math.round(style.center.y * output.height - height / 2), 0, Math.max(0, output.height - height));
  return { x, y, width, height };
}

function shapeAspect(shape: PipShape, camera: Size): number {
  return shape === "rect" ? camera.width / camera.height : 1;
}

/** The largest crop of the shape's aspect inside the camera frame, divided by zoom. */
function cropSize(shape: PipShape, zoom: number, camera: Size): Size {
  const aspect = shapeAspect(shape, camera);
  const base = camera.width / camera.height >= aspect
    ? { width: camera.height * aspect, height: camera.height }
    : { width: camera.width, height: camera.width / aspect };
  return { width: base.width / zoom, height: base.height / zoom };
}

/** The framing with its centre clamped so the crop stays inside the camera frame. */
export function clampFraming(framing: PipFraming, shape: PipShape, camera: Size): PipFraming {
  const s = cropSize(shape, framing.zoom, camera);
  const hx = s.width / 2 / camera.width;
  const hy = s.height / 2 / camera.height;
  return { x: clamp(framing.x, hx, 1 - hx), y: clamp(framing.y, hy, 1 - hy), zoom: framing.zoom };
}

/** `drawImage`'s source rect, in camera pixels. Not rounded: a source rect is sampled, not placed. */
export function framingSource(style: PipStyle, camera: Size): Rect {
  const f = clampFraming(style.framing ?? DEFAULT_FRAMING, style.shape, camera);
  const s = cropSize(style.shape, f.zoom, camera);
  return { x: f.x * camera.width - s.width / 2, y: f.y * camera.height - s.height / 2, width: s.width, height: s.height };
}

/** Today's fixed corner, as a style that lands on exactly the same pixels. */
export function styleFromFixedCorner(pip: { widthPct: number; marginPx: number }, output: Size, camera: Size): PipStyle {
  const r = uvRectToPixels(fixedCornerPipUv(pip, output, camera), outputRect(output));
  return {
    ...DEFAULT_PIP_STYLE,
    center: { x: (r.x + r.width / 2) / output.width, y: (r.y + r.height / 2) / output.height },
    width: clamp(pip.widthPct, PIP_WIDTH_MIN, PIP_WIDTH_MAX),
  };
}

export function pipStylesEqual(a: PipStyle, b: PipStyle): boolean {
  const fa = a.framing, fb = b.framing;
  return a.shape === b.shape && a.cornerRadius === b.cornerRadius && a.width === b.width
    && a.center.x === b.center.x && a.center.y === b.center.y
    && a.mirror === b.mirror && a.shadow === b.shadow
    && (a.border === null ? b.border === null
      : b.border !== null && a.border.widthPt === b.border.widthPt && a.border.color === b.border.color)
    && (fa === undefined ? fb === undefined
      : fb !== undefined && fa.x === fb.x && fa.y === fb.y && fa.zoom === fb.zoom);
}

export function isDefaultPipStyle(s: PipStyle): boolean {
  return pipStylesEqual(s, DEFAULT_PIP_STYLE);
}
```

In `transform/src/trim.ts`, replace the `DEFAULT_PIP` literal (lines ~67-69) with:

```ts
import { DEFAULT_PIP_FIXED } from "./pip-style.js";
// ...
/**
 * The PiP a camera take gets when its own project does not say otherwise.
 * The value lives in pip-style.ts (STC-461), which the main process can import
 * and this file cannot be; one value, re-exported.
 */
export const DEFAULT_PIP: Pip = { ...DEFAULT_PIP_FIXED };
```

(Put the import with the file's other imports at the top.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run transform/test/pip-style.test.ts transform/test/trim.test.ts transform/test/spaces-seam.test.ts`
Expected: PASS. If `styleFromFixedCorner` is off by one for some size, do NOT loosen the test — the rounding order in `pipSize` must match `fixedCornerPipUv` (width first).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add transform/src/pip-style.ts transform/test/pip-style.test.ts transform/src/trim.ts
git commit -m "STC-461: pip-style.ts — PipStyle, the one validator, PiP geometry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `pip-style.ts` — presets and edits

**Files:**
- Modify: `transform/src/pip-style.ts` (append)
- Modify: `transform/test/pip-style.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's types and helpers.
- Produces:
  - `type PipPresetName = "classic" | "circle" | "rounded-square" | "large-circle"`
  - `interface PipPreset { name: PipPresetName; label: string; look: Pick<PipStyle, "shape" | "cornerRadius" | "width" | "border" | "shadow"> }`
  - `const PIP_PRESETS: readonly PipPreset[]`
  - `type PipEdit = { kind: "preset"; name: PipPresetName } | { kind: "shape"; shape: PipShape } | { kind: "radius"; value: number } | { kind: "size"; value: number } | { kind: "border"; on: boolean } | { kind: "borderWidth"; pt: number } | { kind: "borderColor"; color: string } | { kind: "shadow"; on: boolean } | { kind: "mirror"; on: boolean } | { kind: "move"; center: Point } | { kind: "framing"; framing: PipFraming }`
  - `editPipStyle(style: PipStyle, edit: PipEdit, camera: Size): PipStyle` (always returns a style that passes `cleanPipStyle`)
  - `snapCenter(center: Point, size: Size, output: Size, thresholdPx: number): Point`
  - `resizeFromCorner(style: PipStyle, pointer: Point /*output px*/, output: Size, camera: Size): PipStyle`
  - `panFraming(style: PipStyle, deltaCameraPx: Point, camera: Size): PipFraming`
  - `zoomFraming(style: PipStyle, zoom: number, camera: Size): PipFraming`
  - `DEFAULT_BORDER: PipBorder` = `{ widthPt: 2, color: "#ffffff" }`

- [ ] **Step 1: Write the failing tests** (append to `pip-style.test.ts`)

```ts
import {
  PIP_PRESETS, editPipStyle, snapCenter, resizeFromCorner, panFraming, zoomFraming,
  PIP_SNAP_MARGIN_PX, PIP_WIDTH_MIN, DEFAULT_BORDER,
} from "../src/pip-style.js";

describe("presets", () => {
  test("every preset yields a valid style", () => {
    for (const p of PIP_PRESETS) {
      expect(cleanPipStyle(editPipStyle(DEFAULT_PIP_STYLE, { kind: "preset", name: p.name }, CAM))).not.toBeNull();
    }
  });
  test("a preset is a LOOK: position, framing and mirror survive it", () => {
    const placed = style({ center: { x: 0.2, y: 0.3 }, mirror: true, framing: { x: 0.4, y: 0.5, zoom: 1.5 } });
    const after = editPipStyle(placed, { kind: "preset", name: "circle" }, CAM);
    expect(after.shape).toBe("circle");
    expect(after.center).toEqual({ x: 0.2, y: 0.3 });
    expect(after.mirror).toBe(true);
    expect(after.framing).toEqual({ x: 0.4, y: 0.5, zoom: 1.5 });
  });
  test("names are unique", () => {
    expect(new Set(PIP_PRESETS.map((p) => p.name)).size).toBe(PIP_PRESETS.length);
  });
});

describe("editPipStyle clamps rather than producing an invalid style", () => {
  test.each([
    [{ kind: "size", value: 9 } as const, (s: PipStyle) => expect(s.width).toBe(PIP_WIDTH_MAX)],
    [{ kind: "size", value: 0 } as const, (s: PipStyle) => expect(s.width).toBe(PIP_WIDTH_MIN)],
    [{ kind: "radius", value: -1 } as const, (s: PipStyle) => expect(s.cornerRadius).toBe(0)],
    [{ kind: "move", center: { x: -0.5, y: 2 } } as const, (s: PipStyle) => expect(s.center).toEqual({ x: 0, y: 1 })],
    [{ kind: "borderWidth", pt: 99 } as const, (s: PipStyle) => expect(s.border!.widthPt).toBe(12)],
  ])("%j", (edit, check) => {
    const s = editPipStyle(style({ border: DEFAULT_BORDER }), edit, CAM);
    expect(cleanPipStyle(s)).not.toBeNull();
    check(s);
  });
  test("border on uses DEFAULT_BORDER; off is null; a bad colour is ignored", () => {
    const on = editPipStyle(DEFAULT_PIP_STYLE, { kind: "border", on: true }, CAM);
    expect(on.border).toEqual(DEFAULT_BORDER);
    expect(editPipStyle(on, { kind: "border", on: false }, CAM).border).toBeNull();
    expect(editPipStyle(on, { kind: "borderColor", color: "red" }, CAM).border!.color).toBe(DEFAULT_BORDER.color);
  });
  test("a framing edit is stored clamped", () => {
    const s = editPipStyle(style({ shape: "circle" }), { kind: "framing", framing: { x: 1, y: 0, zoom: 1 } }, CAM);
    expect(s.framing!.x).toBeCloseTo((560 + 360) / 1280, 12);
  });
});

describe("snapCenter — nine anchors, per axis", () => {
  const out = { width: 1920, height: 1080 };
  const size = { width: 384, height: 216 };
  const toPx = (c: { x: number; y: number }) => ({ x: c.x * out.width, y: c.y * out.height });
  test("near the bottom-right anchor snaps the PiP's edge onto the margin", () => {
    const anchorX = out.width - PIP_SNAP_MARGIN_PX - size.width / 2;
    const anchorY = out.height - PIP_SNAP_MARGIN_PX - size.height / 2;
    const c = snapCenter({ x: (anchorX - 10) / out.width, y: (anchorY + 9) / out.height }, size, out, 12);
    expect(toPx(c)).toEqual({ x: anchorX, y: anchorY });
    const r = pipRect(style({ width: 0.2, center: c }), out, CAM);
    expect(r.x + r.width).toBe(out.width - PIP_SNAP_MARGIN_PX);
    expect(r.y + r.height).toBe(out.height - PIP_SNAP_MARGIN_PX);
  });
  test("just outside the threshold does not snap", () => {
    const anchorX = PIP_SNAP_MARGIN_PX + size.width / 2;
    const c = snapCenter({ x: (anchorX + 13) / out.width, y: 0.37 }, size, out, 12);
    expect(toPx(c).x).toBeCloseTo(anchorX + 13, 9);
    expect(c.y).toBeCloseTo(0.37, 12);
  });
  test("dead centre is an anchor", () => {
    expect(toPx(snapCenter({ x: 0.503, y: 0.497 }, size, out, 12))).toEqual({ x: 960, y: 540 });
  });
});

describe("resizeFromCorner", () => {
  test("width is twice the pointer's distance from the centre, clamped", () => {
    const out = { width: 1000, height: 1000 };
    const s = style({ shape: "square", center: { x: 0.5, y: 0.5 } });
    expect(resizeFromCorner(s, { x: 650, y: 500 }, out, CAM).width).toBeCloseTo(0.3, 12);
    expect(resizeFromCorner(s, { x: 2000, y: 500 }, out, CAM).width).toBe(PIP_WIDTH_MAX);
    expect(resizeFromCorner(s, { x: 500, y: 500 }, out, CAM).width).toBe(PIP_WIDTH_MIN);
  });
});

describe("panFraming", () => {
  test("dragging the window right moves the framing centre right", () => {
    const s = style({ shape: "square", framing: { x: 0.5, y: 0.5, zoom: 2 } });
    expect(panFraming(s, { x: 64, y: 0 }, CAM).x).toBeCloseTo(0.55, 12);
  });
  test("mirrored: the same drag moves the crop the OTHER way in camera space (Review Focus 2)", () => {
    const s = style({ shape: "square", mirror: true, framing: { x: 0.5, y: 0.5, zoom: 2 } });
    expect(panFraming(s, { x: 64, y: 0 }, CAM).x).toBeCloseTo(0.45, 12);
  });
  test("clamped at the camera edge", () => {
    const s = style({ shape: "square", framing: { x: 0.5, y: 0.5, zoom: 2 } });
    const f = panFraming(s, { x: 5000, y: 0 }, CAM);
    expect(framingSource({ ...s, framing: f }, CAM).x + 360).toBeCloseTo(1280, 9);
  });
  test("zoomFraming clamps to 1..PIP_FRAMING_ZOOM_MAX and keeps the crop inside", () => {
    const s = style({ shape: "circle", framing: { x: 0.95, y: 0.5, zoom: 3 } });
    expect(zoomFraming(s, 0.2, CAM).zoom).toBe(1);
    expect(zoomFraming(s, 9, CAM).zoom).toBe(PIP_FRAMING_ZOOM_MAX);
    const f = zoomFraming(s, 1, CAM);
    const src = framingSource({ ...s, framing: f }, CAM);
    expect(src.x + src.width).toBeLessThanOrEqual(1280 + 1e-9);
  });
});
```

`panFraming`'s delta is in CAMERA pixels as the user sees them (unmirrored screen direction); the caller converts output px → camera px. With mirror on, x flips.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run transform/test/pip-style.test.ts`
Expected: FAIL — `PIP_PRESETS` is not exported.

- [ ] **Step 3: Implement** (append to `pip-style.ts`)

```ts
export const DEFAULT_BORDER: Readonly<PipBorder> = Object.freeze({ widthPt: 2, color: "#ffffff" });

export type PipPresetName = "classic" | "circle" | "rounded-square" | "large-circle";
export interface PipPreset {
  name: PipPresetName;
  label: string;
  /** A LOOK only: a preset never moves the PiP, reframes it or flips it. */
  look: Pick<PipStyle, "shape" | "cornerRadius" | "width" | "border" | "shadow">;
}

/** Tuned by eye on hardware (docs/STC-461-RUNBOOK.md §1); change values here only. */
export const PIP_PRESETS: readonly PipPreset[] = Object.freeze([
  { name: "classic", label: "Classic",
    look: { shape: "rect", cornerRadius: 0.12, width: 0.16, border: null, shadow: true } },
  { name: "circle", label: "Circle",
    look: { shape: "circle", cornerRadius: 0, width: 0.14, border: { ...DEFAULT_BORDER }, shadow: true } },
  { name: "rounded-square", label: "Rounded square",
    look: { shape: "square", cornerRadius: 0.2, width: 0.14, border: null, shadow: true } },
  { name: "large-circle", label: "Large circle",
    look: { shape: "circle", cornerRadius: 0, width: 0.24, border: { widthPt: 3, color: "#ffffff" }, shadow: true } },
]);

export type PipEdit =
  | { kind: "preset"; name: PipPresetName }
  | { kind: "shape"; shape: PipShape }
  | { kind: "radius"; value: number }
  | { kind: "size"; value: number }
  | { kind: "border"; on: boolean }
  | { kind: "borderWidth"; pt: number }
  | { kind: "borderColor"; color: string }
  | { kind: "shadow"; on: boolean }
  | { kind: "mirror"; on: boolean }
  | { kind: "move"; center: Point }
  | { kind: "framing"; framing: PipFraming };

/**
 * What an inspector control or a drag MEANS. Always returns a style
 * `cleanPipStyle` accepts: out-of-range input is clamped, a bad colour is
 * ignored. The DOM only maps events to a `PipEdit`.
 */
export function editPipStyle(style: PipStyle, edit: PipEdit, camera: Size): PipStyle {
  const s: PipStyle = { ...style, center: { ...style.center } };
  switch (edit.kind) {
    case "preset": {
      const p = PIP_PRESETS.find((x) => x.name === edit.name);
      if (!p) return s;
      return { ...s, ...p.look, border: p.look.border ? { ...p.look.border } : null };
    }
    case "shape": return { ...s, shape: edit.shape };
    case "radius": return { ...s, cornerRadius: clamp(edit.value, 0, PIP_RADIUS_MAX) };
    case "size": return { ...s, width: clamp(edit.value, PIP_WIDTH_MIN, PIP_WIDTH_MAX) };
    case "border": return { ...s, border: edit.on ? { ...(s.border ?? DEFAULT_BORDER) } : null };
    case "borderWidth":
      return { ...s, border: { ...(s.border ?? DEFAULT_BORDER), widthPt: clamp(edit.pt, PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX) } };
    case "borderColor":
      if (!PIP_COLOR_PATTERN.test(edit.color)) return s;
      return { ...s, border: { ...(s.border ?? DEFAULT_BORDER), color: edit.color } };
    case "shadow": return { ...s, shadow: edit.on };
    case "mirror": return { ...s, mirror: edit.on };
    case "move": return { ...s, center: { x: clamp(edit.center.x, 0, 1), y: clamp(edit.center.y, 0, 1) } };
    case "framing": {
      const zoom = clamp(edit.framing.zoom, 1, PIP_FRAMING_ZOOM_MAX);
      return { ...s, framing: clampFraming({ ...edit.framing, zoom }, s.shape, camera) };
    }
  }
}

function nearestWithin(candidates: readonly number[], v: number, threshold: number): number | undefined {
  let best: number | undefined;
  let bestD = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - v);
    if (d <= bestD) { best = c; bestD = d; }
  }
  return best;
}

/**
 * Nine anchors, decided per axis: an edge's margin, the middle, the far edge's
 * margin. `size` and `thresholdPx` are OUTPUT pixels — the caller converts its
 * screen threshold for the stage's current scale.
 */
export function snapCenter(center: Point, size: Size, output: Size, thresholdPx: number): Point {
  const m = PIP_SNAP_MARGIN_PX;
  const xs = [m + size.width / 2, output.width / 2, output.width - m - size.width / 2];
  const ys = [m + size.height / 2, output.height / 2, output.height - m - size.height / 2];
  const px = center.x * output.width;
  const py = center.y * output.height;
  const sx = nearestWithin(xs, px, thresholdPx);
  const sy = nearestWithin(ys, py, thresholdPx);
  return { x: (sx ?? px) / output.width, y: (sy ?? py) / output.height };
}

/** A corner handle: aspect locked, centre fixed; the larger of the two axes wins. */
export function resizeFromCorner(style: PipStyle, pointer: Point, output: Size, camera: Size): PipStyle {
  const cx = style.center.x * output.width;
  const cy = style.center.y * output.height;
  const now = pipSize(style, output, camera);
  const aspect = now.width / now.height;
  const halfW = Math.max(Math.abs(pointer.x - cx), Math.abs(pointer.y - cy) * aspect);
  return { ...style, center: { ...style.center }, width: clamp((2 * halfW) / output.width, PIP_WIDTH_MIN, PIP_WIDTH_MAX) };
}

/** Pan by a delta in camera pixels as SEEN (a mirrored picture flips x back). */
export function panFraming(style: PipStyle, deltaCameraPx: Point, camera: Size): PipFraming {
  const f = style.framing ?? DEFAULT_FRAMING;
  const dx = (style.mirror ? -deltaCameraPx.x : deltaCameraPx.x) / camera.width;
  const dy = deltaCameraPx.y / camera.height;
  return clampFraming({ x: f.x + dx, y: f.y + dy, zoom: f.zoom }, style.shape, camera);
}

export function zoomFraming(style: PipStyle, zoom: number, camera: Size): PipFraming {
  const f = style.framing ?? DEFAULT_FRAMING;
  return clampFraming({ ...f, zoom: clamp(zoom, 1, PIP_FRAMING_ZOOM_MAX) }, style.shape, camera);
}
```

- [ ] **Step 4: Run tests** — `npx vitest run transform/test/pip-style.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add transform/src/pip-style.ts transform/test/pip-style.test.ts
git commit -m "STC-461: PiP presets and edits — snap, resize, pan, zoom

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `project-15` — schema, version, parse and write

**Files:**
- Create: `schema/project-15.schema.json`
- Create: `transform/test/pip-project.test.ts`
- Modify: `transform/src/project-version.ts:29`, `transform/src/types.ts:91-97` and `:251`, `transform/src/trim.ts` (`parseProject` pip line ~167, `versionFor` ~379, `projectForWrite` ~411)

**Interfaces:**
- Consumes: `PipStyle`, `cleanPipStyle`, constants (Tasks 1–2).
- Produces: `Pip.style?: PipStyle`; `Project.version` includes 15; `PROJECT_VERSIONS` includes 15.

- [ ] **Step 1: Generate the schema**

Run (from the worktree root):

```bash
python3 - <<'E'
import json
d = json.load(open("schema/project-14.schema.json"))
d["$id"] = "stc:project-15"
d["title"] = d["title"].replace("14", "15")
d["properties"]["version"] = {"const": 15}
d["description"] = ("v15 (STC-461): pip.style — the PiP's shape (rect at the camera's aspect, square, circle) "
  "and corner radius, its centre (UV over the OUTPUT) and width (fraction of output width; height derives from "
  "the shape), its framing (a centre in UV over the CAMERA frame plus a zoom over the largest crop of the shape's "
  "aspect; absent = centred, zoom 1), mirror, an optional border (width in display points, #rrggbb) and a drop "
  "shadow. Absent means the fixed bottom-right corner every earlier version drew, and a document with no style "
  "stays at whatever version its other edits earned. ") + d["description"]
pip = d["properties"]["pip"]
pip["description"] = "Picture-in-picture. Absent means no PiP. With no `style`, the fixed corner below; with one, `style` decides and the corner fields are carried but unused."
num = lambda lo, hi: {"type": "number", "minimum": lo, "maximum": hi}
pip["properties"]["style"] = {
  "type": "object", "additionalProperties": False,
  "required": ["shape", "cornerRadius", "center", "width", "mirror", "border", "shadow"],
  "properties": {
    "shape": {"enum": ["rect", "square", "circle"]},
    "cornerRadius": dict(num(0, 0.5), description="fraction of the PiP's short side; ignored for a circle"),
    "center": {"type": "object", "additionalProperties": False, "required": ["x", "y"],
               "properties": {"x": num(0, 1), "y": num(0, 1)}, "description": "UV over the output"},
    "width": dict(num(0.05, 0.5), description="fraction of output width"),
    "framing": {"type": "object", "additionalProperties": False, "required": ["x", "y", "zoom"],
                "properties": {"x": num(0, 1), "y": num(0, 1), "zoom": num(1, 3)},
                "description": "centre in UV over the camera frame; zoom over the largest crop of the shape's aspect"},
    "mirror": {"type": "boolean"},
    "border": {"oneOf": [{"type": "null"}, {"type": "object", "additionalProperties": False,
               "required": ["widthPt", "color"],
               "properties": {"widthPt": num(0.5, 12), "color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}}}]},
    "shadow": {"type": "boolean"},
  },
}
json.dump(d, open("schema/project-15.schema.json", "w"), indent=2)
open("schema/project-15.schema.json", "a").write("\n")
E
```

Then open the file and confirm `title` reads sensibly (if project-14's title has no "14", set it to `"project-15"` by hand).

- [ ] **Step 2: Write the failing tests** — `transform/test/pip-project.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { PROJECT_VERSIONS } from "../src/project-version.js";
import {
  DEFAULT_PIP_STYLE, PIP_WIDTH_MIN, PIP_WIDTH_MAX, PIP_RADIUS_MAX, PIP_FRAMING_ZOOM_MAX,
  PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX, PIP_COLOR_PATTERN, type PipStyle,
} from "../src/pip-style.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const schema15 = JSON.parse(readFileSync(join(root, "schema/project-15.schema.json"), "utf8"));
const validate15 = new Ajv({ allErrors: true, strict: true }).compile(schema15);
const DUR = 5_000_000_000;
const STYLE: PipStyle = { ...DEFAULT_PIP_STYLE, shape: "circle", shadow: true, mirror: true,
  border: { widthPt: 2, color: "#ffffff" }, framing: { x: 0.4, y: 0.5, zoom: 1.5 } };
const withStyle = (s: unknown) => {
  const p = defaultProject(640, 360, undefined, true);
  return { ...p, pip: { ...p.pip!, style: s as PipStyle } };
};

describe("project-15 pip.style (STC-461)", () => {
  test("15 is a readable version", () => expect(PROJECT_VERSIONS).toContain(15));
  test("an untouched camera project does not promote to 15", () => {
    expect(projectForWrite(defaultProject(640, 360, undefined, true), DUR).version).toBeLessThan(15);
  });
  test("a style writes a schema-valid v15 carrying it", () => {
    const out = projectForWrite(withStyle(STYLE), DUR);
    expect(out.version).toBe(15);
    expect(out.pip!.style).toEqual(STYLE);
    expect(validate15(out), JSON.stringify(validate15.errors, null, 2)).toBe(true);
  });
  test("v15 still carries every v14 field (>=, not ===)", () => {
    const p = { ...withStyle(STYLE), keycast: { show: false }, showClicks: false };
    const out = projectForWrite(p, DUR);
    expect(out.keycast).toEqual({ show: false });
    expect(out.showClicks).toBe(false);
  });
  test("parse round-trips a style", () => {
    const back = parseProject(projectForWrite(withStyle(STYLE), DUR), 640, 360, DUR, true);
    expect(back.pip!.style).toEqual(STYLE);
  });
  test("a bad style is DROPPED, not the project (Review Focus 5)", () => {
    const raw = { ...projectForWrite(withStyle(STYLE), DUR) } as any;
    raw.pip = { ...raw.pip, style: { ...STYLE, border: { widthPt: 2, color: "white" } } };
    const back = parseProject(raw, 640, 360, DUR, true);
    expect(back.pip).toBeDefined();
    expect(back.pip!.enabled).toBe(true);
    expect(back.pip!.style).toBeUndefined();
  });
  test("the schema's bounds are pip-style.ts's bounds", () => {
    const s = schema15.properties.pip.properties.style.properties;
    expect([s.width.minimum, s.width.maximum]).toEqual([PIP_WIDTH_MIN, PIP_WIDTH_MAX]);
    expect(s.cornerRadius.maximum).toBe(PIP_RADIUS_MAX);
    expect(s.framing.properties.zoom.maximum).toBe(PIP_FRAMING_ZOOM_MAX);
    const b = s.border.oneOf[1].properties;
    expect([b.widthPt.minimum, b.widthPt.maximum]).toEqual([PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX]);
    expect(b.color.pattern).toBe(PIP_COLOR_PATTERN.source);
  });
  test("the schema refuses what cleanPipStyle refuses", () => {
    const bad = projectForWrite(withStyle(STYLE), DUR) as any;
    bad.pip.style = { ...STYLE, width: 0.9 };
    expect(validate15(bad)).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run transform/test/pip-project.test.ts`
Expected: FAIL — `PROJECT_VERSIONS` does not contain 15.

- [ ] **Step 4: Implement**

`transform/src/project-version.ts`:
```ts
export const PROJECT_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
```

`transform/src/types.ts` — at the top add `import type { PipStyle } from "./pip-style.js";`, then:
```ts
/** Mirrors the optional `pip` block in schema/project-2.schema.json; `style` is project-15's (STC-461). */
export interface Pip {
  enabled: boolean;
  corner: "bottom-right";
  widthPct: number;
  marginPx: number;
  /** Absent = the fixed corner above. Present = pip-style.ts decides; the corner fields are carried, unused. */
  style?: PipStyle;
}
```
and `version: 1 | 2 | ... | 14 | 15;` on `Project`.

`transform/src/trim.ts`:
- import `cleanPipStyle` alongside `DEFAULT_PIP_FIXED` from `./pip-style.js`.
- Replace `if (doc.pip && typeof doc.pip === "object") project.pip = doc.pip;` with:
```ts
  if (doc.pip && typeof doc.pip === "object") {
    // project-15 (STC-461): a style this build cannot read is DROPPED, not the
    // project — the take renders the fixed corner rather than losing its edits.
    const { style, ...fixed } = doc.pip;
    project.pip = fixed;
    const clean = style === undefined ? null : cleanPipStyle(style);
    if (clean) project.pip.style = clean;
  }
```
- `versionFor`: return type add `| 15`; first line of the body:
```ts
  if (project.pip?.style) return 15;
```
  and update the "Highest first" comment to say v15.
- `projectForWrite`: no change needed (pip is carried whole, and `versionFor` guarantees a style means 15). Add one comment line above `if (project.pip) out.pip = project.pip;`: `// A style is carried with it; versionFor has already made this v15 (STC-461).`

- [ ] **Step 5: Run tests**

Run: `npx vitest run transform/test/pip-project.test.ts transform/test/trim.test.ts transform/test/schema.test.ts transform/test/project-version-seam.test.ts transform/test/keycast-project.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add schema/project-15.schema.json transform/test/pip-project.test.ts transform/src/project-version.ts transform/src/types.ts transform/src/trim.ts
git commit -m "STC-461: project-15 pip.style — written only when styled, dropped not fatal when bad

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: render and compositor — the styled PiP

**Files:**
- Modify: `transform/src/render.ts:92-130` (`PipState`, `pipStateAt`) and `:304` (call site)
- Modify: `transform/src/compositor.ts:115-121`
- Modify: `transform/src/transform-version.ts` (version 14, history, fingerprint)
- Modify: `transform/src/spaces.ts:120-122` (header note)
- Test: `transform/test/render.test.ts`, `transform/test/compositor.test.ts`, `transform/test/transform-version.test.ts`

**Interfaces:**
- Consumes: `pipRect`, `framingSource`, `PIP_SHADOW`, `DEFAULT_FRAMING` (Tasks 1–2); `Pip.style` (Task 3).
- Produces:
```ts
export interface PipDraw {
  source: Rect;                                // camera px
  mirror: boolean;
  radiusPx: number;                            // output px
  border: { px: number; color: string } | null;
  shadow: boolean;
}
export interface PipState { frameIndex; framePtsNs; x; y; width; height; draw?: PipDraw }  // draw absent = old path
```

- [ ] **Step 1: Write the failing tests**

Append to `transform/test/render.test.ts` (it already has `pipSession()`; reuse it):

```ts
import { DEFAULT_PIP_STYLE, pipRect, framingSource } from "../src/pip-style.js";

describe("a styled PiP (STC-461)", () => {
  const t = 2_000_000_000; // inside the fixture camera's 1.0355 s .. 3.0245 s
  test("no style: no draw block, and the rect is exactly the fixed corner", () => {
    const { project, session } = pipSession();
    const fs = render(project, session, t);
    expect(fs.pip).not.toBeNull();
    expect(fs.pip!.draw).toBeUndefined();
  });
  test("a style resolves every drawing number", () => {
    const { project, session } = pipSession();
    const style = { ...DEFAULT_PIP_STYLE, shape: "circle" as const, width: 0.2, center: { x: 0.25, y: 0.3 },
      mirror: true, shadow: true, border: { widthPt: 2, color: "#ffffff" }, framing: { x: 0.4, y: 0.5, zoom: 1.5 } };
    const styled = { ...project, pip: { ...project.pip!, style } };
    const fs = render(styled, session, t);
    const cam = session.anchors.camera!;
    const rect = pipRect(style, styled.output, cam);
    expect({ x: fs.pip!.x, y: fs.pip!.y, width: fs.pip!.width, height: fs.pip!.height }).toEqual(rect);
    expect(fs.pip!.draw!.source).toEqual(framingSource(style, cam));
    expect(fs.pip!.draw!.radiusPx).toBe(rect.width / 2);
    expect(fs.pip!.draw!.mirror).toBe(true);
    expect(fs.pip!.draw!.shadow).toBe(true);
    // Border points scale exactly as the cursor's points do. The fixture has zoom
    // off and cursor.scale 1, so pxPerPoint IS the display->output factor here.
    expect(fs.zoom.amount).toBe(0);
    expect(styled.cursor.scale).toBe(1);
    expect(fs.pip!.draw!.border).toEqual({ px: 2 * fs.cursor.pxPerPoint, color: "#ffffff" });
  });
  test("a rounded rect's radius is a fraction of the short side", () => {
    const { project, session } = pipSession();
    const style = { ...DEFAULT_PIP_STYLE, shape: "rect" as const, cornerRadius: 0.25 };
    const fs = render({ ...project, pip: { ...project.pip!, style } }, session, t);
    expect(fs.pip!.draw!.radiusPx).toBe(0.25 * Math.min(fs.pip!.width, fs.pip!.height));
  });
});
```

Append to `transform/test/compositor.test.ts`:

```ts
describe("the styled PiP (STC-461) — drawing order", () => {
  const cam = { displayWidth: 1280, displayHeight: 720 } as unknown as VideoFrame;
  const base = { frameIndex: 0, framePtsNs: 0, x: 100, y: 50, width: 200, height: 200 };
  const drawOps = (draw?: import("../src/render.js").PipDraw) => {
    const { ctx, ops } = recorder();
    const fs: FrameState = { ...frameState({ visible: false }), pip: { ...base, draw } };
    composite(ctx as unknown as OffscreenCanvasRenderingContext2D, null, cam, fs, 640, 360);
    return ops;
  };
  test("no draw block: the single five-argument call, byte for byte the old one", () => {
    expect(drawOps().filter((o) => o.startsWith("drawImage"))).toEqual(["drawImage([object Object],100,50,200,200)"]);
    expect(drawOps()).not.toContain("clip()");
  });
  test("shadow is filled BEFORE the clip; the image is drawn inside it; the border after restore", () => {
    const ops = drawOps({ source: { x: 280, y: 0, width: 720, height: 720 }, mirror: false, radiusPx: 100,
      border: { px: 3, color: "#ffffff" }, shadow: true });
    const i = (s: string) => ops.findIndex((o) => o.startsWith(s));
    expect(i("shadowBlur=")).toBeGreaterThan(-1);
    expect(i("fill()")).toBeLessThan(i("clip()"));
    expect(i("clip()")).toBeLessThan(i("drawImage"));
    expect(ops[i("drawImage")]).toBe("drawImage([object Object],280,0,720,720,100,50,200,200)");
    expect(ops.lastIndexOf("restore()")).toBeLessThan(i("stroke()"));
    expect(ops).toContain("roundRect(100,50,200,200,100)");
    expect(ops).toContain("lineWidth=3");
    expect(ops).toContain("strokeStyle=#ffffff");
  });
  test("mirror flips about the PiP's own centre", () => {
    const ops = drawOps({ source: { x: 0, y: 0, width: 1280, height: 720 }, mirror: true, radiusPx: 0, border: null, shadow: false });
    expect(ops).toContain("translate(400,0)");   // 2*x + width
    expect(ops).toContain("scale(-1,1)");
    expect(ops.indexOf("scale(-1,1)")).toBeLessThan(ops.findIndex((o) => o.startsWith("drawImage")));
    expect(ops).not.toContain("stroke()");
    expect(ops.some((o) => o.startsWith("shadowBlur="))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run transform/test/render.test.ts transform/test/compositor.test.ts`
Expected: FAIL — `draw` is undefined / no `clip()`.

- [ ] **Step 3: Implement**

`transform/src/render.ts` — imports: add `import { pipRect, framingSource } from "./pip-style.js";`. Replace `PipState` and `pipStateAt`:

```ts
/** A styled PiP's drawing parameters, fully resolved (STC-461). The compositor decides nothing. */
export interface PipDraw {
  /** `drawImage`'s source rect, camera pixels. */
  source: Rect;
  mirror: boolean;
  /** Output pixels; a circle is half its side. */
  radiusPx: number;
  border: { px: number; color: string } | null;
  shadow: boolean;
}

export interface PipState {
  frameIndex: number;
  framePtsNs: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Absent = the fixed-corner PiP, drawn exactly as before project-15. */
  draw?: PipDraw;
}
```

```ts
function pipStateAt(project: Project, session: Session, tNs: number, pxPerDisplayPoint: number): PipState | null {
  // ...existing guards and frameIndex lookup, unchanged...

  if (pip.style) {
    // STC-461: pip-style.ts decides; a style can never fall back to the
    // corner silently, because parseProject only keeps a style it validated.
    const style = pip.style;
    const rect = pipRect(style, project.output, cam);
    const short = Math.min(rect.width, rect.height);
    return {
      frameIndex, framePtsNs: frames[frameIndex]!, ...rect,
      draw: {
        source: framingSource(style, cam),
        mirror: style.mirror,
        radiusPx: style.shape === "circle" ? short / 2 : style.cornerRadius * short,
        // Points, scaled the way the cursor's are: a 2 pt border is a 2 pt line
        // on the recorded display, at whatever size the output is.
        border: style.border ? { px: style.border.widthPt * pxPerDisplayPoint, color: style.border.color } : null,
        shadow: style.shadow,
      },
    };
  }

  // ...existing fixed-corner return, unchanged...
}
```

At the call site: `pip: pipStateAt(project, session, tNs, m.sx),`. (`m.sx` is display points → output pixels. The cursor's `scale` is a cursor preference and must NOT scale the border, and neither must the zoom magnification — the PiP is drawn on the canvas, not in the picture.)

`transform/src/compositor.ts` — import `PIP_SHADOW` from `./pip-style.js` and `type PipDraw, type PipState` from `./render.js`. Replace the PiP block:

```ts
  if (fs.pip && camera) {
    if (fs.pip.draw) drawStyledPip(ctx, camera, fs.pip, fs.pip.draw);
    else ctx.drawImage(camera, fs.pip.x, fs.pip.y, fs.pip.width, fs.pip.height);
  }
```

and add below `composite`:

```ts
function pipPath(ctx: OffscreenCanvasRenderingContext2D, p: PipState, radiusPx: number): void {
  ctx.beginPath();
  ctx.roundRect(p.x, p.y, p.width, p.height, radiusPx);
}

/**
 * A styled PiP (STC-461). Order is the whole design:
 *  1. the shadow is a FILL of the shape, drawn before any clip — a clip would cut it off;
 *  2. the camera is drawn inside the clip, through a flip about the PiP's own centre when mirrored;
 *  3. the border is stroked after the clip is released, centred on the edge.
 */
function drawStyledPip(
  ctx: OffscreenCanvasRenderingContext2D, camera: DecodedFrame, p: PipState, d: PipDraw,
): void {
  const short = Math.min(p.width, p.height);
  ctx.save();
  if (d.shadow) {
    ctx.save();
    ctx.shadowColor = PIP_SHADOW.color;
    ctx.shadowBlur = PIP_SHADOW.blurFraction * short;
    ctx.shadowOffsetY = PIP_SHADOW.offsetYFraction * short;
    ctx.fillStyle = "#000000";
    pipPath(ctx, p, d.radiusPx);
    ctx.fill();
    ctx.restore();
  }
  pipPath(ctx, p, d.radiusPx);
  ctx.clip();
  if (d.mirror) {
    ctx.translate(2 * p.x + p.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(camera, d.source.x, d.source.y, d.source.width, d.source.height, p.x, p.y, p.width, p.height);
  ctx.restore();
  if (d.border) {
    ctx.lineWidth = d.border.px;
    ctx.strokeStyle = d.border.color;
    pipPath(ctx, p, d.radiusPx);
    ctx.stroke();
  }
}
```

(If `DecodedFrame` is not the name of the camera parameter's type in `compositor.ts`, use whatever type `composite`'s `camera` parameter already has.)

`transform/src/transform-version.ts`:
- import `{ PIP_SHADOW, DEFAULT_FRAMING }` from `./pip-style.js`.
- Add a header section `## Version 14: the styled PiP (STC-461)` stating: project-15's `pip.style` draws a clipped, optionally mirrored, bordered and shadowed camera at an authored place and framing; a document with no style draws exactly what version 13 did (one 5-argument `drawImage`); the fingerprint moved because `PIP_SHADOW` and `DEFAULT_FRAMING` reach the pixels.
- `export const TRANSFORM_VERSION = 14;`
- Append to `TRANSFORM_HISTORY`: `{ version: 14, since: "2026-10-02", changed: "the styled PiP (STC-461): project-15's pip.style — shape (rect/square/circle) and corner radius, an authored centre and width, a framing crop of the camera, mirror, border in display points and one drop shadow, all resolved in render() and drawn by the one compositor. A document with no style draws exactly what version 13 did. The fingerprint moved: PIP_SHADOW and DEFAULT_FRAMING reach the pixels" },`
- In `transformFingerprint`'s `inputs`, add `pip: [PIP_SHADOW, DEFAULT_FRAMING],`.

`transform/src/spaces.ts` — in the `**PiP rect**` paragraph (~line 120), append: "With project-15's `pip.style` (STC-461) the authored rect is the source: `pip-style.ts`'s `pipRect`/`framingSource` own it, and `fixedCornerPipUv` remains the answer for documents without a style."

- [ ] **Step 4: Re-pin the fingerprint**

Run: `npx vitest run transform/test/transform-version.test.ts`
Expected: FAIL showing the new fingerprint string. Update `PINNED_FINGERPRINT` to it and update the comment above it to "It last moved at version 14 (STC-461): PIP_SHADOW and DEFAULT_FRAMING were added as inputs." Re-run → PASS.

- [ ] **Step 5: Run the transform suite**

Run: `npx vitest run transform/`
Expected: PASS (including `render-refit.test.ts` goldens and `export-pip.test.ts` — both use the unstyled path and must not move).

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add transform/src/render.ts transform/src/compositor.ts transform/src/transform-version.ts transform/src/spaces.ts transform/test/render.test.ts transform/test/compositor.test.ts transform/test/transform-version.test.ts
git commit -m "STC-461: render and draw a styled PiP; TRANSFORM_VERSION 14

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: the styled fixture in `gate:identity`

**Files:**
- Create: `fixtures/pip-styled/project.json`
- Modify: `.github/workflows/ci.yml` (the "Export and identity gates" step, after the existing `npm run gate:identity -- "$CAM"`)
- Modify: `transform/test/schema.test.ts` (validate the new fixture)

**Interfaces:** Consumes the v15 document shape (Task 3) and the drawing path (Task 4).

- [ ] **Step 1: Write the fixture** — `fixtures/pip-styled/project.json`:

```json
{
  "version": 15,
  "output": { "fps": 60, "width": 640, "height": 360 },
  "cursor": { "style": "default", "scale": 1 },
  "transform": { "version": 14 },
  "pip": {
    "enabled": true, "corner": "bottom-right", "widthPct": 0.125, "marginPx": 32,
    "style": {
      "shape": "circle", "cornerRadius": 0, "center": { "x": 0.22, "y": 0.3 }, "width": 0.25,
      "framing": { "x": 0.42, "y": 0.5, "zoom": 1.5 },
      "mirror": true, "border": { "widthPt": 2, "color": "#ffffff" }, "shadow": true
    }
  }
}
```

It holds ONLY `project.json`; the media comes from `fixtures/pip/` (never copy `camera.mp4` — it is a real person, STC-302).

- [ ] **Step 2: Schema test** — append to `transform/test/schema.test.ts`, using its own `compile`/`load` helpers:

```ts
  test("fixtures/pip-styled's project.json conforms to project-15 (STC-461)", () => {
    const validate = compile("schema/project-15.schema.json");
    const ok = validate(load("fixtures/pip-styled/project.json"));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
```

Run: `npx vitest run transform/test/schema.test.ts` → PASS.

- [ ] **Step 3: Run the gate locally** (needs real Chrome; the gate passes or fails on its own assertions)

```bash
STY="$(mktemp -d)/2026-01-01_00-00-00"; mkdir -p "$STY"
cp fixtures/pip/anchors.json fixtures/pip/events.json fixtures/pip/display.mp4 fixtures/pip/camera.mp4 "$STY/"
cp fixtures/pip-styled/project.json "$STY/"
npm run gate:identity -- "$STY"
```

Expected: PASS, with `pipDrawnFrames > 0` and `pipBlindMismatches` reported as 0 (the gate prints both). If the gate reports a sink mismatch only on this fixture, the shadow or clip is not deterministic across sinks — STOP and report it; do not weaken the gate.

Also run the unstyled one unchanged (`cp` without `project.json`, as CI does) and confirm it still passes.

- [ ] **Step 4: CI** — in `.github/workflows/ci.yml`, after `npm run gate:identity -- "$CAM"`, add:

```yaml
          # STC-461: the same camera take with a STYLED PiP (circle, border,
          # shadow, mirror, reframed). The step above pins the defaulted,
          # unstyled path; this one makes the two sinks agree on the clip,
          # the flip and the shadow. Media from fixtures/pip — never a second
          # copy of camera.mp4 (STC-302).
          STY="$(mktemp -d)/2026-01-01_00-00-00"
          mkdir -p "$STY"
          cp fixtures/pip/anchors.json fixtures/pip/events.json \
             fixtures/pip/display.mp4 fixtures/pip/camera.mp4 "$STY/"
          cp fixtures/pip-styled/project.json "$STY/"
          npm run gate:identity -- "$STY"
```

- [ ] **Step 5: Commit**

```bash
git add fixtures/pip-styled/project.json transform/test/schema.test.ts .github/workflows/ci.yml
git commit -m "STC-461: gate:identity on a styled PiP fixture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: the default reaches a take — settings, seed, write gate

**Files:**
- Modify: `app/src/take-project.ts`
- Modify: `app/src/settings.ts` (interface ~102, `DEFAULT_SETTINGS` ~236, `readSettings` ~388, `writeSettings` clean block)
- Modify: `app/src/main.ts:1489` (take-end choice) and `:2459-2466` (write gate)
- Test: `app/test/take-project.test.ts`, `app/test/settings.test.ts`, `app/test/preview-write-project.e2e.test.ts`

**Interfaces:**
- Consumes: `PipStyle`, `cleanPipStyle`, `isDefaultPipStyle`, `DEFAULT_PIP_STYLE`, `DEFAULT_PIP_FIXED` from `@transform/pip-style.js`.
- Produces:
  - `RecordTimeChoices { showClicks: boolean; pipStyle: PipStyle | null }`
  - `Settings.pipStyle: PipStyle` (never carries `framing`)
  - `defaultStyleForTake(stored: PipStyle, cameraOn: boolean): PipStyle | null` (exported from `take-project.ts`)

- [ ] **Step 1: Write the failing tests**

Append to `app/test/take-project.test.ts`:

```ts
import { recordTimeProject, defaultStyleForTake } from "../src/take-project.js";
import { DEFAULT_PIP_STYLE, type PipStyle } from "@transform/pip-style.js";

const CIRCLE: PipStyle = { ...DEFAULT_PIP_STYLE, shape: "circle", shadow: true };

describe("the PiP default seeds a take (STC-461)", () => {
  test("default style or camera off: nothing (Review Focus 4)", () => {
    expect(defaultStyleForTake(DEFAULT_PIP_STYLE, true)).toBeNull();
    expect(defaultStyleForTake(CIRCLE, false)).toBeNull();
    expect(recordTimeProject({ showClicks: true, pipStyle: null })).toBeNull();
  });
  test("a non-default style with the camera on seeds a v15 pip, never a framing", () => {
    const style = defaultStyleForTake({ ...CIRCLE, framing: { x: 0.3, y: 0.5, zoom: 2 } }, true)!;
    expect(style.framing).toBeUndefined();
    const doc = JSON.parse(recordTimeProject({ showClicks: true, pipStyle: style })!);
    expect(doc.version).toBe(15);
    expect(doc.pip).toEqual({ enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32, style });
    expect(doc.showClicks).toBeUndefined();
  });
  test("both choices together keep both, at v15", () => {
    const doc = JSON.parse(recordTimeProject({ showClicks: false, pipStyle: CIRCLE })!);
    expect(doc).toMatchObject({ version: 15, showClicks: false });
    expect(doc.pip.style.shape).toBe("circle");
  });
  test("show-clicks alone is byte-for-byte what it was", () => {
    expect(recordTimeProject({ showClicks: false, pipStyle: null }))
      .toBe(JSON.stringify({ version: 13, showClicks: false }, null, 2) + "\n");
  });
});
```

Update the file's existing calls `recordTimeProject({ showClicks: … })` to pass `pipStyle: null`.

Append to `app/test/settings.test.ts` (use the file's existing temp-dir helper; if it has none, `mkdtempSync(join(tmpdir(), "stc-settings-"))`):

```ts
describe("pipStyle (STC-461)", () => {
  test("defaults to DEFAULT_PIP_STYLE", () => {
    expect(readSettings(freshDir()).pipStyle).toEqual(DEFAULT_PIP_STYLE);
  });
  test("round-trips, and never stores a framing", () => {
    const dir = freshDir();
    writeSettings(dir, { pipStyle: { ...DEFAULT_PIP_STYLE, shape: "circle", framing: { x: 0.3, y: 0.5, zoom: 2 } } });
    const back = readSettings(dir).pipStyle;
    expect(back.shape).toBe("circle");
    expect(back.framing).toBeUndefined();
  });
  test("a bad stored style falls back to the default", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ pipStyle: { shape: "hexagon" } }));
    expect(readSettings(dir).pipStyle).toEqual(DEFAULT_PIP_STYLE);
  });
});
```

(Use the settings file name `settings.ts` actually uses — its `FILE` constant.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/test/take-project.test.ts app/test/settings.test.ts`
Expected: FAIL — `defaultStyleForTake` is not exported / `pipStyle` undefined.

- [ ] **Step 3: Implement**

`app/src/take-project.ts` — add to the header a short `## The PiP default (STC-461)` paragraph: Settings' PiP style is chosen before there is an editor, like Show Clicks; it is seeded only when it differs from the default AND the take was started with the camera on, and never with a framing (framing is per take; absent = centred). Then:

```ts
import { DEFAULT_PIP_FIXED, isDefaultPipStyle, type PipStyle } from "@transform/pip-style.js";

export interface RecordTimeChoices {
  showClicks: boolean;
  /** Already filtered by `defaultStyleForTake`: null = seed nothing. */
  pipStyle: PipStyle | null;
}

/** The style a new take starts with, or null when there is nothing to say. */
export function defaultStyleForTake(stored: PipStyle, cameraOn: boolean): PipStyle | null {
  if (!cameraOn || isDefaultPipStyle(stored)) return null;
  const { framing: _framing, ...style } = stored;
  return style;
}

/** The text to write to project.json, or null when every choice is the default. */
export function recordTimeProject(choices: RecordTimeChoices): string | null {
  const body: Record<string, unknown> = {};
  let version = 0;
  if (!choices.showClicks) { body.showClicks = false; version = 13; }
  if (choices.pipStyle) { body.pip = { ...DEFAULT_PIP_FIXED, style: choices.pipStyle }; version = 15; }
  if (version === 0) return null;
  return JSON.stringify({ version, ...body }, null, 2) + "\n";
}
```

`app/src/settings.ts`:
- import `{ cleanPipStyle, DEFAULT_PIP_STYLE, type PipStyle } from "@transform/pip-style.js"`.
- Interface field, after `showClicks`:
```ts
  /**
   * The PiP style new camera takes start with (STC-461). Never read at draw
   * time: take-project.ts seeds it into a take's project.json when the take
   * ends. Never holds a framing — framing is per take.
   */
  pipStyle: PipStyle;
```
- `DEFAULT_SETTINGS`: `pipStyle: { ...DEFAULT_PIP_STYLE },`
- helper:
```ts
/** A bad stored style is a preference with no opinion: the default, like every other field here. */
function cleanStoredPipStyle(v: unknown): PipStyle {
  const s = cleanPipStyle(v);
  if (!s) return { ...DEFAULT_PIP_STYLE, center: { ...DEFAULT_PIP_STYLE.center } };
  const { framing: _framing, ...rest } = s;
  return rest;
}
```
- `readSettings`: `pipStyle: cleanStoredPipStyle(doc.pipStyle),`
- `writeSettings`'s `clean`: `pipStyle: cleanStoredPipStyle(merged.pipStyle),`

`app/src/main.ts`:
- import `defaultStyleForTake` from `./take-project.js` (beside `recordTimeProject`) and `cleanPipStyle` from `@transform/pip-style.js`.
- Line ~1489: `recordTimeChoices.set(dir, { showClicks: options.showClicks, pipStyle: defaultStyleForTake(stored.pipStyle, options.camera === true) });` (`stored` is `recordFlowBody`'s parameter.)
- Write gate, inside `if (doc.pip !== undefined) { … }` after the existing throw:
```ts
    // project-15 (STC-461): the write gate REFUSES a style the transform would
    // have to drop — a bad style must never reach disk.
    if (p.style !== undefined && cleanPipStyle(p.style) === null) {
      throw new Error("project.json: malformed pip.style");
    }
```

Add to `app/test/preview-write-project.e2e.test.ts`, following that file's existing pattern for a refused write, one test that writes a v15 document whose `pip.style.border.color` is `"white"` and expects the write to be refused (the existing tests show how the refusal surfaces), and one that writes a valid v15 style and expects it on disk.

- [ ] **Step 4: Run tests**

Run: `npx vitest run app/test/take-project.test.ts app/test/settings.test.ts`
Expected: PASS. Then `npm run typecheck` (the node pass is the one that proves `pip-style.ts` is main-process safe).

- [ ] **Step 5: Commit**

```bash
git add app/src/take-project.ts app/src/settings.ts app/src/main.ts app/test/take-project.test.ts app/test/settings.test.ts app/test/preview-write-project.e2e.test.ts
git commit -m "STC-461: the PiP default — Settings, the take-end seed, the write gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: the shared inspector + the editor's Camera popover

**Files:**
- Create: `app/src/pip-inspector.ts`, `app/renderer/pip-inspector.css`
- Modify: `app/renderer/editor.html` (Camera button + popover beside `#audiobtn`/`#audiopanel` ~596-601; `#pipoverlay` beside `#rectoverlay` ~505; `<link rel="stylesheet" href="pip-inspector.css">`)
- Modify: `app/src/editor.ts` (new `// ---- PiP (STC-461)` section), `app/src/editor-preload.ts` (`setPipStyleDefault`)
- Modify: `app/build.mjs` only if renderer CSS files must be listed there (check how `device-menu.css` is shipped and do the same)
- Test: `app/test/pip-editor.e2e.test.ts`

**Interfaces:**
- Consumes: everything in `pip-style.ts`; `persistProject()`, `player.seek(player.currentNs)`, `openProject`, `openSession`, `stageUv(clientX, clientY)` in `editor.ts`.
- Produces:
```ts
// app/src/pip-inspector.ts
export interface PipInspectorHost {
  surface: "editor" | "settings";
  /** live = while dragging a slider (repaint only); commit = on change (persist). */
  onEdit(edit: PipEdit, phase: "live" | "commit"): void;
  onEnabled?(enabled: boolean): void;        // editor only
  onReframe?(): void;                        // editor only
  onUseAsDefault?(): void;                   // editor only
}
export interface PipInspector { render(style: PipStyle, enabled: boolean): void }
export function buildPipInspector(root: HTMLElement, host: PipInspectorHost): PipInspector
```
- Element IDs the e2e relies on: `#pipbtn`, `#pippanel`, `#pipoverlay`, `#piphandle`, `[data-pip-preset="<name>"]`, `[data-pip-shape="<shape>"]`, `#pipsize`, `#pipradius`, `#pipborder`, `#pipborderwidth`, `#pipbordercolor`, `#pipshadow`, `#pipmirror`, `#pipenabled`, `#pipreframe`, `#pipdefault`.

- [ ] **Step 1: Write the failing e2e** — `app/test/pip-editor.e2e.test.ts`:

```ts
import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { pipRect, PIP_SNAP_MARGIN_PX } from "../../transform/src/pip-style.js";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const savedPip = (dir: string) => {
  try { return JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).pip; } catch { return undefined; }
};

describe("the editor's Camera popover (STC-461)", () => {
  test("hidden for a take with no camera", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await editorWin.isHidden("#pipbtn")).toBe(true);
  }, 120_000);

  test("the Circle preset saves a v15 circle", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    await editorWin.click("#pipbtn");
    await editorWin.click('[data-pip-preset="circle"]');
    await expect.poll(() => savedPip(takeDir)?.style?.shape, { timeout: 10_000 }).toBe("circle");
    expect(JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8")).version).toBe(15);
  }, 120_000);

  test("dragging the PiP near the top-left corner snaps it onto the margin", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    await editorWin.click("#pipbtn");
    const box = (await editorWin.locator("#pipoverlay .pipbox").boundingBox())!;
    const stage = (await editorWin.locator("#stage").boundingBox())!;
    await editorWin.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await editorWin.mouse.down();
    // Aim a few pixels short of the snapped spot; the snap must finish the job.
    const scale = stage.width / 640;
    await editorWin.mouse.move(stage.x + (PIP_SNAP_MARGIN_PX + 4) * scale + box.width / 2,
                               stage.y + (PIP_SNAP_MARGIN_PX + 3) * scale + box.height / 2, { steps: 8 });
    await editorWin.mouse.up();
    await expect.poll(() => savedPip(takeDir)?.style, { timeout: 10_000 }).toBeDefined();
    const style = savedPip(takeDir).style;
    const r = pipRect(style, { width: 640, height: 360 }, { width: 1280, height: 720 });
    expect([r.x, r.y]).toEqual([PIP_SNAP_MARGIN_PX, PIP_SNAP_MARGIN_PX]);
  }, 120_000);
});
```

(Check `launchWithTakeInEditor({ pip: true })` uses `fixtures/pip` — 640×360 output, 1280×720 camera; if its output differs, use the take's `anchors.json` capture size in the test instead of the literals.)

- [ ] **Step 2: Run to verify it fails** — run it in the VM per `docs/VM-TESTING.md` (or locally only if the user allows): `npx vitest run app/test/pip-editor.e2e.test.ts`. Expected: FAIL — `#pipbtn` not found.

- [ ] **Step 3: Implement the inspector** — `app/src/pip-inspector.ts`:

```ts
import {
  PIP_PRESETS, PIP_WIDTH_MIN, PIP_WIDTH_MAX, PIP_RADIUS_MAX, PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX,
  DEFAULT_BORDER, type PipEdit, type PipStyle,
} from "@transform/pip-style.js";

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
  onEdit(edit: PipEdit, phase: "live" | "commit"): void;
  onEnabled?(enabled: boolean): void;
  onReframe?(): void;
  onUseAsDefault?(): void;
}
export interface PipInspector { render(style: PipStyle, enabled: boolean): void }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) {
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
```

`app/renderer/pip-inspector.css` — compact rows matching `device-menu.css`'s metrics, using `tokens.css` tokens only (no new colours): `.pip-inspector{display:grid;gap:8px;min-width:240px}`, `.pip-presets{display:flex;flex-wrap:wrap;gap:6px}`, `.pip-chip` a pill button, `.pip-segmented` a 3-up button group with `[aria-checked="true"]` using `var(--accent)`, `.pip-row{display:flex;align-items:center;gap:8px;justify-content:space-between}`, `.pip-actions{display:flex;gap:8px;justify-content:flex-end}`, disabled controls at `opacity:.4`. Plus the overlay: `#pipoverlay{position:absolute;inset:0;pointer-events:none}`, `#pipoverlay .pipbox{position:absolute;pointer-events:auto;cursor:move;outline:1px solid var(--accent)}`, `#piphandle{position:absolute;right:-5px;bottom:-5px;width:10px;height:10px;border-radius:50%;background:var(--accent);cursor:nwse-resize}`. (`#pipoverlay` must sit exactly over `#stage` the way `#rectoverlay` does — copy `#rectoverlay`'s positioning rules.)

- [ ] **Step 4: Editor markup** — in `app/renderer/editor.html`:
  - beside `#rectoverlay`: `<div id="pipoverlay" hidden><div class="pipbox"><div id="piphandle"></div></div></div>`
  - beside `#audiobtn`: `<button type="button" id="pipbtn" class="audiobtn" popovertarget="pippanel" hidden aria-label="Camera">Camera</button>` and `<div id="pippanel" popover="auto" aria-label="Camera"></div>` (mirror `#audiobtn`/`#audiopanel`'s exact attributes and classes).
  - `<link rel="stylesheet" href="pip-inspector.css">` beside `tokens.css`.

- [ ] **Step 5: Editor wiring** — `app/src/editor-preload.ts`: add `setPipStyleDefault: (style: unknown) => ipcRenderer.invoke("recorder:setSettings", { pipStyle: style }),` and the matching member on the `editor` bridge type in `editor.ts` (line ~31): `setPipStyleDefault: (style: unknown) => Promise<unknown>;`. Confirm `main.ts`'s `recorder:setSettings` handler passes its patch to `writeSettings` (grep it); `writeSettings` cleans `pipStyle` (Task 6).

`app/src/editor.ts` — new section:

```ts
// ---- PiP (STC-461) ----------------------------------------------------------
//
// The Camera popover hosts pip-inspector.ts; #pipoverlay lets the PiP be
// dragged (snapping, pip-style.ts's snapCenter) and resized from its corner.
// Every decision is pip-style.ts's. The player shares `openProject`, so an edit
// is a mutation plus a repaint; a COMMIT also persists.

import {
  editPipStyle, pipRect, pipSize, snapCenter, resizeFromCorner, styleFromFixedCorner,
  PIP_SNAP_THRESHOLD_SCREEN_PX, type PipEdit, type PipStyle,
} from "@transform/pip-style.js";
import { buildPipInspector } from "./pip-inspector.js";

function pipCamera(): { width: number; height: number } | null {
  const cam = openSession?.anchors.camera;
  return cam?.present ? { width: cam.width, height: cam.height } : null;
}

/** The take's style, or the fixed corner expressed as one so a first edit cannot jump. */
function currentPipStyle(): PipStyle | null {
  const cam = pipCamera();
  if (!openProject?.pip || !cam) return null;
  return openProject.pip.style ?? styleFromFixedCorner(openProject.pip, openProject.output, cam);
}

function setPipStyle(style: PipStyle, persist: boolean): void {
  if (!openProject?.pip || !player) return;
  openProject.pip.style = style;
  pipInspector.render(style, openProject.pip.enabled);
  layoutPipOverlay();
  void player.seek(player.currentNs);
  if (persist) void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
}

const pipInspector = buildPipInspector($("pippanel"), {
  surface: "editor",
  onEdit(edit: PipEdit, phase) {
    const style = currentPipStyle();
    const cam = pipCamera();
    if (!style || !cam) return;
    setPipStyle(editPipStyle(style, edit, cam), phase === "commit");
  },
  onEnabled(enabled) {
    if (!openProject?.pip || !player) return;
    openProject.pip.enabled = enabled;
    void player.seek(player.currentNs);
    void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
  },
  onReframe() { enterReframe(); },           // Task 8
  onUseAsDefault() {
    const style = currentPipStyle();
    if (style) void editor.setPipStyleDefault(style);
  },
});

function updatePipButton(): void {
  const has = !!openProject?.pip && !!pipCamera();
  $("pipbtn").toggleAttribute("hidden", !has);
  if (!has) (document.getElementById("pippanel") as HTMLElement & { hidePopover?: () => void }).hidePopover?.();
  const style = currentPipStyle();
  if (style && openProject?.pip) pipInspector.render(style, openProject.pip.enabled);
}

/** Output px → stage CSS px, from the stage's live box (it already reflects any CSS transform). */
function stageScale(): { left: number; top: number; k: number } {
  const r = ($("stage") as HTMLCanvasElement).getBoundingClientRect();
  return { left: r.left, top: r.top, k: r.width / openProject!.output.width };
}

function layoutPipOverlay(): void {
  const overlay = $("pipoverlay");
  const style = currentPipStyle();
  const cam = pipCamera();
  if (!style || !cam || !openProject) { overlay.hidden = true; return; }
  const r = pipRect(style, openProject.output, cam);
  const { k } = stageScale();
  const box = overlay.querySelector<HTMLElement>(".pipbox")!;
  Object.assign(box.style, { left: `${r.x * k}px`, top: `${r.y * k}px`, width: `${r.width * k}px`, height: `${r.height * k}px`,
    borderRadius: style.shape === "circle" ? "50%" : `${style.cornerRadius * Math.min(r.width, r.height) * k}px` });
}

$("pippanel").addEventListener("toggle", (e) => {
  const open = (e as ToggleEvent).newState === "open";
  $("pipoverlay").hidden = !open;
  if (open) layoutPipOverlay();
});

let pipDrag: { kind: "move" | "resize"; dx: number; dy: number } | null = null;

$("pipoverlay").addEventListener("pointerdown", (e) => {
  const style = currentPipStyle();
  const cam = pipCamera();
  if (!style || !cam || !openProject) return;
  const target = e.target as HTMLElement;
  if (!target.closest(".pipbox")) return;
  const { left, top, k } = stageScale();
  const px = (e.clientX - left) / k, py = (e.clientY - top) / k;
  pipDrag = target.id === "piphandle"
    ? { kind: "resize", dx: 0, dy: 0 }
    : { kind: "move", dx: px - style.center.x * openProject.output.width, dy: py - style.center.y * openProject.output.height };
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
});

$("pipoverlay").addEventListener("pointermove", (e) => {
  if (!pipDrag || !openProject) return;
  const style = currentPipStyle();
  const cam = pipCamera();
  if (!style || !cam) return;
  const { left, top, k } = stageScale();
  const out = openProject.output;
  const px = (e.clientX - left) / k, py = (e.clientY - top) / k;
  if (pipDrag.kind === "resize") {
    setPipStyle(resizeFromCorner(style, { x: px, y: py }, out, cam), false);
    return;
  }
  const raw = { x: (px - pipDrag.dx) / out.width, y: (py - pipDrag.dy) / out.height };
  const snapped = snapCenter(raw, pipSize(style, out, cam), out, PIP_SNAP_THRESHOLD_SCREEN_PX / k);
  setPipStyle(editPipStyle(style, { kind: "move", center: snapped }, cam), false);
});

$("pipoverlay").addEventListener("pointerup", () => {
  if (!pipDrag) return;
  pipDrag = null;
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});

window.addEventListener("resize", () => { if (!$("pipoverlay").hidden) layoutPipOverlay(); });
```

Call `updatePipButton()` wherever `updateAudioButton()` is called after a take loads (the same place), so the button and inspector state follow the take. Keep the `import` lines at the top of `editor.ts` with the others (the snippet shows them inline only for reading).

Note: `#pippanel` is `popover="auto"` and closes on an outside click — a press on `#pipoverlay` is "outside". Mirror how `#audiopanel` handles its own `pointerdown` (editor.ts ~1820) if it keeps itself open; if not, make the overlay pointerdown call `$("pippanel").showPopover?.()` after the drag ends so the inspector stays visible. Verify by hand in the runbook (§3).

- [ ] **Step 6: Run** — `npm run typecheck`, `npm run app:start` to look at it once, then the e2e (VM): `npx vitest run app/test/pip-editor.e2e.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/pip-inspector.ts app/renderer/pip-inspector.css app/renderer/editor.html app/src/editor.ts app/src/editor-preload.ts app/test/pip-editor.e2e.test.ts app/build.mjs
git commit -m "STC-461: the PiP inspector and the editor's Camera popover — presets, drag, snap, resize

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Reframe mode

**Files:**
- Modify: `app/renderer/editor.html` (`#pipframing` beside `#pipoverlay`; a small bar like `#overridebar` with a zoom slider `#pipzoom` and `#pipframedone`)
- Modify: `app/src/editor.ts` (PiP section), `app/renderer/pip-inspector.css`
- Test: `app/test/pip-editor.e2e.test.ts` (append)

**Interfaces:**
- Consumes: `panFraming`, `zoomFraming`, `framingSource`, `pipRect`, `editPipStyle`, `DEFAULT_PIP_STYLE`.
- Produces: `enterReframe(): void`, `exitReframe(commit: boolean): void` in `editor.ts`; element IDs `#pipframing`, `#pipframewindow`, `#pipzoom`, `#pipframedone`.

**How it works (spec §3 "Reframe, concretely"):** On enter, remember the real style; give the LIVE project a temporary style — `{ ...real, shape: "rect", cornerRadius: 0, width: 0.5, center: {x:0.5,y:0.5}, border: null, shadow: false, framing: undefined }` (the whole camera frame, large, centred, same `mirror`) — and repaint. `#pipframing` draws `#pipframewindow` over that temporary rect at the REAL framing's crop, in the real shape (`border-radius: 50%` for a circle), with `box-shadow: 0 0 0 9999px rgba(0,0,0,.55)` dimming the rest (`#pipframing{overflow:hidden}` keeps the dim inside the stage). This window element is the surface STC-497's guides will draw inside. Drag the window to pan; `#pipzoom` and the wheel zoom. Done (or Escape) restores the real style with the new framing and persists; nothing else is ever written while reframing.

- [ ] **Step 1: Write the failing e2e** (append):

```ts
  test("reframe: dragging the window right moves framing.x right, and Done saves it", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    await editorWin.click("#pipbtn");
    await editorWin.click('[data-pip-preset="circle"]');
    await editorWin.click("#pipreframe");
    await editorWin.fill("#pipzoom", "2");
    await editorWin.dispatchEvent("#pipzoom", "change");
    const w = (await editorWin.locator("#pipframewindow").boundingBox())!;
    await editorWin.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
    await editorWin.mouse.down();
    await editorWin.mouse.move(w.x + w.width / 2 + 20, w.y + w.height / 2, { steps: 5 });
    await editorWin.mouse.up();
    await editorWin.click("#pipframedone");
    await expect.poll(() => savedPip(takeDir)?.style?.framing?.zoom, { timeout: 10_000 }).toBe(2);
    expect(savedPip(takeDir).style.framing.x).toBeGreaterThan(0.5);
    expect(savedPip(takeDir).style.shape).toBe("circle");
    expect(savedPip(takeDir).style.width).not.toBe(0.5);   // the temporary display style never leaked
  }, 120_000);
```

- [ ] **Step 2: Run to verify it fails** (VM) — FAIL: `#pipreframe` does nothing / `#pipzoom` missing.

- [ ] **Step 3: Markup** — in `editor.html` beside `#pipoverlay`: `<div id="pipframing" hidden><div id="pipframewindow"></div></div>` and, beside `#overridebar`, `<div class="overridebar" id="pipframebar" hidden><span>Drag to reframe</span><label>Zoom <input id="pipzoom" type="range" min="1" max="3" step="0.05"></label><button id="pipframedone">Done</button></div>`. CSS: `#pipframing{position:absolute;inset:0;overflow:hidden}` (same box as `#pipoverlay`), `#pipframewindow{position:absolute;cursor:grab;outline:1px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.55)}`.

- [ ] **Step 4: Implement** (add to the PiP section of `editor.ts`; import `panFraming, zoomFraming, framingSource` with the others):

```ts
let reframing: { real: PipStyle } | null = null;

function displayStyleFor(real: PipStyle): PipStyle {
  return { ...real, shape: "rect", cornerRadius: 0, width: 0.5, center: { x: 0.5, y: 0.5 },
    border: null, shadow: false, framing: undefined };
}

function layoutFramingWindow(): void {
  const cam = pipCamera();
  if (!reframing || !cam || !openProject) return;
  const shown = pipRect(displayStyleFor(reframing.real), openProject.output, cam);
  const src = framingSource(reframing.real, cam);
  const { k } = stageScale();
  const s = (shown.width / cam.width) * k;          // camera px -> stage css px
  // A mirrored picture shows the crop flipped about the shown rect's centre.
  const srcX = reframing.real.mirror ? cam.width - src.x - src.width : src.x;
  Object.assign($("pipframewindow").style, {
    left: `${shown.x * k + srcX * s}px`, top: `${shown.y * k + src.y * s}px`,
    width: `${src.width * s}px`, height: `${src.height * s}px`,
    borderRadius: reframing.real.shape === "circle" ? "50%"
      : `${reframing.real.cornerRadius * Math.min(src.width, src.height) * s}px`,
  });
  ($("pipzoom") as HTMLInputElement).value = String((reframing.real.framing?.zoom) ?? 1);
}

function enterReframe(): void {
  const real = currentPipStyle();
  if (!real || !openProject?.pip || !player) return;
  reframing = { real };
  (document.getElementById("pippanel") as HTMLElement & { hidePopover?: () => void }).hidePopover?.();
  openProject.pip.style = displayStyleFor(real);     // LIVE project only — never persisted
  $("pipframing").hidden = false;
  $("pipframebar").hidden = false;
  void player.seek(player.currentNs);
  layoutFramingWindow();
}

function exitReframe(): void {
  if (!reframing || !openProject?.pip || !player) return;
  const real = reframing.real;
  reframing = null;
  $("pipframing").hidden = true;
  $("pipframebar").hidden = true;
  setPipStyle(real, true);                           // restores the real style and persists
}

let frameDrag: { x: number; y: number } | null = null;
$("pipframewindow").addEventListener("pointerdown", (e) => {
  frameDrag = { x: e.clientX, y: e.clientY };
  ($("pipframewindow") as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
});
$("pipframewindow").addEventListener("pointermove", (e) => {
  const cam = pipCamera();
  if (!frameDrag || !reframing || !cam || !openProject) return;
  const shown = pipRect(displayStyleFor(reframing.real), openProject.output, cam);
  const s = (shown.width / cam.width) * stageScale().k;
  const delta = { x: (e.clientX - frameDrag.x) / s, y: (e.clientY - frameDrag.y) / s };
  frameDrag = { x: e.clientX, y: e.clientY };
  reframing.real = { ...reframing.real, framing: panFraming(reframing.real, delta, cam) };
  layoutFramingWindow();
});
$("pipframewindow").addEventListener("pointerup", () => { frameDrag = null; });

function setFramingZoom(zoom: number): void {
  const cam = pipCamera();
  if (!reframing || !cam) return;
  reframing.real = { ...reframing.real, framing: zoomFraming(reframing.real, zoom, cam) };
  layoutFramingWindow();
}
$("pipzoom").addEventListener("input", () => setFramingZoom(Number(($("pipzoom") as HTMLInputElement).value)));
$("pipzoom").addEventListener("change", () => setFramingZoom(Number(($("pipzoom") as HTMLInputElement).value)));
$("pipframing").addEventListener("wheel", (e) => {
  if (!reframing) return;
  e.preventDefault();
  setFramingZoom(((reframing.real.framing?.zoom) ?? 1) * Math.exp(-e.deltaY / 500));
}, { passive: false });
$("pipframedone").addEventListener("click", exitReframe);
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && reframing) { e.preventDefault(); exitReframe(); } });
```

(`panFraming` takes the delta "as seen" and flips x itself when mirrored — the window's own position flip above is only for drawing it. The `delta` passed is in camera px because `s` converts stage px → camera px.)

Also make `persistProject()` refuse to write while reframing, so no other edit can save the temporary display style: at its top, `if (reframing) return;`. And if the take is closed/reloaded while reframing, `reframing = null` must be reset where `openProject` is reassigned.

- [ ] **Step 5: Run** — `npm run typecheck`; e2e (VM) `npx vitest run app/test/pip-editor.e2e.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add app/renderer/editor.html app/renderer/pip-inspector.css app/src/editor.ts app/test/pip-editor.e2e.test.ts
git commit -m "STC-461: reframe the camera inside the PiP — pan, zoom, the guides' surface

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: the Settings sheet's Camera subsection

**Files:**
- Modify: `app/renderer/index.html` (inside `#profilesheet`, under Preferences, a `.subhead` "Camera" block; `<link rel="stylesheet" href="pip-inspector.css">`)
- Modify: `app/src/renderer.ts`
- Test: `app/test/pip-settings.e2e.test.ts`

**Interfaces:**
- Consumes: `buildPipInspector`, `editPipStyle`, `snapCenter`, `pipRect`, `pipSize`, `PIP_SNAP_THRESHOLD_SCREEN_PX`; `recorder.getSettings()` / `recorder.setSettings(patch)` (already exposed to `renderer.ts`, see `shutterSound` at renderer.ts:1403-1413).
- Produces: element IDs `#pipsettings` (inspector root), `#pipmock` (16:9 frame), `#pipmockbox` (the draggable PiP).

**The mock frame:** a nominal 1920×1080 output and a 1280×720 camera, used only to turn the style into a CSS box (`pipRect`) and to snap; a CSS silhouette inside the box (a circle "head" + rounded "shoulders" in `var(--muted)`), drawn with `transform: scaleX(-1)` when mirrored. No camera is opened (spec non-goal).

- [ ] **Step 1: Write the failing e2e** — `app/test/pip-settings.e2e.test.ts`, modelled on `app/test/settings-sheet.e2e.test.ts` (copy its launch + "open the profile sheet" steps verbatim):

```ts
// ...launch exactly as settings-sheet.e2e.test.ts does, open the sheet...
test("the Circle preset in Settings becomes the stored default", async () => {
  // after opening the profile sheet:
  await win.click('#pipsettings [data-pip-preset="circle"]');
  await expect.poll(() => readStoredSettings(userDataDir).pipStyle?.shape, { timeout: 10_000 }).toBe("circle");
});
test("Settings has no Reframe and no Show camera", async () => {
  expect(await win.locator("#pipsettings #pipreframe").count()).toBe(0);
  expect(await win.locator("#pipsettings #pipenabled").count()).toBe(0);
});
```

`readStoredSettings(dir)` = `JSON.parse(readFileSync(join(dir, FILE), "utf8"))`, where `FILE` is `settings.ts`'s settings file name and `dir` is the user-data dir the launch helper gives (settings-sheet.e2e.test.ts shows where).

- [ ] **Step 2: Run to verify it fails** (VM) — FAIL: `#pipsettings` not found.

- [ ] **Step 3: Markup** — in `index.html`'s profile sheet, after the existing Preferences rows:

```html
<div class="subhead">Camera</div>
<p class="hint">How the camera looks in new recordings. Each recording can still be changed in the editor.</p>
<div id="pipmock" aria-hidden="true"><div id="pipmockbox"><div class="silhouette"></div></div></div>
<div id="pipsettings"></div>
```

CSS (in `pip-inspector.css`): `#pipmock{position:relative;aspect-ratio:16/9;width:100%;background:var(--surface-2);border-radius:6px;overflow:hidden}`, `#pipmockbox{position:absolute;overflow:hidden;cursor:move;background:var(--surface-3)}`, `.silhouette` drawn with two radial shapes in `var(--muted)`.

- [ ] **Step 4: Implement** — in `renderer.ts`:

```ts
import {
  editPipStyle, pipRect, pipSize, snapCenter, PIP_SNAP_THRESHOLD_SCREEN_PX, PIP_SHADOW, type PipStyle,
} from "@transform/pip-style.js";
import { buildPipInspector } from "./pip-inspector.js";

// ---- PiP default (STC-461) ----------------------------------------------------
// The same inspector as the editor's, over a mock 16:9 frame: no camera is
// opened to set a preference. Framing is per take, so there is no Reframe here.
const MOCK_OUT = { width: 1920, height: 1080 };
const MOCK_CAM = { width: 1280, height: 720 };
let pipDefault: PipStyle | null = null;

function drawPipMock(): void {
  if (!pipDefault) return;
  const frame = $("pipmock").getBoundingClientRect();
  const k = frame.width / MOCK_OUT.width;
  const r = pipRect(pipDefault, MOCK_OUT, MOCK_CAM);
  const short = Math.min(r.width, r.height);
  const box = $("pipmockbox");
  Object.assign(box.style, {
    left: `${r.x * k}px`, top: `${r.y * k}px`, width: `${r.width * k}px`, height: `${r.height * k}px`,
    borderRadius: pipDefault.shape === "circle" ? "50%" : `${pipDefault.cornerRadius * short * k}px`,
    border: pipDefault.border ? `${pipDefault.border.widthPt * k * 2}px solid ${pipDefault.border.color}` : "none",
    boxShadow: pipDefault.shadow
      ? `0 ${PIP_SHADOW.offsetYFraction * short * k}px ${PIP_SHADOW.blurFraction * short * k}px ${PIP_SHADOW.color}` : "none",
  });
  (box.firstElementChild as HTMLElement).style.transform = pipDefault.mirror ? "scaleX(-1)" : "";
}

async function savePipDefault(style: PipStyle, persist: boolean): Promise<void> {
  pipDefault = style;
  pipSettingsInspector.render(style, true);
  drawPipMock();
  if (persist) pipDefault = (await recorder.setSettings({ pipStyle: style })).pipStyle;
}

const pipSettingsInspector = buildPipInspector($("pipsettings"), {
  surface: "settings",
  onEdit(edit, phase) { if (pipDefault) void savePipDefault(editPipStyle(pipDefault, edit, MOCK_CAM), phase === "commit"); },
});

async function loadPipDefault(): Promise<void> {
  pipDefault = (await recorder.getSettings()).pipStyle;
  pipSettingsInspector.render(pipDefault!, true);
  drawPipMock();
}

let mockDrag: { dx: number; dy: number } | null = null;
$("pipmockbox").addEventListener("pointerdown", (e) => {
  if (!pipDefault) return;
  const frame = $("pipmock").getBoundingClientRect();
  const k = frame.width / MOCK_OUT.width;
  mockDrag = { dx: (e.clientX - frame.left) / k - pipDefault.center.x * MOCK_OUT.width,
               dy: (e.clientY - frame.top) / k - pipDefault.center.y * MOCK_OUT.height };
  ($("pipmockbox") as HTMLElement).setPointerCapture(e.pointerId);
});
$("pipmockbox").addEventListener("pointermove", (e) => {
  if (!mockDrag || !pipDefault) return;
  const frame = $("pipmock").getBoundingClientRect();
  const k = frame.width / MOCK_OUT.width;
  const raw = { x: ((e.clientX - frame.left) / k - mockDrag.dx) / MOCK_OUT.width,
                y: ((e.clientY - frame.top) / k - mockDrag.dy) / MOCK_OUT.height };
  const c = snapCenter(raw, pipSize(pipDefault, MOCK_OUT, MOCK_CAM), MOCK_OUT, PIP_SNAP_THRESHOLD_SCREEN_PX / k);
  void savePipDefault(editPipStyle(pipDefault, { kind: "move", center: c }, MOCK_CAM), false);
});
$("pipmockbox").addEventListener("pointerup", () => {
  if (!mockDrag || !pipDefault) return;
  mockDrag = null;
  void savePipDefault(pipDefault, true);
});
```

Call `loadPipDefault()` wherever the sheet loads its other preferences on open (the same place `shutterBox.checked` is filled), and again on `settings:changed` so "Use as default" from the editor shows up live. Add `pipStyle: PipStyle` to `renderer.ts`'s local `Settings`-shaped interface (line ~29) if it restates one. (`$` is the file's existing element helper; if it is named differently, use that.)

The border width in the mock is `widthPt × 2 × k` because the mock assumes a 2× (retina) display, i.e. 2 output px per point at 1920 px wide — an approximation for a preview, stated in a comment.

- [ ] **Step 5: Run** — `npm run typecheck`; e2e (VM) `npx vitest run app/test/pip-settings.e2e.test.ts app/test/settings-sheet.e2e.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add app/renderer/index.html app/renderer/pip-inspector.css app/src/renderer.ts app/test/pip-settings.e2e.test.ts
git commit -m "STC-461: the PiP default in Settings — the same inspector over a mock frame

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: runbook, CLAUDE.md, ticket log, full verification

**Files:**
- Create: `docs/STC-461-RUNBOOK.md`
- Modify: `CLAUDE.md` (table rows), `docs/TICKET-LOG.md` (one row)

- [ ] **Step 1: Runbook** — `docs/STC-461-RUNBOOK.md`, in the shape of `docs/STC-419-RUNBOOK.md`. Header: branch `accounts/stc-461-customize-pip-webcam-image` with fetch/checkout commands (CLAUDE.md "Hand off a runbook WITH its branch"). Sections, each saying what to do and what it must show:
  - §0 Setup: `npm run app:start`; record a ≥10 s take with the camera on and some on-screen motion.
  - §1 Presets: try all four in the editor; judge each on a busy and on a dark background. If one is wrong, the dial is `PIP_PRESETS` in `transform/src/pip-style.ts`.
  - §2 Shadow and border: does the shadow read without looking muddy (`PIP_SHADOW`)? Is a 2 pt border visible but not heavy at a 4K export?
  - §3 Drag and snap: does the snap feel like a pull or a jump (`PIP_SNAP_THRESHOLD_SCREEN_PX`)? Does the Camera popover stay usable while dragging (Task 7's popover note)?
  - §4 Reframe: does the dimmed window read as "what will show"? Is the pan direction right with Mirror on AND off? Wheel zoom speed.
  - §5 Mirror: with Mirror on, raising your right hand should look like a mirror.
  - §6 Export: export the styled take; the exported file must match the preview (shape, place, framing, border, shadow).
  - §7 Settings: set a default (e.g. Circle, moved top-left); record a new camera take; the editor must open with that style and a centred framing. Record a take with the camera OFF: its `project.json` must have no `pip`.
  - §8 Old takes: open a take recorded before this branch; its PiP must sit exactly where it always did, and the first drag must not make it jump.
  - "What is deliberately not here": framing guides (STC-497), mid-take changes, undo, a live camera in Settings.

- [ ] **Step 2: CLAUDE.md** — add rows to the "Where things are" table, following the neighbours' voice:
  - `transform/src/pip-style.ts` — the customised PiP's every decision (STC-461): `cleanPipStyle` (the one validator — the write gate refuses on null, `parseProject` and Settings fall back), `pipRect`/`framingSource` (render's answer), `editPipStyle`/`snapCenter`/`resizeFromCorner`/`panFraming` (what an inspector control or a drag means), `PIP_PRESETS` (a LOOK; position, framing and mirror survive). Framing is a centre + zoom, never a rect, so it cannot disagree with its shape. Imports only `spaces.ts` so the main process can validate. `DEFAULT_PIP` lives here, re-exported by `trim.ts`. `docs/STC-461-RUNBOOK.md`
  - `schema/project-15.schema.json` — project-14 plus optional `pip.style`; no style = the fixed corner, byte for byte; `fixtures/pip-styled/` is its gate:identity fixture (media from `fixtures/pip`)
  - `app/src/pip-inspector.ts`, `app/renderer/pip-inspector.css` — the shared PiP inspector (editor Camera popover + Settings sheet); reports `PipEdit`s, decides nothing. Reframe swaps the LIVE project's PiP for the whole camera frame (STC-330's precedent) and `#pipframewindow` is the surface STC-497's guides draw on

- [ ] **Step 3: TICKET-LOG** — append one row for STC-461 to `docs/TICKET-LOG.md`'s table: what shipped, the three planning amendments (framing as centre+zoom; write gate refuses, loader drops; presets are a look), TRANSFORM_VERSION 14, and what only a Mac can settle (the runbook), plus "framing guides split out as STC-497".

- [ ] **Step 4: Full verification**

```bash
npm run typecheck
npm test
npm run gate:identity -- "$STY"     # the styled fixture dir from Task 5 step 3
```

Then the e2e files from Tasks 6–9 in the VM (`docs/VM-TESTING.md`). Expected: all green. Report any failure with its output; do not mark the task done on a partial run.

- [ ] **Step 5: Commit**

```bash
git add docs/STC-461-RUNBOOK.md CLAUDE.md docs/TICKET-LOG.md
git commit -m "STC-461: runbook, CLAUDE.md rows, ticket-log row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
