# STC-412: Split Profile into Profile and Preferences — design

Linear: [STC-412](https://linear.app/studio-cartelli/issue/STC-412/split-profile-into-profile-and-preferences-the-sheet-is-global).
Filed 2026-09-17. This design was written 2026-09-21, after STC-392 (post-capture
panel rewrite, PR #188 merged, more on an unmerged branch) shipped in the
meantime — several of the ticket's original bullets are already satisfied and
are recorded below as such rather than re-built.

**Revision note (same day):** the Linear issue gained a "Scope decided
(2026-09-21)" section partway through this design — live edits, presumably
Patrick, landing while this doc was already in review. Two of its four
points changed real decisions below (Profile becomes an actual relocated
section; dismiss is a close affordance, not a fifth action button) and are
folded in. Its third point (stale "Capture still"/"Capture with
Self-Timer" labels) was re-checked against current code with a repo-wide
grep and found not to apply — see "What's already done" below.

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

**Revised per the 2026-09-21 scope note**: the sheet becomes one panel with
two labeled sections, not a rename alone.

- The `#profile` button is relabeled **"Settings"** (my call — neither
  "Profile" nor "Preferences" alone names a sheet holding both; flag if
  wrong). It opens the same `#profilesheet` `<aside>`, now containing two
  `<h2>`-headed sections in order: **Profile** first (immediate,
  per-capture), then **Preferences** (global) — same stacked-section
  pattern the sheet already uses for Shot/Countdown/Shot shortcuts, no
  tabs.
- **Profile section** (new content, relocated from the main window):
  the Scope select, and whichever of `#display-label`/`#window-source`/
  `#region-source` applies, plus the Camera checkbox and Mic select —
  moved out of `#record-row` and the scope `.row` into the sheet. Their
  element ids are unchanged (`#scope`, `#camera`, `#mic`, `#pickwindow`,
  `#clearwindow`, `#pickregion`, `#clearregion`, …), so `renderer.ts`'s
  existing `getElementById`-based wiring needs no change — only their
  position in the DOM moves. `#record-row` shrinks to Record, the pill,
  Shot, the Settings button, and `#state`.
- **Preferences section** (as originally designed): Save folder (no
  "Beside the shot" button — `#stilldest`/`#stillchoosedest` remain,
  always showing a real resolved path), panel corner, skip-to-clipboard,
  countdown, shortcuts + restore defaults, shutter sound, and the new
  diagnostics toggle (`#showdiagnostics`, gates the `<table>` — off by
  default, `renderer.ts`'s existing per-field updates untouched).
- `#alert` and `alertUser()` are removed from the main window. Warnings
  currently reaching `alertUser` (`r.warning` from an IPC reply,
  `helper:warning` events) are re-routed through the new toast (below).

**Test-suite consequence worth flagging**: Scope/Camera/Mic controls are
currently interactable on the main window at all times; once they live
inside `#profilesheet`, they're only visible/clickable while the sheet has
its `.open` class. Every e2e test that drives them via `page.click(...)`
(`scope-picker.e2e.test.ts`, camera-toggle tests, mic-selection tests,
etc.) needs to open the sheet first. This is mechanical but touches
several files — called out explicitly so it isn't missed sizing the plan.

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

**Revised per the 2026-09-21 scope note**: dismiss is a close affordance
(X / Esc / click-outside), not a fifth button in the Copy/Save/Edit/Trash
row.

- `PanelAction` gains `"dismiss"` for the main-process/IPC side (main.ts's
  handler, `promotes`/`closesPanel` semantics) — but `actionsFor` (which
  drives the four-button row `thumbnail-renderer.ts` draws) is
  **unchanged**; dismiss is never one of its returned actions.
  `closesPanel("dismiss") === true`, `promotes("dismiss") === false` — it
  does nothing to the take itself, same as before.
- `main.ts` gains `ipcMain.handle("panel:dismiss", (_e, dir) => { ... })`
  on the `panel:save`/`panel:edit`/`panel:trash` pattern, calling the
  **already-existing** `dismissThumbnail(dir)` primitive (today an
  internal detail used when save/edit/trash complete) with no promote or
  trash side effect. A dismissed fresh capture stays in temp storage,
  governed entirely by STC-393's existing 7-day purge and crash-recovery —
  no new take-lifecycle state.
- `thumbnail-renderer.ts`/`thumbnail.html` gain a small **X** button
  (visually separate from the action row — same idea as `#profileclose`
  in the main window's sheet) that calls `perform("dismiss")`. Escape and
  a click on the window's own background (outside the card) call the same
  path. `thumbnail-menu.ts`'s right-click menu is **not** changed — Trash
  is already there and remains the menu's own way out; dismiss is a
  window-chrome gesture, not a menu item.
- Click-outside needs a decision at build time: this panel is a
  borderless always-on-top `BrowserWindow`, not a DOM overlay, so "outside
  the card" most likely means the window losing focus (`blur`) rather
  than a literal click handler — matching how `countdown-window.ts`/
  `overlay-session.ts` already reason about this class of window. Confirm
  against `panel-focus.ts`'s focus model when implementing; if blur turns
  out to fire spuriously (e.g. on a system dialog), Esc + the X remain the
  fallback and click-outside can be dropped without losing the core ask.

## Explicitly out of scope

- Multi-profile create/switch/delete UI — the 2026-09-21 scope note is
  explicit ("relocate only... profiles stay a single implicit set until a
  later ticket"). "Profile" here means one section holding the existing
  per-capture controls, not a profiles system.
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
- `app/test/panel-actions.test.ts` (new or extended): `closesPanel`/
  `promotes` for `"dismiss"`; `actionsFor`'s four-action output is
  UNCHANGED (a control asserting this is what would catch dismiss being
  added there by mistake).
- E2E: the sheet shows both Profile and Preferences sections; Scope/
  Camera/Mic still drive `recorder:start`'s payload correctly from their
  new location (every existing scope/camera/mic e2e test updated to open
  the sheet first — see the flag in section 3); no "Beside the shot"
  control; the diagnostics table is hidden by default and toggles;
  dismissing a fresh capture's panel (via X, via Esc) leaves its
  temp-storage directory untouched and closes the panel; the toast
  appears for a forwarded warning and auto-dismisses.
