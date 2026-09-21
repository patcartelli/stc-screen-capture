# STC-412: Split Profile into Profile and Preferences — design

Linear: [STC-412](https://linear.app/studio-cartelli/issue/STC-412/split-profile-into-profile-and-preferences-the-sheet-is-global).
Filed 2026-09-17. This design was written 2026-09-21, after STC-392 (post-capture
panel rewrite, PR #188 merged, more on an unmerged branch) shipped in the
meantime — several of the ticket's original bullets are already satisfied and
are recorded below as such rather than re-built.

## What's already done (no work needed)

- **STC-398's stills→"Shot" rename reached every surface the ticket asked to
  check.** `index.html`'s main button reads `Shot`, the shortcuts editor
  heading reads "Shot shortcuts", and `hotkeys.ts`'s `ACTION_LABELS["self-timer"]`
  is `"Shot with Self-Timer"`. Verified by reading the current files, not
  assumed.
- **"Closes after N s" and the then-action dropdown are already gone.**
  STC-392 reversed the panel's auto-dismiss behaviour outright — `thumbnail.ts`'s
  header documents removing the `showing`/`expiresAt`/`isExpired` state
  entirely. There is no timeout preference left to delete.
- **A toast mechanism already exists** (`toast-window.ts`, built for STC-392's
  undo-trash toast) — the error-banner-to-toast conversion reuses its window
  mechanics rather than inventing a second one.

## What this ticket still builds

### 1. Settings model (`app/src/settings.ts`)

- New top-level field:
  ```ts
  /**
   * Where recordings and stills are saved, or null for "not chosen yet" —
   * which resolves to the same default takesRoot() always computed
   * (env.STC_RECORDINGS_DIR || ~/Desktop/stc), so an untouched install
   * behaves identically to before this field existed, and an E2E fixture's
   * STC_RECORDINGS_DIR isolation never gets baked into a persisted
   * settings.json. Replaces StillSettings.destination and the "beside the
   * shot" concept: there is one save location, not a per-still override.
   */
  saveFolder: string | null;
  ```
- New top-level field:
  ```ts
  /** Whether the diagnostics table (helper pid, frame counts, …) is shown
   * on the main window. Off by default — developer instrumentation, not
   * something a normal user needs to see. */
  showDiagnostics: boolean;
  ```
- Remove `StillSettings.destination` and its `cleanStill` handling. `still`
  keeps `format`/`quality`/`scale`/`stripMetadata`/`template` only.
- `cleanSaveFolder(v: unknown): string | null` follows the existing
  `cleanDisplayId`-style rule: an absolute path string is trusted, anything
  else is null (unset), never half-trusted.

### 2. Save-location plumbing

- `app/src/takes.ts`: `takesRoot(env: NodeJS.ProcessEnv): string` becomes
  `takesRoot(env: NodeJS.ProcessEnv, saveFolder: string | null): string`,
  returning `saveFolder || env.STC_RECORDINGS_DIR || join(homedir(), "Desktop", "stc")`.
  `insideTakesRoot` threads the same parameter through.
- `app/src/library.ts` (`listLibrary`, `listTakes`) and
  `app/src/temp-takes.ts` (`promoteTake`, and anywhere else that resolves
  the library root) gain the same parameter. All current callers are inside
  `main.ts`, which already holds the loaded `Settings` — passing
  `settings.saveFolder` through is mechanical.
- `app/src/still-io.ts`'s `destinationDir` drops the `settings.destination`/
  `fallbackDir` "beside the shot" branch: a save now always resolves against
  the caller-supplied `saveFolder` (still falling through to the clipboard
  cache dir for a bare Copy, unchanged).
- No change to `STC_RECORDINGS_DIR`'s role for tests — it remains the
  fallback inside `takesRoot` when `saveFolder` is null, which is what keeps
  every existing E2E fixture's isolation working unmodified.

### 3. Main window HTML/CSS (`app/renderer/index.html`, `app/src/renderer.ts`)

- `#profilesheet`'s heading and the `#profile` button's label/title change
  from "Profile" to **"Preferences"**. No new sheet or window is built —
  the audit that opened this ticket found Scope/Source/Camera/Mic already
  correctly live in the main window's own rows, not in the sheet, so
  "Profile" as a per-capture concept needs no relocation.
- The `.stillrow` "Saving to" block loses its `#stillcleardest` ("Beside
  the shot") button; `#stilldest`/`#stillchoosedest` remain, now always
  showing a real, resolved path (falling back to the computed default when
  `saveFolder` is null, same as today's blank-then-populated display).
- The diagnostics `<table>` moves behind a toggle (`#showdiagnostics`
  checkbox in Preferences, wired to the new setting); `renderer.ts`'s
  existing per-field update calls (`pid`, `alive`, `camera-state`, …) are
  untouched — only visibility changes.
- `#alert` and `alertUser()` are removed from the main window. Warnings
  currently reaching `alertUser` (`r.warning` from an IPC reply,
  `helper:warning` events) are re-routed through the new toast (below).

### 4. Toast generalization (`app/src/toast-window.ts`)

- Factor the shared window-construction logic out of `showUndoToast`
  (position-from-corner, `PANEL_WINDOW_TYPE`, `showInactive`, "replaces
  whatever's already up") into a helper both `showUndoToast` and a new
  `showMessageToast(text: string, opts): void` call.
- `showMessageToast` auto-dismisses after a fixed duration (no Undo
  affordance — it's a notice, not a promise) and needs a small
  `toast.html` variant or a query-string mode flag distinguishing it from
  the undo toast's countdown-bar UI.
- `main.ts` calls `showMessageToast` directly at the point(s) it currently
  forwards helper warnings toward the renderer's `#alert`, rather than
  round-tripping through IPC to renderer-drawn DOM.

### 5. Explicit dismiss (`app/src/panel-actions.ts`, `main.ts`, panel UI)

- `PanelAction` gains `"dismiss"`. `actionsFor` always includes it — the
  one way out of the panel that isn't Trash, present for every
  kind/origin combination.
- `closesPanel("dismiss") === true`, `promotes("dismiss") === false` —
  dismissing does nothing to the take itself.
- `main.ts` gains `ipcMain.handle("panel:dismiss", (_e, dir) => { ... })`
  on the same pattern as `panel:save`/`panel:edit`/`panel:trash`, calling
  the **already-existing** `dismissThumbnail(dir)` primitive (currently an
  internal detail used when save/edit/trash complete) with no promote or
  trash side effect. A dismissed fresh capture stays in temp storage,
  governed entirely by STC-393's existing 7-day purge and crash-recovery —
  no new take-lifecycle state is introduced.
- `thumbnail-renderer.ts` / `thumbnail.html` / `thumbnail-menu.ts` gain a
  Dismiss control and keyboard path, reading from `actionsFor`/`closesPanel`
  the same way the existing four actions already do — no new per-view copy
  of the action table (this file's own stated purpose).

## Explicitly out of scope

- Building an actual separate "Profile" surface for per-capture settings —
  the audit found this already satisfied by the main window's existing
  rows.
- STC-388's record-flow entry points, STC-413's library-as-folder-view, and
  STC-415's hotkey-modifier outcomes — related, not blocking, not touched
  here.
- Any change to `panel-actions.ts`'s recording-support work in progress on
  the unmerged `codex/stc-392-validation` branch. This design builds
  against master as it stands today; a later merge from that branch may
  need to resolve a conflict against the new `"dismiss"` action, which is
  that branch's author's job, not this ticket's.

## Testing

- `app/test/settings.test.ts`: round-trip for `saveFolder` (null vs. an
  absolute path vs. garbage) and `showDiagnostics`.
- `app/test/takes.test.ts` (or wherever `takesRoot` is pinned): the new
  parameter's precedence (`saveFolder` > `STC_RECORDINGS_DIR` > default).
- `app/test/panel-actions.test.ts` (new or extended): `actionsFor` always
  includes `dismiss`; `closesPanel`/`promotes` for it.
- E2E: Preferences sheet shows the renamed heading and no "Beside the
  shot" control; the diagnostics table is hidden by default and toggles;
  dismissing a fresh capture's panel leaves its temp-storage directory
  untouched and closes the panel; the toast appears for a forwarded
  warning and auto-dismisses.
