# STC-628 Window Shot Looks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A window shot takes one of four looks at capture (default: Desktop wallpaper), set in Settings, and Wallpaper is a fifth-row swatch in the still editor.

**Architecture:** The format already has `background.kind: "wallpaper"` + `file`. The helper learns to read the wallpaper of a display into a shot folder (per-display cache, APFS clone). Main applies the chosen look after capture through the SAME `LookWrite`/`applyLook` merge the still editor uses. `composeStill` loads the background file and `still-render.ts` cover-crops it. A failed read falls back to Clean, and the panel says so (and opens even in clipboard mode).

**Tech Stack:** TypeScript (transform, Electron main/renderers), Swift helper (ScreenCaptureKit, AppKit), vitest, Playwright still gate.

**Spec:** `docs/superpowers/specs/2026-11-02-stc-628-window-shot-looks-design.md`. Read it first. This plan argues from it.

## Global Constraints

- No shot format version bump: a wallpaper shot is `mode: "window-shadow-custom-background"`, `background: { kind: "wallpaper", file, colors: [<Clean's first colour>] }`, written through `shotForWrite`. If a bump turns out to be needed, stop and report.
- `transform/test/shot-v1-frozen.test.ts` and `fixtures/shot-v1/` must not change. `npm run gate:still` stays green.
- The wallpaper is a file IN the shot folder, named by `background.file`, and loaded through `still:frame` (which only accepts `*.png`). Name: `wallpaper.png`.
- Margin = the background looks' `paddingPct` 0.09 (`still-decorate.ts`). Shadow = `PRESET_SHADOW` (Clean's). Canvas `natural`.
- Out-of-box `windowShotLook` = `"wallpaper"`, existing users included.
- Capture backgrounds = the last swatch picked in the still editor. If none has been picked, Clean.
- Fallback copy (panel `#status` and editor): `Couldn't read your wallpaper, so this shot uses Clean.`
- Gate 3 budgets do not move: `STILL_BUDGET_MS` 200, `STILL_END_TO_END_MS` 400, with the wallpaper read on. Don't loosen them. If the read can't fit, stop and report.
- e2e tests run on CI only (via a draft PR), never locally. Run unit tests with `npx vitest run --project unit`.
- Before pushing, run all three typechecks with `npm run typecheck`.

## Review Focus

1. **The shot's display has two monitors with different wallpapers.** A window on the second display must get the second display's wallpaper, not the main one's. The helper reads by the window's resolved display id (Task 4 test).
2. **Wallpaper smaller or a different aspect than the canvas** (a 16:10 picture behind a tall window). It must cover-crop, never stretch or letterbox (Task 1 test).
3. **A wallpaper shot opened after `wallpaper.png` was deleted by hand.** It must render Clean's first colour, not throw (Task 6 test).
4. **Clipboard mode plus a failed read.** The clipboard still gets the Clean shot AND the panel opens with the line (Task 5 test).
5. **A wallpaper shot duplicated, saved from temp, or reopened.** `wallpaper.png` travels with it (whole-dir copy today). A test pins it so a future "copy only known files" change can't drop it (Task 5).

---

### Task 1: Cover-crop the background image

**Files:**
- Modify: `transform/src/still-render.ts:95-118` (`paintBackground`)
- Test: `transform/test/still-render-cover.test.ts` (create)
- Modify: `harness/still.ts`, `scripts/still-gate.mjs` (one wallpaper case)

**Interfaces:**
- Produces: `export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number): { sx: number; sy: number; sw: number; sh: number }` in `still-render.ts`. This is the source rectangle to draw into the full canvas.

- [ ] **Step 1: Write failing tests**

```ts
expect(coverRect(1600, 1000, 800, 500)).toEqual({ sx: 0, sy: 0, sw: 1600, sh: 1000 }); // same aspect
expect(coverRect(1600, 1000, 500, 500)).toEqual({ sx: 300, sy: 0, sw: 1000, sh: 1000 }); // tall canvas: crop sides
expect(coverRect(1000, 1000, 800, 400)).toEqual({ sx: 0, sy: 250, sw: 1000, sh: 500 });  // wide canvas: crop top/bottom
```
Also add a recording-context test: `renderStill` with a `wallpaper` background and a fake image `{width:1600,height:1000}` calls `drawImage(img, 300, 0, 1000, 1000, 0, 0, 500, 500)`. A `mesh` source is still drawn with the 5-argument form (a mesh is rendered at canvas size).

- [ ] **Step 2: Run, expect FAIL** with `npx vitest run --project unit transform/test/still-render-cover.test.ts`.
- [ ] **Step 3: Implement.** `image`/`wallpaper` use the 9-argument `drawImage` with `coverRect`. `mesh` keeps the 5-argument form. Read the size from `image.width`/`image.height`. Update the stale "nothing sources the desktop picture" comment.
- [ ] **Step 4: Still gate.** Add a wallpaper case to `harness/still.ts`: a generated 1600×1000 four-quadrant image (distinct colours) behind a tall window. Add a property assertion to `still-gate.mjs`: the four canvas corners sample their own quadrant's colour, which proves a centred cover-crop with no stretch. No golden image (see the gate's trap).
- [ ] **Step 5: Run** `npx vitest run --project unit` and `npm run gate:still`. Both pass.
- [ ] **Step 6: Commit** `STC-628: cover-crop image and wallpaper backgrounds`.

### Task 2: The Wallpaper look in `backgrounds.ts`

**Files:**
- Modify: `transform/src/backgrounds.ts`
- Test: `transform/test/backgrounds.test.ts` (extend the existing STC-599 test file; find it with `grep -l lookOf transform/test`)

**Interfaces:**
- Produces:
  - `LookId` gains `"wallpaper"`. `LOOKS` gains `{ id: "wallpaper", label: "Wallpaper", mode: "window-shadow-custom-background" }`, placed before `custom` (background supplied at selection, like Custom).
  - `export const WALLPAPER_FILE = "wallpaper.png"`
  - `export function wallpaperBackground(file: string): Background` returns `{ kind: "wallpaper", file, colors: [<first colour of Clean's PRESET_BACKGROUND>] }`
  - `export function wallpaperLookWrite(file: string): LookWrite`: mode `window-shadow-custom-background`, that background, `shadow: null` (the mode's default `PRESET_SHADOW`)
  - `lookOf` returns `"wallpaper"` for any decoration with `background.kind === "wallpaper"`, checked before the Custom rule.

- [ ] **Step 1: Failing tests.** `lookOf(applyLook(base, wallpaperLookWrite("wallpaper.png")))` returns `"wallpaper"`. The merged doc passes `parseShot`, and `shotForWrite(...).version` equals the version for the same doc with a Clean look (no bump). The drawn shadow equals Clean's. `lookOf` of a `linear` custom fill is still `"custom"`.
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement.** Use `lookWrite`'s existing `custom` pattern: `lookWrite(look, custom)` must also accept the wallpaper background, so `lookWrite(LOOKS.wallpaper, wallpaperBackground(f))` equals `wallpaperLookWrite(f)`.
- [ ] **Step 4: Run** `npx vitest run --project unit transform/test`. Must PASS, `shot-v1-frozen` included.
- [ ] **Step 5: Commit.**

### Task 3: The setting and the capture-look decision (pure)

**Files:**
- Create: `app/src/window-look.ts` (node-safe, no Electron)
- Modify: `app/src/settings.ts` (interface, defaults, both read paths ~444 and ~495)
- Test: `app/test/window-look.test.ts`, extend `app/test/settings.test.ts`

**Interfaces:**
- Produces:
  - `export type WindowShotLook = "window-only" | "window-shadow" | "background" | "wallpaper"` and `export const WINDOW_SHOT_LOOKS: readonly { value: WindowShotLook; label: string }[]` with labels `Just the window`, `Window with shadow`, `Capture background`, `Desktop wallpaper`.
  - `Settings.windowShotLook: WindowShotLook` (default `"wallpaper"`; an unknown stored value becomes the default).
  - `Settings.lastBackgroundLook: LookWrite | null` (default `null`). Main's alone: `recorder:setSettings` strips it, like `capturePrimed`. On read, `parseLookWrite` must accept it, and it must be one of the background modes and not a wallpaper. Otherwise it reads as `null`.
  - `export function captureLook(look: WindowShotLook, lastBackground: LookWrite | null, wallpaper: { file: string } | { error: string } | undefined): { write: LookWrite; notice?: string }`
    - `window-only`/`window-shadow` give that look's `lookWrite`.
    - `background` gives `lastBackground ?? lookWrite(clean)`.
    - `wallpaper` with `{file}` gives `wallpaperLookWrite(file)`. With `{error}` or `undefined` it gives Clean's write plus `notice: "Couldn't read your wallpaper, so this shot uses Clean."`
  - `export function wantsWallpaper(look: WindowShotLook): boolean`
  - `export function isRememberedBackground(write: LookWrite): boolean`. True for a Capture-backgrounds look (mode `window-shadow-background`/`-custom-background`, background kind not `wallpaper`). Main uses it to decide whether a still-editor pick updates `lastBackgroundLook`.
- [ ] **Steps:** failing tests for each branch above, the settings default and garbage fallback, and the strip in `recorder:setSettings`'s merge. Then implement, run `npx vitest run --project unit app/test/window-look.test.ts app/test/settings.test.ts`, and commit.

### Task 4: Helper reads the wallpaper

**Files:**
- Create: `helper/src/WallpaperDecisions.swift` (pure), `helper/src/Wallpaper.swift`
- Modify: `helper/src/StillDecisions.swift` (`StillRequest.wallpaper: Bool`, parsed from `"wallpaper": true`; window shots only, ignored otherwise), `helper/src/Still.swift` (fetch beside the window capture), `helper/src/main.swift` (new `wallpaper` verb), `helper/build.sh` if it lists sources
- Test: `helper/test/still/main.swift` (pure decisions), `helper/test/ipc.test.ts` (verb refusals, no grant), `helper/test/still-gates.grant.test.ts` (gate 3 with `wallpaper: true`), new `helper/test/wallpaper.grant.test.ts`; add any file that sends `wallpaper`/`capture-still` to the real binary to `vitest.screencapturekit-files.ts`.

**Interfaces:**
- `capture-still` with `wallpaper: true` on a window shot writes `wallpaper.png` into `dir`. The reply adds either `wallpaper: { file: "wallpaper.png", source: "<how>", ms: <n> }` or `wallpaperError: "<sentence>"`. The capture itself never fails because of the wallpaper, and `shot.json` is untouched (still `window-only`).
- New verb `{"cmd":"wallpaper","dir":…,"displayId":N,"file":"wallpaper.png"}` replies `{file, source}` or a reliable error with code `wallpaper-unavailable`. It uses the same `dir`/`file` name rules as `parseStillRequest` (bare name, `.png`).
- Pure: `parseWallpaperRequest(_:) -> Result<WallpaperRequest, StillRequestError>`, and `wallpaperCacheKey(displayId: UInt32, imageURL: String?, modified: Double?, spaceId: Int?) -> String`. A dynamic wallpaper (`.heic` with more than one image) or no URL gives a key that never hits, so it always re-captures.

- [ ] **Step 1: Measure before choosing (record in the runbook).** Spike on the Mac:
  - (a) Capture the system wallpaper window for that display alone through `SCScreenshotManager`. Find it in `SCShareableContent.windows`: owning app `Dock` or `WallpaperAgent`, layer below desktop icons, frame = display.
  - (b) `NSWorkspace.shared.desktopImageURL(for:)`.
  
  Record the time and whether each shows the frame currently showing for a dynamic and an aerial wallpaper. Prefer (a), and use (b) only for a static image when (a) is missing. Log the source in the reply.
- [ ] **Step 2: Failing tests for the pure decisions:**
  - request parsing refusals: missing dir, a path in `file`, a non-png name
  - the cache key changes with the URL, the mtime and the Space
  - a dynamic wallpaper never hits the cache
- [ ] **Step 3: Implement `Wallpaper.swift`.**
  - Read the picture for the display. Encode it as PNG in the display's colour space, capped at the display's pixel size.
  - Cache it under `~/Library/Caches/<bundle id>/wallpaper/<key>.png`.
  - Clone it into `dir` with `clonefile(2)`, and fall back to `copyItem`.
  - In `Still.swift`, start the fetch concurrently with the window `captureImage` for the window's resolved `geometry.id`. Join it before `finish`.
- [ ] **Step 4: Run** `helper/build.sh`, the pure harness, and `npx vitest run --project unit helper/test/ipc.test.ts`. The grant tests are Patrick's to run (`npm run test:capture`); hand him the command.
- [ ] **Step 5: Gate 3 with wallpaper on.** Add a `wallpaper: true` variant to gate 3 at the same budgets. If it can't pass with a warm cache, stop and report the measured numbers.
- [ ] **Step 6: Commit.**

### Task 5: Main applies the look at capture

**Files:**
- Modify: `app/src/main.ts`:
  - `captureStill` (~2221)
  - `still:writeShot` (~4111): factor its merge into `writeShotLook`
  - a new `still:fetchWallpaper` handler
- Modify: `app/src/thumbnail-window.ts` (`PresentOptions.notice?: string`, passed as the `notice` query param), `app/src/thumbnail-renderer.ts` (on load, a notice goes to `setStatus`)
- Modify: `app/src/still-editor-preload.ts` (`fetchWallpaper(dir)`)
- Test: `app/test/window-look.test.ts` for `presentFlags`, `app/test/takes.test.ts` (duplicate keeps `wallpaper.png`), and an e2e in `app/test/` driving `_fake-helper.mjs` with a new `STC_FAKE_WALLPAPER=fail` (CI only)

**Interfaces:**
- Consumes: `captureLook`, `wantsWallpaper`, `isRememberedBackground` (Task 3), `applyLook`, `parseLookWrite`.
- Produces:
  - `async function writeShotLook(dir: string, write: LookWrite): Promise<Shot>`. Read `shot.json`, apply the look, run `parseShot`, write through `shotForWrite`, and drop the thumbnail cache. This is the body `still:writeShot` already has for `look`, now shared by both callers.
  - `export function presentFlags(afterShot: "panel" | "clipboard", notice?: string): { silent: boolean }` (pure, in `window-look.ts`). It returns `silent: false` whenever a notice exists.
  - `ipcMain.handle("still:fetchWallpaper", (dir) => { ok: true, file } | { ok: false, notice })`. It checks `insideCaptureRoot`, then calls the helper `wallpaper` verb with `shot.display.id`.
- [ ] **Steps:**
  1. Write failing tests for `presentFlags`, and for `writeShotLook`: it round-trips a wallpaper write, and a write that fails `parseShot` throws without writing.
  2. Implement. In `captureStill`, for `outcome.kind === "window"` with `frame.alpha`, send `wallpaper: wantsWallpaper(look)`. Then compute `captureLook`, run `writeShotLook`, and present with the returned shot, the `notice`, and `presentFlags`.
  3. Leave non-window shots untouched.
  4. A `writeShotLook` failure keeps the `window-only` shot and logs it. It never costs the capture.
  5. `still:writeShot` with a `look` that passes `isRememberedBackground` also writes `lastBackgroundLook`.
  6. Add the duplicate test.
  7. Run `npx vitest run --project unit` and commit.

### Task 6: Every compositor loads the background file

**Files:**
- Modify: `app/src/still-compose.ts`:
  - `composeStill` gains an optional 4th parameter, `background?: ImageBitmap`
  - new `loadShotBackground`
- Modify callers: `app/src/thumbnail-renderer.ts:280`, `app/src/still-editor-renderer.ts:116,256-260`, `app/src/renderer.ts:505,714-718`, `harness/still.ts:188`
- Test: `app/test/still-compose-background.test.ts` (pure part), e2e covered by Task 5's

**Interfaces:**
- `export async function loadShotBackground(shot: Shot, getFrame: (name: string) => Promise<ArrayBuffer>): Promise<ImageBitmap | undefined>`. For `image`/`wallpaper` with a `file`, it reads that file and decodes it. A missing or unreadable file gives `undefined`, never a throw, and `paintBackground` then falls back to the colour.
- Inside `composeStill`, a mesh still comes from `withMeshBackground`. Otherwise the passed `background` goes to `sources.background`.
- [ ] **Steps:**
  1. Failing test: `loadShotBackground` returns `undefined` for a rejected read and for a non-image kind.
  2. Implement, and thread it through every caller. Each caller already has a `getFrame`; load the background once per shot open, beside the frame, not on every draw.
  3. Run `npx vitest run --project unit`, `npm run typecheck` and `npm run gate:still`.
  4. Commit.

### Task 7: Wallpaper in the still editor

**Files:**
- Modify: `app/renderer/still-editor.html`, `app/src/still-editor-renderer.ts` (the swatch grid ~300-430)
- Test: extend `app/test/editor-a11y.e2e.test.ts` or the STC-599 picker e2e (CI only)

**Interfaces:**
- Consumes: `LOOKS` (now with `wallpaper`), `wallpaperLookWrite`, `fetchWallpaper` (Task 5).
- Picking Wallpaper:
  - If the shot already has `background.kind === "wallpaper"` and its file loads, just select it.
  - Otherwise call `fetchWallpaper(dir)`. On `ok`, write `wallpaperLookWrite(file)`. On fallback, write Clean and show the notice in the editor's existing reason/status line.
  - The swatch chip shows a small thumbnail of the loaded wallpaper (CSS `background-image` from an object URL), or a neutral desktop glyph before one exists.
  - It keeps the grid's roving tabindex, `aria-checked` and `aria-disabled` while writing.
- [ ] **Steps:** implement, run `npm run typecheck`, then `npm run axe:renderers`, then commit. The e2e runs on CI.

### Task 8: The Settings row

**Files:**
- Modify: `app/renderer/settings.html` (Capture pane: a new section `Window shots`, after `After a shot`), `app/src/settings-renderer.ts`
- Test: `app/test/settings-a11y.e2e.test.ts` (CI), `npm run axe:renderers`

**Interfaces:**
- One row: label `Window shot look`, helper text `Applied when you capture a window. Capture background uses the last one you picked in the editor.`
- Control: a `.dropdown` via `settings-dropdown.ts` (four long labels won't fit a segmented control at 760 px). Build its rows from `WINDOW_SHOT_LOOKS`. It writes `windowShotLook` through `recorder:setSettings`.
- It gets the default, hover, `--focus` ring, active and disabled states from the shared dropdown. It works by keyboard, and the selected row is announced (`aria-checked` on the menu rows, the value in the trigger's accessible name), like `#thumbcorner`.
- [ ] **Steps:**
  1. Add the row.
  2. Extend the axe stub's settings with `windowShotLook`.
  3. Add an e2e asserting that choosing a row persists and that the trigger's name includes the value.
  4. Run `npm run typecheck` and `npm run axe:renderers`.
  5. Commit.

### Task 9: Runbook, records, PR

**Files:**
- Create: `docs/STC-628-RUNBOOK.md`
- Modify: `docs/TICKET-LOG.md` (a row), `CLAUDE.md` (a row in the table: `helper/src/Wallpaper.swift`, `app/src/window-look.ts`, the runbook)

**The runbook covers:**
- Task 4's spike results.
- A static, a dynamic and an aerial wallpaper.
- Two displays with different wallpapers.
- A window on a non-main Space.
- The fallback, forced by a fault `STC_CAPTURE_FAULT=wallpaper-unavailable`. Add that fault in Task 4.
- Clipboard mode with the fallback.
- Gate 3 numbers with wallpaper on.
- The sign-off set: four looks × light and dark window. Note that 9% vs CleanShot's ~13% margin is to be judged here.

**Steps:**
- [ ] Write the docs.
- [ ] Run `npm run typecheck` and `npx vitest run --project unit`.
- [ ] Push, then open a draft PR with `gh pr create --draft --base master` so e2e runs on CI.
- [ ] Tell Patrick to run the runbook from branch `accounts/stc-628-window-shot-looks`, and that the ticket stays open until he signs off on the screenshots.
