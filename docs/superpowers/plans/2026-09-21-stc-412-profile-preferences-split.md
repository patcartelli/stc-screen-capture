# STC-412: Profile/Preferences split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the main window's "Profile" sheet into a Profile section (per-capture: Scope/Source/Camera/Mic, relocated from the main window) and a Preferences section (global: save folder, panel corner, countdown, shortcuts, shutter sound, a new diagnostics toggle), unify recordings and stills onto one configurable save folder, convert the main window's inline error banner to a toast, and add an explicit dismiss (X/Esc/click-outside) to the post-capture panel.

**Architecture:** Almost entirely a relocation and rewire of existing, already-working pieces — no new windows, no new IPC surfaces beyond three small additions (`toast:message`, `panel:dismiss`, and the folded-in `saveFolder` field). The riskiest mechanical piece is that Scope/Source/Camera/Mic controls move from always-visible main-window rows into a slide-over sheet, which breaks every e2e test that clicks them directly — that sweep is its own task (9) so it doesn't get lost inside the bigger DOM-restructure task (3).

**Tech Stack:** TypeScript, Electron (main + renderer, contextBridge/ipcMain), Vitest (unit + Playwright-driven e2e under `xvfb-run` in this sandbox), no framework — hand-written DOM wiring throughout, following every existing file's own conventions exactly.

**Spec:** `docs/superpowers/specs/2026-09-21-stc-412-profile-preferences-split-design.md`

## Global Constraints

- No multi-profile create/switch/delete UI. "Profile" here is one relocated section, not a profiles system (2026-09-21 Linear scope note).
- Dismiss is a close affordance (X + Escape + click-outside), never a fifth button in the Copy/Save/Edit/Trash row. `actionsFor()`'s four-action output must not change.
- `saveFolder: string | null` — null means "not chosen," resolving to the exact same default `takesRoot()` always computed (`env.STC_RECORDINGS_DIR || ~/Desktop/stc`). An E2E fixture's `STC_RECORDINGS_DIR` isolation must never get written into a persisted `settings.json`.
- Every file this plan touches follows its own file's existing conventions (doc-comment style, split between pure-decision modules and Electron-owning modules, `getElementById`-based wiring) — do not introduce a different pattern.
- Do not touch `editor.ts`/`editor.html`'s own separate `#alert` — out of scope, a different window.
- Do not touch `panel-actions.ts`'s recording-support work in progress on the unmerged `codex/stc-392-validation` branch — this plan builds against master as it stands.

---

### Task 1: Settings model — `saveFolder` and `showDiagnostics`

**Files:**
- Modify: `app/src/settings.ts`
- Test: `app/test/settings.test.ts`

**Interfaces:**
- Produces: `Settings.saveFolder: string | null`, `Settings.showDiagnostics: boolean`, `cleanSaveFolder(v: unknown): string | null` (exported, used by Task 2's callers if needed for symmetry — not required, but keep it exported since `takesRoot` will want the identical rule).
- Removes: `StillSettings.destination` (and its handling in `cleanStill`).

- [ ] **Step 1: Write the failing settings tests**

Replace the `destinationDir`... no — replace the still-destination assertions in `app/test/settings.test.ts`'s `"the still export preferences (STC-293)"` block and add new tests for the two new fields. Edit the block starting at `test("defaults are PNG, native scale, metadata kept, and no chosen folder"...)`:

```ts
  test("defaults are PNG, native scale, metadata kept", () => {
    const s = readSettings(dir()).still;
    expect(s.format).toBe("png");
    expect(s.scale).toBe("native");
    expect(s.stripMetadata).toBe(false);
    expect(s.template).toContain("{date}");
  });
```

Remove the three tests that reference `.still.destination` entirely: `"the destination folder is sticky"`, `"changing the format does NOT drop the destination folder"`, and `"a relative destination is treated as unset, never resolved against the cwd"`. Keep `"a still preference survives an unrelated camera change"`, `"an unknown format or scale falls back rather than reaching the encoder"`, `"an empty template falls back..."`, and `"a still block of the wrong shape falls back whole"` — none of those reference `.destination`.

Then add a new describe block, right after the still-preferences block:

```ts
/**
 * STC-412: one save location for both recordings and stills, replacing
 * StillSettings.destination and the "beside the shot" concept.
 */
describe("the save folder (STC-412)", () => {
  test("defaults to null — 'not chosen', which takesRoot() resolves the same way it always has", () => {
    expect(readSettings(dir()).saveFolder).toBeNull();
    expect(DEFAULT_SETTINGS.saveFolder).toBeNull();
  });

  test("round-trips an absolute path", () => {
    const d = dir();
    writeSettings(d, { saveFolder: "/Users/me/Captures" });
    expect(readSettings(d).saveFolder).toBe("/Users/me/Captures");
  });

  test("a relative path is treated as unset, never resolved against the cwd", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ saveFolder: "Captures" }));
    expect(readSettings(d).saveFolder).toBeNull();
  });

  test("clearing it back to null is a real, storable choice", () => {
    const d = dir();
    writeSettings(d, { saveFolder: "/Users/me/Captures" });
    writeSettings(d, { saveFolder: null });
    expect(readSettings(d).saveFolder).toBeNull();
  });

  test("a partial update leaves it alone", () => {
    const d = dir();
    writeSettings(d, { saveFolder: "/Users/me/Captures" });
    writeSettings(d, { camera: true });
    expect(readSettings(d).saveFolder).toBe("/Users/me/Captures");
  });
});

describe("the diagnostics toggle (STC-412)", () => {
  test("defaults to off — developer instrumentation, not a normal control", () => {
    expect(readSettings(dir()).showDiagnostics).toBe(false);
    expect(DEFAULT_SETTINGS.showDiagnostics).toBe(false);
  });

  test("round-trips, and being on survives a restart", () => {
    const d = dir();
    writeSettings(d, { showDiagnostics: true });
    expect(readSettings(d).showDiagnostics).toBe(true);
  });

  test("a non-boolean is not a preference, and falls back to OFF not to silence", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ showDiagnostics: "yes" }));
    expect(readSettings(d).showDiagnostics).toBe(false);
  });

  test("a partial update leaves it alone", () => {
    const d = dir();
    writeSettings(d, { showDiagnostics: true });
    writeSettings(d, { camera: true });
    expect(readSettings(d).showDiagnostics).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/test/settings.test.ts`
Expected: FAIL — `saveFolder`/`showDiagnostics` do not exist on `Settings`, `DEFAULT_SETTINGS`.

- [ ] **Step 3: Add the fields to `settings.ts`**

In the `Settings` interface, add after the `scope` field's closing:

```ts
  /**
   * Where recordings and stills are saved, or null for "not chosen yet" —
   * which resolves to the same default takesRoot() always computed
   * (env.STC_RECORDINGS_DIR || ~/Desktop/stc), so an untouched install
   * behaves identically to before this field existed, and an E2E fixture's
   * STC_RECORDINGS_DIR isolation never gets baked into a persisted
   * settings.json. Replaces StillSettings.destination and the "beside the
   * shot" concept (STC-412): there is one save location, not a per-still
   * override.
   */
  saveFolder: string | null;
  /**
   * Whether the diagnostics table (helper pid, frame counts, event counts,
   * …) is shown on the main window (STC-412). Off by default — developer
   * instrumentation, not something a normal user needs in view.
   */
  showDiagnostics: boolean;
```

Remove `destination: string | null;` and its doc comment from `StillSettings`.

In `DEFAULT_STILL_SETTINGS`, remove `destination: null,`.

In `DEFAULT_SETTINGS`, add:

```ts
  saveFolder: null, showDiagnostics: false,
```

Add the cleaner function, near `cleanDisplayId`:

```ts
/**
 * An absolute path is trusted; anything else (relative, missing, garbage)
 * is null — "not chosen" — never resolved against the process's cwd.
 */
function cleanSaveFolder(v: unknown): string | null {
  return typeof v === "string" && v.startsWith("/") ? v : null;
}
```

In `cleanStill`, remove the `destination` computation and its field from the returned object.

In `readSettings`'s returned object, add:

```ts
    saveFolder: cleanSaveFolder(doc.saveFolder),
    showDiagnostics: typeof doc.showDiagnostics === "boolean"
      ? doc.showDiagnostics : DEFAULT_SETTINGS.showDiagnostics,
```

In `writeSettings`'s `clean` object, add the identical two lines (reading from `merged` instead of `doc`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/test/settings.test.ts`
Expected: PASS, all tests including the two new describe blocks.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: fails right now — `still-io.ts`, `main.ts`, `thumbnail-renderer.ts` all still reference `StillSettings.destination`. That's expected; Task 2 fixes those. Confirm the *only* errors are about `.destination` not existing on `StillSettings`/the still-block type, nothing else.

- [ ] **Step 6: Commit**

```bash
git add app/src/settings.ts app/test/settings.test.ts
git commit -m "STC-412: settings gain saveFolder and showDiagnostics, still.destination retired"
```

---

### Task 2: Save-location plumbing

**Files:**
- Modify: `app/src/takes.ts`, `app/src/library.ts`, `app/src/temp-takes.ts`, `app/src/still-io.ts`, `app/src/main.ts`, `app/src/preload.ts`
- Test: `app/test/takes.test.ts`, `app/test/still-io.test.ts`, `app/test/library.e2e.test.ts` (imports `StillSettings` — check it doesn't reference `.destination`)

**Interfaces:**
- Consumes: `Settings.saveFolder` (Task 1).
- Produces: `takesRoot(env, saveFolder): string`, `insideTakesRoot(env, saveFolder, dir): boolean`, `destinationDir(saveFolder, target, fallbackDir, cacheRoot): string`, `exportStill(send, req, settings, saveFolder, cacheRoot): Promise<ExportResult>`.

- [ ] **Step 1: Write the failing `takesRoot` tests**

In `app/test/takes.test.ts`, replace the `describe("where recordings go", ...)` block's four tests:

```ts
describe("where recordings go", () => {
  test("defaults to ~/Desktop/stc when nothing is chosen and no env override exists", () => {
    expect(takesRoot({}, null)).toBe(join(homedir(), "Desktop", "stc"));
  });

  test("never defaults into a temp directory that the OS sweeps", () => {
    const original = process.env.TMPDIR;
    delete process.env.TMPDIR;
    expect(takesRoot({}, null)).not.toMatch(/\/var\/folders|\/tmp|[/\\]T$/);
    if (original !== undefined) process.env.TMPDIR = original;
  });

  test("a chosen saveFolder wins over everything else", () => {
    expect(takesRoot({ STC_RECORDINGS_DIR: "/somewhere/else" }, "/chosen/folder"))
      .toBe("/chosen/folder");
  });

  test("STC_RECORDINGS_DIR overrides the default when nothing is chosen — tests need not litter the Desktop", () => {
    expect(takesRoot({ STC_RECORDINGS_DIR: "/somewhere/else" }, null)).toBe("/somewhere/else");
  });

  test("take directories are timestamped, sortable and collision-free", () => {
    // unchanged body — takesRoot(env) calls below become takesRoot(env, null)
  });
});
```

(Keep that last test's body as-is except updating any internal `takesRoot(...)` call to pass `null` as the second argument — check the file for exact usage before editing.)

Update `describe("insideTakesRoot (STC-293 review)", ...)`'s five tests the same way: every `insideTakesRoot(env, dir)` call becomes `insideTakesRoot(env, null, dir)` (or with a `/somewhere/else` env override where the test already sets one, still passing `null` as the middle argument unless that specific test is about `saveFolder` winning).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/test/takes.test.ts`
Expected: FAIL — wrong arity / TS errors (this file is checked by `npm run typecheck` too, but vitest transpiles without typechecking, so failures here will be runtime "expected X, got Y" or the old two-arg calls silently ignoring the new signature if you haven't changed `takesRoot`'s implementation yet — verify by reading the failure, then proceed).

- [ ] **Step 3: Update `takes.ts`**

```ts
export function insideTakesRoot(env: NodeJS.ProcessEnv, saveFolder: string | null, dir: string): boolean {
  if (typeof dir !== "string" || dir.length === 0) return false;
  const root = resolve(takesRoot(env, saveFolder));
  const target = resolve(dir);
  return target !== root && (target + sep).startsWith(root + sep);
}

/**
 * Where recordings live. `saveFolder` (STC-412's settings field) wins when
 * set; otherwise the same default this always computed —
 * env.STC_RECORDINGS_DIR, or ~/Desktop/stc. Deliberately NOT os.tmpdir(): on
 * macOS that is /var/folders/.../T, which the system purges on boot and
 * sweeps for files untouched for ~3 days. A take is the thing the user
 * made — it is a deliverable, not scratch, and must not sit somewhere it
 * can silently disappear.
 */
export function takesRoot(env: NodeJS.ProcessEnv, saveFolder: string | null): string {
  return saveFolder || env.STC_RECORDINGS_DIR || join(homedir(), "Desktop", "stc");
}
```

Find every other call to `takesRoot(` or `insideTakesRoot(` inside `takes.ts` itself (e.g. inside `newTakeDir`, `duplicateTake`) and thread a `saveFolder: string | null` parameter through those functions' own signatures too, defaulting nothing — every exported function in this file that resolves the root must accept and pass the value through, the same way it already threads `env`. Check with:

```bash
grep -n "takesRoot(\|insideTakesRoot(" app/src/takes.ts
```

and update each call site and enclosing function signature found.

- [ ] **Step 4: Update `library.ts` and `temp-takes.ts` call sites**

```bash
grep -n "takesRoot(\|insideTakesRoot(" app/src/library.ts app/src/temp-takes.ts
```

For each exported function found (`listLibrary`, `listTakes` in `library.ts`; `promoteTake` and any other caller in `temp-takes.ts`), add a `saveFolder: string | null` parameter (after `env`, matching `takesRoot`'s own order) and pass it through to the `takesRoot`/`insideTakesRoot` call inside.

- [ ] **Step 5: Update every `main.ts` caller**

```bash
grep -n "takesRoot(\|insideTakesRoot(\|listTakes(\|listLibrary(\|promoteTake(" app/src/main.ts
```

At each call site, read the settings the handler already has in scope (most handlers already call `readSettings(app.getPath("userData"))` for something — reuse that value rather than re-reading) and pass `.saveFolder`. Where a handler doesn't already read settings, add `const { saveFolder } = readSettings(app.getPath("userData"));` right before the call.

- [ ] **Step 6: Run `takes.test.ts` again**

Run: `npx vitest run app/test/takes.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing `destinationDir`/`exportStill` tests**

In `app/test/still-io.test.ts`, the `settings()` helper currently returns a `StillSettings` including `.destination`; `destinationDir`'s signature is changing to take `saveFolder: string | null` as its first argument directly, so every call site in this file needs updating. Replace the helper and the `"where a still goes (STC-293)"` block:

```ts
const settings = (over: Partial<StillSettings> = {}): StillSettings =>
  ({ ...DEFAULT_STILL_SETTINGS, ...over });

describe("where a still goes (STC-412)", () => {
  const both = { file: true, clipboard: true };
  const copyOnly = { file: false, clipboard: true };

  test("a save with no chosen saveFolder lands beside the shot", () => {
    expect(destinationDir(null, { file: true, clipboard: false }, "/takes/shot-1", cache))
      .toBe("/takes/shot-1");
  });

  test("a chosen saveFolder wins over the shot's own directory", () => {
    expect(destinationDir("/Users/me/Shots",
                          { file: true, clipboard: false }, "/takes/shot-1", cache))
      .toBe("/Users/me/Shots");
  });

  test("a COPY never writes into the user's folders", () => {
    expect(destinationDir("/Users/me/Shots", copyOnly, "/takes/shot-1", cache))
      .toBe(join(cache, CLIPBOARD_SUBDIR));
  });

  test("a directory that does not exist is empty, not an error", async () => {
    expect(await namesIn(join(cache, "does-not-exist"))).toEqual([]);
  });
});
```

(Keep the exact bodies of the third and fourth tests as they already are in the file if they differ from this sketch — read the current file first and preserve any assertions beyond the destination change; only the `settings(...)` wrapper around `destinationDir`'s first argument is being replaced with a bare string/null.)

Every remaining `exportStill(...)` call in this test file currently passes `settings(...)` as the third argument and `cache` as the fourth. Update each to pass `settings(...)` as the third argument, a `saveFolder` value (usually `null`, or an explicit folder where the test is about a chosen destination — check each test's intent) as a new fourth argument, and `cache` as the fifth. Find them with:

```bash
grep -n "exportStill(" app/test/still-io.test.ts
```

and update each one, reading the surrounding test to decide whether it wants `null` or a specific folder string.

- [ ] **Step 8: Run to verify failure**

Run: `npx vitest run app/test/still-io.test.ts`
Expected: FAIL — signature mismatch.

- [ ] **Step 9: Update `still-io.ts`**

```ts
export function destinationDir(saveFolder: string | null,
                               target: ExportTarget,
                               fallbackDir: string | undefined,
                               cacheRoot: string): string {
  if (!target.file) return join(cacheRoot, CLIPBOARD_SUBDIR);
  if (saveFolder) return saveFolder;
  if (fallbackDir) return fallbackDir;
  return join(cacheRoot, CLIPBOARD_SUBDIR);
}
```

```ts
export async function exportStill(send: SendExport, req: ExportRequest,
                                  settings: StillSettings,
                                  saveFolder: string | null,
                                  cacheRoot: string): Promise<ExportResult> {
  ...
  const dir = destinationDir(saveFolder, req.target, req.fallbackDir, cacheRoot);
  ...
```

(Only the `destinationDir(settings, ...)` call inside changes to `destinationDir(saveFolder, ...)`; everything else in the function body is unchanged.)

- [ ] **Step 10: Update `main.ts`'s two `exportStill` callers**

At `still:export` (around line 1446), change:

```ts
  const stored = readSettings(app.getPath("userData")).still;
```
to:
```ts
  const settingsNow = readSettings(app.getPath("userData"));
  const stored = settingsNow.still;
```

and change the `exportStill(...)` call's `stored, app.getPath("temp"))` tail to `stored, settingsNow.saveFolder, app.getPath("temp"))`.

At `still:dragFile` (around line 1609), same change: read the full settings object once, keep `stored = settingsNow.still` for `resolveExportOptions`, and add `settingsNow.saveFolder` as the new argument before `app.getPath("temp")` in the `exportStill(...)` call.

- [ ] **Step 11: Fix `still:chooseDestination` and delete `still:clearDestination`**

Replace the `still:chooseDestination` handler body:

```ts
ipcMain.handle("still:chooseDestination", async () => {
  if (!win) throw new Error("no window");
  const current = readSettings(app.getPath("userData")).saveFolder;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Where should recordings and shots be saved?",
    properties: ["openDirectory", "createDirectory"],
    ...(current ? { defaultPath: current } : {}),
    buttonLabel: "Choose",
  });
  if (canceled || !filePaths[0]) return { saveFolder: current };
  const saveFolder = filePaths[0];
  writeSettings(app.getPath("userData"), { saveFolder });
  return { saveFolder };
});
```

Delete the `still:clearDestination` handler entirely (the `/** Back to "beside the shot"... */` block and its `ipcMain.handle(...)`) — "beside the shot" is retired per the design.

In `app/src/preload.ts`, change:
```ts
  chooseStillDestination: () => ipcRenderer.invoke("still:chooseDestination"),
  clearStillDestination: () => ipcRenderer.invoke("still:clearDestination"),
```
to just:
```ts
  chooseStillDestination: () => ipcRenderer.invoke("still:chooseDestination"),
```
(delete the `clearStillDestination` line).

- [ ] **Step 12: Fix `thumbnail-renderer.ts`'s stale `getSettings` type**

Change:
```ts
      getSettings(): Promise<{ still: ExportOptions & { destination: string | null } }>;
```
to:
```ts
      getSettings(): Promise<{ still: ExportOptions; saveFolder: string | null }>;
```
None of the three call sites (`draw`, `runExport`, `refreshDragFile`) read `.destination` off the result — confirmed by reading the file — so no other change is needed there.

- [ ] **Step 13: Run the full still-io and settings suites**

Run: `npx vitest run app/test/still-io.test.ts app/test/settings.test.ts app/test/takes.test.ts`
Expected: PASS.

- [ ] **Step 14: Typecheck**

Run: `npm run typecheck`
Expected: clean, or only errors in files this plan hasn't reached yet (Task 3's `renderer.ts` still calls `recorder.clearStillDestination()` and reads `.still.destination` — expected to still error until Task 3 lands; confirm no *other* unrelated errors).

- [ ] **Step 15: Fix six e2e fixtures that seed `still.destination` directly on disk**

`Settings` parsing never throws on an unknown field, so these six files will not error — they will silently seed a value `cleanStill` no longer reads, leaving `saveFolder` at its `null` default while each test still expects its export to land in the folder it seeded. Found via `grep -rln 'still.*destination\|destination.*still' app/test/*.ts` — a real blast-radius item the design doc's file-by-file search missed because it only grepped `.ts` **source**, not JSON literals inside test fixtures.

In `app/test/_editor-fixture.ts` (around line 25-27):
```ts
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    saveFolder: null,
  }));
```
Update the doc comment above it (currently "`still.destination` is seeded to `null` explicitly...") to say `saveFolder` instead of `still.destination` — same claim, new field name.

In `app/test/library.e2e.test.ts` (around line 40-41):
```ts
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    saveFolder: destDir,
  }));
```
Update the comment above it ("`recorder:setSettings` deliberately strips `still.destination`") to name `saveFolder` instead — check `recorder:setSettings`'s handler in `main.ts` actually still strips it the same way (it should, since `saveFolder` is a plain top-level field like `camera`/`displayId`, written the same way); if the strip logic was specific to `still.*`, note that in the comment rather than assuming.

In `app/test/nothing-lost.e2e.test.ts` (around line 96-97), same substitution:
```ts
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    saveFolder: destDir,
  }));
```
and update its comment the same way.

In `app/test/panel-waits.e2e.test.ts` (line 138-139):
```ts
  writeFileSync(join(userData, "settings.json"),
                JSON.stringify({ saveFolder: destDir }));
```

In `app/test/redaction.e2e.test.ts` (around line 39-40), same substitution and comment update:
```ts
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    saveFolder: destDir,
  }));
```

In `app/test/thumbnail.e2e.test.ts` (around line 61-63):
```ts
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    saveFolder: destDir,
  }));
```
and update its comment (currently "`still.destination` is seeded to... never through `recorder:setSettings`... strips `still.destination`") to name `saveFolder`.

Three more files reference `still.destination` only in prose/comments, not in a functional JSON seed — update the wording for accuracy but check first whether any functional change is also needed:
- `app/test/e2e-user-data-isolation.test.ts` (lines 11, 14) — comment only, confirm with `grep -n "still" app/test/e2e-user-data-isolation.test.ts` that nothing else in the file constructs a `still.destination` fixture.
- `app/test/share.e2e.test.ts` (lines 37, 145) — comment only, same confirmation.
- `app/test/rename-migration.e2e.test.ts` (line 16) — comment describing what STC-397's migration copies; the migration copies `settings.json` wholesale regardless of its shape, so no functional change, comment wording only.

- [ ] **Step 16: Run every touched file**

Run: `npx vitest run app/test/settings.test.ts app/test/takes.test.ts app/test/still-io.test.ts`
Run: `xvfb-run -a npx vitest run app/test/library.e2e.test.ts app/test/nothing-lost.e2e.test.ts app/test/panel-waits.e2e.test.ts app/test/redaction.e2e.test.ts app/test/thumbnail.e2e.test.ts app/test/e2e-user-data-isolation.test.ts app/test/share.e2e.test.ts app/test/rename-migration.e2e.test.ts`
Expected: PASS across all. `_editor-fixture.ts` has no tests of its own — it's exercised indirectly through whatever files import `launchApp` from it (`grep -rl "_editor-fixture" app/test/*.e2e.test.ts`); run those too.

- [ ] **Step 17: Typecheck, then commit**

Run: `npm run typecheck` — expected clean (same caveat as Step 14 about Task 3's not-yet-landed pieces).

```bash
git add app/src/takes.ts app/src/library.ts app/src/temp-takes.ts app/src/still-io.ts app/src/main.ts app/src/preload.ts app/src/thumbnail-renderer.ts app/test/takes.test.ts app/test/still-io.test.ts app/test/_editor-fixture.ts app/test/library.e2e.test.ts app/test/nothing-lost.e2e.test.ts app/test/panel-waits.e2e.test.ts app/test/redaction.e2e.test.ts app/test/thumbnail.e2e.test.ts app/test/e2e-user-data-isolation.test.ts app/test/share.e2e.test.ts app/test/rename-migration.e2e.test.ts
git commit -m "STC-412: recordings and stills resolve through one saveFolder setting"
```

---

### Task 3: Sheet restructure — Settings button, Profile + Preferences sections

**Files:**
- Modify: `app/renderer/index.html`, `app/src/renderer.ts`

**Interfaces:**
- Consumes: `Settings.saveFolder`, `Settings.showDiagnostics` (Task 1); `recorder.getSettings()`/`recorder.setSettings()` (unchanged bridge).
- Produces: no new exports — a DOM/wiring change only. Element ids named below become load-bearing for Tasks 6 and 9.

- [ ] **Step 1: Move markup in `index.html`**

Rename the sheet-opening button and its title:

```html
  <div class="row" id="record-row">
    <button id="record">Record</button>
    <button id="pill" aria-label="Stop recording">
      <span id="pill-dot" aria-hidden="true"></span>
      <span id="pill-timer">00:00</span>
      <span id="pill-meter" aria-hidden="true"></span>
      <span id="pill-stop" aria-hidden="true"></span>
    </button>
    <button id="capturestill" title="Select an area or a window and take one shot">Shot</button>
    <button id="settings" title="Profile, preferences and shortcuts">Settings</button>
    <span id="state">starting…</span>
  </div>
```

(The `camera-label`/`mic-label` elements are REMOVED from this row — they move into the sheet below. `id="profile"` becomes `id="settings"` and its label text changes from "Profile" to "Settings".)

Remove the standalone Scope/Source `<div class="row">` block that currently follows `#record-row` (the one containing `#scope`, `#display-label`, `#window-source`, `#region-source`) — its contents move into the sheet in the next edit.

Replace the `<aside id="profilesheet">` block's opening and first section:

```html
  <aside id="profilesheet">
    <div class="row" id="profilesheet-head">
      <h1>Settings</h1>
      <button id="profileclose" aria-label="Close">×</button>
    </div>

    <h2>Profile</h2>
    <div class="row">
      <label>Scope <select id="scope">
        <option value="display">Screen</option>
        <option value="window">Window</option>
        <option value="region">Area</option>
      </select></label>
      <label id="display-label">Source <select id="display"><option value="">Automatic</option></select></label>
      <span id="window-source" class="row" hidden>
        <span id="window-source-label" class="sourcelabel">No window chosen</span>
        <button id="pickwindow">Choose window…</button>
        <button id="clearwindow" title="Forget the chosen window">Clear</button>
      </span>
      <span id="region-source" class="row" hidden>
        <span id="region-source-label" class="sourcelabel">No area chosen</span>
        <button id="pickregion">Choose area…</button>
        <button id="clearregion" title="Forget the chosen area">Clear</button>
      </span>
    </div>
    <div class="row">
      <label id="camera-label"><input type="checkbox" id="camera"> Camera</label>
      <label id="mic-label">Mic <select id="mic"><option value="">Off</option></select></label>
    </div>

    <h2>Preferences</h2>
```

(Everything from the original `<h2>Shot</h2>` heading through the closing `</aside>` stays exactly where it is, immediately after the new `<h2>Preferences</h2>` line — only the two new blocks above are inserted, and the original standalone Scope/Source row and `camera-label`/`mic-label` labels are deleted from `#record-row`'s area since they now live here instead.)

- [ ] **Step 2: Remove the "beside the shot" button**

Within the (now Preferences-section) `.stillrow` for "Saving to", delete the `#stillcleardest` button:

```html
    <div class="stillrow">
      <span>Saving to</span>
      <span id="stilldest">beside the shot</span>
      <button id="stillchoosedest">Change…</button>
    </div>
```

- [ ] **Step 3: Update `renderer.ts`'s profile-button binding**

```ts
const profileBtn = $("settings") as HTMLButtonElement;
```

(The variable name `profileBtn` can stay — it's an internal identifier, not user-facing — but the `$("profile")` lookup must become `$("settings")` to match the renamed id. `profileSheet`/`profileCloseBtn`/`setProfileOpen` and the click/Escape wiring below them are unchanged, since `#profilesheet`/`#profileclose` kept their ids.)

- [ ] **Step 4: Update `showDestination`/`loadStillPreferences` for `saveFolder`**

```ts
function showDestination(dest: string | null): void {
  $("stilldest").textContent = dest ?? "beside the shot";
}
```

stays as-is (it's just a display helper), but its caller changes:

```ts
async function loadStillPreferences(): Promise<void> {
  const { thumbnail, countdownMs, saveFolder } = await recorder.getSettings();
  showDestination(saveFolder);
  thumbCornerSel.value = thumbnail.corner;
  thumbSkipBox.checked = thumbnail.skip;
  countdownSel.value = COUNTDOWN_OPTIONS.some((o) => o.ms === countdownMs)
    ? String(countdownMs) : "";
}
```

(`still` is no longer destructured here since nothing in this function reads it any more — `still.destination` is gone. If any linter complains about an unused import elsewhere because of this, leave other `still.*` usages alone; this function alone changes.)

- [ ] **Step 5: Update the destination button handlers**

```ts
$("stillchoosedest").addEventListener("click", async () => {
  showDestination((await recorder.chooseStillDestination()).saveFolder);
});
```

Delete the `$("stillcleardest").addEventListener(...)` block entirely.

- [ ] **Step 6: Update `preload.ts`'s type declaration for `getSettings`/`chooseStillDestination`** (if renderer.ts's own `declare global` block types these — check)

```bash
grep -n "chooseStillDestination\|clearStillDestination\|interface.*Recorder\|getSettings" app/src/renderer.ts | head -20
```

If `renderer.ts` declares a local interface for the `recorder` bridge (it likely does, near the top, mirroring `preload.ts`'s `exposeInMainWorld` shape), update `chooseStillDestination(): Promise<{ destination: string | null }>` to `chooseStillDestination(): Promise<{ saveFolder: string | null }>` and delete the `clearStillDestination` line from that interface too.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean except for anything Task 4/5/6 haven't reached (diagnostics toggle markup doesn't exist yet, which is fine — nothing references it yet).

- [ ] **Step 8: Add the e2e test for the restructured sheet**

Create or extend an e2e test asserting the new layout — find the existing profile-sheet e2e coverage first:

```bash
grep -rl "#profilesheet\|profilesheet" app/test/*.e2e.test.ts
```

In whichever file already exercises the sheet (or a new `app/test/settings-sheet.e2e.test.ts` if none does — model its `launch()` helper on `camera-toggle.e2e.test.ts`'s), add:

```ts
test("the sheet holds Profile and Preferences as two sections, and Scope/Camera/Mic live there now", async () => {
  const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: makeTakeFolder().dir });
  // Not directly clickable before the sheet opens — this is the ticket's own
  // acceptance property, and the negative check matters as much as the
  // positive one below.
  await expect(win.locator("#scope")).not.toBeVisible();
  await win.click("#settings");
  await expect(win.locator("#profilesheet")).toHaveClass(/open/);
  const headings = await win.locator("#profilesheet h2").allTextContents();
  expect(headings).toContain("Profile");
  expect(headings).toContain("Preferences");
  expect(headings.indexOf("Profile")).toBeLessThan(headings.indexOf("Preferences"));
  await expect(win.locator("#scope")).toBeVisible();
  await expect(win.locator("#camera")).toBeVisible();
  await expect(win.locator("#mic")).toBeVisible();
  await expect(win.locator("#stillcleardest")).toHaveCount(0);
});
```

Adjust imports (`mkdtempSync`, `join`, `tmpdir`, `makeTakeFolder`) to match whatever the target file already imports.

- [ ] **Step 9: Run the new e2e test**

Run: `xvfb-run -a npx vitest run <the file> -t "Profile and Preferences"`
Expected: PASS. (If it fails because `#scope`'s pre-open visibility check is wrong for Playwright's definition of "visible" on a `translateX`'d element, that is real information — adjust the assertion to match what Playwright actually reports, but keep the *intent*: scope/camera/mic are not usable before the sheet opens.)

- [ ] **Step 10: Commit**

```bash
git add app/renderer/index.html app/src/renderer.ts app/test/
git commit -m "STC-412: sheet becomes Settings, with Profile and Preferences sections"
```

---

### Task 4: Diagnostics toggle

**Files:**
- Modify: `app/renderer/index.html`, `app/src/renderer.ts`

**Interfaces:**
- Consumes: `Settings.showDiagnostics` (Task 1).

- [ ] **Step 1: Give the diagnostics table an id and default-hide it**

In `index.html`, change:
```html
  <table>
```
to:
```html
  <table id="diagnostics" hidden>
```

Add the toggle checkbox to the Preferences section — right after the `<h2>Preferences</h2>` heading added in Task 3, or wherever reads most naturally beside the other Preferences controls (adjacent to shutter sound is reasonable, since both are small booleans):

```html
    <div class="stillrow">
      <label title="Show helper pid, frame/drop counts and event counts on the main window">
        <input type="checkbox" id="showdiagnostics"> Show diagnostics</label>
    </div>
```

- [ ] **Step 2: Wire it in `renderer.ts`**

Near the other Preferences bindings (beside `thumbCornerSel`/`thumbSkipBox`):

```ts
const showDiagnosticsBox = $("showdiagnostics") as HTMLInputElement;
const diagnosticsTable = $("diagnostics") as HTMLTableElement;
```

In `loadStillPreferences` (Task 3's version), add the field and apply it:

```ts
async function loadStillPreferences(): Promise<void> {
  const { thumbnail, countdownMs, saveFolder, showDiagnostics } = await recorder.getSettings();
  showDestination(saveFolder);
  thumbCornerSel.value = thumbnail.corner;
  thumbSkipBox.checked = thumbnail.skip;
  showDiagnosticsBox.checked = showDiagnostics;
  diagnosticsTable.hidden = !showDiagnostics;
  countdownSel.value = COUNTDOWN_OPTIONS.some((o) => o.ms === countdownMs)
    ? String(countdownMs) : "";
}
```

Add the change handler:

```ts
showDiagnosticsBox.addEventListener("change", async () => {
  diagnosticsTable.hidden = !showDiagnosticsBox.checked;
  await recorder.setSettings({ showDiagnostics: showDiagnosticsBox.checked });
});
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Extend the sheet e2e test**

In the test written in Task 3 Step 8, add:

```ts
  await expect(win.locator("#diagnostics")).toBeHidden();
  await win.check("#showdiagnostics");
  await expect(win.locator("#diagnostics")).toBeVisible();
```

- [ ] **Step 5: Run it**

Run: `xvfb-run -a npx vitest run <the file> -t "Profile and Preferences"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/renderer/index.html app/src/renderer.ts app/test/
git commit -m "STC-412: diagnostics table gated behind a Preferences toggle"
```

---

### Task 5: Toast generalization

**Files:**
- Modify: `app/src/toast-window.ts`, `app/renderer/toast.html`, `app/src/toast-renderer.ts`

**Interfaces:**
- Produces: `showMessageToast(text: string, opts: ToastWindowOptions): void`, `hideToast(): void` (renamed from `hideUndoToast` — both undo and message toasts share one "current toast" slot).
- Consumes: nothing new — `Corner`/`positionFor`/`PANEL_WINDOW_TYPE` already imported.

- [ ] **Step 1: Refactor `toast-window.ts`**

```ts
export interface ToastWindowOptions {
  corner: Corner;
  /** Where `toast-preload.cjs` lives (`here` in main.ts). */
  dist: string;
  /** Where `toast.html` lives (`join(here, "..", "renderer")`). */
  rendererDir: string;
}

export interface ShowUndoToastOptions extends ToastWindowOptions {
  /** The take this toast is about — never shown, only echoed back on Undo. */
  dir: string;
}

/** How long a plain message toast stays up — no Undo, so no promise to keep. */
export const MESSAGE_TOAST_MS = 4_000;

let current: { win: BrowserWindow; timer: NodeJS.Timeout } | undefined;

function buildToastWindow(opts: ToastWindowOptions, query: Record<string, string>): BrowserWindow {
  hideToast();
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const { x, y } = positionFor(opts.corner, workArea, TOAST_SIZE);
  const win = new BrowserWindow({
    x, y, width: TOAST_SIZE.width, height: TOAST_SIZE.height,
    transparent: true, frame: false, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true,
    type: PANEL_WINDOW_TYPE,
    show: false,
    webPreferences: {
      preload: join(opts.dist, "toast-preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(join(opts.rendererDir, "toast.html"), { query });
  win.once("ready-to-show", () => win.showInactive());
  win.on("closed", () => { if (current?.win === win) current = undefined; });
  return win;
}

export function showUndoToast(opts: ShowUndoToastOptions): void {
  const win = buildToastWindow(opts, { mode: "undo", dir: opts.dir, ms: String(UNDO_WINDOW_MS) });
  const timer = setTimeout(() => {
    if (!win.isDestroyed()) win.webContents.send("toast:expire");
    hideToast();
  }, UNDO_WINDOW_MS);
  current = { win, timer };
}

/**
 * A plain notice — no Undo, no promise, auto-dismisses after
 * MESSAGE_TOAST_MS. Replaces the main window's inline #alert banner
 * (STC-412) for warnings that reach the user off the reliable channel.
 */
export function showMessageToast(text: string, opts: ToastWindowOptions): void {
  const win = buildToastWindow(opts, { mode: "message", text, ms: String(MESSAGE_TOAST_MS) });
  const timer = setTimeout(hideToast, MESSAGE_TOAST_MS);
  current = { win, timer };
}

/** Take the toast off screen right now, if one is up — undo or message alike. */
export function hideToast(): void {
  if (!current) return;
  clearTimeout(current.timer);
  const { win } = current;
  current = undefined;
  if (!win.isDestroyed()) win.destroy();
}
```

Delete the old `showUndoToast`/`hideUndoToast` bodies you're replacing (keep the module doc comment at the top of the file — update its "It does NOT take focus" and "One instance" sections only if they now read as undo-specific in a way that's misleading; both already describe behavior that still holds for the message toast too, so they likely need no change beyond maybe adding one sentence noting the message toast shares the same window class).

- [ ] **Step 2: Update `toast.html`**

Make the label and the undo row conditional on mode. Since there's no inline script (CSP), do this by having `toast-renderer.ts` set `hidden` and `textContent` from JS rather than templating the HTML — so the HTML markup itself barely changes:

```html
  <div id="card">
    <div id="row">
      <span id="label">Deleted</span>
      <button id="undo" type="button">Undo</button>
    </div>
    <div id="bar-track"><div id="bar"></div></div>
  </div>
```

stays exactly as-is; Step 3 makes `toast-renderer.ts` hide `#undo` and set `#label`'s text when `mode=message`.

- [ ] **Step 3: Update `toast-renderer.ts`**

```ts
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") ?? "undo";
const dir = params.get("dir") ?? "";
const ms = Number(params.get("ms") ?? "0");
const text = params.get("text") ?? "";

const bar = document.getElementById("bar") as HTMLDivElement;
const label = document.getElementById("label") as HTMLSpanElement;
const undoBtn = document.getElementById("undo") as HTMLButtonElement;

if (mode === "message") {
  label.textContent = text;
  undoBtn.hidden = true;
}
```

Place this near the top, before the `applyBarMotion`/`reducedMotion` section (which still runs for both modes — a message toast's bar drains the same way, just over `MESSAGE_TOAST_MS` instead of `UNDO_WINDOW_MS`, since both pass their own `ms` through the identical query param). The existing `undoBtn.addEventListener("click", ...)` and `window.toast.onExpire(...)` wiring stay as-is — they're simply unreachable/inert when `#undo` is hidden, which is fine and matches this codebase's "the button decides, not a second code path" style used elsewhere (e.g. `countdownFired`).

- [ ] **Step 4: Update `main.ts`'s import and the two existing call sites**

```ts
import { showUndoToast, hideToast } from "./toast-window.js";
```

Every existing `hideUndoToast()` call in `main.ts` becomes `hideToast()`:

```bash
grep -n "hideUndoToast(" app/src/main.ts
```

Update each occurrence found.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Write a unit test for the mode branching**

There's no existing unit test file for `toast-window.ts` (it's Electron-owning, real-window mechanics — no pure decisions to unit test beyond what already lives in `thumbnail.ts`'s `positionFor`). Instead, add an e2e check. Find the existing undo-toast e2e coverage:

```bash
grep -rl "showUndoToast\|toast.html\|panel:trash" app/test/*.e2e.test.ts
```

Confirm the existing undo-toast e2e test(s) still pass unmodified first — the undo path's query string gained an explicit `mode: "undo"` that wasn't there before, so verify nothing there was asserting on the absence of a `mode` param:

Run: `xvfb-run -a npx vitest run <that file>`
Expected: PASS, unchanged.

- [ ] **Step 7: Commit**

```bash
git add app/src/toast-window.ts app/renderer/toast.html app/src/toast-renderer.ts app/src/main.ts
git commit -m "STC-412: toast-window.ts generalized to a plain message mode"
```

---

### Task 6: Wire main-window warnings through the toast

**Files:**
- Modify: `app/src/preload.ts`, `app/src/main.ts`, `app/src/renderer.ts`, `app/renderer/index.html`

**Interfaces:**
- Consumes: `showMessageToast` (Task 5).
- Produces: `recorder.showToast(text: string): void` (preload bridge), `ipcMain.on("toast:message", ...)`.

- [ ] **Step 1: Add the preload bridge**

In `app/src/preload.ts`, in the `recorder` object:

```ts
  showToast: (text: string) => ipcRenderer.send("toast:message", text),
```

(Following the exact `reportPillWidth`/`ipcRenderer.send` precedent already in this file.)

- [ ] **Step 2: Add the main-process handler**

In `main.ts`, near the other `ipcMain.on(...)` fire-and-forget handlers (beside `pill:contentWidth`):

```ts
ipcMain.on("toast:message", (_e, text: unknown) => {
  if (typeof text !== "string" || !text) return;
  showMessageToast(text, {
    corner: readSettings(app.getPath("userData")).thumbnail.corner,
    dist: here, rendererDir: join(here, "..", "renderer"),
  });
});
```

- [ ] **Step 3: Change `renderer.ts`'s `alertUser`**

```ts
function alertUser(text: string): void { recorder.showToast(text); }
```

(Replaces the DOM manipulation entirely. All existing call sites — `reportStill`, the `helper:warning` handler, and any others found by `grep -n "alertUser(" app/src/renderer.ts` — need no changes themselves, since the function's signature is unchanged.)

- [ ] **Step 4: Remove `#alert` from `index.html`**

Delete the line:
```html
  <div id="alert"></div>
```

Delete the CSS rules:
```css
    #alert { padding: 10px 12px; border-radius: 7px; border: 1px solid var(--warn);
             background: var(--warn-soft); display: none; white-space: pre-wrap; }
    #alert.show { display: block; }
```

- [ ] **Step 5: Update `renderer.ts`'s type declaration for `recorder`**

Find the local interface declaring the `recorder` bridge's shape (near the top of the file, mirroring `preload.ts`) and add:

```ts
  showToast(text: string): void;
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Manual smoke check**

Run: `npm run app:start` — trigger any warning path reachable without hardware (e.g. attempt a still capture with `STC_FAKE_STILL_ERROR` if runnable locally, or just confirm the app launches with no `#alert`-related console error). This is a sanity check, not a substitute for Task 7's automated coverage.

- [ ] **Step 8: Commit**

```bash
git add app/src/preload.ts app/src/main.ts app/src/renderer.ts app/renderer/index.html
git commit -m "STC-412: main-window warnings route through the toast, #alert removed"
```

---

### Task 7: Migrate e2e tests off `#alert`

**Files:**
- Create: `app/test/_toast.ts`
- Modify: `app/test/still-overlay.e2e.test.ts`, `app/test/missing-helper.e2e.test.ts`, `app/test/mic-picker.e2e.test.ts`, `app/test/camera-toggle.e2e.test.ts`, `app/test/shell.e2e.test.ts`, `app/test/warnings.e2e.test.ts`, `app/test/countdown.e2e.test.ts`

**Interfaces:**
- Consumes: none from prior tasks besides the fact that Task 6 made `#alert` disappear and toasts appear instead.
- Produces: `toastPage(app): Promise<Page | undefined>`, `toastText(app): Promise<string>` — the one shared helper every migrated test uses, so there is exactly one owner of "how do you find the toast" (this codebase's own repeated lesson about one-value-two-copies).

**Do NOT touch** `app/test/export-size.e2e.test.ts` or `app/test/manage.e2e.test.ts` — both reference the EDITOR window's own separate `#alert` (`editor.html`), which this ticket does not change. Confirmed by reading their `win`/`app` setup: both obtain `win` via `openTake`/`openEditorFromLibrary`, not `app.firstWindow()`.

- [ ] **Step 1: Write `app/test/_toast.ts`**

```ts
import type { ElectronApplication, Page } from "playwright";

/**
 * The main window's message toast (STC-412), if one is currently up —
 * undefined otherwise. Replaces every e2e test's old `win.locator("#alert")`
 * read: a toast is a SEPARATE BrowserWindow now, not a DOM element in the
 * main window, so it has to be found among `app.windows()` the way any
 * other floating surface in this app's e2e suite already is.
 */
export async function toastPage(app: ElectronApplication): Promise<Page | undefined> {
  for (const w of app.windows()) {
    if (w.url().includes("toast.html") && w.url().includes("mode=message")) return w;
  }
  return undefined;
}

/** The toast's message text, or "" if none is up. */
export async function toastText(app: ElectronApplication): Promise<string> {
  const page = await toastPage(app);
  if (!page) return "";
  return (await page.textContent("#label")) ?? "";
}
```

- [ ] **Step 2: `still-overlay.e2e.test.ts`**

Change (line ~270):
```ts
    await expect.poll(() => win.textContent("#alert"), { timeout: 15_000 })
      .toContain("macOS 14");
```
to:
```ts
    await expect.poll(() => toastText(app!), { timeout: 15_000 })
      .toContain("macOS 14");
```
Add the import: `import { toastText } from "./_toast.js";`. Confirm `app` is the module-level variable already in scope (it is — `let app: ElectronApplication | undefined;` at line 29).

- [ ] **Step 3: `missing-helper.e2e.test.ts`**

Change (lines ~35-36):
```ts
    await expect.poll(() => win.locator("#alert").isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await win.textContent("#alert")).toMatch(/keeps failing to start/);
```
to:
```ts
    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 30_000 }).toBe(true);
    expect(await toastText(app!)).toMatch(/keeps failing to start/);
```
Add the import.

- [ ] **Step 4: `countdown.e2e.test.ts`**

All three occurrences (lines ~172, ~255, ~288):
```ts
    expect(await win.textContent("#alert")).toBeFalsy();
```
become:
```ts
    expect(await toastPage(app!)).toBeUndefined();
```
Add the import; confirm `app` is in scope at each of the three call sites (check the enclosing test — if the module uses a differently-named app variable there, e.g. a per-test `a`, adjust accordingly by reading the surrounding lines first).

- [ ] **Step 5: `mic-picker.e2e.test.ts`**

Both occurrences (lines ~174, ~200) follow the `expect.poll(() => win.textContent("#alert"), ...).toContain(...)` pattern — apply the same substitution as Step 2, reading each test's exact expected substring first and preserving it:
```ts
    await expect.poll(() => toastText(app!), { timeout: 20_000 }).toContain(/* the original substring */);
```
Add the import.

- [ ] **Step 6: `camera-toggle.e2e.test.ts`**

Both occurrences (lines ~221, ~262) — same pattern as Step 5. Add the import.

- [ ] **Step 7: `shell.e2e.test.ts`**

Change (lines ~59-64):
```ts
    await expect.poll(async () =>
      (await win.textContent("#state")) === "recording" ||
      (await win.locator("#alert").isVisible()), { timeout: 30_000 }).toBe(true);

    if (await win.locator("#alert").isVisible()) {
      const msg = await win.textContent("#alert");
      expect(msg).toMatch(/Screen Recording permission|Could not start/);
      expect(await win.locator("#record").isDisabled()).toBe(false);  // still usable
```
to:
```ts
    await expect.poll(async () =>
      (await win.textContent("#state")) === "recording" ||
      ((await toastPage(app!)) !== undefined), { timeout: 30_000 }).toBe(true);

    const toast = await toastPage(app!);
    if (toast) {
      const msg = await toast.textContent("#label");
      expect(msg).toMatch(/Screen Recording permission|Could not start/);
      expect(await win.locator("#record").isDisabled()).toBe(false);  // still usable
```
Add the import.

- [ ] **Step 8: `warnings.e2e.test.ts`**

This file has the densest usage (lines ~63-64, ~126-127, ~139-145, ~152). Read the current text around each before editing, since several assert different substrings/patterns; apply the same two substitutions throughout:
- `win.locator("#alert").isVisible()` → `toastPage(app).then((p) => !!p)` (poll) or `(await toastPage(app)) !== undefined` (inline), using whichever `app`/`win` variable name is actually in scope at each site (this file's `launchAndPressRecord` returns/sets `app` at module scope, confirmed earlier).
- `win.textContent("#alert")` → `toastText(app)`.

Line ~152's negative check:
```ts
    expect(await win.locator("#alert").isVisible()).toBe(false);
```
becomes:
```ts
    expect(await toastPage(app!)).toBeUndefined();
```
Add the import.

- [ ] **Step 9: Run every migrated file**

Run: `xvfb-run -a npx vitest run app/test/still-overlay.e2e.test.ts app/test/missing-helper.e2e.test.ts app/test/mic-picker.e2e.test.ts app/test/camera-toggle.e2e.test.ts app/test/shell.e2e.test.ts app/test/warnings.e2e.test.ts app/test/countdown.e2e.test.ts`
Expected: PASS across all seven. Where one fails, read the actual failure — the most likely gap is a substring in a test this plan didn't fully quote above; fix by matching the original assertion's exact expected text, not by loosening it.

- [ ] **Step 9b: Write the auto-dismiss test the design doc's own testing section calls for**

None of the seven migrated tests assert that a toast actually goes away on its own — each either checks it APPEARS with the right text, or never appears at all. Add one real test of the timing property, in `app/test/warnings.e2e.test.ts` (which already has a `launchAndPressRecord` fixture producing a genuine warning):

```ts
test("the toast auto-dismisses on its own, with no click", async () => {
  await launchAndPressRecord({ STC_FAKE_WARNING: "some-new-fault" });
  await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 10_000 }).toBe(true);
  // MESSAGE_TOAST_MS is 4_000 (toast-window.ts) — poll well past it rather
  // than asserting at a fixed instant, so this is not a race against the
  // exact same clock it is testing.
  await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 8_000 }).toBe(false);
}, 15_000);
```

Check the exact env var this file's fixture actually uses to inject an arbitrary warning code (read `launchAndPressRecord`'s existing tests for the pattern already used at line ~127's `"some-new-fault"` assertion — reuse whatever mechanism produces that, rather than inventing `STC_FAKE_WARNING` if the real one is named differently).

- [ ] **Step 9c: Run it**

Run: `xvfb-run -a npx vitest run app/test/warnings.e2e.test.ts -t "auto-dismisses"`
Expected: PASS.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add app/test/_toast.ts app/test/still-overlay.e2e.test.ts app/test/missing-helper.e2e.test.ts app/test/mic-picker.e2e.test.ts app/test/camera-toggle.e2e.test.ts app/test/shell.e2e.test.ts app/test/warnings.e2e.test.ts app/test/countdown.e2e.test.ts
git commit -m "STC-412: e2e suite reads warnings from the toast window, not #alert"
```

---

### Task 8: `panel-actions.ts` gains `dismiss`

**Files:**
- Modify: `app/src/panel-actions.ts`
- Test: `app/test/panel-actions.test.ts`

**Interfaces:**
- Produces: `PanelAction` now includes `"dismiss"`; `closesPanel("dismiss") === true`; `promotes("dismiss") === false`. `actionsFor` is UNCHANGED — never returns `"dismiss"`.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/panel-actions.test.ts`, inside (or right after) the `"what an action does to the panel"` describe block:

```ts
describe("dismiss (STC-412)", () => {
  test("dismiss does not promote and does not appear in actionsFor", () => {
    // actionsFor's four-action contract is UNCHANGED — dismiss is a close
    // affordance (X / Esc / click-outside), never a fifth action-row button.
    for (const kind of ["shot", "recording"] as const) {
      for (const origin of ["fresh", "library"] as const) {
        expect(actionsFor({ kind, origin })).not.toContain("dismiss");
      }
    }
  });

  test("dismiss closes the panel and does nothing to the take", () => {
    expect(closesPanel("dismiss")).toBe(true);
    expect(promotes("dismiss")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/test/panel-actions.test.ts`
Expected: FAIL — `"dismiss"` is not assignable to `PanelAction`, or `closesPanel`/`promotes` don't handle it (TS error at the type level; vitest will report a runtime issue since `"dismiss"` isn't typed yet — confirm the failure is about the missing case, not something else).

- [ ] **Step 3: Add the action**

```ts
export type PanelAction = "copy" | "save" | "edit" | "trash" | "dismiss";
```

`actionsFor` needs NO change — it already only ever pushes `"copy"`/`"save"`/`"edit"`/`"trash"`, and `dismiss` must never appear in its output. Add a one-line comment above `actionsFor`'s existing return, noting this explicitly so a future edit doesn't "helpfully" add it:

```ts
/**
 * The actions this take has, in the order the panel lays them out.
 *
 * Trash is always last and always present — it is the ✕, and a panel that
 * never closes on its own must always have a way out.
 *
 * "dismiss" (STC-412) is deliberately NEVER in this list — it is a close
 * affordance (the panel's own X, Escape, click-outside), not a button in
 * this row. `main.ts`'s `panel:dismiss` handler and `thumbnail-renderer.ts`
 * reach it directly, never through this table.
 */
```

Update `closesPanel`:

```ts
export function closesPanel(action: PanelAction): boolean {
  return action !== "copy";
}
```

(No change needed — `"dismiss" !== "copy"` is already `true`. Leave the function body as-is; it already generalizes correctly.)

Update `promotes`:

```ts
export function promotes(action: PanelAction): boolean {
  return action === "save" || action === "edit";
}
```

(Also no change needed — `dismiss` already falls through to `false`. Leave as-is.)

Since neither function's *body* needs editing, the only real code change in this step is the `PanelAction` union widening to include `"dismiss"` plus the doc comment above. TypeScript's exhaustiveness will now allow `"dismiss"` wherever `PanelAction` is accepted, which is exactly what Task 9 needs.

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run app/test/panel-actions.test.ts`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/panel-actions.ts app/test/panel-actions.test.ts
git commit -m "STC-412: panel-actions.ts gains dismiss, kept out of actionsFor's four buttons"
```

---

### Task 9: Dismiss wiring end to end

**Files:**
- Modify: `app/src/main.ts`, `app/src/thumbnail-preload.ts`, `app/src/thumbnail-renderer.ts`, `app/renderer/thumbnail.html`
- Test: `app/test/thumbnail.e2e.test.ts` (or wherever the panel's other actions are e2e-tested — confirm with `grep -rl "panel:trash\|perform(\"trash" app/test/*.e2e.test.ts`)

**Interfaces:**
- Consumes: `PanelAction` including `"dismiss"`, `dismissThumbnail(dir)` (already exists in `thumbnail-window.ts`).
- Produces: `ipcMain.handle("panel:dismiss", ...)`, `window.thumb.dismiss(dir): Promise<{ok: boolean}>`.

- [ ] **Step 1: Add the main-process handler**

In `main.ts`, right after the `panel:edit` handler and before `panel:trash` (matching the existing ordering, and reusing the same `insideCaptureRoot` guard every sibling handler uses):

```ts
/**
 * Close the panel without deciding anything (STC-412) — the take is
 * untouched: still in temp storage if it was fresh, still in the library if
 * it was re-opened. Governed entirely by STC-393's existing purge and
 * crash-recovery, the same as ignoring the panel always was before
 * STC-392 removed the timeout that used to do this automatically.
 */
ipcMain.handle("panel:dismiss", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideCaptureRoot(process.env, dir)) {
    return { ok: false, detail: "not a take this app wrote" };
  }
  dismissThumbnail(dir);
  return { ok: true };
});
```

- [ ] **Step 2: Add the preload bridge**

In `app/src/thumbnail-preload.ts`, beside `trash`:

```ts
  dismiss: (dir: string) => ipcRenderer.invoke("panel:dismiss", dir),
```

- [ ] **Step 3: Update `thumbnail-renderer.ts`'s bridge type and `run()`**

Find the `declare global { interface Window { thumb: { ... } } }` block and add:

```ts
      dismiss(dir: string): Promise<{ ok: boolean; detail?: string }>;
```

Add a branch to `run()`, right before the `// trash` fallthrough comment:

```ts
  if (action === "dismiss") {
    const r = await window.thumb.dismiss(dir);
    return r.ok;
  }
```

- [ ] **Step 4: Add the X button to `thumbnail.html`**

Add a corner close button, as the first child of `#card` (before `#thumbwrap`):

```html
  <div id="card">
    <button id="dismiss" title="Close without deciding" aria-label="Close">×</button>
    <div id="thumbwrap"><canvas id="thumbcanvas"></canvas></div>
```

Add its CSS, near `#card`'s own rules:

```css
    #dismiss {
      position: absolute; top: 6px; right: 6px; z-index: 1;
      width: 20px; height: 20px; padding: 0; line-height: 1;
      border: none; border-radius: 999px;
      background: rgba(255, 255, 255, 0.12); color: #f2f2f2;
      font-size: 15px; cursor: pointer;
    }
    #dismiss:hover { background: rgba(255, 255, 255, 0.22); }
```

(Deliberately NOT `data-action="dismiss"` — it must stay outside the `[data-action]` loop `thumbnail-renderer.ts` uses to draw/hide the four action-row buttons, per Task 8's own note that dismiss is never in `actionsFor`'s output. It's a separate, always-present button, visually distinct — top-right corner, small ghost circle — from `#trash`'s "✕" sitting inline in the action row, so the two are never confusable.)

- [ ] **Step 5: Wire the X button's click**

In `thumbnail-renderer.ts`, near the `[data-action]` button-wiring loop:

```ts
document.getElementById("dismiss")!.addEventListener("click", (e) => {
  e.stopPropagation();
  void perform("dismiss");
});
```

- [ ] **Step 6: Wire Escape**

Replace the existing `keydown` listener's redact-only Escape handling:

```ts
document.addEventListener("keydown", (e) => {
  if (redacting && e.key === "Escape") { setRedacting(false); return; }
  if (performance.now() < keysLiveAt) return;
  if (e.key === "Escape") { e.preventDefault(); void perform("dismiss"); return; }
  for (const [action, matches] of KEYS) {
    if (!matches(e) || !available.has(action)) continue;
    e.preventDefault();
    void perform(action);
    return;
  }
});
```

(Redact-mode Escape still takes priority and is checked first, unaffected by the settling window — consistent with its own existing comment: "a user who has just started a drag they did not mean must be able to cancel it in the same 300 ms." Plain Escape — dismiss — respects `keysLiveAt` like every other action, since it's now a real decision rather than an exempt cancel.)

Update the stale block comment directly above (the one starting "Escape no longer closes the panel...") to state the new, opposite fact:

```ts
 * Escape closes the panel again (STC-412), reversing STC-392's own removal
 * of "close without deciding". Redact mode still takes priority — backing
 * out of a half-drawn box is the thing someone reaches for first, and that
 * check runs before the settling window even applies.
```

- [ ] **Step 7: Wire click-outside via window blur**

In `thumbnail-renderer.ts`, add near the other top-level listeners:

```ts
/**
 * Click-outside (STC-412): this panel is a borderless always-on-top
 * BrowserWindow, not a DOM overlay, so "outside the card" is the window
 * losing key status, not a literal click handler. Guarded on `busy` so an
 * action already in flight (e.g. a native Save-As dialog momentarily taking
 * focus) cannot dismiss a panel mid-decision.
 */
window.addEventListener("blur", () => {
  if (busy) return;
  void perform("dismiss");
});
```

(`busy` is the existing module-level flag `perform()` already sets/clears — confirm its exact name by reading the file; use whatever it's actually called if different from `busy`.)

- [ ] **Step 8: Run the existing thumbnail unit/e2e suite first, unmodified**

Run: `npx vitest run app/test/thumbnail.test.ts app/test/panel-actions.test.ts`
Run: `xvfb-run -a npx vitest run app/test/thumbnail.e2e.test.ts`
Expected: PASS — confirms nothing in Steps 1-7 broke the four existing actions before adding new coverage.

- [ ] **Step 9: Write the failing e2e test for dismiss**

`app/test/thumbnail.e2e.test.ts` already has exactly the fixture this needs: `launch()` returns `{ win, recordings, temp, destDir, stillLog }`, `thumbnailWindow(ms)` finds the panel's `Page` by polling `app.windows()` for a `thumbnail.html` url, `noThumbnailWindow(ms)` polls `windowCount(app, "thumbnail.html")` down to 0, and `captureDisplay(win)` triggers a capture the same way a hotkey would. Add, in the `describe("the post-capture floating thumbnail", ...)` block:

```ts
test("dismiss (the X) closes the panel and leaves the take exactly where it was", async () => {
  const { win, temp } = await launch();
  const r = await captureDisplay(win);
  expect(r.ok).toBe(true);
  const panel = await thumbnailWindow();
  const before = readdirSync(temp, { recursive: true }).sort();

  await panel.click("#dismiss");

  await noThumbnailWindow();
  expect(readdirSync(temp, { recursive: true }).sort()).toEqual(before);
});

test("Escape dismisses the panel outside redact mode", async () => {
  const { win, temp } = await launch();
  const r = await captureDisplay(win);
  expect(r.ok).toBe(true);
  const panel = await thumbnailWindow();
  const before = readdirSync(temp, { recursive: true }).sort();

  await panel.keyboard.press("Escape");

  await noThumbnailWindow();
  expect(readdirSync(temp, { recursive: true }).sort()).toEqual(before);
});
```

(`readdirSync` with `{ recursive: true }` is already imported at the top of this file. `before` is read AFTER the capture completes and the panel has painted — not before `captureDisplay` — since the capture itself is what populates `temp` in the first place; asserting equality across the dismiss action is what proves dismiss touched nothing.)

- [ ] **Step 10: Run to verify failure**

Run: `xvfb-run -a npx vitest run app/test/thumbnail.e2e.test.ts -t "dismiss"`
Expected: FAIL — `#dismiss` not found if Steps 4-7 weren't actually applied yet in this pass, or PASS already if you're running this after Steps 1-7 (in which case skip to Step 11 — this file's TDD ordering is looser than the pure-logic tasks above since the DOM/IPC wiring had to exist before any e2e test could target it; that's fine, note it and move on).

- [ ] **Step 11: Run to verify passing**

Run: `xvfb-run -a npx vitest run app/test/thumbnail.e2e.test.ts -t "dismiss\|Escape dismisses"`
Expected: PASS.

- [ ] **Step 12: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 13: Commit**

```bash
git add app/src/main.ts app/src/thumbnail-preload.ts app/src/thumbnail-renderer.ts app/renderer/thumbnail.html app/test/thumbnail.e2e.test.ts
git commit -m "STC-412: explicit dismiss (X, Escape, click-outside) on the post-capture panel"
```

---

### Task 10: Sweep — open the sheet before Scope/Camera/Mic/Display e2e interactions

**Files:**
- Modify: `app/test/camera-toggle.e2e.test.ts`, `app/test/display-picker.e2e.test.ts`, `app/test/mic-picker.e2e.test.ts`, `app/test/scope-indicator.e2e.test.ts`, `app/test/scope-picker.e2e.test.ts`

**Interfaces:**
- Consumes: Task 3's relocation (Scope/Source/Camera/Mic/Display now live inside `#profilesheet`, only interactable while it has the `.open` class).

Each of these five files has its own `launch()`-shaped helper that returns the main window's `Page` after load, right before `return win;` (confirmed shape: `await withoutCountdown(win); return win;`, with `scope-picker.e2e.test.ts` instead returning `{ win, userData, startLog }`). Every test in each file exists specifically to drive scope/camera/mic/display, so opening the sheet once in each file's shared launch helper is correct and sufficient — no per-test-site changes needed.

- [ ] **Step 1: Run all five files first, to see the actual failure shape**

Run: `xvfb-run -a npx vitest run app/test/camera-toggle.e2e.test.ts app/test/display-picker.e2e.test.ts app/test/mic-picker.e2e.test.ts app/test/scope-indicator.e2e.test.ts app/test/scope-picker.e2e.test.ts`
Expected: FAIL — every test that calls `.click`/`.selectOption`/`.isChecked` on `#scope`/`#camera`/`#mic`/`#display`/`#pickwindow`/`#pickregion`/`#clearwindow`/`#clearregion` times out or errors, because those elements are inside the closed sheet. Read the actual error text for one representative failure (Playwright's actionability-timeout message names the element and why it isn't actionable) before proceeding — that message is what confirms this is the expected, understood failure and not something else.

- [ ] **Step 2: `camera-toggle.e2e.test.ts`**

Change the tail of `launch()` (currently `await withoutCountdown(win); return win;`) to:

```ts
  await withoutCountdown(win);
  await win.click("#settings");
  return win;
}
```

- [ ] **Step 3: `display-picker.e2e.test.ts`**

Same change to its `launch()` (line ~40's `await withoutCountdown(win);` / line ~41's `return win;`):

```ts
  await withoutCountdown(win);
  await win.click("#settings");
  return win;
}
```

- [ ] **Step 4: `mic-picker.e2e.test.ts`**

Same change (line ~51/52):

```ts
  await withoutCountdown(win);
  await win.click("#settings");
  return win;
}
```

- [ ] **Step 5: `scope-indicator.e2e.test.ts`**

Same change (line ~73/74):

```ts
  await withoutCountdown(win);
  await win.click("#settings");
  return win;
}
```

- [ ] **Step 6: `scope-picker.e2e.test.ts`**

This file's `launch()` calls `await win.waitForSelector("#scope");` BEFORE `withoutCountdown` — that line now needs `{ state: "attached" }` since `#scope` is no longer guaranteed "visible" (Playwright's default wait state) the instant the page loads, only once the sheet opens:

```ts
  const win = await app.firstWindow();
  await win.waitForSelector("#scope", { state: "attached" });
  await withoutCountdown(win);
  await win.click("#settings");
  return { win, userData: ud, startLog };
}
```

- [ ] **Step 7: Run all five again**

Run: `xvfb-run -a npx vitest run app/test/camera-toggle.e2e.test.ts app/test/display-picker.e2e.test.ts app/test/mic-picker.e2e.test.ts app/test/scope-indicator.e2e.test.ts app/test/scope-picker.e2e.test.ts`
Expected: PASS across all five. If any individual test still fails (for instance because it separately re-checks something about the closed/open state of the sheet, or reads a status element that's now differently laid out), read that specific failure and fix it locally — do not weaken its assertion to make it pass; the goal is the same behavioral claim these tests made before, now reached through the sheet.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add app/test/camera-toggle.e2e.test.ts app/test/display-picker.e2e.test.ts app/test/mic-picker.e2e.test.ts app/test/scope-indicator.e2e.test.ts app/test/scope-picker.e2e.test.ts
git commit -m "STC-412: e2e tests open the Settings sheet before driving Scope/Camera/Mic/Display"
```

---

### Task 11: Full verification and documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: clean across all three passes.

- [ ] **Step 2: Full test suite**

Run: `npm test` (or the equivalent full local invocation this sandbox uses — check `package.json`'s `test` script; if `npm test` requires `swiftc`/a real helper build this sandbox lacks, use the throwaway-config `xvfb-run` pattern this repo's own CLAUDE.md documents for a from-scratch local run, rebuilding `app/dist/` first via `node app/build.mjs`)
Expected: green, except for this sandbox's own already-documented baseline failures (no-`swiftc` files: `helper-client`/`supervisor`/`shell`/`frame-png`-dependent tests; `manage.e2e.test.ts`'s macOS-only Trash-path assertion). Confirm the failure SET is identical to a baseline run on unmodified `master` — if anything new fails, it's this plan's work, not the known baseline; fix it before proceeding.

- [ ] **Step 3: Confirm the baseline by comparison**

```bash
git stash push -u -m "stc-412-baseline-check"
node app/build.mjs
# run the same full suite invocation as Step 2, capture the failure list
git stash pop
node app/build.mjs
```

Compare the two failure lists. They must match exactly (same files, same test names) for this plan's work to be considered clean.

- [ ] **Step 4: Update CLAUDE.md's "Next up" table**

Add a row for STC-412 following this file's own established format (see any recent entry, e.g. STC-421 or STC-416, for the exact tone and structure: what shipped, what was found along the way, what's still open). Include:
- The Profile/Preferences split and what moved where.
- The save-folder unification (recordings + stills, one setting, "beside the shot" retired).
- The diagnostics toggle and toast conversion.
- The explicit dismiss (X/Esc/click-outside) and its interaction with STC-392's undo-trash toast (two toast MODES sharing one window class now).
- What's NOT verified: written on Linux/this sandbox if no real macOS run happens — note that blur-based click-outside (Task 9, Step 7) is the one piece with real platform-behavior risk (same class of risk this file already documents for `app.focus()`/panel key semantics) and flag it for a hardware runbook check, the same way `panel-focus.ts`'s escalation path is flagged elsewhere in this file.
- Any deviation actually taken during implementation (if Task 9's blur approach had to be dropped per the design doc's own stated fallback, say so plainly, the same way this file records every other reversed decision).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "STC-412: document the Profile/Preferences split in CLAUDE.md"
```

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin worktree-stc-412-profile-preferences-split:accounts/stc-412-profile-preferences-split
gh pr create --base master --title "STC-412: split Profile into Profile and Preferences" --body "$(cat <<'EOF'
## Summary
- Splits the main window's sheet into Profile (Scope/Source/Camera/Mic, relocated here) and Preferences (save folder, panel corner, countdown, shortcuts, shutter sound, a new diagnostics toggle).
- Unifies recordings and stills onto one saveFolder setting, retiring "beside the shot".
- Converts the main window's inline error banner to a toast, reusing STC-392's toast window class.
- Adds an explicit dismiss (X / Esc / click-outside) to the post-capture panel, separate from the existing Copy/Save/Edit/Trash row.

## Test plan
- [x] Full local suite green against the documented sandbox baseline
- [ ] Hardware: click-outside (window blur) actually reads as "clicked away" rather than firing spuriously — see the design doc's own flagged risk
EOF
)"
```

- [ ] **Step 7: Update Linear**

Set STC-412's status appropriately once CI is green (In Review or per this workspace's own convention), and comment with the PR link.
