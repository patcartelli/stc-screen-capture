# STC-396 Video Framing Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A video take exports (and previews) with a background, padding, rounded corners and a shadow around the recording, chosen from three presets (Clean, Dark, Solid) or None.

**Architecture:** `render()` gains a `framing` result (a content rect inset inside the fixed output, plus the chrome). The cursor, click highlight, PiP and zoom crop map into that rect through the existing `spaces.ts` owners; the one compositor draws background, shadow, then the rounded-clipped picture. Framing None takes today's code path unchanged, so no existing pixel moves.

**Tech Stack:** TypeScript (transform + Electron app), vitest, Ajv schemas, Playwright/Chromium gates, Canvas 2D.

**Spec:** `docs/superpowers/specs/2026-10-02-stc-396-video-framing-design.md`. Read it first.

## Global Constraints

- Work in this worktree on branch `accounts/stc-396-video-framing-presets`. Never touch the main checkout.
- `render(project, session, t)` stays a pure function. No wall clock, no live settings, no sink forking.
- Output size rules are unchanged: framing is an INSET inside the chosen output, so the 3840x2160 ceiling and `output-size.ts`'s even-dimension rule are untouched.
- Project document: new optional `framing`; absent means None. `projectForWrite` emits the MINIMUM version that can express the document, so an untouched project stays at its current version. New version is **15**. `PROJECT_VERSIONS` gains 15.
- `TRANSFORM_VERSION` goes **13 -> 14**, with a `TRANSFORM_HISTORY` entry. Framing None must render byte-identically to version 13.
- Every coordinate conversion goes through `transform/src/spaces.ts` (STC-314). No hand-rolled UV math elsewhere.
- Padding, radius and shadow are fractions of the output's SHORT EDGE (resolution independent), rounded to whole pixels where they place a decoded frame.
- Shadow reach (`blur * 1.5 + |offsetY|`) is clamped to the padding.
- Camera PiP is anchored to the CONTENT rect. The keycast pill stays on the output canvas. Zoom crops within the content rect.
- Loaders refuse or drop rather than invent: a malformed `framing` in a loaded document is dropped (take renders unframed); `main.ts`'s write gate REFUSES it.
- Preset values are provisional (tuned by eye on a Mac in Task 8); every parameter is stored/overridable in the document.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Do not run Electron e2e tests on the host casually (they are disruptive). Use `docs/VM-TESTING.md` / `tools/vm/` for them, or ask Patrick to run the named command.
- Out of scope: annotation markers, tracked redaction, per-dial editor controls, Figma-matched design.

## Review Focus

Failure modes the spec implies that no obvious test would exercise, most likely first. Each has a pinned test in the task named.

1. **Cursor outside the picture.** A pointer on another display is outside the capture; unframed it is clipped by the canvas edge, framed it would be painted over the background chrome. Expected: never drawn outside the content rect. (Task 4)
2. **Output aspect differs from the capture** (viewer's-eye size, region/window scope). Expected: picture letterboxed inside the padded area, never stretched. (Task 1)
3. **Cursor placement under frame + zoom** (the STC-421 failure class). Expected: framed position is the unframed UV mapped into the content rect, at any zoom. A first-draft test can pass against the bug, so Task 3 includes a mutation check. (Task 3)
4. **Tiny or extreme outputs and hand-edited padding.** Expected: content never collapses below 2 px; shadow never clipped by the canvas. (Task 1)
5. **Hand-edited or malformed `framing` in `project.json`.** Expected: loader drops it, the take still opens; the write gate refuses it; a frozen v14 document loads unchanged. (Task 2)
6. **PiP overlapping the rounded corner / leaving the picture.** Expected: PiP rect stays inside the content rect with its normal margin. (Task 3)

---

## File Structure

| File | Responsibility |
|---|---|
| `transform/src/framing.ts` (new) | Pure: types, presets, validation (`framingProblem`/`cleanFraming`), `framingLayout`, `gradientLine`, `contentFraction`. No DOM, no Node. Importable from `main.ts`. |
| `transform/src/types.ts` | `Project.framing?: Framing` |
| `schema/project-15.schema.json` (new) | The document shape |
| `transform/src/project-version.ts` | add 15 |
| `transform/src/trim.ts` | parse, `versionFor`, `projectForWrite` for framing |
| `transform/src/render.ts` | `FrameState.framing`, content-rect mapping for cursor/PiP/crop |
| `transform/src/compositor.ts` | draw chrome, clip picture, clip cursor |
| `transform/src/transform-version.ts` | version 14 + fingerprint inputs |
| `transform/src/legibility.ts` | `frameFraction` |
| `app/src/main.ts` | write-gate validation for `framing` |
| `app/renderer/editor.html`, `app/src/editor.ts` | Frame control in the export dialog |
| `harness/framing.html`, `harness/framing.ts`, `scripts/framing-gate.mjs` (new) | pixel-property gate |
| `harness/sink-identity.ts`, `scripts/identity-gate.mjs`, `.github/workflows/ci.yml` | framed identity run |
| `docs/STC-396-RUNBOOK.md`, `docs/TICKET-LOG.md`, `CLAUDE.md` | docs |

Tests: `transform/test/framing.test.ts`, `framing-project.test.ts`, `render-framing.test.ts`, additions to `compositor.test.ts`, `legibility.test.ts`, `transform-version.test.ts`, `app/test/preview-write-project.e2e.test.ts`, `app/test/framing-editor.e2e.test.ts`.

---

### Task 1: The pure layout (`framing.ts`)

**Files:**
- Create: `transform/src/framing.ts`
- Test: `transform/test/framing.test.ts`

**Interfaces:**
- Produces (exact):
  ```ts
  export type FramingPreset = "clean" | "dark" | "solid";
  export type FramingBackground =
    | { kind: "solid"; color: string }
    | { kind: "linear"; colors: [string, string]; angleDeg: number };
  export interface FramingShadow { offsetYPct: number; blurPct: number; opacity: number }
  export interface Framing {
    preset: FramingPreset; color?: string; paddingPct?: number; radiusPct?: number;
    shadow?: FramingShadow; background?: FramingBackground;
  }
  export interface FramingLayout {
    content: Rect;                       // output pixels, whole numbers
    radius: number;                      // output pixels
    shadow: { offsetY: number; blur: number; opacity: number };   // output pixels (blur = canvas shadowBlur)
    background: FramingBackground;
  }
  export const FRAMING_PADDING_MAX = 0.25;
  export const FRAMING_RADIUS_MAX = 0.1;
  export const DEFAULT_SOLID_COLOR = "#3b4252";
  export const FRAMING_PRESETS: Readonly<Record<FramingPreset, { paddingPct: number; radiusPct: number; shadow: FramingShadow; background: FramingBackground }>>;
  export function framingProblem(raw: unknown): string | undefined;
  export function cleanFraming(raw: unknown): Framing | undefined;
  export function framingLayout(framing: Framing | undefined, output: Size, captureAspect: number): FramingLayout | undefined;
  export function gradientLine(angleDeg: number, w: number, h: number): { x0: number; y0: number; x1: number; y1: number };
  export function contentFraction(framing: Framing | undefined, output: Size, captureAspect: number): number;
  ```
- Consumes: `Rect`, `Size` types from `./spaces.js`.

- [ ] **Step 1: Write the failing tests**

Create `transform/test/framing.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import {
  framingLayout, framingProblem, cleanFraming, gradientLine, contentFraction,
  FRAMING_PRESETS, FRAMING_PADDING_MAX, DEFAULT_SOLID_COLOR,
} from "../src/framing.js";

const OUT = { width: 1920, height: 1080 };
const ASPECT = 16 / 9;

describe("framingLayout", () => {
  test("no framing means no layout", () => {
    expect(framingLayout(undefined, OUT, ASPECT)).toBeUndefined();
  });

  test("clean on a matching-aspect output: padded, centred, whole pixels, inside the output", () => {
    const l = framingLayout({ preset: "clean" }, OUT, ASPECT)!;
    const pad = Math.round(1080 * FRAMING_PRESETS.clean.paddingPct);
    for (const n of [l.content.x, l.content.y, l.content.width, l.content.height]) {
      expect(Number.isInteger(n)).toBe(true);
    }
    expect(l.content.y).toBeGreaterThanOrEqual(pad);
    expect(l.content.x).toBeGreaterThanOrEqual(pad);
    expect(l.content.x + l.content.width).toBeLessThanOrEqual(OUT.width - pad);
    expect(l.content.y + l.content.height).toBeLessThanOrEqual(OUT.height - pad);
    expect(Math.abs(l.content.x * 2 + l.content.width - OUT.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(l.content.y * 2 + l.content.height - OUT.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(l.content.width / l.content.height - ASPECT)).toBeLessThan(0.01);
  });

  test("an output of a different aspect letterboxes the picture; it is never stretched", () => {
    const l = framingLayout({ preset: "clean" }, { width: 1000, height: 1000 }, ASPECT)!;
    expect(Math.abs(l.content.width / l.content.height - ASPECT)).toBeLessThan(0.01);
    expect(l.content.width).toBeLessThan(1000);
    expect(l.content.height).toBeLessThan(l.content.width);
  });

  test("the shadow's reach never exceeds the padding, at any output size", () => {
    for (const out of [{ width: 320, height: 180 }, { width: 640, height: 360 },
                       { width: 1232, height: 693 }, { width: 3840, height: 2160 },
                       { width: 200, height: 200 }]) {
      const l = framingLayout({ preset: "clean" }, out, ASPECT)!;
      const short = Math.min(out.width, out.height);
      const pad = Math.min(Math.round(short * FRAMING_PRESETS.clean.paddingPct), Math.floor((short - 2) / 2));
      expect(l.shadow.blur * 1.5 + Math.abs(l.shadow.offsetY)).toBeLessThanOrEqual(pad + 1e-9);
    }
  });

  test("zero padding leaves no room for a shadow and fills the output", () => {
    const l = framingLayout({ preset: "clean", paddingPct: 0 }, OUT, ASPECT)!;
    expect(l.content).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(l.shadow.blur).toBe(0);
    expect(l.shadow.offsetY).toBe(0);
  });

  test("a tiny output keeps at least 2 px of picture on both axes", () => {
    for (const out of [{ width: 4, height: 4 }, { width: 8, height: 8 }, { width: 6, height: 4 }]) {
      const l = framingLayout({ preset: "clean", paddingPct: FRAMING_PADDING_MAX }, out, 1)!;
      expect(l.content.width).toBeGreaterThanOrEqual(2);
      expect(l.content.height).toBeGreaterThanOrEqual(2);
    }
  });

  test("the radius never exceeds half the picture's short side", () => {
    const l = framingLayout({ preset: "clean", radiusPct: 0.1 }, { width: 100, height: 100 }, 1)!;
    expect(l.radius).toBeLessThanOrEqual(Math.floor(Math.min(l.content.width, l.content.height) / 2));
  });

  test("the layout is proportional across output sizes (Embed vs capture size)", () => {
    const a = framingLayout({ preset: "clean" }, { width: 3840, height: 2160 }, ASPECT)!;
    const b = framingLayout({ preset: "clean" }, { width: 1232, height: 693 }, ASPECT)!;
    expect(Math.abs(a.content.width / 3840 - b.content.width / 1232)).toBeLessThan(0.01);
    expect(Math.abs(a.content.x / 3840 - b.content.x / 1232)).toBeLessThan(0.01);
  });

  test("explicit values beat the preset; solid takes its colour; dark differs from clean", () => {
    const wide = framingLayout({ preset: "clean", paddingPct: 0.1 }, OUT, ASPECT)!;
    const std = framingLayout({ preset: "clean" }, OUT, ASPECT)!;
    expect(wide.content.width).toBeLessThan(std.content.width);

    const bg = { kind: "solid", color: "#112233" } as const;
    expect(framingLayout({ preset: "clean", background: bg }, OUT, ASPECT)!.background).toEqual(bg);

    expect(framingLayout({ preset: "solid", color: "#aabbcc" }, OUT, ASPECT)!.background)
      .toEqual({ kind: "solid", color: "#aabbcc" });
    expect(framingLayout({ preset: "solid" }, OUT, ASPECT)!.background)
      .toEqual({ kind: "solid", color: DEFAULT_SOLID_COLOR });
    expect(framingLayout({ preset: "dark" }, OUT, ASPECT)!.background)
      .not.toEqual(framingLayout({ preset: "clean" }, OUT, ASPECT)!.background);
  });
});

describe("framingProblem / cleanFraming", () => {
  test("accepts each preset and a full set of overrides", () => {
    for (const preset of ["clean", "dark", "solid"]) expect(framingProblem({ preset })).toBeUndefined();
    expect(framingProblem({
      preset: "solid", color: "#0a0b0c", paddingPct: 0.1, radiusPct: 0.02,
      shadow: { offsetYPct: 0.01, blurPct: 0.03, opacity: 0.4 },
      background: { kind: "linear", colors: ["#000000", "#ffffff"], angleDeg: 90 },
    })).toBeUndefined();
  });

  test("refuses every malformed shape", () => {
    const bad: unknown[] = [
      null, 5, [], {}, { preset: "none" }, { preset: "clean", extra: 1 },
      { preset: "clean", color: "red" }, { preset: "clean", paddingPct: -0.1 },
      { preset: "clean", paddingPct: FRAMING_PADDING_MAX + 0.01 },
      { preset: "clean", paddingPct: "0.1" }, { preset: "clean", radiusPct: 0.5 },
      { preset: "clean", shadow: { offsetYPct: 0, blurPct: 0, opacity: 2 } },
      { preset: "clean", shadow: { offsetYPct: 0, blurPct: 0, opacity: 1, spread: 1 } },
      { preset: "clean", background: { kind: "radial" } },
      { preset: "clean", background: { kind: "solid", color: "#12" } },
      { preset: "clean", background: { kind: "linear", colors: ["#000000"], angleDeg: 0 } },
    ];
    for (const b of bad) expect(framingProblem(b), JSON.stringify(b)).toEqual(expect.any(String));
  });

  test("cleanFraming drops a bad block and keeps a good one", () => {
    expect(cleanFraming({ preset: "nope" })).toBeUndefined();
    expect(cleanFraming({ preset: "dark" })).toEqual({ preset: "dark" });
  });
});

describe("gradientLine", () => {
  test("90 degrees runs left to right through the centre", () => {
    const l = gradientLine(90, 200, 100);
    expect(l.x0).toBeCloseTo(0); expect(l.x1).toBeCloseTo(200);
    expect(l.y0).toBeCloseTo(50); expect(l.y1).toBeCloseTo(50);
  });
  test("135 degrees runs top-left to bottom-right, symmetric about the centre", () => {
    const l = gradientLine(135, 100, 100);
    expect(l.x0 + l.x1).toBeCloseTo(100); expect(l.y0 + l.y1).toBeCloseTo(100);
    expect(l.x1).toBeGreaterThan(l.x0); expect(l.y1).toBeGreaterThan(l.y0);
  });
});

describe("contentFraction", () => {
  test("1 with no framing, the picture's share of the width with it", () => {
    expect(contentFraction(undefined, OUT, ASPECT)).toBe(1);
    const f = contentFraction({ preset: "clean" }, OUT, ASPECT);
    expect(f).toBeGreaterThan(0.8);
    expect(f).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run transform/test/framing.test.ts`
Expected: FAIL (cannot resolve `../src/framing.js`).

- [ ] **Step 3: Implement `transform/src/framing.ts`**

```ts
import type { Rect, Size } from "./spaces.js";

/**
 * Video framing (STC-396): static chrome around a moving picture — a
 * background, padding, rounded corners and a shadow — decided without a canvas.
 *
 * Same split the rest of this project uses (see `still-decorate.ts`, whose
 * stills this carries over from): this module works out WHERE the picture sits
 * and how big the chrome is, `render()` carries the answer in `FrameState`,
 * and `compositor.ts` draws it and decides nothing.
 *
 * ## An INSET, not a bigger canvas — and why that is the opposite of a still
 *
 * A still grows its canvas around a capture drawn at natural size. Video
 * cannot: H.264 and Chrome's decoder cap at 3840x2160, a 4K take is already at
 * the cap, and `output-size.ts` owns the even-dimension rule. So the output
 * size is whatever was chosen and the recording is fitted INSIDE it. The cost
 * is that text gets smaller, which `legibility.ts` accounts for through
 * `contentFraction`.
 *
 * ## Fractions of the SHORT EDGE
 *
 * Padding, radius and shadow are fractions of the output's short edge, never a
 * pixel count: the same document at 4K and at Embed size has to look the same.
 *
 * ## The values are provisional
 *
 * Like the stills' presets, these are reasoned rather than made — chosen by
 * looking at real exports on a Mac (docs/STC-396-RUNBOOK.md). Every parameter
 * is stored in the document and overridable; none has its own control yet.
 */

export type FramingPreset = "clean" | "dark" | "solid";

export type FramingBackground =
  | { kind: "solid"; color: string }
  | { kind: "linear"; colors: [string, string]; angleDeg: number };

export interface FramingShadow { offsetYPct: number; blurPct: number; opacity: number }

export interface Framing {
  preset: FramingPreset;
  /** Solid preset only: the fill. Ignored when `background` is given. */
  color?: string;
  paddingPct?: number;
  radiusPct?: number;
  shadow?: FramingShadow;
  background?: FramingBackground;
}

export interface FramingLayout {
  /** Where the recording is drawn, in output pixels, whole numbers. */
  content: Rect;
  radius: number;
  /** In output pixels. `blur` is the value for canvas `shadowBlur`. */
  shadow: { offsetY: number; blur: number; opacity: number };
  background: FramingBackground;
}

export const FRAMING_PADDING_MAX = 0.25;
export const FRAMING_RADIUS_MAX = 0.1;
export const DEFAULT_SOLID_COLOR = "#3b4252";

const SHADOW: FramingShadow = { offsetYPct: 0.012, blurPct: 0.03, opacity: 0.32 };

export const FRAMING_PRESETS: Readonly<Record<FramingPreset, {
  paddingPct: number; radiusPct: number; shadow: FramingShadow; background: FramingBackground;
}>> = {
  clean: {
    paddingPct: 0.06, radiusPct: 0.012, shadow: { ...SHADOW },
    background: { kind: "linear", colors: ["#e9edf2", "#cfd6e0"], angleDeg: 135 },
  },
  dark: {
    paddingPct: 0.06, radiusPct: 0.012, shadow: { ...SHADOW, opacity: 0.55 },
    background: { kind: "linear", colors: ["#2a3040", "#0d1017"], angleDeg: 135 },
  },
  solid: {
    paddingPct: 0.06, radiusPct: 0.012, shadow: { ...SHADOW },
    background: { kind: "solid", color: DEFAULT_SOLID_COLOR },
  },
};

// ---------------------------------------------------------------------------
// validation — one owner, used by trim.ts (drops) and main.ts (refuses)
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-fA-F]{6}$/;
const TOP_KEYS = new Set(["preset", "color", "paddingPct", "radiusPct", "shadow", "background"]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const inRange = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const onlyKeys = (o: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(o).every((k) => keys.includes(k));

/** The reason a `framing` value is not acceptable, or undefined when it is. */
export function framingProblem(raw: unknown): string | undefined {
  if (!isObj(raw)) return "framing must be an object";
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) return `framing has an unknown field "${k}"`;
  }
  if (raw.preset !== "clean" && raw.preset !== "dark" && raw.preset !== "solid") {
    return 'framing.preset must be "clean", "dark" or "solid"';
  }
  if (raw.color !== undefined && !(typeof raw.color === "string" && HEX.test(raw.color))) {
    return "framing.color must be #rrggbb";
  }
  if (raw.paddingPct !== undefined && !inRange(raw.paddingPct, 0, FRAMING_PADDING_MAX)) {
    return `framing.paddingPct must be a number in 0..${FRAMING_PADDING_MAX}`;
  }
  if (raw.radiusPct !== undefined && !inRange(raw.radiusPct, 0, FRAMING_RADIUS_MAX)) {
    return `framing.radiusPct must be a number in 0..${FRAMING_RADIUS_MAX}`;
  }
  if (raw.shadow !== undefined) {
    const s = raw.shadow;
    if (!isObj(s) || !onlyKeys(s, ["offsetYPct", "blurPct", "opacity"])
        || !inRange(s.offsetYPct, 0, 0.1) || !inRange(s.blurPct, 0, 0.2) || !inRange(s.opacity, 0, 1)) {
      return "framing.shadow must be { offsetYPct 0..0.1, blurPct 0..0.2, opacity 0..1 }";
    }
  }
  if (raw.background !== undefined) {
    const b = raw.background;
    const solid = isObj(b) && b.kind === "solid" && onlyKeys(b, ["kind", "color"])
      && typeof b.color === "string" && HEX.test(b.color);
    const linear = isObj(b) && b.kind === "linear" && onlyKeys(b, ["kind", "colors", "angleDeg"])
      && Array.isArray(b.colors) && b.colors.length === 2
      && b.colors.every((c) => typeof c === "string" && HEX.test(c))
      && inRange(b.angleDeg, -360, 360);
    if (!solid && !linear) return "framing.background must be a solid or two-stop linear fill";
  }
  return undefined;
}

/** A `framing` the loader can trust, or undefined — a bad block must not cost the take. */
export function cleanFraming(raw: unknown): Framing | undefined {
  return framingProblem(raw) === undefined ? (raw as Framing) : undefined;
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

/**
 * Where the picture goes inside `output`, and how big the chrome is.
 *
 * `captureAspect` is the capture's width/height. The picture is fitted
 * (aspect kept, centred) inside the output minus the padding, so an output of
 * another aspect letterboxes into the background rather than stretching.
 *
 * Padding is clamped so at least 2 px of picture remain on the short axis, and
 * the shadow's reach (1.5x blur plus the offset — canvas `shadowBlur` is a
 * Gaussian with sigma = blur/2, dead by three sigma) is scaled down to fit the
 * padding. The latter is a CORRECTNESS bound: a shadow wider than its padding
 * is cut off by the canvas edge and reads as a hard band, which is exactly what
 * the stills gate caught in STC-291.
 */
export function framingLayout(
  framing: Framing | undefined, output: Size, captureAspect: number,
): FramingLayout | undefined {
  if (!framing || !(captureAspect > 0)) return undefined;
  const p = FRAMING_PRESETS[framing.preset];
  const paddingPct = framing.paddingPct ?? p.paddingPct;
  const radiusPct = framing.radiusPct ?? p.radiusPct;
  const shadowIn = framing.shadow ?? p.shadow;
  const background: FramingBackground = framing.background
    ?? (framing.preset === "solid"
      ? { kind: "solid", color: framing.color ?? DEFAULT_SOLID_COLOR }
      : p.background);

  const short = Math.min(output.width, output.height);
  const pad = Math.max(0, Math.min(Math.round(short * paddingPct), Math.floor((short - 2) / 2)));

  let blur = short * shadowIn.blurPct;
  let offsetY = short * shadowIn.offsetYPct;
  const reach = blur * 1.5 + Math.abs(offsetY);
  if (reach > pad) {
    const k = reach > 0 ? pad / reach : 0;
    blur *= k;
    offsetY *= k;
  }

  const availW = output.width - 2 * pad;
  const availH = output.height - 2 * pad;
  let width: number;
  let height: number;
  if (availW / availH > captureAspect) {
    height = availH;
    width = Math.round(height * captureAspect);
  } else {
    width = availW;
    height = Math.round(width / captureAspect);
  }
  width = Math.max(2, Math.min(width, availW));
  height = Math.max(2, Math.min(height, availH));

  const content: Rect = {
    x: Math.round((output.width - width) / 2),
    y: Math.round((output.height - height) / 2),
    width,
    height,
  };
  const radius = Math.min(Math.round(short * radiusPct), Math.floor(Math.min(width, height) / 2));
  return { content, radius, shadow: { offsetY, blur, opacity: shadowIn.opacity }, background };
}

/**
 * Canvas `createLinearGradient` endpoints for a CSS-style angle: 0 is
 * bottom-to-top, 90 left-to-right, 135 top-left to bottom-right, the line
 * passing through the centre and long enough that the corners take the end
 * stops exactly.
 */
export function gradientLine(angleDeg: number, w: number, h: number):
  { x0: number; y0: number; x1: number; y1: number } {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const cx = w / 2;
  const cy = h / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

/**
 * The picture's share of the output's width: 1 with no framing. What
 * `legibility.ts` multiplies by, because inset text is smaller by exactly this.
 */
export function contentFraction(
  framing: Framing | undefined, output: Size, captureAspect: number,
): number {
  const l = framingLayout(framing, output, captureAspect);
  return l ? l.content.width / output.width : 1;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run transform/test/framing.test.ts`
Expected: PASS (all). If the tiny-output test fails, check the `pad` clamp and the `Math.max(2, ...)` lines.

- [ ] **Step 5: Commit**

```bash
git add transform/src/framing.ts transform/test/framing.test.ts
git commit -m "STC-396: framing layout, presets and validation (pure)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The project document (schema, loader, writer, write gate)

**Files:**
- Create: `schema/project-15.schema.json`, `transform/test/framing-project.test.ts`
- Modify: `transform/src/types.ts` (Project), `transform/src/project-version.ts:29`, `transform/src/trim.ts` (`parseProject`, `versionFor`, `projectForWrite`), `app/src/main.ts:2352-2360, ~2498` (known fields + validation), `app/test/preview-write-project.e2e.test.ts` (after the keycast pair, ~line 214)

**Interfaces:**
- Consumes: `Framing`, `cleanFraming`, `framingProblem` (Task 1).
- Produces: `Project.framing?: Framing`; documents with `framing` write as version 15.

- [ ] **Step 1: Write the failing tests**

Create `transform/test/framing-project.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { PROJECT_VERSIONS } from "../src/project-version.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const validate15 = new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/project-15.schema.json"), "utf8")));
const DUR = 5_000_000_000;

describe("project-15 framing (STC-396)", () => {
  test("15 is a readable version", () => {
    expect(PROJECT_VERSIONS).toContain(15);
  });

  test("an untouched project does not promote to 15", () => {
    expect(projectForWrite(defaultProject(640, 360), DUR).version).toBeLessThan(15);
  });

  test("a framed project writes a schema-valid v15 carrying framing", () => {
    const p = { ...defaultProject(640, 360), framing: { preset: "clean" as const } };
    const out = projectForWrite(p, DUR);
    expect(out.version).toBe(15);
    expect(out.framing).toEqual({ preset: "clean" });
    expect(validate15(out), JSON.stringify(validate15.errors, null, 2)).toBe(true);
  });

  test("framing coexists with the lower-version fields it promotes past", () => {
    const p = {
      ...defaultProject(640, 360), framing: { preset: "solid" as const, color: "#112233" },
      keycast: { show: false }, showClicks: false, micMuted: true, bookmarks: [1_000_000_000],
    };
    const out = projectForWrite(p, DUR);
    expect(out.version).toBe(15);
    expect(out.keycast).toEqual({ show: false });
    expect(out.showClicks).toBe(false);
    expect(out.micMuted).toBe(true);
    expect(out.bookmarks).toEqual([1_000_000_000]);
    expect(validate15(out), JSON.stringify(validate15.errors, null, 2)).toBe(true);
  });

  test("a framed document round-trips through parseProject", () => {
    const framing = {
      preset: "dark" as const, paddingPct: 0.1,
      shadow: { offsetYPct: 0.01, blurPct: 0.02, opacity: 0.4 },
    };
    const written = projectForWrite({ ...defaultProject(640, 360), framing }, DUR);
    expect(parseProject(written, 640, 360, DUR).framing).toEqual(framing);
  });

  test("a malformed framing is dropped, not fatal: the take opens unframed", () => {
    const written = projectForWrite({ ...defaultProject(640, 360), framing: { preset: "clean" as const } }, DUR);
    for (const bad of [{ preset: "bogus" }, "clean", 7, { preset: "clean", paddingPct: 9 }]) {
      const p = parseProject({ ...written, framing: bad }, 640, 360, DUR);
      expect(p.framing).toBeUndefined();
      expect(p.output).toEqual({ fps: 60, width: 640, height: 360 });
    }
  });

  test("a document with no framing parses with none", () => {
    const old = projectForWrite(defaultProject(640, 360), DUR);
    expect(parseProject(old, 640, 360, DUR).framing).toBeUndefined();
  });

  test("a frozen v14 document still loads unchanged", () => {
    const v14 = {
      version: 14, output: { fps: 60, width: 640, height: 360 },
      cursor: { style: "default", scale: 1 }, transform: { version: 13 },
      keycast: { show: false }, showClicks: false,
    };
    const p = parseProject(v14, 640, 360, DUR);
    expect(p.keycast).toEqual({ show: false });
    expect(p.showClicks).toBe(false);
    expect(p.framing).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run transform/test/framing-project.test.ts`
Expected: FAIL (project-15 schema file missing).

- [ ] **Step 3: Implement**

3a. `schema/project-15.schema.json` — derive from project-14 with a one-off script, then check the diff:

```bash
node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync("schema/project-14.schema.json", "utf8"));
d.$id = "stc:project-15";
d.title = "stc project (edit document), v15";
d.description = "v15 adds `framing` (STC-396): a background, padding, rounded corners and a shadow around the recording, fitted INSIDE the chosen output size. A preset (clean, dark, solid) plus optional explicit overrides, which win over the preset. Padding, radius and shadow are fractions of the output's short edge. Absent means no framing, and a document without it stays at whatever version its other edits earned. " + d.description;
d.properties.version = { const: 15 };
const hex = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
d.properties.framing = {
  type: "object", additionalProperties: false, required: ["preset"],
  properties: {
    preset: { enum: ["clean", "dark", "solid"] },
    color: hex,
    paddingPct: { type: "number", minimum: 0, maximum: 0.25 },
    radiusPct: { type: "number", minimum: 0, maximum: 0.1 },
    shadow: {
      type: "object", additionalProperties: false, required: ["offsetYPct", "blurPct", "opacity"],
      properties: {
        offsetYPct: { type: "number", minimum: 0, maximum: 0.1 },
        blurPct: { type: "number", minimum: 0, maximum: 0.2 },
        opacity: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    background: {
      oneOf: [
        { type: "object", additionalProperties: false, required: ["kind", "color"],
          properties: { kind: { const: "solid" }, color: hex } },
        { type: "object", additionalProperties: false, required: ["kind", "colors", "angleDeg"],
          properties: { kind: { const: "linear" },
                        colors: { type: "array", minItems: 2, maxItems: 2, items: hex },
                        angleDeg: { type: "number", minimum: -360, maximum: 360 } } },
      ],
    },
  },
};
fs.writeFileSync("schema/project-15.schema.json", JSON.stringify(d, null, 2) + "\n");
'
git diff --no-index --stat schema/project-14.schema.json schema/project-15.schema.json
```

3b. `transform/src/project-version.ts:29` — append 15:

```ts
export const PROJECT_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
```

3c. `transform/src/types.ts` — add near the top with the other type imports:

```ts
import type { Framing } from "./framing.js";
```

and at the end of the `Project` interface (after `showClicks?: boolean;`):

```ts
  /**
   * Video framing (project-15, STC-396): a background, padding, rounded corners
   * and a shadow around the recording, fitted INSIDE `output`. Absent means
   * none. A preset plus optional explicit overrides, which win. See framing.ts.
   */
  framing?: Framing;
```

3d. `transform/src/trim.ts` — add `import { cleanFraming } from "./framing.js";` with the other imports; in `parseProject` after the `showClicks` handling (end of the field list, before `return project`):

```ts
  // project-15 (STC-396). A malformed block is DROPPED, not repaired: the take
  // opens unframed rather than with a guessed frame, the rule every field in
  // this parser follows.
  const framing = cleanFraming(doc.framing);
  if (framing) project.framing = framing;
```

`versionFor` — change the return type to include `15` and add the first line:

```ts
function versionFor(project: Project): 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 {
  if (project.framing) return 15;
  if (project.keycast?.show === false) return 14;
```

`projectForWrite` — after the `version >= 14` line:

```ts
  if (version >= 15 && project.framing) out.framing = project.framing;
```

3e. `app/src/main.ts` — add `import { framingProblem } from "@transform/framing.js";` beside the `@transform/zoom.js` import; add `"framing"` to `KNOWN_PROJECT_FIELDS` (and change the comment's `project-1..14` to `1..15`); after the `keycast` validation block add:

```ts
  if (doc.framing !== undefined) {
    const problem = framingProblem(doc.framing);
    if (problem) throw new Error(`project.json: ${problem}`);
  }
```

3f. `app/test/preview-write-project.e2e.test.ts` — after the keycast pair add:

```ts
  test("refuses a malformed framing block (STC-396)", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 15, framing: { preset: "bogus" } })).toMatch(/framing/);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 15, framing: { preset: "clean", paddingPct: 9 } })).toMatch(/framing/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("a project-15 with a framing writes (STC-396)", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 15, framing: { preset: "clean" } })).toBe("wrote");
    expect(JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8")).framing).toEqual({ preset: "clean" });
  }, 120_000);
```

- [ ] **Step 4: Run to verify**

Run: `npx vitest run transform/test/framing-project.test.ts transform/test/project-version-seam.test.ts transform/test/keycast-project.test.ts && npm run typecheck`
Expected: PASS, and all three tsc passes clean (this is the check that `framing.ts` is importable from `main.ts` under the no-DOM config). The e2e additions run in the VM per `docs/VM-TESTING.md` (or hand Patrick `npx vitest run app/test/preview-write-project.e2e.test.ts`); record which in the PR.

- [ ] **Step 5: Commit**

```bash
git add schema/project-15.schema.json transform/src/types.ts transform/src/project-version.ts transform/src/trim.ts app/src/main.ts transform/test/framing-project.test.ts app/test/preview-write-project.e2e.test.ts
git commit -m "STC-396: project-15 framing field (schema, loader, writer, write gate)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `render()` maps into the content rect

**Files:**
- Modify: `transform/src/render.ts` (`FrameState`, `pipStateAt`, `render`)
- Test: `transform/test/render-framing.test.ts` (new)

**Interfaces:**
- Consumes: `framingLayout`, `FramingLayout` (Task 1); `Project.framing` (Task 2); `displayToOutput`, `throughCrop`, `outputRect`, `Rect`, `Size` from `spaces.ts`.
- Produces: `FrameState.framing: FramingLayout | null` (required field). Cursor `x/y/vx/vy/pxPerPoint`, `pip` rect and `zoom.crop` mapping all relative to the content rect when framed.

- [ ] **Step 1: Write the failing tests**

Create `transform/test/render-framing.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { DEFAULT_ZOOM, defaultProject } from "../src/trim.js";
import { render } from "../src/render.js";
import { framingLayout } from "../src/framing.js";
import type { Project, Session, SessionEvent } from "../src/types.js";

const MS = 1_000_000;
const duration = 12_000_000_000;
// One click at 2000 ms near the top-left, so a zoom crop clamps against the
// frame edge and the pointer sits OFF-centre in it. (STC-421's lesson: a click
// at dead centre maps centre to centre and passes against the bug.)
const events: SessionEvent[] = [
  { t: 2000 * MS, kind: "down", x: 300, y: 200, button: 0 },
  { t: 2050 * MS, kind: "up", x: 300, y: 200, button: 0 },
];

function session(camera = false): Session {
  return {
    anchors: {
      version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
      display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920,
                 pixelHeight: 1080, backingScale: 1, originX: 0, originY: 0 },
      capture: { width: 1920, height: 1080, codec: "h264", firstFrameNs: 0 },
      files: { display: "display.mp4" }, stop: { t: duration, reason: "user" },
      ...(camera ? { camera: { present: true, width: 1280, height: 720, firstFramePtsNs: 0,
                               lastFramePtsNs: 10_000 * MS, frameIntervalNs: 33 * MS } } : {}),
    },
    events, frames: [0, 16 * MS, 32 * MS],
    ...(camera ? { cameraFrames: Array.from({ length: 300 }, (_, i) => i * 33 * MS) } : {}),
  } as unknown as Session;
}

const noZoom = { ...DEFAULT_ZOOM, enabled: false };
const base = (over: Partial<Project> = {}): Project => ({ ...defaultProject(1920, 1080), ...over });
const framed = (over: Partial<Project> = {}): Project => base({ framing: { preset: "clean" }, ...over });

describe("render() with framing", () => {
  test("no framing: FrameState.framing is null", () => {
    expect(render(base(), session(), 3000 * MS).framing).toBeNull();
  });

  test("framing: carries the layout the pure module computes", () => {
    const fs = render(framed(), session(), 3000 * MS);
    expect(fs.framing).toEqual(framingLayout({ preset: "clean" }, { width: 1920, height: 1080 }, 1920 / 1080));
  });

  test("the cursor lands where the unframed UV maps into the content rect (zoom off)", () => {
    const un = render(base({ zoom: noZoom }), session(), 3000 * MS);
    const fr = render(framed({ zoom: noZoom }), session(), 3000 * MS);
    const c = fr.framing!.content;
    expect(fr.cursor.x).toBeCloseTo(c.x + (un.cursor.x / 1920) * c.width, 3);
    expect(fr.cursor.y).toBeCloseTo(c.y + (un.cursor.y / 1080) * c.height, 3);
  });

  test("...and under a zoom crop too: the crop is UV over the capture, so the same relation holds", () => {
    const un = render(base(), session(), 3000 * MS);
    const fr = render(framed(), session(), 3000 * MS);
    expect(un.zoom.crop).not.toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(fr.zoom.crop).toEqual(un.zoom.crop);
    const c = fr.framing!.content;
    expect(fr.cursor.x).toBeCloseTo(c.x + (un.cursor.x / 1920) * c.width, 3);
    expect(fr.cursor.y).toBeCloseTo(c.y + (un.cursor.y / 1080) * c.height, 3);
  });

  test("pointer size and velocity scale with the picture, not the canvas", () => {
    const un = render(base({ zoom: noZoom }), session(), 2020 * MS);
    const fr = render(framed({ zoom: noZoom }), session(), 2020 * MS);
    const k = fr.framing!.content.width / 1920;
    expect(fr.cursor.pxPerPoint).toBeCloseTo(un.cursor.pxPerPoint * k, 6);
    expect(fr.cursor.vx).toBeCloseTo(un.cursor.vx * k, 6);
  });

  test("the layout follows the output size (Embed), proportionally", () => {
    const big = render(framed(), session(), 3000 * MS).framing!.content;
    const small = render(framed({ output: { fps: 60, width: 1232, height: 693 } }), session(), 3000 * MS).framing!.content;
    expect(Math.abs(big.width / 1920 - small.width / 1232)).toBeLessThan(0.01);
  });

  test("the PiP stays inside the content rect with its normal margin", () => {
    const p = framed({ zoom: noZoom, pip: { enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32 } });
    const fs = render(p, session(true), 3000 * MS);
    const c = fs.framing!.content;
    expect(fs.pip).not.toBeNull();
    expect(fs.pip!.x).toBeGreaterThanOrEqual(c.x);
    expect(fs.pip!.y).toBeGreaterThanOrEqual(c.y);
    expect(fs.pip!.x + fs.pip!.width).toBe(c.x + c.width - 32);
    expect(fs.pip!.y + fs.pip!.height).toBe(c.y + c.height - 32);
  });

  test("framing: absent changes nothing about the cursor or PiP (byte-identical to before)", () => {
    const a = render(base(), session(), 3000 * MS);
    const b = render({ ...base(), framing: undefined }, session(), 3000 * MS);
    expect(b).toEqual(a);
  });
});
```

(`Project.pip`'s exact shape: use `DEFAULT_PIP`'s fields from `trim.ts:67` if the literal above does not typecheck.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run transform/test/render-framing.test.ts`
Expected: FAIL (`framing` undefined on the FrameState / positions not offset).

- [ ] **Step 3: Implement in `transform/src/render.ts`**

Add the import: `import { framingLayout, type FramingLayout } from "./framing.js";` (and `Size` from `./spaces.js` if not already imported).

`FrameState` — add after `keycast`:

```ts
  /**
   * Video framing (STC-396), or null when the project has none. The picture is
   * drawn into `framing.content` (an inset of the output); the cursor, PiP and
   * zoom crop in this state are already in OUTPUT pixels relative to that rect,
   * so the compositor draws them where they are told and decides nothing.
   */
  framing: FramingLayout | null;
```

`pipStateAt` — add a final parameter `frame: Rect` (the rect the picture occupies — the whole output when unframed) and use it for both uses of `project.output`:

```ts
function pipStateAt(project: Project, session: Session, tNs: number, frame: Rect): PipState | null {
```
```ts
  const rect = roundRect(uvRectToPixels(
    fixedCornerPipUv(pip, { width: frame.width, height: frame.height }, cam),
    frame,
  ));
```
(`frame` replaces `outputRect(project.output)`; with no framing `frame` is exactly that rect, so the numbers are unchanged.)

`render()` — after `const zoom = project.zoom ?? DEFAULT_ZOOM;` add:

```ts
  // Video framing (STC-396). The picture is an INSET of the output; everything
  // placed in output pixels below is placed relative to that rect. With no
  // framing `frame` IS the whole output and `sized` IS project.output, so every
  // number below is exactly what version 13 computed.
  const cap = session.anchors.capture;
  const layout = framingLayout(project.framing, project.output, cap.width / cap.height);
  const frame: Rect = layout?.content ?? outputRect(project.output);
  const sized: Size = layout ? { width: frame.width, height: frame.height } : project.output;
```

Replace the `displayToOutput` line:

```ts
  const m0 = displayToOutput(g.shown, sized, g.contentRect, cap);
  const m = layout ? { ...m0, ox: m0.ox + frame.x, oy: m0.oy + frame.y } : m0;
```

Replace `outputRect(project.output)` in the `throughCrop` call with `frame`:

```ts
  const at = throughCrop(full, crop, frame);
```

Replace the `pip:` field and add `framing`:

```ts
    pip: pipStateAt(project, session, tNs, frame),
    zoom: { amount: zoomAmount, crop },
    keycast: keycastFor(project, session, tick),
    framing: layout ?? null,
```

Then fix every compile error from the new required field: `grep -rn "keycast: null" transform/test app/test harness` and add `framing: null,` to each hand-built `FrameState` (known: `transform/test/compositor.test.ts:18`). Any other `FrameState` literal the typecheck finds gets the same.

- [ ] **Step 4: Run to verify it passes, then MUTATION-CHECK**

Run: `npx vitest run transform/test/render-framing.test.ts transform/test/render.test.ts transform/test/render-refit.test.ts transform/test/zoom-change-render.test.ts && npm run typecheck`
Expected: PASS. The refit goldens passing is the "framing None changes no pixel" evidence for the cursor path.

Mutation check (the STC-421 lesson: prove the tests can fail). Do each, run `npx vitest run transform/test/render-framing.test.ts`, confirm the named tests FAIL, then revert:
1. In `render()`, change `throughCrop(full, crop, frame)` back to `throughCrop(full, crop, outputRect(project.output))` -> the zoom test fails.
2. Remove the `ox/oy` offset (`const m = m0`) -> both cursor tests fail.
3. In `pipStateAt` call pass `outputRect(project.output)` -> the PiP test fails.

- [ ] **Step 5: Commit**

```bash
git add transform/src/render.ts transform/test/render-framing.test.ts transform/test/compositor.test.ts
git commit -m "STC-396: render() maps cursor, PiP and zoom crop into the framed content rect

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The compositor draws the frame

**Files:**
- Modify: `transform/src/compositor.ts` (`drawSource`, `composite`; new `drawChrome`)
- Test: `transform/test/compositor.test.ts` (add a `describe`)

**Interfaces:**
- Consumes: `FrameState.framing`, `gradientLine` (Task 1/3), `Rect` from `spaces.ts`.
- Produces: draw order when framed: black fill, background, shadow, `save`/rounded-`clip`/picture/`restore`, then PiP and cursor clipped to the content rect, then keycast unclipped.

- [ ] **Step 1: Write the failing tests**

Append to `transform/test/compositor.test.ts` (reuse its `frameState`/`draw` helpers; extend `draw` if it takes no frame, or call `composite` directly as below):

```ts
import { framingLayout } from "../src/framing.js";

describe("framing (STC-396)", () => {
  const bitmap = { width: 1280, height: 720 } as unknown as ImageBitmap;
  const W = 640, H = 360;
  const layout = framingLayout({ preset: "clean" }, { width: W, height: H }, 16 / 9)!;
  const c = layout.content;

  function drawFramed(over: Partial<FrameState["cursor"]> = {}) {
    const { ctx, ops } = recorder();
    composite(ctx as unknown as OffscreenCanvasRenderingContext2D, bitmap, null,
              { ...frameState(over), framing: layout }, W, H);
    return ops;
  }
  const idx = (ops: string[], prefix: string, from = 0) => ops.findIndex((o, i) => i >= from && o.startsWith(prefix));

  test("order: background, shadow, then a rounded clip, then the picture inside the content rect", () => {
    const ops = drawFramed({ visible: false });
    const gradient = idx(ops, "createLinearGradient");
    const bgFill = idx(ops, `fillRect(0,0,${W},${H})`, gradient);
    const shadow = idx(ops, `shadowBlur=${layout.shadow.blur}`);
    const clip = idx(ops, "clip(");
    const picture = idx(ops, `drawImage(${String(bitmap)},${c.x},${c.y},${c.width},${c.height})`);
    expect(gradient).toBeGreaterThan(-1);
    expect(bgFill).toBeGreaterThan(gradient);
    expect(shadow).toBeGreaterThan(bgFill);
    expect(clip).toBeGreaterThan(shadow);
    expect(picture).toBeGreaterThan(clip);
    expect(ops.some((o) => o === `roundRect(${c.x},${c.y},${c.width},${c.height},${layout.radius})`)).toBe(true);
  });

  test("the cursor is clipped to the content rect so it cannot be drawn over the chrome", () => {
    const ops = drawFramed({ visible: true });
    const picture = idx(ops, "drawImage(");
    const rectClip = idx(ops, `rect(${c.x},${c.y},${c.width},${c.height})`, picture);
    const cursor = idx(ops, "arc(", picture);   // the click highlight / pointer art starts after the clip
    expect(rectClip).toBeGreaterThan(picture);
    // some cursor drawing op comes after the clip; the clip is not undone before it
    const afterClip = ops.slice(rectClip);
    expect(afterClip.some((o) => o.startsWith("clip("))).toBe(true);
    expect(cursor === -1 || cursor > rectClip).toBe(true);
  });

  test("a solid background fills with the colour, no gradient", () => {
    const solid = framingLayout({ preset: "solid", color: "#112233" }, { width: W, height: H }, 16 / 9)!;
    const { ctx, ops } = recorder();
    composite(ctx as unknown as OffscreenCanvasRenderingContext2D, bitmap, null,
              { ...frameState({ visible: false }), framing: solid }, W, H);
    expect(ops.some((o) => o.startsWith("createLinearGradient"))).toBe(false);
    expect(ops).toContain("fillStyle=#112233");
  });

  test("a zoom crop under framing draws the crop's source rect into the content rect", () => {
    const { ctx, ops } = recorder();
    const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
    composite(ctx as unknown as OffscreenCanvasRenderingContext2D, bitmap, null,
              { ...frameState({ visible: false }), zoom: { amount: 1, crop }, framing: layout }, W, H);
    expect(ops.some((o) => o === `drawImage(${String(bitmap)},128,144,640,360,${c.x},${c.y},${c.width},${c.height})`)).toBe(true);
  });

  test("framing: null draws exactly the pre-framing sequence (no clip, no gradient, no shadow)", () => {
    const { ctx, ops } = recorder();
    composite(ctx as unknown as OffscreenCanvasRenderingContext2D, bitmap, null,
              { ...frameState({ visible: false }), framing: null }, W, H);
    expect(ops.some((o) => o.startsWith("clip(") || o.startsWith("createLinearGradient") || o.startsWith("shadow"))).toBe(false);
    expect(ops).toContain(`drawImage(${String(bitmap)},0,0,${W},${H})`);
  });
});
```

(Adjust the exact op strings to what `recorder()` emits if a line differs: it records calls as `name(arg,arg)` and assignments as `prop=value`; print `ops` once while writing the test.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run transform/test/compositor.test.ts`
Expected: the new framing tests FAIL; the existing tests still pass.

- [ ] **Step 3: Implement in `transform/src/compositor.ts`**

Imports: add `import { gradientLine, type FramingLayout } from "./framing.js";` and `type Rect` to the `./spaces.js` import.

`drawSource` takes the destination rect instead of `width, height`:

```ts
function drawSource(
  ctx: OffscreenCanvasRenderingContext2D,
  frame: DecodedFrame,
  fs: FrameState,
  dest: Rect,
): void {
  const c = fs.zoom.crop;
  if (isWholeFrame(c)) {
    ctx.drawImage(frame, dest.x, dest.y, dest.width, dest.height);
    return;
  }
  const { width: fw, height: fh } = frameSize(frame);
  const src = uvRectToPixels(c, { x: 0, y: 0, width: fw, height: fh });
  ctx.drawImage(frame, src.x, src.y, src.width, src.height, dest.x, dest.y, dest.width, dest.height);
}
```
(Update its doc comment: "drawn into `dest` — the whole canvas unless the take is framed". With `dest = {0,0,width,height}` the unframed calls are argument-for-argument what they were.)

New helper above `composite`:

```ts
/**
 * The frame's chrome (STC-396): the background over the whole canvas, then the
 * shadow, cast from the rounded content rect. The picture is drawn over the
 * shadow's opaque core afterwards, so only the soft edge shows.
 */
function drawChrome(
  ctx: OffscreenCanvasRenderingContext2D, f: FramingLayout, width: number, height: number,
): void {
  const bg = f.background;
  if (bg.kind === "solid") {
    ctx.fillStyle = bg.color;
  } else {
    const l = gradientLine(bg.angleDeg, width, height);
    const g = ctx.createLinearGradient(l.x0, l.y0, l.x1, l.y1);
    g.addColorStop(0, bg.colors[0]);
    g.addColorStop(1, bg.colors[1]);
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, width, height);

  if (f.shadow.opacity > 0 && f.shadow.blur > 0) {
    const c = f.content;
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${f.shadow.opacity})`;
    ctx.shadowBlur = f.shadow.blur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = f.shadow.offsetY;
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, c.width, c.height, f.radius);
    ctx.fill();
    ctx.restore();
  }
}
```

In `composite`, replace the `if (frame) drawSource(...)` line and wrap the cursor, so the section reads:

```ts
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  const framing = fs.framing;
  if (framing) drawChrome(ctx, framing, width, height);
  if (frame) {
    if (framing) {
      const c = framing.content;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(c.x, c.y, c.width, c.height, framing.radius);
      ctx.clip();
      drawSource(ctx, frame, fs, c);
      ctx.restore();
    } else {
      drawSource(ctx, frame, fs, { x: 0, y: 0, width, height });
    }
  }

  // The PiP and the pointer live ON the picture, so a framed take clips them to
  // it: a pointer on another display is outside the capture, and unframed the
  // canvas edge hides it — framed, it would otherwise be painted over the
  // background. The keycast below is a caption on the canvas and is not clipped.
  if (framing) {
    const c = framing.content;
    ctx.save();
    ctx.beginPath();
    ctx.rect(c.x, c.y, c.width, c.height);
    ctx.clip();
  }
  ... existing PiP block and cursor block, unchanged ...
  if (framing) ctx.restore();

  if (fs.keycast) drawKeycast(ctx, fs.keycast, width, height);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run transform/test/compositor.test.ts transform/test/render-backend.test.ts && npm run typecheck`
Expected: PASS, including every pre-existing compositor test unchanged (that is the by-construction evidence for framing None).

- [ ] **Step 5: Commit**

```bash
git add transform/src/compositor.ts transform/test/compositor.test.ts
git commit -m "STC-396: compositor draws the frame chrome and clips picture and pointer to it

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Transform version 14

**Files:**
- Modify: `transform/src/transform-version.ts` (version, history, fingerprint inputs, header comment), `transform/test/transform-version.test.ts` (`PINNED_FINGERPRINT` and its comment)

**Interfaces:**
- Consumes: `FRAMING_PRESETS`, `DEFAULT_SOLID_COLOR`, `FRAMING_PADDING_MAX`, `FRAMING_RADIUS_MAX` (Task 1).
- Produces: `TRANSFORM_VERSION = 14`.

- [ ] **Step 1: Make the test fail first**

Run: `npx vitest run transform/test/transform-version.test.ts`
Expected: PASS today. Now change `TRANSFORM_VERSION` to `14` only: the "last entry in the history" test FAILS. That is the contiguity guard working.

- [ ] **Step 2: Implement**

In `transform/src/transform-version.ts`:
1. `import { FRAMING_PRESETS, DEFAULT_SOLID_COLOR, FRAMING_PADDING_MAX, FRAMING_RADIUS_MAX } from "./framing.js";`
2. `export const TRANSFORM_VERSION = 14;`
3. Append to `TRANSFORM_HISTORY`:

```ts
  { version: 14, since: "2026-10-02", changed: "video framing (STC-396): project-15's optional framing insets the recording inside the chosen output and draws a background, a shadow and rounded corners around it. render() carries the layout in FrameState.framing and maps the cursor, click highlight, pointer size, PiP and zoom crop into the inset rect (spaces.ts's existing owners); the one compositor draws background, shadow, then the picture clipped to a rounded rect, with the PiP and pointer clipped to the picture. A project with no framing renders exactly what version 13 did: framing is null, the compositor takes its previous code path argument for argument, and every position is computed from the same numbers. The fingerprint moved: the framing presets and bounds reach the pixels" },
```
4. In `transformFingerprint()`'s `inputs` object add (beside the other grouped constants):

```ts
    framing: { FRAMING_PRESETS, DEFAULT_SOLID_COLOR, FRAMING_PADDING_MAX, FRAMING_RADIUS_MAX },
```
5. Add a `## Version 14: video framing (STC-396)` paragraph above `TRANSFORM_VERSION` in the file's header comment, two or three sentences matching the history entry.

- [ ] **Step 3: Run, read the new fingerprint, pin it**

Run: `npx vitest run transform/test/transform-version.test.ts`
Expected: the fingerprint test FAILS showing Expected `f5959acd` and Received `<new>`. Put `<new>` in `PINNED_FINGERPRINT` and extend the comment above it: "It last moved at version 14 (STC-396): the framing presets, solid default and padding/radius bounds were added as inputs."

Re-run: `npx vitest run transform/test/transform-version.test.ts` -> PASS.

- [ ] **Step 4: Run the whole transform suite**

Run: `npx vitest run transform/ && npm run typecheck`
Expected: PASS. Any test hard-coding version 13 as a literal (not the constant) fails here: update it to use `TRANSFORM_VERSION`.

- [ ] **Step 5: Commit**

```bash
git add transform/src/transform-version.ts transform/test/transform-version.test.ts
git commit -m "STC-396: transform version 14 (video framing)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Legibility accounts for the frame; the editor's Frame control

**Files:**
- Modify: `transform/src/legibility.ts`, `app/renderer/editor.html` (export dialog), `app/src/editor.ts` (`updateLegibilityUI` ~1303, the export manifest call ~2418, new framing block near the keycast block ~1715, init calls)
- Test: `transform/test/legibility.test.ts` (add), `app/test/framing-editor.e2e.test.ts` (new)

**Interfaces:**
- Consumes: `contentFraction`, `Framing`, `DEFAULT_SOLID_COLOR` (Task 1); `Project.framing` (Task 2).
- Produces: `legibility(display, textPt, embedWidthPx, zoomFactor = 1, frameFraction = 1)`; `Legibility.frameFraction`; the Frame control (`#framepreset`, `#framecolor`).

- [ ] **Step 1: Write the failing tests**

Add to `transform/test/legibility.test.ts`:

```ts
describe("frame fraction (STC-396)", () => {
  const display = { pointWidth: 1728 };
  test("a frame shrinks the text by the picture's share of the width", () => {
    const plain = legibility(display, 13, 1232);
    const framed = legibility(display, 13, 1232, 1, 0.88);
    expect(framed.textPx).toBeCloseTo(plain.textPx * 0.88, 9);
    expect(framed.frameFraction).toBe(0.88);
  });
  test("the default fraction is 1 and changes nothing", () => {
    expect(legibility(display, 13, 1232).textPx).toBe(legibility(display, 13, 1232, 1, 1).textPx);
  });
  test("the sentence names the frame only when there is one", () => {
    expect(legibilitySentence(legibility(display, 13, 1232))).not.toMatch(/frame/);
    expect(legibilitySentence(legibility(display, 13, 1232, 1, 0.88))).toMatch(/inside the frame/);
  });
});
```

Create `app/test/framing-editor.e2e.test.ts` modelled on `app/test/keycast-editor.e2e.test.ts` (copy its launch/open-take scaffolding):

```ts
// Asserts: the export dialog has #framepreset, defaulting to "none"; choosing
// "clean" writes project.json with framing {preset:"clean"} at version 15 and
// the legibility line gains "inside the frame"; choosing "solid" reveals
// #framecolor; choosing "none" removes framing from project.json again.
```
Write it with the same helpers (`launchWithTakeInEditor`, `inkiness`) the keycast test uses; open the dialog the way that file or `legibility.e2e.test.ts` does, then `selectOption`/`fill` on the ids above and read `project.json` from `takeDir`.

- [ ] **Step 2: Run to verify the unit test fails**

Run: `npx vitest run transform/test/legibility.test.ts`
Expected: FAIL (`frameFraction` undefined).

- [ ] **Step 3: Implement**

3a. `legibility.ts`:

```ts
export interface Legibility {
  textPx: number;
  verdict: "ok" | "warn";
  textPt: number;
  embedWidthPx: number;
  zoomFactor: number;
  /** The picture's share of the output width when framed (STC-396); 1 otherwise. */
  frameFraction: number;
}
```
`legibility(display, textPt, embedWidthPx, zoomFactor = 1, frameFraction = 1)`: `textPx = (textPt * embedWidthPx * zoomFactor * frameFraction) / pointWidth`, and return `frameFraction`. In `legibilitySentence` add `const framed = l.frameFraction < 1 ? " inside the frame" : "";` and append it after the zoom text: `` `At ${l.embedWidthPx}px${zoom}${framed}, ...` ``. Add a short note to the header: framing is the fourth input and, like the output width, the cancelling is the point — a frame shrinks the picture within the embed.

Fix any existing test that deep-equals a `Legibility` object (add `frameFraction: 1`).

3b. `editor.html` — a new row in `#exportdialog`, directly after the "Export size" row:

```html
    <div class="dialogrow">
      <label for="framepreset">Frame</label>
      <select id="framepreset">
        <option value="none">None</option>
        <option value="clean">Clean</option>
        <option value="dark">Dark</option>
        <option value="solid">Solid</option>
      </select>
      <input id="framecolor" type="color" value="#3b4252" hidden aria-label="Frame colour">
    </div>
```

3c. `editor.ts` — imports: `import { contentFraction, DEFAULT_SOLID_COLOR, type Framing, type FramingPreset } from "@transform/framing";`. A helper, and use it in both legibility call sites:

```ts
function frameFractionFor(p: Project): number {
  return openCapture ? contentFraction(p.framing, p.output, openCapture.width / openCapture.height) : 1;
}
```
`updateLegibilityUI`: `legibility(openDisplay, ..., embedWidthPx, zoomFactorForCrop(fs.zoom.crop.width), frameFractionFor(openProject))`. The export-manifest call (~2418): `legibility(openDisplay!, exporting.textPt ?? DEFAULT_TEXT_PT, embedWidthPx, 1, frameFractionFor(exporting))`.

New block after the keycast block:

```ts
// ---- framing (STC-396) -------------------------------------------------
// A preset (or none) saved to the project. Preview and export both go through
// render(), so what is previewed is what exports.
function updateFramingUI(): void {
  const f = openProject?.framing;
  ($("framepreset") as HTMLSelectElement).value = f?.preset ?? "none";
  const color = $("framecolor") as HTMLInputElement;
  color.hidden = f?.preset !== "solid";
  color.value = f?.color ?? DEFAULT_SOLID_COLOR;
}

async function setFraming(next: Framing | undefined): Promise<void> {
  if (!openProject || !player) return;
  const previous = openProject.framing;
  if (next) openProject.framing = next; else delete openProject.framing;
  try {
    await persistProject();
  } catch (e) {
    if (previous) openProject.framing = previous; else delete openProject.framing;
    updateFramingUI();
    throw e;
  }
  updateFramingUI();
  updateLegibilityUI();
  await player.seek(player.currentNs);   // repaint this frame with the new choice
}

function framingFromControls(): Framing | undefined {
  const v = ($("framepreset") as HTMLSelectElement).value;
  if (v === "none") return undefined;
  const preset = v as FramingPreset;
  return preset === "solid"
    ? { preset, color: ($("framecolor") as HTMLInputElement).value }
    : { preset };
}

for (const id of ["framepreset", "framecolor"]) {
  $(id).addEventListener("change", () => {
    void setFraming(framingFromControls()).catch((e: any) => alertUser(String(e?.message ?? e)));
  });
}
```
Call `updateFramingUI()` everywhere `updateKeycastUI()` is called on take open (`grep -n "updateKeycastUI()" app/src/editor.ts`). Disable `#framepreset` and `#framecolor` while exporting, beside the existing `($("outsize") ...).disabled = true/false` lines (~2369, ~2431). Check that `persistProject` writes through `projectForWrite` (it does for every other field) so version 15 is produced.

- [ ] **Step 4: Run to verify**

Run: `npx vitest run transform/test/legibility.test.ts && npm run typecheck && npm run app:build` (whatever bundles `app/dist` — see `package.json` / `app/build.mjs`; the point is the editor still bundles).
Expected: PASS. Run `app/test/framing-editor.e2e.test.ts` plus the legibility/export e2es in the VM (`docs/VM-TESTING.md`) or have Patrick run `npx vitest run app/test/framing-editor.e2e.test.ts app/test/legibility.e2e.test.ts app/test/export.e2e.test.ts`; record which in the PR.

- [ ] **Step 5: Commit**

```bash
git add transform/src/legibility.ts transform/test/legibility.test.ts app/renderer/editor.html app/src/editor.ts app/test/framing-editor.e2e.test.ts
git commit -m "STC-396: Frame control in the export dialog; legibility accounts for the inset

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Gates (framed identity, pixel properties)

**Files:**
- Create: `harness/framing.html`, `harness/framing.ts`, `scripts/framing-gate.mjs`
- Modify: `harness/sink-identity.ts` (~line 77), `scripts/identity-gate.mjs` (~line 74), `package.json` (scripts), `.github/workflows/ci.yml` (after the "Decorated still gate" step; and a framed run after the fixture identity steps)

**Interfaces:**
- Consumes: `framingLayout`, `composite`, `FrameState` (Tasks 1, 3, 4).
- Produces: `npm run gate:framing`; `STC_IDENTITY_FRAMING=<preset>` env for `gate:identity`.

- [ ] **Step 1: The framed identity run**

`harness/sink-identity.ts`, right after `const project: Project = parseProject(...)`:

```ts
    // STC-396: `?framing=clean` frames the take for this run, so the two sinks
    // are compared on the framed path too (scripts/identity-gate.mjs passes it).
    const framingParam = new URLSearchParams(location.search).get("framing");
    if (framingParam) {
      const f = { preset: framingParam };
      const problem = framingProblem(f);
      if (problem) throw new Error(problem);
      project.framing = f as Project["framing"];
    }
```
(import `framingProblem` from `@transform/framing`.)

`scripts/identity-gate.mjs` line ~74: 

```js
  const framing = process.env.STC_IDENTITY_FRAMING;
  await page.goto(`http://localhost:5205/sink-identity.html${framing ? `?framing=${encodeURIComponent(framing)}` : ""}`);
```

`.github/workflows/ci.yml`: mirror the existing PiP-fixture identity step (read the ~20 lines above the "Decorated still gate" step) with a new step "Sink identity, framed" that copies `fixtures/pip/` into a temp take as that step does and runs `STC_IDENTITY_FRAMING=clean npm run gate:identity -- "$CAM"`. Add after the "Decorated still gate" step:

```yaml
      - name: Video framing gate
        run: npm run gate:framing
```

- [ ] **Step 2: The pixel-property gate**

`harness/framing.html`:

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>framing gate</title><link rel="icon" href="data:,"></head>
<body><pre id="s">framing harness ready</pre><script type="module" src="/framing.ts"></script></body></html>
```

`harness/framing.ts`:

```ts
import { composite } from "@transform/compositor";
import { framingLayout, type Framing } from "@transform/framing";
import { FULL_FRAME_UV, type FrameState } from "@transform/render";

/**
 * The video framing gate's page (STC-396). Draws a flat-colour "recording"
 * through the REAL compositor with a hand-built FrameState and reports pixel
 * facts the gate script asserts as PROPERTIES (no golden images: gradients and
 * blurred shadows are rasteriser output — see scripts/still-gate.mjs).
 */
const W = 960, H = 540;
const FILL = { r: 0x2f, g: 0x6d, b: 0xd8 };

async function frameBitmap(): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(640, 360);
  const x = c.getContext("2d")!;
  x.fillStyle = `rgb(${FILL.r},${FILL.g},${FILL.b})`;
  x.fillRect(0, 0, 640, 360);
  return createImageBitmap(c);
}

function stateFor(framing: Framing | undefined, pointer?: { x: number; y: number }): FrameState {
  const layout = framingLayout(framing, { width: W, height: H }, 16 / 9) ?? null;
  return {
    tick: 0, frameIndex: 0, framePtsNs: 0, pip: null, keycast: null,
    zoom: { amount: 0, crop: FULL_FRAME_UV },
    cursor: { x: pointer?.x ?? 0, y: pointer?.y ?? 0, vx: 0, vy: 0, pressed: false, showClicks: false,
              visible: !!pointer, shape: "arrow", style: "default", pxPerPoint: 2 },
    framing: layout,
  };
}

async function render(framing: Framing | undefined, pointer?: { x: number; y: number }) {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true })!;
  composite(ctx, await frameBitmap(), null, stateFor(framing, pointer), W, H);
  return ctx.getImageData(0, 0, W, H);
}

const px = (d: ImageData, x: number, y: number) => {
  const i = (Math.round(y) * d.width + Math.round(x)) * 4;
  return { r: d.data[i]!, g: d.data[i + 1]!, b: d.data[i + 2]!, a: d.data[i + 3]! };
};
const lum = (p: { r: number; g: number; b: number }) => 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;

(window as any).__framingGate = async () => {
  const out: any[] = [];
  for (const framing of [{ preset: "clean" }, { preset: "dark" }, { preset: "solid", color: "#c0392b" }] as Framing[]) {
    const layout = framingLayout(framing, { width: W, height: H }, 16 / 9)!;
    const c = layout.content;
    const a = await render(framing);
    const b = await render(framing);
    // the same document with the shadow switched off, as the "no shadow" reference
    const none = await render({ ...framing, shadow: { offsetYPct: 0, blurPct: 0, opacity: 0 } });
    const cx = c.x + c.width / 2;
    const below: { d: number; lum: number; ref: number }[] = [];
    const reach = Math.ceil(layout.shadow.blur * 1.5 + Math.abs(layout.shadow.offsetY));
    for (let d = 0; d <= reach + 6; d += 2) {
      const y = c.y + c.height + d;
      if (y >= H) break;
      below.push({ d, lum: lum(px(a, cx, y)), ref: lum(px(none, cx, y)) });
    }
    out.push({
      preset: (framing as any).preset, layout,
      repeatEqual: a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]),
      interior: px(a, cx, c.y + c.height / 2),
      corner: px(a, c.x + 1, c.y + 1),
      background: px(a, 0, 0),
      backgroundFar: px(a, W - 1, H - 1),
      below,
    });
  }
  // a pointer on the CHROME (outside the picture) must not be drawn
  const layout = framingLayout({ preset: "clean" }, { width: W, height: H }, 16 / 9)!;
  const clean = await render({ preset: "clean" });
  const stray = { x: 4, y: 4 };   // inside the padding, outside the content
  const withPointer = await render({ preset: "clean" }, stray);
  let chromeDiff = 0;
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
    const p = px(clean, x, y), q = px(withPointer, x, y);
    if (p.r !== q.r || p.g !== q.g || p.b !== q.b) chromeDiff++;
  }
  return { probes: out, fill: FILL, chromeDiff, contentX: layout.content.x };
};

(window as any).__ready = true;
```

`scripts/framing-gate.mjs` — start from `scripts/still-gate.mjs` lines 1-60 (imports, `fail`/`ok`, vite server on a free port such as 5208 serving `harness`, the same bundled-Chromium launch with `STC_STILL_GATE_CHANNEL`/`STC_STILL_GATE_BROWSER`-style env, `bounded`, `instrumentPage`, `closeQuietly`, and the `isBoundFailure` handling in its `catch`/`finally`), using `"http://localhost:5208/framing.html"`, then:

```js
  const result = await bounded(page.evaluate(() => window.__framingGate()), STILL_MS, "in-page framing gate");
  for (const p of result.probes) {
    const tag = p.preset;
    const { r, g, b, a } = p.interior, f = result.fill;
    if (a !== 255 || Math.abs(r - f.r) > 2 || Math.abs(g - f.g) > 2 || Math.abs(b - f.b) > 2) {
      fail(`${tag}: the picture's interior is ${r},${g},${b} (alpha ${a}), not the recording's ${f.r},${f.g},${f.b} — framing must not tint it`);
    } else ok(`${tag}: the picture reaches the canvas untouched`);

    // the rounded corner is clipped: the very corner pixel shows chrome, not the picture
    const k = p.corner;
    if (Math.abs(k.r - f.r) <= 2 && Math.abs(k.g - f.g) <= 2 && Math.abs(k.b - f.b) <= 2) {
      fail(`${tag}: the content corner is not rounded (corner pixel is still the recording's colour)`);
    } else ok(`${tag}: the corner is rounded`);

    // no dark fringe: a corner pixel may not be darker than BOTH the picture and the background
    const L = (q) => 0.2126 * q.r + 0.7152 * q.g + 0.0722 * q.b;
    if (L(k) < Math.min(L(f), L(p.background)) - 12) fail(`${tag}: dark fringe at the rounded corner`);

    // the background covers every pixel it should: opaque at both far corners
    if (p.background.a !== 255 || p.backgroundFar.a !== 255) fail(`${tag}: the background has a hole at a canvas corner`);

    // the shadow reaches zero: at and beyond its reach, the pixel equals the no-shadow reference
    const last = p.below.at(-1);
    if (Math.abs(last.lum - last.ref) > 1.5) fail(`${tag}: the shadow has not faded to nothing by ${last.d}px (lum ${last.lum.toFixed(1)} vs ${last.ref.toFixed(1)})`);
    else ok(`${tag}: the shadow reaches zero within the padding`);
    // and it is present near the picture
    const first = p.below[0];
    if (first.ref - first.lum < 2 && p.preset !== "dark") fail(`${tag}: no shadow visible against the picture's edge`);

    if (!p.repeatEqual) fail(`${tag}: two renders of one document differ inside this browser`);
    else ok(`${tag}: two renders agree byte for byte`);
  }
  if (result.chromeDiff !== 0) fail(`a pointer outside the picture was drawn over the chrome (${result.chromeDiff} pixels differ)`);
  else ok("a pointer outside the picture is clipped, not drawn over the background");
```
and end like `still-gate.mjs` (print `FAIL`/`PASS` summary, `process.exit(failures ? 1 : 0)`, close browser and server).

`package.json`: `"gate:framing": "node scripts/gate-retry.mjs scripts/framing-gate.mjs",`

- [ ] **Step 3: Run**

Run: `npm run gate:framing`
Expected: every `ok`, exit 0. If "no shadow visible" fires on `clean`, the shadow is too faint at this size: that is a PRESET finding, not a gate bug; adjust `SHADOW` in `framing.ts` (then Task 5's fingerprint must be re-pinned). If the dark preset's shadow check is noisy, the guard `p.preset !== "dark"` already exempts only the visibility check, not the fade-to-zero check.

Then, on a Mac with Chrome: `npm run gate:identity -- fixtures/pip` is not valid (needs a directory with display.mp4): use the CI recipe (copy `fixtures/pip/*` to a temp take dir) with `STC_IDENTITY_FRAMING=clean npm run gate:identity -- "$CAM"`. Expected: sink identity holds on the framed path.

- [ ] **Step 4: Commit**

```bash
git add harness/framing.html harness/framing.ts scripts/framing-gate.mjs harness/sink-identity.ts scripts/identity-gate.mjs package.json .github/workflows/ci.yml
git commit -m "STC-396: framing pixel-property gate and a framed sink-identity run

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Docs, a real export looked at, and the PR

**Files:**
- Create: `docs/STC-396-RUNBOOK.md`
- Modify: `docs/TICKET-LOG.md` (append a row), `CLAUDE.md` (table rows for `transform/src/framing.ts`, `schema/project-15.schema.json`, the runbook)

- [ ] **Step 1: Look at real output on this Mac**

Run the app and frame a real take in the editor, then export it:

```bash
npm run app:start
```
In the editor: open a take, open the export dialog, choose each of Clean, Dark, Solid (pick a colour), export, and WATCH the files (play them). Also export once at Embed 1x and once at capture size. Record, for the runbook: how each preset looks; whether the shadow reads at 4K and at Embed size; whether the inset hurts legibility (read the legibility line); whether the rounded corner and shadow are clean in the encoded file; the cursor staying on its target under a zoom. Fix preset values in `framing.ts` if something is plainly off (then re-pin the fingerprint, Task 5 step 3, and re-run `npm run gate:framing`).

For a scripted export of a take whose `project.json` you edited by hand to add `"framing": {"preset": "clean"}` (and `"version": 15`): `node scripts/export-one.mjs <sessionDir> 10`.

- [ ] **Step 2: Write `docs/STC-396-RUNBOOK.md`**

Sections: what shipped; what was run and seen on this Mac (the Step 1 results, stated plainly, including anything not run); what only a person can still judge (provisional preset values, look of each at 4K and Embed, whether a 6% inset is too generous for a small embed); the Frame control matches the existing dialog's controls and is NOT a Figma-matched design; how to hand-author an override in `project.json`; the VM/e2e commands that were or were not run.

- [ ] **Step 3: Ticket log and CLAUDE.md**

Append an `STC-396` row to `docs/TICKET-LOG.md` in that file's existing style (what shipped, what was learned, what is still open). Add three table rows to `CLAUDE.md` for `transform/src/framing.ts`, `schema/project-15.schema.json`, and `docs/STC-396-RUNBOOK.md` in the existing one-line-per-file style, naming the decisions: inset not canvas growth, PiP anchored to content, framing None identical to v13.

- [ ] **Step 4: Full verification**

Run, and read the output:

```bash
npm run typecheck
npm test
npm run gate:framing
```
Expected: all green. If `npm test` shows an unrelated pre-existing failure, say so in the PR with its output. Do not claim green without having run these.

- [ ] **Step 5: Commit, push, PR**

```bash
git add docs/STC-396-RUNBOOK.md docs/TICKET-LOG.md CLAUDE.md
git commit -m "STC-396: runbook, ticket log, CLAUDE.md rows

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --base master --title "STC-396: video framing presets" --body "<summary, what was run, what was not, link the runbook>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
After the PR is open: call the `ccd_pr` `get_status` tool and bind it if needed; read CI; do not poll. Merge with `npm run merge -- <pr>` only when Patrick says so. Comment on STC-396 in Linear with the PR link and hand Patrick the runbook with this branch name (it is not on `master` yet).

---

## Self-review (against the spec)

- **Goal / presets (None, Clean, Dark, Solid):** Tasks 1, 2, 6.
- **Inset inside a fixed output, output rules untouched:** Task 1 (`framingLayout`), Task 3 (`render` uses `project.output` only as the fitting bound).
- **PiP on content, keycast on canvas, zoom within the picture:** Task 3 (PiP, crop), Task 4 (keycast unclipped, cursor/PiP clipped).
- **Data (project-15, minimum version, explicit overrides win, frozen v14 loads):** Tasks 1, 2.
- **Layout rules (fraction of short edge, aspect fit, whole pixels, shadow clamp):** Task 1.
- **Rendering order, framing None byte-identical by construction, `TRANSFORM_VERSION` 14:** Tasks 4, 5.
- **Rasterizer risk (framed fixture in identity gates):** Task 7.
- **Legibility uses the content width:** Task 6.
- **Editor control, no Figma:** Task 6.
- **Tests and proof (pure, render mutation-checked, schema/loader, gates, runbook, looked at a real export):** Tasks 1-8.
- **Type names used across tasks:** `Framing`, `FramingLayout`, `FramingPreset`, `framingLayout`, `framingProblem`, `cleanFraming`, `gradientLine`, `contentFraction`, `FrameState.framing`, `frameFraction`, `#framepreset`, `#framecolor` are consistent.
- **Open item for the executor, not decided here:** `Project.pip`'s literal shape in the Task 3 PiP test, and the exact `recorder()` op strings in Task 4 — both are one print-and-adjust, flagged in the steps.
