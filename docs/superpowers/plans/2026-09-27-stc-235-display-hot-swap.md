# STC-235 Display Hot-Swap (Refit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A take survives any display change it can survive — the display stream is refitted into the SAME `display.mp4` at the take's original capture size, and the transform maps cursor/zoom/legibility through a per-frame geometry timeline recorded in anchors-7.

**Architecture:** The helper never changes `AVAssetWriter` dimensions; on a debounced display change it classifies (stop vs refit), re-resolves the target against fresh `SCShareableContent`, computes an even-edged letterbox fit rect inside `captureW×captureH`, and pushes it to the live `SCStream` (`updateContentFilter` + `updateConfiguration`, restart fallback). Each refit appends `{startNs, display, contentRect}` to a `geometry` list written as anchors-7. `render()` picks the entry by the SHOWN frame's PTS and maps global points → display-local → `contentRect` → output. Everything else in the pipeline (demux, decoders, compositor, export, preview) is untouched.

**Tech Stack:** Swift 6.4 / macOS SDK 27 (ScreenCaptureKit, AVFoundation), built by `helper/build.sh`; TypeScript transform + Electron app; vitest; ajv for schemas; Playwright-Electron e2e.

**Spec:** `docs/superpowers/specs/2026-09-27-stc-235-display-hot-swap-design.md`

## Global Constraints

- `render(project, session, t)` stays pure; geometry is session data only.
- Every take with no refit must be **byte-identical** to today: anchors stays v2–v6 (minimum-version rule), render output unchanged.
- `geometry` present ⇒ anchors `version: 7`; `geometry.length >= 2`; `geometry[0].display` deep-equals top-level `display`, `geometry[0].contentRect` = `{0,0,capture.width,capture.height}`, `geometry[0].startNs === capture.firstFrameNs`; `startNs` strictly increasing; every `contentRect` inside `capture`, even `x/y/width/height`, width/height ≥ 2.
- Stop reasons: captured display gone → `display-reconfigured`; region not entirely inside new display point bounds → `region-out-of-bounds`; refit that never produces a frame within `REFIT_FRAME_TIMEOUT_MS = 3000` → `display-reconfigured`.
- `DISPLAY_CHANGE_SETTLE_MS = 250`.
- Window resize/close still ends a window take (unchanged).
- Loaders refuse, never default.
- `spaces.ts` owns every coordinate conversion (STC-314; `transform/test/spaces-seam.test.ts` greps for violations).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `master` is protected: PR + `npm run merge -- <pr>`.
- `npm run typecheck` (all three passes) and `npm test` green before each commit that touches TS.

## Deviations from the spec (decided while planning — call out in the PR)

1. **`display-refit` travels as a `warning` code**, not a new event type. It is still unsolicited; the renderer's existing `helper:warning` path already carries codes to the UI, so no helper-client/supervisor plumbing is added and the supervisor cannot mistake it for a stop.
2. **The recorded `contentRect` is the COMPUTED fit rect.** The SDK documents `SCStreamFrameInfoContentRect` as "size and location of content in points in surface" — unit ambiguous (points vs output pixels). Gating the refit on it could stall every refit into the 3 s timeout. The refit ends at the first frame accepted after the update completion handler returns; SCK's rect is read, compared under BOTH interpretations (raw and ×`SCStreamFrameInfoScaleFactor`), and a mismatch under both sends `display-refit-rect-mismatch`. Runbook §8 settles the unit.
3. **`preservesAspectRatio = false` with an explicit `destinationRect`.** We compute the aspect-preserving fit ourselves, so SCK is told to fill exactly that rect. This makes placement deterministic rather than relying on SCK's own centring, and lets the fault inject a narrower rect.
4. **`TRANSFORM_VERSION` 8 → 9**, fingerprint unchanged: per the version-7 note's rule, a v7 document renders differently under the new code than under the old.

## Review Focus

1. **A take with no refit is unchanged** — anchors version, bytes, and render output. Pinned by Task 3's golden and Task 9's control.
2. **A cursor event at a `t` inside the seam** (after the change, before the first refitted frame) is mapped with the HELD frame's geometry, not the next one. Pinned in Task 2 (`geometryAt`) and Task 3 (render).
3. **A burst of 3+ CG callbacks for one physical change yields exactly ONE refit.** Pinned in Task 8's debounce reducer test.
4. **A region exactly touching the new display edge continues; one point over stops.** Pinned in Task 8.
5. **A display change that arrives while paused** refits normally, and the geometry entry's `startNs` is the first frame AFTER resume (paused frames never become the first refitted frame). Pinned in Task 10's frame-path rule and asserted in Task 11's grant test (`pause` then fault).

---

# PR 1 — schema, transform, app (CI-testable)

### Task 1: anchors-7 schema + library version gate

**Files:**
- Create: `schema/anchors-7.schema.json` (copy of `anchors-6.schema.json` + additions)
- Modify: `app/src/library-items.ts:250`
- Test: `transform/test/schema.test.ts`

**Interfaces:**
- Produces: `schema/anchors-7.schema.json` with `geometry` and `$defs.display`; stop enum gains `region-out-of-bounds`, `region-out-of-bounds-timeout`.

- [ ] **Step 1: Write the failing schema tests** — append to `transform/test/schema.test.ts` (it already has `compile(path)`):

```ts
describe("anchors-7 carries a refit geometry timeline (STC-235)", () => {
  const base = () => ({
    version: 7,
    timebase: { numer: 125, denom: 3 },
    t0Ns: "1000000000",
    display: { id: 1, pointWidth: 1728, pointHeight: 1117, pixelWidth: 3456, pixelHeight: 2234,
               backingScale: 2, originX: 0, originY: 0 },
    capture: { width: 3340, height: 2160, codec: "h264", firstFrameNs: 16000000 },
    files: { display: "display.mp4" },
    stop: { t: 9000000000, reason: "user" },
    geometry: [
      { startNs: 16000000,
        display: { id: 1, pointWidth: 1728, pointHeight: 1117, pixelWidth: 3456, pixelHeight: 2234,
                   backingScale: 2, originX: 0, originY: 0 },
        contentRect: { x: 0, y: 0, width: 3340, height: 2160 } },
      { startNs: 4000000000,
        display: { id: 1, pointWidth: 1440, pointHeight: 900, pixelWidth: 2880, pixelHeight: 1800,
                   backingScale: 2, originX: 0, originY: 0 },
        contentRect: { x: 0, y: 36, width: 3340, height: 2088 } },
    ],
  });

  test("a two-entry geometry validates", () => {
    const v = compile("schema/anchors-7.schema.json");
    expect(v(base()), JSON.stringify(v.errors)).toBe(true);
  });
  test("a one-entry geometry is refused (write none instead)", () => {
    const v = compile("schema/anchors-7.schema.json");
    const d = base(); d.geometry = d.geometry.slice(0, 1);
    expect(v(d)).toBe(false);
  });
  test("an unknown key in a geometry entry is refused", () => {
    const v = compile("schema/anchors-7.schema.json");
    const d: any = base(); d.geometry[1].scale = 2;
    expect(v(d)).toBe(false);
  });
  test("region-out-of-bounds is a valid stop reason", () => {
    const v = compile("schema/anchors-7.schema.json");
    const d = base(); d.stop.reason = "region-out-of-bounds";
    expect(v(d), JSON.stringify(v.errors)).toBe(true);
  });
  test("anchors-6 still refuses geometry (it is new at 7)", () => {
    const v = compile("schema/anchors-6.schema.json");
    const d: any = base(); d.version = 6;
    expect(v(d)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run transform/test/schema.test.ts`
Expected: FAIL — `ENOENT ... anchors-7.schema.json`.

- [ ] **Step 3: Create the schema.** `cp schema/anchors-6.schema.json schema/anchors-7.schema.json`, then edit:
  - `$id`/`title` → anchors-7; `version.const` → 7; description line: "anchors-6 plus `geometry` (STC-235): the refit timeline, present only when the display changed mid-take and the take continued."
  - Move the existing `properties.display` object into `$defs.display` and make `properties.display` = `{ "$ref": "#/$defs/display" }` (identical constraints).
  - Add to `properties`:

```json
"geometry": {
  "description": "STC-235. Present only after at least one refit. Entry 0 is the take's start (top-level display, full-frame contentRect, startNs = capture.firstFrameNs). contentRect is in capture pixels. Selected by the PTS of the frame being shown.",
  "type": "array",
  "minItems": 2,
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["startNs", "display", "contentRect"],
    "properties": {
      "startNs": { "type": "integer", "minimum": 0 },
      "display": { "$ref": "#/$defs/display" },
      "contentRect": {
        "type": "object",
        "additionalProperties": false,
        "required": ["x", "y", "width", "height"],
        "properties": {
          "x": { "type": "integer", "minimum": 0 },
          "y": { "type": "integer", "minimum": 0 },
          "width": { "type": "integer", "minimum": 2 },
          "height": { "type": "integer", "minimum": 2 }
        }
      }
    }
  }
}
```

  - In `properties.stop.properties.reason`, add `"region-out-of-bounds"` alongside `display-reconfigured` in whatever form the enum/pattern uses for the `-timeout` family (mirror exactly how `window-resized` was added in anchors-3).

- [ ] **Step 4: Add 7 to the library gate** — `app/src/library-items.ts:250`:

```ts
export const SUPPORTED_ANCHORS_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run transform/test/schema.test.ts app/test/take-list.test.ts`
Expected: PASS (take-list pins the list to the schema files on disk).

- [ ] **Step 6: Commit**

```bash
git add schema/anchors-7.schema.json transform/test/schema.test.ts app/src/library-items.ts
git commit -m "STC-235: anchors-7 — geometry timeline and region-out-of-bounds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: geometry types, loader validation, `geometryAt`

**Files:**
- Create: `transform/src/display-geometry.ts`
- Modify: `transform/src/types.ts:103-141` (`Anchors`), `transform/src/session.ts` (version gate + validation call)
- Test: `transform/test/display-geometry.test.ts` (new), `transform/test/session.test.ts`

**Interfaces:**
- Produces:
  - `interface CaptureRect { x: number; y: number; width: number; height: number }`
  - `interface GeometryEntry { startNs: number; display: Anchors["display"]; contentRect: CaptureRect }`
  - `Anchors.version: 1|2|3|4|5|6|7`, `Anchors.geometry?: GeometryEntry[]`, `Anchors.capture.firstFrameNs?: number`
  - `function checkGeometry(anchors: Anchors): void` — throws `SessionLoadError`
  - `function geometryAt(anchors: Anchors, frameNs: number | null): { display: Anchors["display"]; contentRect: CaptureRect }`
  - `function fullFrame(capture: { width: number; height: number }): CaptureRect`

- [ ] **Step 1: Write failing tests** — `transform/test/display-geometry.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { checkGeometry, geometryAt, fullFrame } from "../src/display-geometry.js";
import type { Anchors } from "../src/types.js";

const D0 = { id: 1, pointWidth: 1728, pointHeight: 1117, pixelWidth: 3456, pixelHeight: 2234,
             backingScale: 2, originX: 0, originY: 0 };
const D1 = { ...D0, pointWidth: 1440, pointHeight: 900, pixelWidth: 2880, pixelHeight: 1800 };

function v7(): Anchors {
  return {
    version: 7, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
    display: D0,
    capture: { width: 3340, height: 2160, codec: "h264", firstFrameNs: 16_000_000 },
    files: { display: "display.mp4" },
    geometry: [
      { startNs: 16_000_000, display: D0, contentRect: { x: 0, y: 0, width: 3340, height: 2160 } },
      { startNs: 4_000_000_000, display: D1, contentRect: { x: 0, y: 36, width: 3340, height: 2088 } },
    ],
  } as Anchors;
}

describe("geometryAt — the entry for the frame being SHOWN", () => {
  test("no geometry: the top-level display and the full frame", () => {
    const a = { ...v7(), version: 6, geometry: undefined } as Anchors;
    expect(geometryAt(a, 5_000_000_000)).toEqual({ display: D0, contentRect: fullFrame(a.capture) });
  });
  test("a frame before the refit uses entry 0", () => {
    expect(geometryAt(v7(), 3_999_999_999).display).toBe(D0);
  });
  test("the refitted frame itself uses entry 1", () => {
    expect(geometryAt(v7(), 4_000_000_000).display).toBe(D1);
  });
  test("no frame shown yet (null) uses entry 0", () => {
    expect(geometryAt(v7(), null).display).toBe(D0);
  });
});

describe("checkGeometry refuses rather than defaults", () => {
  const bad = (mut: (a: any) => void) => { const a: any = v7(); mut(a); return a; };
  test("a valid v7 passes", () => expect(() => checkGeometry(v7())).not.toThrow());
  test("no geometry passes (every take before STC-235)", () =>
    expect(() => checkGeometry({ ...v7(), version: 6, geometry: undefined } as Anchors)).not.toThrow());
  test.each([
    ["v7 without geometry", (a: any) => { delete a.geometry; }],
    ["geometry on a v6", (a: any) => { a.version = 6; }],
    ["one entry", (a: any) => { a.geometry.length = 1; }],
    ["entry 0 display differs", (a: any) => { a.geometry[0].display = D1; }],
    ["entry 0 not full frame", (a: any) => { a.geometry[0].contentRect.y = 2; }],
    ["entry 0 startNs != firstFrameNs", (a: any) => { a.geometry[0].startNs = 0; }],
    ["startNs not increasing", (a: any) => { a.geometry[1].startNs = 16_000_000; }],
    ["rect outside capture", (a: any) => { a.geometry[1].contentRect.height = 2160; }],
    ["odd rect edge", (a: any) => { a.geometry[1].contentRect.y = 35; }],
  ])("%s throws", (_, mut) => expect(() => checkGeometry(bad(mut))).toThrow());
});
```

- [ ] **Step 2: Run** `npx vitest run transform/test/display-geometry.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `transform/src/display-geometry.ts`:**

```ts
/**
 * The refit geometry timeline (STC-235) — WHICH display geometry and WHERE in
 * the capture frame applied to a given frame. Selection and validation only;
 * every conversion that USES it lives in spaces.ts (STC-314).
 *
 * Selected by the PTS of the frame being SHOWN, never by `t`: between a
 * physical display change and the first refitted frame the picture is still
 * the old geometry (held, never interpolated — the frame-selection rule), so
 * the cursor drawn over it must be mapped the old way too.
 */
import type { Anchors } from "./types.js";
import { SessionLoadError } from "./session-error.js";

export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface GeometryEntry { startNs: number; display: Anchors["display"]; contentRect: CaptureRect }

export function fullFrame(capture: { width: number; height: number }): CaptureRect {
  return { x: 0, y: 0, width: capture.width, height: capture.height };
}

export function geometryAt(
  anchors: Anchors, frameNs: number | null,
): { display: Anchors["display"]; contentRect: CaptureRect } {
  const g = anchors.geometry;
  if (!g) return { display: anchors.display, contentRect: fullFrame(anchors.capture) };
  let pick = g[0]!;
  if (frameNs !== null) {
    for (const e of g) { if (e.startNs <= frameNs) pick = e; else break; }
  }
  return { display: pick.display, contentRect: pick.contentRect };
}

const sameDisplay = (a: Anchors["display"], b: Anchors["display"]) =>
  (Object.keys(a) as (keyof Anchors["display"])[]).every((k) => a[k] === b[k]) &&
  Object.keys(a).length === Object.keys(b).length;

export function checkGeometry(anchors: Anchors): void {
  const g = anchors.geometry;
  if (anchors.version === 7 && !g) throw new SessionLoadError("anchors v7 has no geometry — a take with no refit is written as v6 or lower");
  if (!g) return;
  if (anchors.version !== 7) throw new SessionLoadError(`geometry is new at anchors v7, found on v${anchors.version}`);
  if (g.length < 2) throw new SessionLoadError("geometry has fewer than 2 entries");
  const { width: W, height: H } = anchors.capture;
  const e0 = g[0]!;
  if (!sameDisplay(e0.display, anchors.display)) throw new SessionLoadError("geometry[0].display differs from the top-level display");
  const f = e0.contentRect;
  if (f.x !== 0 || f.y !== 0 || f.width !== W || f.height !== H) throw new SessionLoadError("geometry[0].contentRect is not the full capture frame");
  if (e0.startNs !== anchors.capture.firstFrameNs) throw new SessionLoadError("geometry[0].startNs is not capture.firstFrameNs");
  for (let i = 0; i < g.length; i++) {
    const r = g[i]!.contentRect;
    if (i > 0 && !(g[i]!.startNs > g[i - 1]!.startNs)) throw new SessionLoadError(`geometry[${i}].startNs does not increase`);
    const even = [r.x, r.y, r.width, r.height].every((v) => Number.isInteger(v) && v % 2 === 0);
    if (!even || r.width < 2 || r.height < 2) throw new SessionLoadError(`geometry[${i}].contentRect must have even, positive edges`);
    if (r.x < 0 || r.y < 0 || r.x + r.width > W || r.y + r.height > H) throw new SessionLoadError(`geometry[${i}].contentRect lies outside the capture`);
  }
}
```

If `SessionLoadError` is declared inside `session.ts`, import it from there instead (`import { SessionLoadError } from "./session.js"`) — do NOT create `session-error.ts` unless the import would be circular (`session.ts` will import this module). If it would be circular, move `SessionLoadError` into `transform/src/session-error.ts` and re-export it from `session.ts` so no existing import changes.

- [ ] **Step 4: Types** — in `transform/src/types.ts`, `Anchors`:

```ts
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  ...
  capture: { width: number; height: number; codec: "h264"; firstFrameNs?: number };
  /** STC-235. Present only after a refit; see display-geometry.ts. */
  geometry?: import("./display-geometry.js").GeometryEntry[];
```

Update the doc comment to "anchors-1 through anchors-7". Remove the `(anchors.capture as { firstFrameNs?: number })` cast in `session.ts` now that the field is typed.

- [ ] **Step 5: Loader** — `transform/src/session.ts`: extend the version check to accept 7 (message "expected 1..7"), add one comment paragraph ("v7's `geometry` (STC-235) is validated here and read by render() through display-geometry.ts's geometryAt"), and call `checkGeometry(anchors)` immediately after the version checks. Add to `transform/test/session.test.ts`: a v7 anchors with a malformed geometry (entry 0 not full frame) is refused by `loadSession` with `SessionLoadError` (reuse that file's existing fixture-mp4 loading helper for `displayMp4`).

- [ ] **Step 6: Run** `npx vitest run transform/test/display-geometry.test.ts transform/test/session.test.ts && npm run typecheck` — Expected: PASS.

- [ ] **Step 7: Commit** — `git add transform/src/display-geometry.ts transform/src/types.ts transform/src/session.ts transform/test/display-geometry.test.ts transform/test/session.test.ts` + message `STC-235: geometry timeline — types, loader refusals, geometryAt`.

---

### Task 3: cursor mapping through `contentRect` (render + spaces), TRANSFORM_VERSION 9

**Files:**
- Modify: `transform/src/spaces.ts:344-400`, `transform/src/render.ts:216-221`, `transform/src/transform-version.ts`
- Create: `fixtures/refit/{anchors.json,events.json,frames.json,project.json}`, `transform/test/golden/render-cursor-basic.json`, `transform/test/golden/render-cursor-real-session.json`
- Test: `transform/test/render-refit.test.ts` (new), `transform/test/spaces.test.ts`, `transform/test/transform-version.test.ts`

**Interfaces:**
- Consumes: `geometryAt`, `CaptureRect` (Task 2)
- Produces: `displayToOutput(display: DisplayGeometry, output: Size, contentRect?: CaptureRect, capture?: Size): DisplayToOutput` where `DisplayToOutput` gains `ox: number; oy: number`; `mapPoint` = `(p - origin) * s + o`; `mapVector` unchanged; `unmapPoint` = `(p - o) / s + origin`.

- [ ] **Step 1: Characterise today's output BEFORE touching render.** Create `transform/test/render-refit.test.ts` with a golden generator + check:

```ts
import { describe, test, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { render } from "../src/render.js";
import type { Project, Session } from "../src/types.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const session = (dir: string): Session => ({
  anchors: load(`${dir}/anchors.json`), events: load(`${dir}/events.json`).events,
  frames: load(`${dir}/frames.json`),
});

function cursorTrace(project: Project, s: Session): unknown[] {
  const end = s.frames.at(-1)!;
  const out = [];
  for (let i = 0; i < 200; i++) {
    const t = Math.floor((end * i) / 199);
    const f = render(project, s, t);
    out.push([t, f.cursor.x, f.cursor.y, f.cursor.vx, f.cursor.vy, f.cursor.pxPerPoint, f.zoom.crop]);
  }
  return out;
}

// Goldens are written ONCE, on master's code, before the refactor. After that
// this test only compares. Regenerating them to make a failure go away is the
// defect this test exists to catch.
describe("every take before STC-235 renders byte-identically", () => {
  test.each([["basic", "fixtures/basic"]])("%s", (name, dir) => {
    const golden = join(__dirname, "golden", `render-cursor-${name}.json`);
    const trace = cursorTrace(load(`${dir}/project.json`), session(dir));
    if (process.env.STC_WRITE_GOLDEN === "1" && !existsSync(golden)) {
      writeFileSync(golden, JSON.stringify(trace));
    }
    expect(JSON.stringify(trace)).toBe(readFileSync(golden, "utf8"));
  });
});
```

If `fixtures/real-session` has a `frames.json` and `project.json`, add it to `test.each`; if not, synthesise a project with `defaultProject(capture.width, capture.height)` (from `trim.ts`) and frames every 16_666_667 ns up to `anchors.stop.t`, and a zoom-enabled variant (`zoom.enabled: true`) so the crop path is covered too. Generate: `mkdir -p transform/test/golden && STC_WRITE_GOLDEN=1 npx vitest run transform/test/render-refit.test.ts`, then run again without the env var — Expected: PASS. Commit the goldens alone: `STC-235: pin today's render cursor trace before the refit refactor`.

- [ ] **Step 2: Write the failing refit tests** — create `fixtures/refit/` by copying `fixtures/basic/{events.json,frames.json,project.json}` and writing `anchors.json` as `fixtures/basic/anchors.json` with: `"version": 7`, `"capture"` unchanged (640×360, `firstFrameNs` = `frames.json[0]`), and

```json
"geometry": [
  { "startNs": <frames[0]>, "display": <top-level display>, "contentRect": { "x": 0, "y": 0, "width": 640, "height": 360 } },
  { "startNs": <a frames.json value near the middle>,
    "display": { "id": 1, "pointWidth": 480, "pointHeight": 360, "pixelWidth": 480, "pixelHeight": 360,
                 "backingScale": 1, "originX": 100, "originY": 0 },
    "contentRect": { "x": 80, "y": 0, "width": 480, "height": 360 } }
]
```

(a 4:3 display pillarboxed into a 16:9 capture, and an origin shift of 100 — both kinds of change at once). Append to `render-refit.test.ts`:

```ts
import { geometryAt } from "../src/display-geometry.js";

describe("a refitted take maps the cursor into contentRect", () => {
  const s = session("fixtures/refit");
  const project: Project = load("fixtures/refit/project.json");
  const refitNs = s.anchors.geometry![1]!.startNs;

  test("after the refit, the display's top-left global point lands on contentRect's top-left", () => {
    // The cursor is a SPRING (120 Hz, OMEGA 30), not the raw event position:
    // put the only move right after the refit and read it ~2 s later, when the
    // spring has long settled, at the last frame of the fixture.
    const e = { ...s, events: [{ t: refitNs + 1, kind: "move", x: 100, y: 0 }] as Session["events"] };
    const tRead = s.frames.at(-1)!;
    expect(tRead - refitNs).toBeGreaterThan(1_500_000_000);   // the fixture's midpoint refit leaves room
    const f = render(project, e, tRead);
    const sx = project.output.width / s.anchors.capture.width;
    expect(f.cursor.x).toBeCloseTo(80 * sx, 6);
    expect(f.cursor.y).toBeCloseTo(0, 6);
  });

  test("pxPerPoint follows the new scale", () => {
    const f = render(project, s, refitNs + 100_000_000);
    const expected = project.cursor.scale * (480 / 480) * (project.output.width / 640);
    expect(f.cursor.pxPerPoint).toBeCloseTo(expected, 9);
  });

  test("a t inside the seam uses the HELD frame's geometry, not the next one", () => {
    const iRefit = s.frames.indexOf(refitNs);
    const tSeam = refitNs - 1;                    // the frame shown is frames[iRefit-1]
    expect(geometryAt(s.anchors, s.frames[iRefit - 1]!).contentRect.x).toBe(0);
    const f = render(project, s, tSeam);
    expect(f.framePtsNs).toBe(s.frames[iRefit - 1]);
    const g0 = render(project, { ...s, anchors: { ...s.anchors, version: 6, geometry: undefined } }, tSeam);
    expect(f.cursor.x).toBe(g0.cursor.x);          // identical to the pre-refit mapping
  });
});
```

Adjust the synthetic `move` event's shape to the real `SessionEvent` `move` variant in `types.ts` if it differs. Run `npx vitest run transform/test/render-refit.test.ts` — Expected: the three refit tests FAIL (render ignores geometry), goldens PASS.

- [ ] **Step 3: Generalise `displayToOutput`** in `transform/src/spaces.ts` (keep the existing header prose; add the contentRect space to the file-top vocabulary table as "capture contentRect — capture pixels, the part of the frame the display's content occupies after a refit (STC-235)"):

```ts
export interface DisplayToOutput { originX: number; originY: number; sx: number; sy: number; ox: number; oy: number }

/**
 * global points -> display-local points -> capture contentRect -> output.
 *
 * `contentRect` defaults to the full capture (every take before STC-235 and
 * every take with no refit). The ratio `contentRect.width / capture.width` is
 * EXACTLY 1 in that case and `ox`/`oy` exactly 0, so the result is
 * bit-identical to the old `output.width / display.pointWidth` — which is why
 * the ratio is applied as a separate factor rather than folded into one
 * division (folding changes the last bit of `sx`, and the golden test sees it).
 */
export function displayToOutput(
  display: DisplayGeometry, output: Size, contentRect?: Rect, capture?: Size,
): DisplayToOutput {
  const cap = capture ?? output;
  const r = contentRect ?? { x: 0, y: 0, width: cap.width, height: cap.height };
  const kx = output.width / cap.width, ky = output.height / cap.height;
  return {
    originX: display.originX,
    originY: display.originY,
    sx: (output.width / display.pointWidth) * (r.width / cap.width),
    sy: (output.height / display.pointHeight) * (r.height / cap.height),
    ox: r.x * kx,
    oy: r.y * ky,
  };
}

export function mapPoint(m: DisplayToOutput, p: Point): Point {
  return { x: (p.x - m.originX) * m.sx + m.ox, y: (p.y - m.originY) * m.sy + m.oy };
}

export function unmapPoint(m: DisplayToOutput, p: Point): Point {
  return { x: (p.x - m.ox) / m.sx + m.originX, y: (p.y - m.oy) / m.sy + m.originY };
}
```

(`Rect` is spaces.ts's existing `{x,y,width,height}` type; `mapVector` does not change.) Add to `transform/test/spaces.test.ts`: `displayToOutput(d, out)` and `displayToOutput(d, out, {0,0,cap.w,cap.h}, cap)` produce `===`-equal `sx`/`sy` for d = 1728×1117, out = 1920×1080, cap = 3340×2160; and `unmapPoint(m, mapPoint(m, p))` round-trips `p` within 1e-9 for a pillarboxed rect.

- [ ] **Step 4: Wire render** — `transform/src/render.ts:216-221`:

```ts
  const tick = tickOf(tNs);
  const frameIndex = frameIndexAt(session.frames, tNs);
  const s = sim.stateAt(tick);

  // global points → display-local points → capture contentRect → output
  // pixels. spaces.ts owns the rule; this stays the only event-space
  // conversion in the transform. The geometry is the one the SHOWN frame was
  // captured under (STC-235) — display-geometry.ts's header says why.
  const g = geometryAt(session.anchors, frameIndex === null ? null : session.frames[frameIndex]!);
  const m = displayToOutput(g.display, project.output, g.contentRect, session.anchors.capture);
```

Import `geometryAt` from `./display-geometry.js`.

- [ ] **Step 5: Run** `npx vitest run transform/test/render-refit.test.ts transform/test/spaces.test.ts transform/test/render.test.ts transform/test/spaces-seam.test.ts` — Expected: PASS, goldens unchanged.

- [ ] **Step 6: TRANSFORM_VERSION 9** — `transform/src/transform-version.ts`: add a `## Version 9: the display can change under a take (STC-235)` header section (a v7 document's geometry timeline moves the cursor after a refit; no constant reaches the pixels, so the fingerprint is unchanged; every take with no refit renders exactly what version 8 did — pinned by `render-refit.test.ts`'s goldens), set `TRANSFORM_VERSION = 9`, append `{ version: 9, since: "2026-09-27", changed: "..." }` to `TRANSFORM_HISTORY`. Update whatever `transform-version.test.ts` pins about the version number (not the fingerprint).

- [ ] **Step 7: Full check** — `npm run typecheck && npm test` — Expected: green.

- [ ] **Step 8: Commit** — `STC-235: render maps the cursor through the shown frame's contentRect (TRANSFORM_VERSION 9)`.

---

### Task 4: auto-zoom stage 2 converts each cursor sample with its own geometry

**Files:**
- Modify: `transform/src/zoom-change.ts:108, 186-235`, `transform/src/render.ts:171`, `transform/src/spaces.ts` (one new conversion)
- Test: `transform/test/zoom-change.test.ts`

**Interfaces:**
- Consumes: `geometryAt`, `CaptureRect`
- Produces: `spaces.ts`: `globalToCaptureUv(p: Point, display: DisplayGeometry, contentRect: Rect, capture: Size): Point`; `deriveZoomCrop(window, changes, anchors: Anchors, frames: readonly number[]): Rect | null` (signature change — `display` → `anchors` + `frames`).

- [ ] **Step 1: Failing test** — in `transform/test/zoom-change.test.ts`, add:

```ts
test("a window spanning a refit crops around where the activity appeared in the PICTURE (STC-235)", () => {
  // Take the refit fixture's anchors/frames; a click before the refit at the
  // old display's centre and one after at the new display's centre.
  const anchors = load("fixtures/refit/anchors.json");
  const frames = load("fixtures/refit/frames.json");
  const refitNs = anchors.geometry[1].startNs;
  const window = zoomWindowFrom([
    { t: refitNs - 50_000_000, kind: "down", x: 320, y: 180, button: 0 },
    { t: refitNs + 50_000_000, kind: "down", x: 100 + 240, y: 180, button: 0 },
  ]);
  const crop = deriveZoomCrop(window, undefined, anchors, frames)!;
  // Both clicks are at the picture's centre in capture UV (0.5, 0.5):
  // before the refit 320/640; after, (80 + 240)/640. One cluster, centred.
  expect(crop.x + crop.width / 2).toBeCloseTo(0.5, 6);
  expect(crop.y + crop.height / 2).toBeCloseTo(0.5, 6);
});

test("a take with no geometry derives exactly what it did before", () => {
  // Re-run every existing deriveZoomCrop case in this file with (anchors of
  // fixtures/basic, its frames) in place of the bare display block — the
  // results must be === equal to the values those tests already assert.
});
```

Build `zoomWindowFrom` from the existing helpers this file already uses to construct a `ZoomWindow` (reuse them; do not invent a second constructor). For the second test, change every existing call site in the file from `deriveZoomCrop(w, c, display)` to `deriveZoomCrop(w, c, anchorsWith(display), framesCovering(w))`, where `anchorsWith` wraps the display in a minimal v6 `Anchors` (capture = display point size ×1) and `framesCovering` returns `[w.startNs]`; the expected values stay untouched. Run — Expected: FAIL (signature).

- [ ] **Step 2: Add the conversion to `spaces.ts`:**

```ts
/**
 * A global point in capture UV (0..1 over the capture frame), through the
 * refit contentRect (STC-235). With a full-frame rect this is exactly the old
 * display-local / pointSize — UV is scale-invariant over the display.
 */
export function globalToCaptureUv(p: Point, display: DisplayGeometry, contentRect: Rect, capture: Size): Point {
  const lx = (p.x - display.originX) / display.pointWidth;
  const ly = (p.y - display.originY) / display.pointHeight;
  return {
    x: (contentRect.x + lx * contentRect.width) / capture.width,
    y: (contentRect.y + ly * contentRect.height) / capture.height,
  };
}
```

Verify bit-identity for the full frame: `(0 + lx * W) / W` is NOT always `=== lx` in floating point. So guard it: `if (contentRect.x === 0 && contentRect.y === 0 && contentRect.width === capture.width && contentRect.height === capture.height) return { x: lx, y: ly };` — with a comment saying the fast path exists for bit-identity with pre-STC-235 derivations, not for speed.

- [ ] **Step 3: Rewrite `deriveFromCursor`/`deriveZoomCrop`** in `zoom-change.ts`: replace `DisplayGeom` param with `anchors: Anchors, frames: readonly number[]`; for each positioned event `e`, `const fi = frameIndexAt(frames, e.t); const g = geometryAt(anchors, fi === null ? null : frames[fi]!); const uv = globalToCaptureUv(e, g.display, g.contentRect, anchors.capture);`. Delete the now-unused `DisplayGeom` interface and the `toDisplayLocal`/`pixelsToUv` imports if nothing else uses them. Update the header comment on `deriveZoomCrop` (`display` → the anchors' geometry timeline, per sample).

- [ ] **Step 4: Call site** — `render.ts:171`: `deriveZoomCrop(window, session.changes, session.anchors, session.frames)`.

- [ ] **Step 5: Run** `npx vitest run transform/test/zoom-change.test.ts transform/test/zoom-change-render.test.ts transform/test/render-refit.test.ts transform/test/spaces-seam.test.ts && npm run typecheck` — Expected: PASS, goldens unchanged.

- [ ] **Step 6: Commit** — `STC-235: auto-zoom maps each cursor sample through its own geometry`.

---

### Task 5: legibility reports the worst geometry

**Files:**
- Modify: `transform/src/legibility.ts`, `app/src/editor.ts:1367`
- Test: `transform/test/legibility.test.ts`

**Interfaces:**
- Produces: `effectivePointWidth(anchors: Pick<Anchors, "display" | "capture" | "geometry">): number`

- [ ] **Step 1: Failing test** — `transform/test/legibility.test.ts`:

```ts
import { effectivePointWidth } from "../src/legibility.js";

test("no geometry: the display's own point width", () => {
  expect(effectivePointWidth({ display: { pointWidth: 1728 } as any, capture: { width: 3340, height: 2160 } as any }))
    .toBe(1728);
});
test("a refit that downscales into a narrower contentRect warns for its smallest text", () => {
  const a = {
    display: { pointWidth: 1728 } as any,
    capture: { width: 3340, height: 2160 } as any,
    geometry: [
      { startNs: 0, display: { pointWidth: 1728 } as any, contentRect: { x: 0, y: 0, width: 3340, height: 2160 } },
      { startNs: 1, display: { pointWidth: 2560 } as any, contentRect: { x: 0, y: 118, width: 3340, height: 1924 } },
    ],
  };
  // entry 1: 2560 points squeezed into the full width => 2560 effective.
  expect(effectivePointWidth(a)).toBe(2560);
});
test("a pillarboxed entry counts its reduced width", () => {
  const a = {
    display: { pointWidth: 1920 } as any, capture: { width: 3840, height: 2160 } as any,
    geometry: [
      { startNs: 0, display: { pointWidth: 1920 } as any, contentRect: { x: 0, y: 0, width: 3840, height: 2160 } },
      { startNs: 1, display: { pointWidth: 1440 } as any, contentRect: { x: 480, y: 0, width: 2880, height: 2160 } },
    ],
  };
  // 1440 * 3840 / 2880 = 1920 — equal to entry 0, so 1920.
  expect(effectivePointWidth(a)).toBe(1920);
});
```

- [ ] **Step 2: Run** — FAIL (not exported).

- [ ] **Step 3: Implement** in `legibility.ts`:

```ts
/**
 * The point width to judge a take by (STC-235). A refit can put more points
 * into the same capture width — or pillarbox the content into less of it —
 * and text is smallest in whichever geometry does that most. Larger effective
 * width = smaller text, so the WORST entry is the max. A take with no refit
 * returns `display.pointWidth` itself, untouched.
 */
export function effectivePointWidth(
  anchors: { display: { pointWidth: number }; capture: { width: number };
             geometry?: readonly { display: { pointWidth: number }; contentRect: { width: number } }[] },
): number {
  if (!anchors.geometry) return anchors.display.pointWidth;
  return Math.max(...anchors.geometry.map(
    (g) => g.display.pointWidth * anchors.capture.width / g.contentRect.width));
}
```

- [ ] **Step 4: Editor** — `app/src/editor.ts:1367`: `openDisplay = { pointWidth: effectivePointWidth(anchors) };` and add `effectivePointWidth` to the existing `@transform/legibility` import at line ~75.

- [ ] **Step 5: Run** `npx vitest run transform/test/legibility.test.ts && npm run typecheck` — PASS.

- [ ] **Step 6: Commit** — `STC-235: legibility judges a refitted take by its worst geometry`.

---

### Task 6: the app treats `display-refit` as news, not a stop

**Files:**
- Modify: `app/src/renderer.ts:646-652` (`ENDED_BY_HELPER`), `app/src/renderer.ts:830-846` (warning handler + comment), `app/src/supervisor.ts:224-226` (comment only)
- Test: `app/test/warnings.e2e.test.ts`

**Interfaces:**
- Consumes: helper warning codes `display-refit`, `display-refit-rect-mismatch` (Task 10); stop reason `region-out-of-bounds`.

- [ ] **Step 1: Failing e2e test** — in `app/test/warnings.e2e.test.ts`, beside "an idle display reconfiguration is not an alert":

```ts
test("a display refit mid-take is not an alert, and the take keeps recording (STC-235)", async () => {
  const win = await recordWithWarning("display-refit");
  await new Promise((r) => setTimeout(r, 1_000));
  expect(await toastPage(app!)).toBeUndefined();
  expect(await win.textContent("#state")).toBe("recording");
}, 120_000);
```

Also add a case driving the fake helper's unsolicited `stopped` with reason `region-out-of-bounds`, modelled on the existing `stream-stopped` test in this file (same env var it uses to inject an unsolicited stop), asserting the toast matches `/recorded area no longer fits on it, so the recording was stopped/`. Run `npx vitest run -c <the e2e vitest config this file runs under — see package.json "test:e2e" or equivalent> app/test/warnings.e2e.test.ts` — Expected: the refit test FAILS if the renderer alerts on unknown codes (check `CAMERA_FAULTS`/fallback branch); the region test FAILS (copy missing).

- [ ] **Step 2: Renderer** — `ENDED_BY_HELPER` gains:

```ts
  // STC-235: a region take whose region no longer fits the changed display.
  // Clamping would silently record a different area, so the helper stops.
  "region-out-of-bounds": "The display changed and the recorded area no longer fits on it, so the recording was stopped.",
```

and the warning set becomes:

```ts
/**
 * Emitted by the helper's watchers whenever ANY display changes, recording or
 * not — alone it is not worth an alert. A take the display change ENDS says so
 * through `helper:recording-ended`; one it survives (STC-235) sends
 * `display-refit`, which is news, not a problem: the recording continues.
 */
const INFORMATIONAL_WARNINGS = new Set(["display-reconfigured", "display-refit", "display-refit-rect-mismatch"]);
```

with `refreshDisplays()` called for both `display-reconfigured` and `display-refit`. Delete the `display-change-during-recording` branch (the helper stops sending it in Task 10; a stop still reaches the user through `ENDED_BY_HELPER`). Leave a one-line comment where it was naming STC-235.

- [ ] **Step 3: Supervisor comment** — `supervisor.ts:224-226`: "A stop nobody asked for: the helper decided — the captured display went away, a region no longer fits it, or the stream died. A display change it SURVIVES is a `display-refit` warning, not a stop (STC-235)."

- [ ] **Step 4: Run** the e2e file and `npm run typecheck` — PASS.

- [ ] **Step 5: Commit** — `STC-235: the app shows a survived display change as news, and region-out-of-bounds in words`.

- [ ] **Step 6: Open PR 1** — `git push -u origin HEAD`, `gh pr create --base master --title "STC-235 PR 1: anchors-7 geometry timeline — schema, transform, app"`, body lists the deviations section of this plan and "nothing emits v7 yet; PR 2 is the helper". Merge with `npm run merge -- <pr>` once green.

---

# PR 2 — helper (branch off master after PR 1 merges: `accounts/stc-235-helper`)

### Task 7: `fitRect`

**Files:**
- Modify: `helper/src/CaptureGeometry.swift`
- Test: `helper/test/geometry/main.swift`

**Interfaces:**
- Produces: `struct FitRect: Equatable { let x: Int, y: Int, width: Int, height: Int }`; `func fitRect(sourceWidth: Int, sourceHeight: Int, intoWidth: Int, intoHeight: Int) -> FitRect`

- [ ] **Step 1: Failing assertions** — append to `helper/test/geometry/main.swift` before its final ALL PASS check:

```swift
func checkFit(_ label: String, _ got: FitRect, _ want: FitRect) {
    if got == want { print("ok   \(label)") }
    else { print("FAIL \(label): got \(got), want \(want)"); failures += 1 }
}
checkFit("same aspect is the full frame",
         fitRect(sourceWidth: 2880, sourceHeight: 1800, intoWidth: 3456, intoHeight: 2160),
         FitRect(x: 0, y: 0, width: 3456, height: 2160))
checkFit("4:3 into 16:9 pillarboxes, centred",
         fitRect(sourceWidth: 1600, sourceHeight: 1200, intoWidth: 3840, intoHeight: 2160),
         FitRect(x: 480, y: 0, width: 2880, height: 2160))
checkFit("21:9 into 16:9 letterboxes, centred",
         fitRect(sourceWidth: 3440, sourceHeight: 1440, intoWidth: 3840, intoHeight: 2160),
         FitRect(x: 0, y: 276, width: 3840, height: 1608))
for (sw, sh, iw, ih) in [(1919, 1081, 3840, 2160), (1000, 3000, 3840, 2160), (7, 5, 640, 360), (3456, 2234, 3340, 2160)] {
    let r = fitRect(sourceWidth: sw, sourceHeight: sh, intoWidth: iw, intoHeight: ih)
    if [r.x, r.y, r.width, r.height].contains(where: { $0 % 2 != 0 }) { print("FAIL \(sw)x\(sh): odd edge \(r)"); failures += 1 }
    if r.x < 0 || r.y < 0 || r.x + r.width > iw || r.y + r.height > ih { print("FAIL \(sw)x\(sh): outside \(r)"); failures += 1 }
    if abs((iw - r.width) - 2 * r.x) > 2 || abs((ih - r.height) - 2 * r.y) > 2 { print("FAIL \(sw)x\(sh): not centred \(r)"); failures += 1 }
    if r.width != iw && r.height != ih { print("FAIL \(sw)x\(sh): touches neither axis \(r)"); failures += 1 }
}
```

(Verify the letterbox numbers: 3840 × 1440/3440 = 1607.4 → even 1608; y = (2160−1608)/2 = 276.)

- [ ] **Step 2: Run** `npx vitest run helper/test/geometry.test.ts` — FAIL (no `fitRect`).

- [ ] **Step 3: Implement** in `CaptureGeometry.swift`:

```swift
/// Where a refitted source lands inside the take's FIXED capture frame
/// (STC-235). SPACE: source pixels → capture pixels; the transform's name for
/// the result is `contentRect` (`transform/src/spaces.ts`).
///
/// The capture size never changes mid-take — AVAssetWriter cannot — so a
/// display whose aspect changed is fitted, letterboxed or pillarboxed, never
/// stretched. Every edge is even (H.264 4:2:0), the rect is centred, and a
/// same-aspect source is exactly the full frame so an ordinary resolution
/// change records no letterbox at all.
struct FitRect: Equatable { let x: Int, y: Int, width: Int, height: Int }

func fitRect(sourceWidth: Int, sourceHeight: Int, intoWidth: Int, intoHeight: Int) -> FitRect {
    guard sourceWidth > 0, sourceHeight > 0 else { return FitRect(x: 0, y: 0, width: intoWidth, height: intoHeight) }
    func even(_ v: Double) -> Int { max(2, Int(v.rounded()) / 2 * 2) }
    let sa = Double(sourceWidth) / Double(sourceHeight), ia = Double(intoWidth) / Double(intoHeight)
    if abs(sa - ia) < 1e-3 { return FitRect(x: 0, y: 0, width: intoWidth, height: intoHeight) }
    if sa > ia {
        let h = min(intoHeight, even(Double(intoWidth) / sa))
        return FitRect(x: 0, y: (intoHeight - h) / 4 * 2, width: intoWidth, height: h)
    } else {
        let w = min(intoWidth, even(Double(intoHeight) * sa))
        return FitRect(x: (intoWidth - w) / 4 * 2, y: 0, width: w, height: intoHeight)
    }
}
```

(`(n)/4*2` = half of `n`, floored to even; `n` is even since both operands are even.) The `1e-3` aspect tolerance absorbs the capture cap's even-rounding (e.g. 3456×2234 display vs its own 3340×2160 capture): document that in a comment.

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `STC-235: fitRect — a refitted source's place in the fixed capture frame`.

---

### Task 8: classify and debounce display changes

**Files:**
- Create: `helper/src/DisplayChangeDecisions.swift`, `helper/test/display-change/main.swift`, `helper/test/display-change.test.ts`

**Interfaces:**
- Produces:
  - `let DISPLAY_CHANGE_SETTLE_MS: Int = 250`, `let REFIT_FRAME_TIMEOUT_MS: Int = 3000`
  - `enum DisplayChangeDecision: Equatable { case refit; case stop(String) }`
  - `func decideDisplayChange(capturedDisplayPresent: Bool, region: StillRect?, newPointWidth: Int, newPointHeight: Int) -> DisplayChangeDecision`
  - `struct SettleDebounce { private(set) var deadlineMs: Int?; mutating func poke(nowMs: Int); func due(nowMs: Int) -> Bool; mutating func fire() }` — the pure reducer the capture queue drives.

- [ ] **Step 1: Failing harness** — `helper/test/display-change/main.swift`:

```swift
import Foundation
var failures = 0
func expect(_ label: String, _ ok: Bool) { print(ok ? "ok   \(label)" : "FAIL \(label)"); if !ok { failures += 1 } }

let r = StillRect(x: 100, y: 100, width: 800, height: 600)
expect("captured display gone stops", decideDisplayChange(capturedDisplayPresent: false, region: nil, newPointWidth: 1440, newPointHeight: 900) == .stop("display-reconfigured"))
expect("display scope refits", decideDisplayChange(capturedDisplayPresent: true, region: nil, newPointWidth: 1440, newPointHeight: 900) == .refit)
expect("region exactly touching the new edge refits", decideDisplayChange(capturedDisplayPresent: true, region: r, newPointWidth: 900, newPointHeight: 700) == .refit)
expect("region one point over stops", decideDisplayChange(capturedDisplayPresent: true, region: r, newPointWidth: 899, newPointHeight: 700) == .stop("region-out-of-bounds"))
expect("display gone beats region", decideDisplayChange(capturedDisplayPresent: false, region: r, newPointWidth: 0, newPointHeight: 0) == .stop("display-reconfigured"))

var d = SettleDebounce()
expect("idle debounce is never due", !d.due(nowMs: 10_000))
d.poke(nowMs: 0); d.poke(nowMs: 100); d.poke(nowMs: 200)       // a CG burst
expect("not due inside the settle window after the LAST poke", !d.due(nowMs: 449))
expect("due once settled", d.due(nowMs: 450))
d.fire()
expect("one burst fires exactly once", !d.due(nowMs: 10_000))

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
```

`helper/test/display-change.test.ts` mirrors `geometry.test.ts` with sources `["helper/src/StillDecisions.swift", "helper/src/DisplayChangeDecisions.swift", "helper/test/display-change/main.swift"]` and label `"display-change"`.

- [ ] **Step 2: Run** `npx vitest run helper/test/display-change.test.ts` — FAIL (compile).

- [ ] **Step 3: Implement** `helper/src/DisplayChangeDecisions.swift`:

```swift
import Foundation

/// STC-235: what a take does when the display changes under it. Pure — no
/// ScreenCaptureKit, no clock — so every row of the spec's outcome table is
/// tested without a display (helper/test/display-change/).
///
/// CG calls back once per affected display, often several times for one
/// physical change; the decision runs ONCE, after `DISPLAY_CHANGE_SETTLE_MS`
/// of quiet.
let DISPLAY_CHANGE_SETTLE_MS = 250
/// A refit that never produces a frame is a take whose geometry is unknown.
let REFIT_FRAME_TIMEOUT_MS = 3000

enum DisplayChangeDecision: Equatable { case refit; case stop(String) }

/// `region` is the take's region in display-local points (nil for display and
/// window scopes). It must lie ENTIRELY inside the display's new point bounds:
/// clamping it would silently record a different area than the one picked.
func decideDisplayChange(capturedDisplayPresent: Bool, region: StillRect?,
                         newPointWidth: Int, newPointHeight: Int) -> DisplayChangeDecision {
    guard capturedDisplayPresent else { return .stop("display-reconfigured") }
    if let r = region {
        let fits = r.x >= 0 && r.y >= 0 &&
            r.x + r.width <= Double(newPointWidth) && r.y + r.height <= Double(newPointHeight)
        if !fits { return .stop("region-out-of-bounds") }
    }
    return .refit
}

/// The debounce as a value, so "a burst collapses to one decision" is a test
/// rather than a hope about timer scheduling.
struct SettleDebounce {
    private(set) var deadlineMs: Int?
    mutating func poke(nowMs: Int) { deadlineMs = nowMs + DISPLAY_CHANGE_SETTLE_MS }
    func due(nowMs: Int) -> Bool { deadlineMs.map { nowMs >= $0 } ?? false }
    mutating func fire() { deadlineMs = nil }
}
```

(Check `StillRect`'s field types — if they are not `Double`, adapt the comparisons, not the test.)

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `STC-235: classify and debounce a display change — stop or refit`.

---

### Task 9: anchors v7 emission

**Files:**
- Modify: `helper/src/AnchorsDoc.swift` (`anchorsDocument`), `helper/test/anchors/main.swift`, `helper/test/anchors.test.ts`

**Interfaces:**
- Consumes: `FitRect` (Task 7)
- Produces: `struct GeometryEntryDoc { let startNs: Int; let display: DisplayGeometry; let contentRect: FitRect }`; `anchorsDocument(..., geometry: [GeometryEntryDoc] = [], ...)` — emits `geometry` and forces version 7 iff `geometry.count >= 2`.

- [ ] **Step 1: Failing assertions** — in `helper/test/anchors/main.swift` add two documents printed on marker lines the TS test extracts (follow the file's existing `print("ANCHORS_…=" + json)` convention):
  - `ANCHORS_REFIT=`: display scope, `geometry` of 2 entries (entry 0 = the top-level display, full-frame `FitRect(0,0,captureW,captureH)`, `startNs` = `firstFrameNs`; entry 1 a different display, `FitRect(x: 480, y: 0, width: 2880, height: 2160)` in a 3840×2160 capture). Assert in Swift: `doc["version"] == 7`.
  - `ANCHORS_ONE_ENTRY=`: `geometry` with ONE entry. Assert: version is what it would be without geometry (2) and no `geometry` key.
  In `anchors.test.ts`: validate `ANCHORS_REFIT` against `schema/anchors-7.schema.json` and `ANCHORS_ONE_ENTRY` against `anchors-2`.

- [ ] **Step 2: Run** `npx vitest run helper/test/anchors.test.ts` — FAIL.

- [ ] **Step 3: Implement** — add the `GeometryEntryDoc` struct beside `CaptureGeometryDoc`, a `geometry: [GeometryEntryDoc] = []` parameter after `pauses:`, then:

```swift
    if geometry.count >= 2 { version = max(version, 7) }
    ...
    if geometry.count >= 2 {
        // STC-235: the refit timeline. Written only once there IS a refit, so
        // every take the display never changed under stays v2–v6 byte for byte.
        doc["geometry"] = geometry.map { g in [
            "startNs": g.startNs,
            "display": displayJSON(g.display),
            "contentRect": ["x": g.contentRect.x, "y": g.contentRect.y,
                            "width": g.contentRect.width, "height": g.contentRect.height],
        ] as [String: Any] }
    }
```

Extract the existing inline top-level `"display": [...]` dictionary into `private func displayJSON(_ d: DisplayGeometry) -> [String: Any]` and use it in both places, so the two can never disagree (the loader deep-compares entry 0 to the top level). Update the function's doc comment with a `geometry` paragraph in the same style as the `pauses` one.

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `STC-235: anchorsDocument writes the geometry timeline as v7`.

---

### Task 10: the refit path in the live helper

**Files:**
- Modify: `helper/src/main.swift:51-61`, `helper/src/Capture.swift` (fields ~95-151, `start` ~243, `begin` ~394-399, `startStream` 793-819, frame path 823-870, faults ~541, `writeSidecars` 1403-1442), `helper/src/Watchers.swift` (no behaviour change; comment only), `helper/src/CaptureDecisions.swift:471-480` (comment)
- Test: `helper/test/stop-reasons.test.ts`

**Interfaces:**
- Consumes: `fitRect`, `decideDisplayChange`, `SettleDebounce`, `DISPLAY_CHANGE_SETTLE_MS`, `REFIT_FRAME_TIMEOUT_MS`, `GeometryEntryDoc`
- Produces: `CaptureSession.displayChanged()` (called by App on every CG callback while recording); `CaptureSession.onRefitFailed: ((String) -> Void)?` (App stops the take with the given reason); warnings `display-refit {startNs, display, contentRect, path}` and `display-refit-rect-mismatch {computed, reported, scaleFactor}`; `STC_CAPTURE_FAULT=display-refit` / `=display-gone`.

- [ ] **Step 1: Failing test** — `helper/test/stop-reasons.test.ts`: switch the compiled schema from `anchors-3` to `anchors-7` (update the explanatory comment: anchors-7's enum is anchors-3's plus `region-out-of-bounds`), and extend the `arrayContaining` list with `"display-reconfigured", "region-out-of-bounds"`. Also extend the regex scrape (`reasonsInSwift`) if needed so it picks up reasons passed as `.stop("…")` in `DisplayChangeDecisions.swift` — add that file to `SOURCES`. Run — FAIL (`region-out-of-bounds` not yet reachable from the scraped sources until Task 8's file is included; if it already passes after adding the file, that is correct — note it and move on).

- [ ] **Step 2: Session state** — in `CaptureSession`:

```swift
    /// STC-235: the request this take started from, kept so a refit can
    /// re-resolve the SAME display / window / region against fresh content.
    private var startRequest: StartRequest?
    /// Every geometry this take was captured under, entry 0 appended in
    /// begin(). Guarded by `lock`.
    private var geometry: [GeometryEntryDoc] = []
    /// Set by a refit; the next ACCEPTED (not paused) frame's PTS becomes the
    /// entry's startNs. Guarded by `lock`.
    private var pendingGeometry: (display: DisplayGeometry, rect: FitRect, path: String)?
    private var debounce = SettleDebounce()
    private var refitInFlight = false
    var onRefitFailed: ((String) -> Void)?
    private let refitQueue = DispatchQueue(label: "stc.capture.refit")
```

Set `startRequest = request` at the top of `start(request:completion:)`. In the frame path, where `firstFramePtsNs` is set (`if firstFramePtsNs < 0 { firstFramePtsNs = pts }`), add — still under `lock`:

```swift
                if geometry.isEmpty {
                    geometry.append(GeometryEntryDoc(startNs: Int(pts),
                        display: currentDisplayGeometry(),
                        contentRect: FitRect(x: 0, y: 0, width: captureW, height: captureH)))
                }
                if let p = pendingGeometry {
                    pendingGeometry = nil
                    geometry.append(GeometryEntryDoc(startNs: Int(pts), display: p.display, contentRect: p.rect))
                    refitLanded(ptsNs: pts, pending: p, attachments: att)   // sends the warning; no lock inside
                }
```

(`currentDisplayGeometry()` builds `DisplayGeometry` from the scalar fields exactly as `writeSidecars` does today — extract it and use it in both places. The paused-frame early return sits ABOVE this block, so a paused frame never becomes a refit's first frame — Review Focus 5. `refitLanded` must be called after `lock.unlock()`; restructure with a local `var landed: (...)?` captured under the lock and acted on after.)

- [ ] **Step 3: Debounce + decide** —

```swift
    /// Called by App for every CG reconfiguration callback while recording.
    func displayChanged() {
        refitQueue.async { [weak self] in
            guard let self else { return }
            let now = Int(Clock.nowNs() / 1_000_000)
            self.debounce.poke(nowMs: now)
            self.refitQueue.asyncAfter(deadline: .now() + .milliseconds(DISPLAY_CHANGE_SETTLE_MS)) { [weak self] in
                guard let self else { return }
                let now = Int(Clock.nowNs() / 1_000_000)
                guard self.debounce.due(nowMs: now), !self.refitInFlight else { return }
                self.debounce.fire()
                self.refitInFlight = true
                self.refit()
            }
        }
    }
```

A callback that arrives while `refitInFlight` re-pokes; `finishRefit()` (below) re-checks `debounce.due` after clearing `refitInFlight` and runs another refit if one is due — never two in flight (spec).

- [ ] **Step 4: Refit** —

```swift
    private func refit() {
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, _ in
            guard let self else { return }
            self.refitQueue.async {
                guard let content, let req = self.startRequest else { return self.failRefit("display-reconfigured") }
                let present = content.displays.contains { $0.displayID == self.displayID }
                // Same display, never "Automatic" again: a refit must not hop displays.
                let pinned = StartRequest(copying: req, displayId: self.displayID)
                let newDisplay = content.displays.first { $0.displayID == self.displayID }
                let decision = decideDisplayChange(capturedDisplayPresent: present || req.windowId != nil,
                                                   region: self.captureScope.region,
                                                   newPointWidth: newDisplay?.width ?? 0,
                                                   newPointHeight: newDisplay?.height ?? 0)
                if case .stop(let reason) = decision { return self.failRefit(reason) }
                switch self.resolveCaptureTarget(pinned, content: content) {
                case .failure(.windowNotFound): return self.failRefit("window-closed")
                case .failure: return self.failRefit("display-reconfigured")
                case .success(let target): self.apply(target)
                }
            }
        }
    }
```

`StartRequest(copying:displayId:)` — add a small initializer in `CaptureDecisions.swift` that copies every field and overrides `displayId` (tested implicitly by the grant test; keep it a plain memberwise copy). For a region take the region is re-resolved from the ORIGINAL request, which `decideDisplayChange` has already proven fits, so `resolveCrop` cannot clamp it.

```swift
    private func apply(_ target: CaptureTarget) {
        var src = captureSize(target.pixelSize.width, target.pixelSize.height)
        if ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"] == "display-refit" {
            src = (captureW * 3 / 4 / 2 * 2, captureH)            // forced pillarbox, see the fault's doc
        }
        let rect = fitRect(sourceWidth: src.w, sourceHeight: src.h, intoWidth: captureW, intoHeight: captureH)
        let cfg = streamConfiguration(sourceRect: target.sourceRect, destination: rect)
        guard let s = stream else { return failRefit("display-reconfigured") }
        s.updateContentFilter(target.filter) { [weak self] err in
            guard let self else { return }
            if err != nil { return self.restartStream(target, cfg, rect) }
            s.updateConfiguration(cfg) { err in
                if err != nil { return self.restartStream(target, cfg, rect) }
                self.armRefitLanding(target.geometry, rect, path: "update")
            }
        }
    }
```

Refactor `startStream` so its `SCStreamConfiguration` construction is `private func streamConfiguration(sourceRect: CGRect?, destination: FitRect?) -> SCStreamConfiguration` (same `captureW/H`, fps, queue depth, pixel format, `showsCursor = false`, `captureResolution`), and when `destination` is non-nil: `cfg.scalesToFit = true; cfg.preservesAspectRatio = false; cfg.destinationRect = CGRect(x: d.x, y: d.y, width: d.width, height: d.height)`. `startStream` calls it with `destination: nil` — the initial stream is byte-for-byte the config it is today.

`restartStream(target, cfg, rect)`: `stream?.stopCapture { _ in … }` then create a new `SCStream(filter: target.filter, configuration: cfg, delegate: self)`, `addStreamOutput(self, type: .screen, sampleHandlerQueue:)` on the SAME queue label, assign `stream`, `startCapture`; on error `failRefit("display-reconfigured")`; on success `armRefitLanding(target.geometry, rect, path: "restart")`. The writer and gate are not touched. Because `stopCapture` of the old stream may deliver `didStopWithError`, set a `private var restarting = false` flag (under `lock`) that `stream(_:didStopWithError:)` checks before calling `onStreamDied`.

```swift
    private func armRefitLanding(_ g: DisplayGeometry, _ rect: FitRect, path: String) {
        lock.lock()
        pendingGeometry = (g, rect, path)
        displayID = CGDirectDisplayID(g.id); pointW = g.pointWidth; pointH = g.pointHeight
        pixelW = g.pixelWidth; pixelH = g.pixelHeight; originX = g.originX; originY = g.originY
        lock.unlock()
        refitQueue.asyncAfter(deadline: .now() + .milliseconds(REFIT_FRAME_TIMEOUT_MS)) { [weak self] in
            guard let self else { return }
            self.lock.lock(); let stillPending = self.pendingGeometry != nil; self.lock.unlock()
            if stillPending { self.failRefit("display-reconfigured") }
        }
    }
```

Note the scalar fields now mean "the CURRENT geometry"; `writeSidecars` must pass the top-level `display` from `geometry.first?.display ?? currentDisplayGeometry()` (the START display — spec), and `geometry: geometry` to `anchorsDocument`.

`refitLanded(ptsNs:pending:attachments:)`: sends

```swift
IO.send("warning", ["code": "display-refit", "startNs": Int(ptsNs), "path": pending.path,
                    "display": ["id": pending.display.id, "pointWidth": pending.display.pointWidth,
                                "pointHeight": pending.display.pointHeight],
                    "contentRect": ["x": pending.rect.x, "y": pending.rect.y,
                                    "width": pending.rect.width, "height": pending.rect.height]])
```

then reads `attachments[.contentRect]` (`CGRect(dictionaryRepresentation:)`) and `attachments[.scaleFactor]`; if NEITHER the raw rect nor the rect × scaleFactor is within 1 px of `pending.rect` on every edge, sends `warning display-refit-rect-mismatch {computed, reported, scaleFactor}`. Then `refitQueue.async { self.finishRefit() }`.

`failRefit(reason)`: `refitInFlight = false`, `pendingGeometry = nil`, `onRefitFailed?(reason)`. `finishRefit()`: `refitInFlight = false`; if `debounce.due(now)` run another refit.

- [ ] **Step 5: Faults** — beside `armWindowFault`:

```swift
    /// `STC_CAPTURE_FAULT=display-refit` / `=display-gone` (STC-235): 0.5 s in,
    /// the display-change path runs as though CG had called back — the refit
    /// against the SAME display, with `apply` forcing a 3:4-width pillarbox so
    /// the grant test sees a real second geometry and real bars without anyone
    /// changing a display mode. `display-gone` skips straight to the
    /// classifier's stop arm. Driven by helper/test/display-refit.grant.test.ts.
    private func armDisplayFault() {
        guard let fault = ProcessInfo.processInfo.environment["STC_CAPTURE_FAULT"],
              fault == "display-refit" || fault == "display-gone" else { return }
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.windowFaultDelaySeconds) { [weak self] in
            if fault == "display-gone" { self?.failRefit("display-reconfigured") } else { self?.displayChanged() }
        }
    }
```

Call it wherever `armWindowFault()` is called.

- [ ] **Step 6: App wiring** — `main.swift` `boot()`:

```swift
        Watchers.shared.onDisplayChange = { [weak self] _, _ in
            guard let self = self, self.state == .recording, let session = self.capture else { return }
            // STC-235: the take survives any display change it can — the
            // session debounces, classifies, and either refits the stream into
            // the same display.mp4 or asks to be stopped (onRefitFailed).
            session.displayChanged()
        }
```

and per session, beside `onWindowChanged`:

```swift
        session.onRefitFailed = { [weak self, weak session] reason in
            DispatchQueue.main.async {
                guard let self, let session,
                      self.state == .recording, self.capture === session else { return }
                self.stop(reason: reason)
            }
        }
```

The `display-change-during-recording` warning is no longer sent. Fix the comments at `CaptureDecisions.swift:471-480` (window resize still stops; a DISPLAY change no longer does — STC-235) and in `Watchers.swift` near `onDisplayChange`.

- [ ] **Step 7: Build and run the non-grant suite** — `helper/build.sh && npx vitest run helper/test` (non-grant files) — Expected: PASS, including `stop-reasons.test.ts`, `ipc.test.ts`, `capture.test.ts`.

- [ ] **Step 8: Commit** — `STC-235: refit the display stream into the same file instead of stopping`.

---

### Task 11: grant test, frame probe, runbook, docs

**Files:**
- Create: `helper/test/display-refit.grant.test.ts`, `helper/test/frame-probe/main.swift`, `docs/STC-235-RUNBOOK.md`
- Modify: `PHASE-1.md:58`, `docs/CORRECTNESS-TRAPS.md:87`, `CLAUDE.md` (table rows + Toolchain paragraph + "Phase 1 scope" hot-swap sentence), `docs/TICKET-LOG.md` (new STC-235 row)

- [ ] **Step 1: Frame probe** — `helper/test/frame-probe/main.swift`, compiled by `runSwiftHarness` with no production sources: arguments `<mp4> <tSeconds> <x> <y> <w> <h>`; uses `AVAssetImageGenerator` (`requestedTimeToleranceBefore/After = .zero`) to grab the frame, draws it into a `CGContext` (RGBA8), and prints `LUMA_OUTSIDE=<mean luma of pixels outside the rect>` and `LUMA_INSIDE=<mean inside>`. Follow how the existing harness passes argv (check `_swift-harness.ts` for an `args` option; if it has none, add one — a pass-through to the compiled binary's argv).

- [ ] **Step 2: Grant test** — `helper/test/display-refit.grant.test.ts`, modelled on `region-window-scope.grant.test.ts` (same spawn helper, same `STC_CAPTURE_FAULT` env usage, same stop request):
  - **refit:** `STC_CAPTURE_FAULT=display-refit`, record 3 s, stop. Assert: the take ends by OUR stop (`stop.reason === "user"`); exactly one `display.mp4`; `anchors.version === 7`; `geometry.length === 2`; `geometry[1].contentRect.width < capture.width`; `geometry[1].startNs` is an element of the demuxed frame PTS list (use `transform/src/demux.ts`'s `demuxTrack`, as `capture.grant.test.ts` does); a `display-refit` warning arrived on stdout/fd3; `loadSession` accepts the take; frame probe at `(geometry[1].startNs + 0.5 s)` reports `LUMA_OUTSIDE < 8` and `LUMA_INSIDE` > `LUMA_OUTSIDE`.
  - **refit while paused (Review Focus 5):** start, `pause`, fault fires at 0.5 s, `resume` at 1.5 s, stop at 3 s. Assert `geometry[1].startNs >= ` the pause interval's `endNs`.
  - **display-gone:** `STC_CAPTURE_FAULT=display-gone`; the helper sends an unsolicited `stopped` with `reason: "display-reconfigured"`, and anchors has no `geometry`.
  - **control:** same 3 s take, no fault — `version <= 6`, no `geometry` key. The comment says this is what proves the fault made the difference.

Run: `npm run test:capture -- helper/test/display-refit.grant.test.ts` on a Mac with the grant — Expected: PASS. (Not run in CI; say so in the PR.)

- [ ] **Step 3: Runbook** — `docs/STC-235-RUNBOOK.md`, in the house style of `docs/STC-370-RUNBOOK.md`: §0 build and the grant; §1–§8 exactly the spec's "Runbook" list, each with the command/action, what to look at (`anchors.json` `geometry`, the `display-refit` warning's `path`, the seam = `geometry[1].startNs` minus the previous frame PTS from `node scripts/export-one.mjs`'s probe output or `demuxTrack`), and what result sends it back. §3 is the acceptance: record, change System Settings › Displays scaling mid-take, stop, `node scripts/export-one.mjs <take> 20`, WATCH it.

- [ ] **Step 4: Docs** — `PHASE-1.md:58` and `docs/CORRECTNESS-TRAPS.md:87`: replace "display hot-swap is a stop" with "a display change refits the stream into the same file at the take's fixed size (STC-235); only a lost display or an out-of-bounds region stops". `CLAUDE.md`: add table rows for `helper/src/DisplayChangeDecisions.swift`, `transform/src/display-geometry.ts`, `schema/anchors-7.schema.json`, `docs/STC-235-RUNBOOK.md`; fix the "Phase 1 scope" `AVAssetWriter` sentence; fix the Toolchain paragraph (Swift 6.4 / SDK 27, `build.sh` targets macOS 26 — `preservesAspectRatio`/`destinationRect` no longer need KVC; re-check `captureResolution`'s KVC note against `Capture.swift:813`, which already sets it directly). `docs/TICKET-LOG.md`: append the STC-235 row (what shipped, deviations, what only the runbook can settle).

- [ ] **Step 5: Full verification** — `npm run typecheck && npm test && helper/build.sh` — green. Grant test run and pasted into the PR.

- [ ] **Step 6: Commit and PR 2** — commit `STC-235: grant test, runbook, docs`; `git push -u origin HEAD`; `gh pr create --base master --title "STC-235 PR 2: helper refits the display stream instead of stopping"`; body names the runbook AND the branch to run it from (CLAUDE.md "Hand off a runbook WITH its branch"). Merge with `npm run merge -- <pr>` only after CI is green; the runbook §3 watch is the acceptance and is Patrick's.
