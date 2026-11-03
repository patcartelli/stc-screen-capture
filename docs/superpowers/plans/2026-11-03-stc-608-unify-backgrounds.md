# STC-608 One Set of Looks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The video editor's Frame tab offers None, Clean, Dark, Solid, Aurora, Ember and Custom. They appear in the still editor's swatch grid, every look's colours are defined once, and a recording stores the colours it draws.

**Architecture:** A new import-free leaf module `transform/src/looks.ts` owns every look's fill. `framing.ts` (video) and `backgrounds.ts` (stills) both derive from it. Video's `FramingBackground` linear fill grows to 2–8 stops behind a new project version. One `gradientLine` (in `framing.ts`) serves both renderers. The video look rules are pure functions in `app/src/framing-edit.ts`. The swatch grid's DOM and CSS move into a shared `app/src/look-grid.ts` + `app/renderer/look-grid.css`, which both editors use.

**Tech Stack:** TypeScript, Vitest, Playwright-Electron e2e (CI only), Ajv for the schema.

**Spec:** `docs/superpowers/specs/2026-11-03-stc-608-unify-backgrounds-design.md`

## Global Constraints

- **Work in this worktree,** on branch `accounts/stc-608-unify-backgrounds`.
- **Never run e2e locally.** Run unit tests with `npx vitest run --project unit <file>`. e2e goes to CI through a draft PR.
- **`npm run typecheck` (all three passes) must be green after every task.** `framing.ts` and `looks.ts` are imported by the main process. They may import only `./spaces.js` (type-only) and each other: no DOM, no `shot.ts`, no `still-decorate.ts`.
- **No existing document's output changes:** `shot-v1-frozen`, `npm run gate:still` and `npm run gate:identity` stay green, and `TRANSFORM_VERSION` is NOT bumped.
- **Linear fills on video take 2 to 8 stops,** each `#rrggbb`.
- **Look order and labels in both pickers:** None/Window only…, Clean, Dark, Solid, Aurora, Ember, Custom. Labels are exactly the existing `LOOKS` labels; video's first swatch is labelled `None`.
- **The new project version is called `V` below.** Before Task 3, run `ls schema/project-*.schema.json` on a fresh `origin/master`. `V` = the highest number there + 1. It is 20 only if neither #440 (STC-630) nor #444 (STC-636) has merged. If one merges mid-branch, rebase and renumber.
- **Fill values** (verbatim from today's code): Clean `["#e9edf2","#cfd6e0"]` @135; Dark `["#2a3040","#0d1017"]` @135; Solid `#3b4252`; Aurora `["#050a12","#0d4a52","#5b3fd1"]` @135; Ember `["#12061a","#7a1f5c","#ff7a3d"]` @160. Shadow opacity: 0.32 base, 0.55 Dark.

## Review Focus

1. **An old recording tinted under STC-604** (Clean with first stop `#112233`) must render unchanged and select Custom. Test in Task 4.
2. **Dark with the Shadow switch off, then Aurora picked:** the shadow stays off, and Aurora must not inherit Dark's 0.55. Test in Task 4.
3. **A three-stop fill in a document claiming v15–v19** (a hand edit). `framingProblem` accepts it; it renders, and the next write promotes it to V. Test in Task 3.
4. **Typing an invalid hex into Custom** never reaches the document and marks the field `aria-invalid`, as in the still editor. Test in Task 6 (e2e).
5. **Keyboard:** arrow keys, Home and End move across seven swatches in both editors, with exactly one tab stop. Test in Task 5 (still e2e, existing) and Task 6 (video e2e).

---

### Task 1: The looks catalogue, and video framing taking 2–8 stops

**Files:**
- Create: `transform/src/looks.ts`
- Modify: `transform/src/framing.ts` (types ~35-37, `FRAMING_PRESETS` ~66-80, `framingProblem` linear check ~126-130)
- Modify: `transform/src/backgrounds.ts` (Aurora/Ember entries ~95-98, `fromFraming`, header)
- Modify: `transform/src/still-decorate.ts` (`PRESET_BACKGROUND` ~139)
- Test: `transform/test/looks.test.ts` (new), `transform/test/framing.test.ts`, `transform/test/backgrounds.test.ts`

**Interfaces:**
- Produces, in `looks.ts`:
  ```ts
  export type LookFill =
    | { kind: "solid"; color: string }
    | { kind: "linear"; colors: readonly string[]; angleDeg: number };
  export type FillLookId = "clean" | "dark" | "solid" | "aurora" | "ember";
  export const LOOK_FILLS: Readonly<Record<FillLookId, LookFill>>;
  export const BASE_SHADOW_OPACITY = 0.32;
  export const DARK_SHADOW_OPACITY = 0.55;
  export const LINEAR_STOPS_MIN = 2;
  export const LINEAR_STOPS_MAX = 8;
  ```
- Produces, in `framing.ts`: `FramingBackground`'s linear variant becomes `{ kind: "linear"; colors: string[]; angleDeg: number }` (2–8 entries, enforced by `framingProblem`).

- [ ] **Step 1: Write the failing tests**
  - `looks.test.ts` / `"every fill is #rrggbb and every linear has 2-8 stops"`: iterate `LOOK_FILLS` and assert that.
  - `"aurora and ember are three-stop"`: assert `LOOK_FILLS.aurora.colors` equals the Global Constraints value, and the same for Ember with angle 160.
  - `framing.test.ts` / `"framingProblem takes 2 to 8 linear stops"`: 3 and 8 stops give `undefined`; 1 and 9 give a string containing `"2 to 8"`; a bad hex in position 2 of 3 gives a string.
  - `"FRAMING_PRESETS read the catalogue"`: `FRAMING_PRESETS.clean.background` equals `LOOK_FILLS.clean`, the same for Dark and Solid; `FRAMING_PRESETS.dark.shadow.opacity === DARK_SHADOW_OPACITY`.
  - `backgrounds.test.ts` / `"aurora and ember read the catalogue"`: `look("aurora").background` equals `{ kind: "linear", colors: [...LOOK_FILLS.aurora.colors], angleDeg: 135 }`, and the same for Ember.

- [ ] **Step 2: Run, and expect the new tests to fail**
  - Run: `npx vitest run --project unit transform/test/looks.test.ts transform/test/framing.test.ts transform/test/backgrounds.test.ts`
  - Expected: FAIL, with `looks.js` not found and `framingProblem` refusing 3 stops.

- [ ] **Step 3: Implement**
  - Create `looks.ts` with no imports. Its header says it is the ONE place a look's colours live, and why it is a leaf: the main process imports `framing.ts`.
  - In `framing.ts`, build `FRAMING_PRESETS` from `LOOK_FILLS` (copy arrays; never share references) and from the two opacity constants.
  - `framingProblem`'s message becomes `"framing.background must be a solid or a 2 to 8 stop linear fill"`.
  - In `backgrounds.ts`, Aurora and Ember read `LOOK_FILLS` through `fromFraming`, and their "Stills only until STC-608" comment goes.
  - In `still-decorate.ts`, `PRESET_BACKGROUND` is built from `LOOK_FILLS.clean` (still `kind: "linear"`, a fresh array). The existing test holding it equal to video's Clean stays.
  - Rewrite `backgrounds.ts`'s header "One place to tune" paragraph: `looks.ts` owns every fill now.

- [ ] **Step 4: Run, and expect a pass**
  - Same command, plus `npm run typecheck`.
  - Expected: PASS.

- [ ] **Step 5: Commit** `STC-608: one catalogue for every look's fill; video framing takes 2-8 stops`

### Task 2: One gradientLine, and the compositor draws N stops

**Files:**
- Modify: `transform/src/still-render.ts:86-95` (delete its `gradientLine`, import `framing.ts`'s), `:154` (call site argument order)
- Modify: `transform/src/compositor.ts:97-103`
- Test: `transform/test/still-render.test.ts:66-90` (point at `framing.ts`'s function, swapping argument order), `transform/test/compositor.test.ts`

**Interfaces:**
- Consumes: `gradientLine(angleDeg: number, w: number, h: number)` from `framing.ts` (unchanged signature).

- [ ] **Step 1: Write the failing test**
  - `compositor.test.ts` / `"a three-stop framing background adds stops at 0, 0.5 and 1"`: lay out `{ preset: "clean", background: { kind: "linear", colors: ["#050a12","#0d4a52","#5b3fd1"], angleDeg: 135 } }` and draw it through the existing recording-ctx helper. Assert that the recorded ops include `addColorStop(0,#050a12)`, `addColorStop(0.5,#0d4a52)` and `addColorStop(1,#5b3fd1)`. Match the op string format the file already records.
  - `still-render.test.ts`: change the import so `gradientLine` comes from `../src/framing.js`, and swap the call arguments to `(angle, w, h)`. Keep the assertions.

- [ ] **Step 2: Run, and expect a fail**
  - Run: `npx vitest run --project unit transform/test/compositor.test.ts transform/test/still-render.test.ts`
  - Expected: the compositor test FAILS (only two stops are added).

- [ ] **Step 3: Implement**
  - In `drawChrome`, add every colour at `i / (n - 1)`. This is the rule `still-render.ts` already uses.
  - In `still-render.ts`, delete the local `gradientLine` and import it from `./framing.js`. Its CSS-convention doc comment moves onto `framing.ts`'s copy if that copy says less.

- [ ] **Step 4: Run, and expect a pass**
  - Same command, plus `npm run typecheck` and `npm run gate:still`.
  - Expected: PASS, and the gate stays green.

- [ ] **Step 5: Commit** `STC-608: one gradientLine; the compositor draws every stop`

### Task 3: Project version V

**Files:**
- Create: `schema/project-V.schema.json` (copy project-19's; `framing.background`'s linear `colors` becomes `minItems 2, maxItems 8`; prepend a `vV (STC-608)` sentence to the description)
- Modify: `transform/src/project-version.ts` (append `V`), `transform/src/trim.ts` `versionFor` (~442: return type and a first line)
- Test: `transform/test/framing-project.test.ts` (new `describe("project-V multi-stop framing (STC-608)")`)

**Interfaces:**
- Produces: in `trim.ts`, `function hasMultiStopFraming(project: Project): boolean` (true when `framing.background` is linear with more than 2 colours). It is checked first in `versionFor`, returning `V`.

- [ ] **Step 1: Write the failing tests**
  - `"a three-stop framing writes vV and validates"`: `projectForWrite` of a default project with Aurora's background gives `version === V`, and `validateV(out)` is true.
  - `"a two-stop or solid framing stays at 15"`: both give `version === 15`.
  - `"vV is readable and keeps a three-stop framing"`: `parseProject(written)` round-trips `framing` with deep equality.
  - `"a three-stop framing in a v19 document still loads"` (Review Focus 3): set `version: 19` with Aurora's background; `parseProject(...).framing.background.colors` has length 3.
  - `"the vV schema refuses nine stops"`.

- [ ] **Step 2: Run, and expect a fail**
  - Run: `npx vitest run --project unit transform/test/framing-project.test.ts transform/test/project-version-seam.test.ts`
  - Expected: FAIL.

- [ ] **Step 3: Implement** the schema file, the `PROJECT_VERSIONS` entry, and `hasMultiStopFraming` placed first in `versionFor`. Then check whether `main.ts`'s `preview:writeProject` needs anything beyond `PROJECT_VERSIONS`. It shouldn't; the seam test says so.

- [ ] **Step 4: Run, and expect a pass**
  - Same command, plus `npx vitest run --project unit transform/test/schema.test.ts` and `npm run typecheck`.

- [ ] **Step 5: Commit** `STC-608: project-V carries a 2-8 stop framing background`

### Task 4: The video look rules (pure)

**Files:**
- Modify: `app/src/framing-edit.ts`. Export `backgroundOf`, and add the functions below. `framingColor`/`withColor` stay until Task 6 removes their last caller.
- Test: `app/test/framing-edit.test.ts`. Add the cases below.

**Interfaces:**
- Consumes: `LOOK_FILLS`, `DARK_SHADOW_OPACITY` and `BASE_SHADOW_OPACITY` (Task 1); `customBackground` and `LOOKS` from `@transform/backgrounds`.
- Produces:
  ```ts
  export type VideoLookId = "none" | "clean" | "dark" | "solid" | "aurora" | "ember" | "custom";
  export const VIDEO_LOOKS: readonly { id: VideoLookId; label: string; fill?: LookFill }[]; // spec order; labels from LOOKS, "None" first
  export function backgroundOf(f: Framing): FramingBackground;
  export function withLook(was: Framing | undefined, id: Exclude<VideoLookId, "custom">): Framing | undefined;
  export function withCustom(was: Framing | undefined, background: FramingBackground): Framing;
  export function customFraming(first: string, second?: string): { ok: true; background: FramingBackground } | { ok: false; reason: string };
  export function videoLookOf(f: Framing | undefined): VideoLookId | undefined;
  ```

**Rules** (from the spec; the tests pin them):
- **`withLook("none")`** returns `undefined`.
- **Otherwise `withLook`** sets `preset` (Clean, Dark and Solid use their own; Aurora and Ember use `clean`) and an explicit `background` copied from `LOOK_FILLS` (a solid fill becomes `{ kind: "solid", color }`). It drops `color`, and keeps `paddingPct`/`radiusPct`. For shadow:
  - If `was` had the shadow off (`framingShadowOn` false), keep `was.shadow`.
  - Otherwise, Dark writes `shadow: { ...FRAMING_PRESETS.dark.shadow }`, and every other look omits `shadow`.
- **`withCustom`** keeps `was.preset` (`clean` when `was` is undefined), padding, radius and shadow, and sets `background`.
- **`customFraming`** wraps `customBackground`, converting a still solid `{ colors: [a] }` to `{ kind: "solid", color: a }`. It passes the still's refusal sentence through unchanged.
- **`videoLookOf(undefined)`** is `"none"`. Otherwise, a look matches when `backgroundOf(f)` deep-equals the look's fill AND (the shadow is off OR its opacity equals that look's: `DARK_SHADOW_OPACITY` for Dark, `BASE_SHADOW_OPACITY` otherwise). If nothing matches, a solid or 2-stop fill gives `"custom"`, and anything else gives `undefined`.

- [ ] **Step 1: Write the failing tests** (`describe("video looks (STC-608)")`):
  - `"each look round-trips through videoLookOf"`: for every id except `custom`, `videoLookOf(withLook(undefined, id))` is `id`.
  - `"aurora writes its three stops explicitly with preset clean"`.
  - `"dark writes its shadow; leaving dark drops it"`: `withLook(withLook(undefined,"dark"),"aurora").shadow` is `undefined`.
  - `"shadow off survives every look"` (Review Focus 2): `withShadow(withLook(undefined,"dark"), false)`, then `withLook(…,"aurora")` gives `framingShadowOn === false`, and `videoLookOf` is `"aurora"`.
  - `"dark with the shadow off still reads as dark"`.
  - `"padding and corners survive a look change"`.
  - `"pre-change documents"`: `{preset:"dark"}` gives `dark`; `{preset:"solid", color:"#3b4252"}` gives `solid`; `{preset:"solid", color:"#112233"}` gives `custom`; `{preset:"clean", background:{kind:"linear",colors:["#112233","#cfd6e0"],angleDeg:135}}` gives `custom` (Review Focus 1).
  - `"a retuned three-stop fill selects nothing"`: Aurora's colours with one changed give `undefined`.
  - `"custom keeps the document's preset"`: `withCustom(withLook(undefined,"dark"), solid).preset === "dark"`, and its shadow opacity is 0.55.
  - `"customFraming"`: `("#112233")` gives a solid; `("#112233","#445566")` gives a linear at 135; `("nope")` gives `ok: false`.
  - **Every result passes `framingProblem`** (loop over all of the above).

- [ ] **Step 2: Run, and expect a fail**
  - Run: `npx vitest run --project unit app/test/framing-edit.test.ts`

- [ ] **Step 3: Implement** the signatures above in `framing-edit.ts`. Update its header so the Colour-row paragraph describes Custom.

- [ ] **Step 4: Run, and expect a pass**
  - Same command, plus `npm run typecheck`.

- [ ] **Step 5: Commit** `STC-608: the video look rules`

### Task 5: The shared swatch grid, with the still editor moved onto it

**Files:**
- Create: `app/src/look-grid.ts`, `app/renderer/look-grid.css`
- Modify: `app/src/still-editor-renderer.ts` (`initLooks` ~592-620, `paintSwatches` ~405, grid keydown ~576-590, `cssFill` ~386 moves out)
- Modify: `app/renderer/still-editor.html`. Its `.look*` CSS (~71-103) moves to `look-grid.css`; add the `<link>`. The CSP already allows `style-src 'self'` (STC-443).
- Modify: `tsconfig.browser.json` if renderer files are listed explicitly, and `app/build.mjs` if CSS files are copied by name.
- Test: `app/test/look-grid.test.ts` (new, pure parts only)

**Interfaces:**
- Produces, in `look-grid.ts`:
  ```ts
  export interface LookSwatch { id: string; label: string; fill: string /* CSS background */; glyph?: string /* svg markup */ }
  export interface LookGrid { setSelected(id: string | undefined): void; setDisabled(disabled: boolean): void; element: HTMLElement }
  export function cssFill(fill: { kind: string; colors?: readonly string[]; color?: string; angleDeg?: number } | undefined): string;
  export function mountLookGrid(container: HTMLElement, swatches: readonly LookSwatch[], onChoose: (id: string) => void): LookGrid;
  export function nextSwatchIndex(key: string, at: number, count: number): number | undefined; // pure: Home/End/Arrow*, undefined for other keys
  ```
- `mountLookGrid` owns `role="radio"` buttons, `aria-checked`, one roving tab stop (falling back to the first swatch when none is selected), `aria-disabled` (never `disabled`), and keydown through `nextSwatchIndex`.

- [ ] **Step 1: Write the failing tests**
  - `look-grid.test.ts`: `nextSwatchIndex` wraps at both ends for Arrow keys, Home gives 0, End gives `count-1`, and `"a"` gives `undefined`.
  - `cssFill`: a linear fill gives `linear-gradient(<angle>deg, a, b, c)`; a solid in either shape (`color` or `colors[0]`) gives the colour.

- [ ] **Step 2: Run, and expect a fail**
  - Run: `npx vitest run --project unit app/test/look-grid.test.ts`

- [ ] **Step 3: Implement** `look-grid.ts` and the CSS. Move `cssFill`'s body from `still-editor-renderer.ts`. Rewire the still editor to `mountLookGrid` with `LOOKS` mapped to `LookSwatch` (the wallpaper glyph as today). Its behaviour must not change: selection, Custom fields and wallpaper all stay put.

- [ ] **Step 4: Run, and expect a pass**
  - Same command, plus `npm run typecheck` and the existing still-editor unit tests (`npx vitest run --project unit app/test/window-look.test.ts transform/test/backgrounds.test.ts`).
  - `window-shot-look.e2e.test.ts` and `still-editor` e2e run on CI in Task 7.

- [ ] **Step 5: Commit** `STC-608: one swatch grid for both editors`

### Task 6: The Frame tab's swatch grid and Custom row

**Files:**
- Modify: `app/renderer/editor.html` ~1158-1175. Replace `#framepreset` and `#framecolorrow` with `<div id="framelooks" role="radiogroup" aria-label="Background">` inside the Background group, plus `<div class="row" id="framecustomrow" hidden>` holding two text inputs `#framecustoma`/`#framecustomb` (placeholders `#rrggbb`, the second labelled optional). Link `look-grid.css`. Lay the grid out as four columns at the pane's width.
- Modify: `app/src/editor.ts` ~3085-3210. Delete `framePresetButtons`, `framePresetValue`, `setFramePresetUI`, `framingFromControls`, `editFramingColor` and their listeners. Mount the grid with `VIDEO_LOOKS` and route picks to `setFraming(withLook(...))`. On a Custom pick, or on a field `change` with a valid value, call `setFraming(withCustom(was, bg))`. An invalid value sets `aria-invalid="true"` and writes nothing. `updateFramingUI` calls `grid.setSelected(videoLookOf(f))`, shows `#framecustomrow` when the look is Custom (fields filled from `backgroundOf(f)`), and `setFramePresetDisabled` becomes `grid.setDisabled`. Also rename at the `:4119` call site.
- Modify: `app/src/framing-edit.ts`. Delete `framingColor` and `withColor` (the tint is gone, per Patrick 2026-11-03) and their cases in `app/test/framing-edit.test.ts`. Rewrite the header's Colour-row paragraph to describe Custom.
- Modify: `app/test/framing-editor.e2e.test.ts`. Rewrite the three tests onto `#framelooks [data-look=…]`.
- Test: e2e only (CI).

**Interfaces:**
- Consumes: `VIDEO_LOOKS`, `withLook`, `withCustom`, `customFraming`, `videoLookOf` and `backgroundOf` (Task 4); `mountLookGrid` and `cssFill` (Task 5).

- [ ] **Step 1: Rewrite the e2e tests** (they will fail until Step 3; they are not run locally):
  - `"defaults to None, frames on a look, and clears again"`: None is checked, Aurora writes `project.json` with Aurora's three stops and `version: V`, and None removes `framing`.
  - `"padding, corners and shadow wait for a frame and survive a look change"`: keep today's assertions, and switch the clicks from Clean to Dark.
  - `"Custom shows its colour row, writes valid colours, and marks a bad one"` (Review Focus 4): Custom with `#112233` writes a solid; adding `#445566` writes a linear; `zz` sets `aria-invalid` and leaves the file unchanged.
  - `"the look grid is one tab stop and arrows move"` (Review Focus 5): Tab lands on the checked swatch, ArrowRight moves focus, and End reaches Custom.

- [ ] **Step 2: Typecheck**
  - Run `npm run typecheck`. Expected: FAIL in `editor.ts` until Step 3.

- [ ] **Step 3: Implement** the HTML and `editor.ts` changes above. Keep the existing `setFraming`, `chosenFraming` and `heldFraming` flow untouched.

- [ ] **Step 4: Verify**
  - Run `npm run typecheck` and `npx vitest run --project unit` (whole unit project). Expected: PASS.
  - Then `npm run app:start`, open a take, and confirm by eye that the grid draws in the pane and that Aurora repaints the preview. This is a quick look only; Patrick's sign-off is Task 7.

- [ ] **Step 5: Commit** `STC-608: the Frame tab picks from the shared looks`

### Task 7: Gates, docs, draft PR

**Files:**
- Create: `docs/STC-608-RUNBOOK.md`. It covers what Patrick runs: each look in a recording and in a still, on a real window capture with light and dark windows, side by side; the branch to run from; and how to make each export.
- Modify: `docs/TICKET-LOG.md` (append the STC-608 row), and add `CLAUDE.md` rows for `transform/src/looks.ts`, `app/src/look-grid.ts` and `schema/project-V.schema.json`.

- [ ] **Step 1: Run the gates**
  - Run `npx vitest run --project unit`, `npm run typecheck`, `npm run gate:still` and `npm run gate:identity`. Expected: all green. `transform/test/shot-v1-frozen.test.ts` passes unchanged.
- [ ] **Step 2: Write the runbook and the doc rows**
- [ ] **Step 3: Commit, push and open a draft PR**
  - Run `git push -u origin HEAD`, then `gh pr create --draft --base master` with a body ending in the attribution line.
  - CI runs the e2e suite.
- [ ] **Step 4: Bind the PR,** then read CI. Fix e2e failures in the owning task's files.
- [ ] **Step 5: Hand Patrick the runbook with its branch name.** The ticket closes only on his sign-off, not on merge.
