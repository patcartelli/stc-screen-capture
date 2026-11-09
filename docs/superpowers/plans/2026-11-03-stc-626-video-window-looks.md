# STC-626 Video Window Looks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new window-scope recording starts wearing the look chosen in Settings, and the video Frame control offers all four window looks, wallpaper included, with preview equal to export.

**Architecture:** One new `framing.background` kind (`wallpaper`) in the document, drawn by `composite()` from a bitmap the session carries. `window-look.ts` remains the one look mapping. Main reads the wallpaper during the countdown into a scratch folder, moves it into the take after `start`, then writes the seed.

**Tech Stack:** TypeScript, Electron, Canvas 2D, Vitest, Playwright gates, Swift helper (no Swift changes planned).

**Spec:** `docs/superpowers/specs/2026-11-03-stc-626-video-window-looks-design.md`

## Global Constraints

- White look: `#ffffff` solid, preset `clean` padding, corners and shadow.
- Wallpaper background: `{ "kind": "wallpaper", "file": "wallpaper.jpg", "color": "#e9edf2" }`. `file` must equal `WALLPAPER_FILE` exactly; `color` is `#rrggbb`.
- `project-22` only when the background is this kind. All other documents keep their version.
- Display and area takes: seed, grid and labels unchanged.
- `render()` stays pure, with no I/O and no live setting. Nothing shows mid-take.
- `TRANSFORM_VERSION` stays 20: only a v22 document reaches the new draw path, the same precedent as STC-608 and STC-630. No fingerprint change. (Refines the spec, which left this to the builder.)
- Cover crop reuses `coverRect` from `still-render.ts`; no second copy. (Refines the spec.)
- `npm test` includes e2e and must not run locally: use `npx vitest run --project unit`. E2e runs on CI through a draft PR.
- Work only in this worktree. Branch `accounts/stc-626-video-window-looks`.

## Review Focus

1. **Wallpaper file deleted or corrupt** after the take was framed: every sink draws `color`, and the take opens. Task 2 (decode null), Task 7 (gate control).
2. **Countdown cancelled while the read is in flight:** the scratch folder is gone even if the read answers later, and nothing reaches a take. Task 4.
3. **Moving the file into the take fails after `start` succeeded:** the recording continues on Clean with the notice; the flow never reports a failed start. Task 4.
4. **Window on no connected display** (unplugged during the countdown, or spanning displays): a display is still chosen or the read fails to Clean. Task 3.
5. **Picking Wallpaper, then Clean, then Wallpaper again:** the first picture is kept, with no re-read of today's desktop. Task 6.

---

### Task 1: The document accepts a wallpaper background

**Files:**
- Modify: `transform/src/looks.ts`, `transform/src/backgrounds.ts`, `transform/src/framing.ts`, `transform/src/trim.ts`, `transform/src/project-version.ts`
- Create: `schema/project-22.schema.json`
- Test: `transform/test/framing.test.ts`, `transform/test/schema.test.ts`, `transform/test/framing-project.test.ts`

**Interfaces:**
- Produces: `WALLPAPER_FILE` and `WINDOW_SHADOW_FILL` from `looks.ts`. `WALLPAPER_FILE` moves here and `backgrounds.ts` re-exports it, so the main process can validate without reaching `shot.ts`. `WINDOW_SHADOW_FILL = { kind: "solid", color: "#ffffff" }` stays out of `LOOK_FILLS`, because stills do not have it.
- Produces: `FramingBackground` gains `{ kind: "wallpaper"; file: string; color: string }`. `wallpaperFraming(): FramingBackground` in `framing.ts`, with `color` = `LOOK_FILLS.clean.colors[0]`. `hasWallpaperFraming(project): boolean` in `trim.ts`.

- [ ] **Step 1: Write failing tests**

`framingProblem` returns undefined for `{preset:"clean", background: wallpaperFraming()}`, and a problem for each of: `file: "../wallpaper.jpg"`, `file: "other.jpg"`, a missing `color`, `color: "red"`, an extra key. `projectForWrite` emits version 22 with the kind and 15 for a solid `#ffffff` framing. `project-22` validates a v22 document; `project-21` refuses it. `framingLayout` returns the wallpaper background unchanged.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run --project unit transform/test/framing.test.ts transform/test/schema.test.ts`
Expected: FAIL, `wallpaperFraming` is not defined.

- [ ] **Step 3: Implement**

Update `framingProblem`'s third branch and its message. Put `if (hasWallpaperFraming(project)) return 22;` first in `versionFor`, add 22 to its return union and to `PROJECT_VERSIONS`. `project-22.schema.json` is project-21 with the new `oneOf` arm and a v22 sentence first in `description`. Fix any `bg.colors` narrowing the new kind breaks in `framing-edit.ts` by returning undefined from `videoLookOf` for now (Task 5 finishes it).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project unit transform/test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add schema transform app/src/framing-edit.ts
git commit -m "STC-626: project-22, a wallpaper framing background"
```

### Task 2: Every sink draws it

**Files:**
- Create: `transform/src/wallpaper-image.ts` (browser-only; covered by `tsconfig.browser.json`'s `transform/src/**`, and check the node pass does not reach it)
- Modify: `transform/src/session.ts`, `transform/src/compositor.ts`, `transform/src/export.ts`, `transform/src/preview.ts`, `app/src/session-io.ts`, `harness/main.ts`, `harness/framing.ts`, `harness/sink-identity.ts`, `app/src/editor.ts` (close on take close)

**Interfaces:**
- Consumes: `FramingBackground` wallpaper kind, `WALLPAPER_FILE` (Task 1).
- Produces: `DrawableImage { readonly width: number; readonly height: number; close?(): void }` in `session.ts`. It is structural because `session.ts` reaches the node pass and `ImageBitmap` is a DOM type, as `capture-colour.ts`'s header explains. `LoadedSession.wallpaper?: DrawableImage | null`.
- Produces: `decodeWallpaper(bytes: ArrayBuffer | null | undefined): Promise<DrawableImage | null>`: `createImageBitmap(new Blob([bytes], { type: "image/jpeg" }))`, null on no bytes or any decode failure, never rejects. The one decode call, so every sink uses the same options.
- Produces: `composite(ctx, frame, camera, fs, width, height, wallpaper: DrawableImage | null)`. The parameter is REQUIRED, so `tsc` lists every call site.

- [ ] **Step 1: Write the failing test**

A unit test for `drawChrome`'s branch through `composite` with a stub context recording calls: wallpaper kind with an image calls `drawImage` with `coverRect`'s source rect and the whole output as destination; with `null` it calls `fillRect` with `fillStyle === color`. `decodeWallpaper(undefined)` resolves null. (Real pixels are Task 7's gate.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run --project unit transform/test/compositor`
Expected: FAIL.

- [ ] **Step 3: Implement the draw**

`drawChrome` takes `wallpaper`. Draw inside `save`/`restore` with `imageSmoothingQuality = "high"`. Import `coverRect` from `still-render.js`. Shadow drawing is unchanged.

- [ ] **Step 4: Thread it through the sinks**

`compositeFrames` and `PreviewPlayer` pass `session.wallpaper ?? null`. `loadTake` calls `decodeWallpaper(await io.readOptional(WALLPAPER_FILE).catch(() => null))` only when `project.framing?.background?.kind === "wallpaper"`, and sets `session.wallpaper`. Every harness call passes `null`, except `sink-identity.ts`, which fetches `${dir}/wallpaper.jpg` the same way. Add `wallpaper.jpg` to `TAKE_FILES` in `main.ts`. `editor.ts`'s `closeTake` calls `openSession.wallpaper?.close?.()`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run --project unit transform/test && npm run typecheck`
Expected: PASS, with no remaining `composite(` arity errors.

- [ ] **Step 6: Commit**

```bash
git add transform app harness
git commit -m "STC-626: draw a wallpaper background in preview and export"
```

### Task 3: The look mapping and the seed

**Files:**
- Modify: `app/src/window-look.ts`, `app/src/take-project.ts`
- Test: `app/test/window-look.test.ts`, `app/test/take-project.test.ts` (extend whichever exist; `grep -l captureLook app/test`)

**Interfaces:**
- Consumes: `withLook` and `withCustom` (`framing-edit.ts`), `wallpaperFraming`, `WINDOW_SHADOW_FILL`.
- Produces: `recordingLook(look: WindowShotLook, lastBackground: LookWrite | null, wallpaper: { file: string } | { error: string } | undefined): { framing?: Framing; notice?: string }`.
- Produces: `WALLPAPER_TAKE_NOTICE = "Couldn't read your wallpaper, so this take uses Clean."`.
- Produces: `displayOfWindow(bounds: Rect, displays: readonly { id: number; bounds: Rect }[]): number | undefined`: the display containing the window's midpoint, else the one nearest it, the same rule as the helper's `chooseDisplayForWindow`; undefined only for an empty list. Adapt `displays` to `ConnectedDisplay`'s real field names in main.
- Produces: `RecordTimeChoices.framing: Framing | null`.

- [ ] **Step 1: Write failing tests**

`recordingLook`:
- `window-only` → no framing.
- `window-shadow` → preset `clean`, background solid `#ffffff`, no explicit padding, radius or shadow.
- `background` with null → Clean's fill.
- `background` with a Dark `LookWrite` → Dark's fill and shadow opacity 0.55.
- `background` with Custom two-stop → those colours.
- `background` with a `radial` or `mesh` write → Clean.
- `wallpaper` with a file → `wallpaperFraming()`.
- `wallpaper` with an error or undefined → Clean plus `WALLPAPER_TAKE_NOTICE`.

`displayOfWindow`: midpoint inside the second display returns it; midpoint on no display returns the nearest; an empty list returns undefined.

`recordTimeProject`: window-only and clicks on → null; a fill → version 15; a three-stop look → 21; wallpaper → 22; wallpaper plus a PiP style → 22 with both; clicks off plus a fill → 15 with both.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run --project unit app/test/window-look.test.ts app/test/take-project.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

A `LookWrite` whose fill equals a `LOOK_FILLS` entry goes through `withLook(undefined, id)`, so Dark keeps its shadow; any other solid or linear goes through `withCustom`; anything else is Clean. Use `Math.max` for the seed's version.

- [ ] **Step 4: Run tests, then commit**

Run: `npx vitest run --project unit app/test && npm run typecheck`
Expected: PASS.

```bash
git add app
git commit -m "STC-626: the look a new window take is seeded with"
```

### Task 4: Reading the wallpaper during the countdown

**Files:**
- Create: `app/src/record-wallpaper.ts`
- Test: `app/test/record-wallpaper.test.ts`
- Modify: `app/src/main.ts` (`recordFlowBody`, `presentRecordingPanel`), `app/src/thumbnail-renderer.ts` (line 188's `take.kind === "shot"` guard)

**Interfaces:**
- Consumes: `sup.wallpaper(dir, displayId, file)`, `recordingLook`, `displayOfWindow`, `RecordTimeChoices.framing`.
- Produces:

```ts
export interface PendingWallpaper {
  /** Resolves when the read answers; never rejects. */
  settled: Promise<{ file: string } | { error: string }>;
  /** Moves the file into `dir`. Resolves to the outcome, never rejects; a failed move is an `{ error }`. Removes the scratch folder. */
  moveInto(dir: string): Promise<{ file: string } | { error: string }>;
  /** Removes the scratch folder, now or once the read answers. */
  discard(): void;
}
export function startWallpaperRead(
  read: (dir: string, displayId: number, file: string) => Promise<unknown>,
  displayId: number | undefined,
): PendingWallpaper;
```

The scratch folder is `mkdtemp(join(tmpdir(), "stc-wallpaper-"))`, not under the temp takes root, which the sweep and recovery scan. Move with `temp-takes.ts`'s existing cross-volume helper.

- [ ] **Step 1: Write failing tests (with a stub `read` writing a real file)**

- `moveInto` puts `wallpaper.jpg` in the target and removes the scratch folder.
- A rejecting `read` → `settled` is `{ error }`, and `moveInto` is `{ error }`.
- `discard()` before `read` answers → the scratch folder is gone after it answers, and nothing was written elsewhere.
- `moveInto` to a directory that does not exist → `{ error }`, no rejection, scratch removed.
- `displayId` undefined → `{ error }` without calling `read`.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run --project unit app/test/record-wallpaper.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `record-wallpaper.ts`**

- [ ] **Step 4: Wire `recordFlowBody`**

- Before the countdown block, when `outcome.kind === "window" && wantsWallpaper(stored.windowShotLook)`: find the window in `windows`, take its display with `displayOfWindow`, and call `startWallpaperRead`.
- Cancelled countdown, the failed-start `catch` and any early return → `pending?.discard()`.
- Before `sup.startRecording`: `await pending?.settled`.
- After it succeeds: `const wp = await pending?.moveInto(dir)`, then `recordingLook(stored.windowShotLook, stored.lastBackgroundLook, wp)` for window takes only. Pass `framing` to `writeRecordTimeProject`, whose `null` covers other scopes.
- A notice goes in a `Map<string, string>` keyed by dir.

- [ ] **Step 5: Show the notice on the panel**

`presentRecordingPanel` passes `notice` to `presentThumbnail` and deletes the entry. Allow `notice` for recordings in `thumbnail-renderer.ts`; check that a reason line and a notice don't overwrite each other, joining them if they would.

- [ ] **Step 6: Run tests, then commit**

Run: `npx vitest run --project unit app/test && npm run typecheck`
Expected: PASS.

```bash
git add app
git commit -m "STC-626: read the wallpaper during the countdown and seed the take"
```

### Task 5: The Frame control's four looks

**Files:**
- Modify: `app/src/framing-edit.ts`, `app/src/editor.ts`
- Test: `app/test/framing-edit.test.ts`

**Interfaces:**
- Produces: `VideoLookId` gains `"window-shadow" | "wallpaper"`. `videoLooksFor(scopeKind: string | undefined): readonly VideoLook[]`: for `"window"`, returns Just the window (`id: "none"`, label from `WINDOW_SHOT_LOOKS`), Window with shadow, Clean, Dark, Solid, Aurora, Ember, Wallpaper, Custom; otherwise exactly today's `VIDEO_LOOKS`.
- Produces: `withLook(was, id)` handles `"window-shadow"` (`WINDOW_SHADOW_FILL`, preset `clean`) and `"wallpaper"` (`wallpaperFraming()`). `videoLookOf(f, looks = VIDEO_LOOKS)`.

- [ ] **Step 1: Write failing tests**

- `videoLooksFor("display")` deep-equals `VIDEO_LOOKS`; `videoLooksFor("region")` likewise.
- `videoLooksFor("window")` ids in the order above, and `none`'s label is `Just the window`.
- Round trips through `videoLookOf(withLook(…), videoLooksFor("window"))` for every id except custom.
- A solid `#ffffff` framing under display looks → `"custom"`, under window looks → `"window-shadow"`.
- A wallpaper framing under display looks → undefined; under window looks → `"wallpaper"`.
- `withLook` from wallpaper to Clean keeps padding and corners; with the shadow off, it stays off.
- Every `withLook` result passes `framingProblem`.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run --project unit app/test/framing-edit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the pure half**

- [ ] **Step 4: Mount the grid per take**

`editor.ts`'s module-level `frameLooks` becomes a `let`, remounted when a take opens with `videoLooksFor(openSession.anchors.scope?.kind)`, clearing `#framelooks` first. `frameLookOf` passes the same list. The window-shadow swatch uses `chip: "window-shadow"`, and the wallpaper swatch uses the still editor's chip treatment (`has-image` and a blob URL of the take's own file; the same CSS class).

- [ ] **Step 5: Run tests, then commit**

Run: `npx vitest run --project unit app/test && npm run typecheck`
Expected: PASS.

```bash
git add app
git commit -m "STC-626: window takes get the four looks in the Frame control"
```

### Task 6: Picking Wallpaper in the editor

**Files:**
- Modify: `app/src/main.ts`, `app/src/editor-preload.ts`, `app/src/editor.ts`
- Test: e2e in `app/test/` (Task 8), plus a unit test for the extracted rule

**Interfaces:**
- Produces: in main, `ensureWallpaper(dir: string, displayId: number, notice: string): Promise<{ ok: true; file: string } | { ok: false; notice: string }>`, extracted from `still:fetchWallpaper` so both handlers share it, including "an existing file is kept". It lives in `record-wallpaper.ts` with `read` injected, so it can be unit tested.
- Produces: IPC `editor:fetchWallpaper` with no parameters: uses `getOpenTake(e)` and `anchors.display.id`. Bridge: `window.editor.fetchWallpaper()`.

- [ ] **Step 1: Write failing tests for `ensureWallpaper`**

An existing `wallpaper.jpg` → `ok`, and `read` never called (this is Review Focus 5). No file and `read` succeeds → `ok`. `read` rejects → `{ ok: false, notice }`.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run --project unit app/test/record-wallpaper.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement and point `still:fetchWallpaper` at it**

- [ ] **Step 4: Wire `chooseFrameLook`**

For `"wallpaper"`: disable the grid (`setFrameLooksDisabled`), `await window.editor.fetchWallpaper()`. On ok: read the file, `decodeWallpaper`, assign `openSession.wallpaper` (closing any previous one), then `setFraming(withLook(was, "wallpaper"))`. On failure: `setFraming(withLook(was, "clean"))` and show the notice in the Frame pane's hint line, using `WALLPAPER_TAKE_NOTICE`. Re-enable in `finally`.

- [ ] **Step 5: Run tests, then commit**

Run: `npx vitest run --project unit app/test && npm run typecheck`
Expected: PASS.

```bash
git add app
git commit -m "STC-626: pick Wallpaper in the editor on any window take"
```

### Task 7: The identity gate holds on wallpaper

**Files:**
- Create: `fixtures/wallpaper-framed/project.json`, `fixtures/wallpaper-framed/wallpaper.jpg` (small and committed, with a gradient plus edges so a shifted crop would change pixels; generate with `sips` from a test image), `fixtures/wallpaper-framed-missing/project.json`
- Modify: `scripts/identity-gate.mjs` (allow-list and content type), `.github/workflows/ci.yml` (beside line 209's `fixtures/pip-styled` step), `transform/test/schema.test.ts`

**Interfaces:**
- Consumes: Task 2's `sink-identity.ts` fetch.

- [ ] **Step 1: Add the fixtures and the allow-list entry**

The `/session` middleware's list gains `wallpaper.jpg` with `image/jpeg`; a missing file 404s, which `sink-identity.ts` treats as null for this file only. Both fixtures' `project.json` conform to `project-22` (schema test).

- [ ] **Step 2: Run the gate on both, media copied as `ci.yml` does for `pip-styled`**

Run: `npm run gate:identity -- <tmp copy with wallpaper>` and again with `<tmp copy, missing>`.
Expected: both PASS. Then corrupt the framed copy's `wallpaper.jpg` with a truncated file and expect PASS again, drawing `color`.

- [ ] **Step 3: Prove the gate can fail**

Temporarily change `drawChrome` to offset the crop in one sink only (a preview-only branch), run the gate, expect FAIL, and revert. Report the output.

- [ ] **Step 4: Add both runs to CI's gate step, then commit**

```bash
git add fixtures scripts .github transform/test/schema.test.ts
git commit -m "STC-626: gate:identity on a wallpaper background"
```

### Task 8: Settings copy, e2e, Reclaim, grant test, runbook

**Files:**
- Modify: `app/renderer/settings.html`, `app/test/settings-window.e2e.test.ts:68`, `app/test/orphan-sweep.test.ts`, `CLAUDE.md`, `docs/TICKET-LOG.md`
- Create: `app/test/video-window-looks.e2e.test.ts`, `helper/test/video-wallpaper.grant.test.ts`, `docs/STC-626-RUNBOOK.md`

- [ ] **Step 1: Pin Reclaim (spec's most likely trap)**

In `orphan-sweep.test.ts`: a recording bundle with `wallpaper.jpg` inside and its `.mp4` gone from the save folder is still found as an orphan, and a control where an untagged `.mp4` is in the way is `blocked`. Run it. If it fails, fix `findOrphanedBundles`; do not weaken the test.

- [ ] **Step 2: Settings copy**

Section `Windows`, row `Window look`, helper: `Applied when you capture or record a window. Capture background uses the last one you picked in the still editor.` The stored key `windowShotLook` and `save("the window look", …)`. Update the e2e's section list.

- [ ] **Step 3: Write the e2e (CI only, never run locally)**

Through `_record-flow.ts` with the fake helper, which already writes a real `wallpaper.jpg`:
- A window take under default settings opens in the editor with the Wallpaper swatch checked.
- With `STC_CAPTURE_FAULT=wallpaper-unavailable`, Clean is checked and the panel shows `WALLPAPER_TAKE_NOTICE`.
- A display take has no `project.json` framing, and its grid's first swatch reads `None`.

The fake helper's `wallpaper` verb must answer for the record path; extend it if `grep wallpaper app/test/_fake-helper.mjs` shows it only covers `capture-still` and the verb.

- [ ] **Step 4: Write the grant test**

Through the helper's `wallpaper` verb then `start`, with a window scope: `wallpaper.jpg` exists and decodes, and the `wallpaper-unavailable` control returns the error. Add it to `vitest.screencapturekit-files.ts`. Patrick runs it (`npm run test:capture`); the agent shell cannot.

- [ ] **Step 5: Write `docs/STC-626-RUNBOOK.md`**

Short yes/no lines, one per check, with the branch's fetch and checkout commands at the top:
- A clip of each look on a real window.
- Corners on white and on wallpaper, with a small window too.
- A dynamic wallpaper.
- The panel's Copy wears the look.
- The failed-read panel line.
- Older and display takes unchanged.
- Wallpaper GIF looks acceptable?

- [ ] **Step 6: Docs**

Add a CLAUDE.md table row and a `docs/TICKET-LOG.md` row, stating exactly what has and has not been seen running.

- [ ] **Step 7: Final local verification, then commit**

Run: `npm run typecheck && npx vitest run --project unit && npm run gate:still`
Expected: all PASS; report counts.

```bash
git add app helper docs CLAUDE.md vitest.screencapturekit-files.ts
git commit -m "STC-626: Settings copy, e2e, grant test, runbook"
```

- [ ] **Step 8: Open the draft PR**

`git push -u origin HEAD`, `gh pr create --draft --base master`, ending the body with the attribution line. CI runs the e2e suite. Bind it with `ccd_pr`. Do not merge: the ticket's done-when needs Patrick's clips.
