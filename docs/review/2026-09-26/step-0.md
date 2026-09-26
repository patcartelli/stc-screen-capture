# STC-465 review — Step 0: orientation

Territory map only. No findings, no fixes. Line numbers are as of this
worktree's checkout (branch `stc-465-review-run`, commit `a998725`).

## 1. The windows

| Window (module) | HTML loaded | Preload | webPreferences (besides preload) | Lifetime |
|---|---|---|---|---|
| Main (`main.ts:222-251`, `createWindow`) | `app/renderer/index.html` | `preload.cjs` | `contextIsolation: true, nodeIntegration: false`; `titleBarStyle: "hidden"`, `trafficLightPosition: {20,24}` | **One instance.** Menu-bar-first (STC-292): closable, re-created by `createWindow()` on dock-click/tray-open when absent; `window-all-closed` does not quit on macOS. Collapses/expands into the STC-375 "pill" in place (same `BrowserWindow`, resized) via `attachPillToSupervisor`, re-attached every `createWindow()` call. |
| Editor (`editor-window.ts:40-73`, `openEditor`) | `app/renderer/editor.html` | `editor-preload.cjs` | `contextIsolation: true, nodeIntegration: false`, `autoplayPolicy: "no-user-gesture-required"` | **One instance**, module-level `let win`. Opening a second take re-navigates the same window (`load()`); closes to `undefined` on `"closed"`. |
| Still editor / "Redact" (`still-editor-window.ts:36-69`, `openStillEditor`) | `app/renderer/still-editor.html` | `still-editor-preload.cjs` | `contextIsolation: true, nodeIntegration: false` | **One instance**, module-level `let win`, same re-navigate-on-reopen shape as the editor. |
| Selection overlay (`overlay-session.ts:296-431`, class `OverlaySession`, driven by module-level `let active`) | `app/renderer/overlay.html` | `overlay-preload.cjs` | `contextIsolation: true, nodeIntegration: false`, `backgroundThrottling: false`; transparent/frameless/`type: "panel"` (NSPanel, `panel-focus.ts`); `enableLargerThanScreen: true` | **One window per display**, all belonging to one `OverlaySession` (one session at a time, `openOverlay`/`closeOverlay`/`overlayIsOpen` gate on `active`). Built fresh in `open()` (`for (const d of screen.getAllDisplays())`), torn down together on `finish()`. |
| Countdown panel (`countdown-window.ts:137-300`, class `Session`, module-level `let active`) | `app/renderer/countdown.html` | `countdown-preload.cjs` | `contextIsolation: true, nodeIntegration: false`, `backgroundThrottling: false`; transparent/frameless/`type: "panel"` | **One instance per countdown run** — a fresh `Session`/`BrowserWindow` each `runCountdown()` call, gated by `active`/`countdownIsOpen()`; destroyed when the countdown settles (`finish()`, `try/finally` per STC-391's wedge fix). |
| Thumbnail/floating panel (`thumbnail-window.ts`, class `ThumbnailSession`, module-level `let panels: ThumbnailSession[]`) | `app/renderer/thumbnail.html` | `thumbnail-preload.cjs` | `contextIsolation: true, nodeIntegration: false`, `backgroundThrottling: false`; transparent/frameless/`type: "panel"` | **A stack** — one `BrowserWindow` per capture, newest at the corner, each with its own settle/discard timer (`presentThumbnail` pushes onto `panels`; `"closed"` calls `leaveStack()`/resolves `closed`). Several can be alive at once (a capture burst). |
| Toast (`toast-window.ts:69-175`, module-level `let current`) | `app/renderer/toast.html` | `toast-preload.cjs` | `contextIsolation: true, nodeIntegration: false`, `backgroundThrottling: false`; transparent/frameless/`type: "panel"`, `show: false` → `showInactive()` (rule 1: never takes focus) | **One instance at a time** (undo or message mode share the same window class/slot); a new toast replaces (`hideToast()` first) whatever is up. Destroyed (not just hidden) via `hideToast()`. |

Pill: no separate `BrowserWindow`/module of its own — `pill-window.ts` operates on the **main window**, resizing/repositioning it in place (`collapsePill`/`restorePill`), driven by `attachPillToSupervisor` off `HelperSupervisor` heartbeat/`recording-ended`/`recording-lost` (never a click).

All seven `*-preload.ts` files use `contextIsolation: true` / `nodeIntegration: false` uniformly; no window sets `sandbox: false` or otherwise widens beyond that pair.

## 2. IPC surface (preload → handler)

Channel names below are exactly as passed to `ipcRenderer.invoke`/`.send`. "Handler file:line" cites the `ipcMain.handle`/`.on` (or, for the three windows that register their own, the equivalent listener).

| channel | exposed by (preloads) | handler file:line | args | touches disk? | touches the helper? |
|---|---|---|---|---|---|
| `recorder:status` | preload.ts (`recorder`) | main.ts:839 | — | no | reads `sup` presence/state only |
| `recorder:devices` | preload.ts | main.ts:834 | — | no | yes — `sup.devices()` |
| `recorder:getSettings` | preload.ts, editor-preload.ts, still-editor-preload.ts, thumbnail-preload.ts | main.ts:780 | — | yes — `readSettings` | no |
| `recorder:setSettings` | preload.ts (full patch), editor-preload.ts (`{previewMuted}` only) | main.ts:813 | `Partial<Settings>` | yes — `writeSettings` | no |
| `recorder:resolvedSaveFolder` | preload.ts | main.ts:799 | — | yes (path resolution, no I/O beyond settings read) | no |
| `recorder:takes` | preload.ts | main.ts:1580 | — | yes — `listTakes` | no |
| `recorder:start` | preload.ts | main.ts:1108 (`runRecordFlow("window")`) | — | yes (creates take dir via `newTakeDir`/temp-takes) | yes — spawns/starts recording |
| `recorder:stop` | preload.ts | main.ts:1475 | — | yes (promotes take) | yes — `sup.stopRecording()` |
| `recorder:reveal` | preload.ts | main.ts:2687 | `dir` | yes — `shell.showItemInFolder` after `existsSync`/root check | no |
| `take:rename` | preload.ts | main.ts:1605 | `file, dir, name` | yes — renames on disk | no |
| `take:delete` | preload.ts | main.ts:1795 | `file?, dir?` | yes | no |
| `editor:open` | preload.ts | main.ts:1831 | `dir, name, autoShare?` | no (opens window) | no |
| `still:capture` | preload.ts | main.ts:1383 | `action?` | yes (writes still under capture root) | yes — `sup.captureStill(...)` |
| `shortcuts:get` / `:set` / `:reset` | preload.ts | main.ts:1445 / 1447 / 1470 | action/accelerator | in-memory (`shortcuts`) + persisted via settings | no |
| `still:export` | preload.ts, editor-preload.ts, still-editor-preload.ts, thumbnail-preload.ts | main.ts:1948 | export request object | yes — writes file/pasteboard | yes — `sup.exportStill(...)` (helper does the ImageIO encode) |
| `still:chooseDestination` | preload.ts | main.ts:2079 | — | yes — `dialog.showOpenDialog` | no |
| `share:chooseDestination` | preload.ts | main.ts:2508 | — | yes — `dialog.showOpenDialog` | no |
| `library:list` | preload.ts | main.ts:1487 | `filter?` | yes — `listLibrary` | no |
| `library:writeThumbnail` | preload.ts | main.ts:1509 | `dir, bytes` | yes — `writeFile` | no |
| `library:shot` | preload.ts, still-editor-preload.ts | main.ts:1523 | `dir` | yes — reads `shot.json` | no |
| `still:reopen` | preload.ts | main.ts:1546 | `dir` | yes — reads `shot.json`, opens still editor | no |
| `still:duplicate` | preload.ts | main.ts:1568 | `dir` | yes — `duplicateTake` | no |
| `preview:open` / `:close` | editor-preload.ts | main.ts:1812 / 1821 | `dir` | no (sets `openTakes` map) | no |
| `preview:read` / `:size` / `:chunk` | editor-preload.ts | main.ts:2456 / 2464 / 2479 | `name[, offset, length]` | yes — reads take files | no |
| `preview:writeProject` | editor-preload.ts | main.ts:1840 | `bytes` | yes — writes `project.json` | no |
| `export:write` | editor-preload.ts | main.ts:1877 | `name, bytes` | yes — writes export file | no |
| `take:captureId` | editor-preload.ts | main.ts:1926 | — | yes — reads/writes capture-id sidecar (`capture-identity.ts`) | no |
| `app:version` | editor-preload.ts | main.ts:465 | — | no | no |
| `share:publish` | editor-preload.ts | main.ts:2567 | — | yes — `copyFile`, reads `project.json`, writes manifest | no |
| `share:reveal` | editor-preload.ts | main.ts:2680 | — | yes — `shell.showItemInFolder` | no |
| `still:writeShot` | still-editor-preload.ts | main.ts:2427 | `dir, redactions, mode` | yes — reads/writes `shot.json`, deletes stale thumbnail | no |
| `still:frame` | preload.ts, still-editor-preload.ts, thumbnail-preload.ts | main.ts:2384 | `dir, name` | yes — `readFile` (any `.png` in the dir) | no |
| `thumbnail:menu` | thumbnail-preload.ts | main.ts:2103 | `ctx` | no (builds/pops a `Menu`) | no |
| `still:dragFile` | thumbnail-preload.ts | main.ts:2139 | export request | yes — writes temp file for drag-out | yes — via `still:export`'s own path (helper encode) |
| `still:startDrag` (send) | thumbnail-preload.ts | main.ts:2181 (`ipcMain.on`) | `file` | yes — `existsSync` + native drag | no |
| `still:revealShot` | thumbnail-preload.ts | main.ts:2199 | `dir` | yes — `shell.showItemInFolder` | no |
| `panel:save` / `:edit` / `:dismiss` / `:trash` | thumbnail-preload.ts | main.ts:2222 / 2254 / 2285 / 2310 | `dir` | yes (moves/promotes/trashes) | no |
| `panel:undoTrash` | toast-preload.ts | main.ts:2346 | `dir` | yes — reverses a pending `shell.trashItem` | no |
| `still:reveal` | thumbnail-preload.ts | main.ts:2370 | — | yes — `shell.showItemInFolder(lastStillFile)` | no |
| `pill:contentWidth` (send) | preload.ts | main.ts:90 (`ipcMain.on`) | `px` | no (in-memory cache) | no |
| `toast:message` (send) | preload.ts | main.ts:97 (`ipcMain.on`) | `text` | no | no |
| `toast:dismiss` (send) | toast-preload.ts | main.ts:96 (`ipcMain.on`) | — | no | no |
| `overlay:event` (send) | overlay-preload.ts | overlay-session.ts:350 (`ipcMain.on`, registered per `OverlaySession.open()`) | event | no | no directly (feeds selection state; a confirmed selection later calls `still:capture`/`recorder:start`) |
| `countdown:event` (send) | countdown-preload.ts | countdown-window.ts:183 (`ipcMain.on`, registered per `Session.begin()`) | event | no | no |
| `thumbnail:event` (send) | thumbnail-preload.ts | thumbnail-window.ts:551-553 — **not** `ipcMain.on`; listened directly on `this.win.webContents.on("ipc-message", ...)`, one listener per panel | event | no | no |

Push-only channels (main → renderer, no handler to look up because nothing is answered): `helper:*` (ready/stats/respawned/gave-up/recording-lost/recording-ended/warning/camera-started/mic-started), `still:captured`, `pill:state`, `settings:changed`, `recorder:recording-state`, `overlay:state`, `countdown:state`, `thumbnail:hiddenCount`, `toast:expire`. These are sent via `win.webContents.send(...)` from `main.ts`/`overlay-session.ts`/`countdown-window.ts`/`thumbnail-window.ts`/`pill-window.ts`, not routed through `ipcMain`.

**Orphan check:** every channel a preload exposes resolved to a live handler above (including the four shared ones — `still:export`, `still:frame`, `recorder:getSettings`, `library:shot` — each called from more than one preload against the exact same `main.ts` handler, matching the "no second implementation" convention the module headers describe). No handler in the grep of `ipcMain.handle`/`ipcMain.on` across `app/src/*.ts` was left without a preload caller. `still-io.ts` registers no `ipcMain` handlers of its own — it is a plain function module (`exportStill`, `plannedFileName`, etc.) called from `main.ts`'s own `still:export`/`still:dragFile`/`thumbnail:menu` handlers, not a fourth self-registering window module the way the task description's framing suggested; the three that do self-register are `overlay-session.ts`, `countdown-window.ts`, and (via the `webContents`-level listener, not `ipcMain`) `thumbnail-window.ts`.

## 3. The helper boundary

- **Binary path** (`main.ts:74-75`): `process.env.STC_HELPER_BIN || join(here, "..", "..", "helper", "build", "stc-helper")` — overridable for the E2E suite and debug builds.
- **Spawn** (`helper-client.ts:161-163`, `HelperClient.spawn`): `spawn(binPath, argv, { stdio: ["pipe", "pipe", "pipe", "pipe"] })`. `argv` is `["--stats-interval-ms", String(opts.statsIntervalMs)]` when supplied, else `[]`. `main.ts:288-294` (`startSupervisor`) calls `HelperSupervisor.start(HELPER, { statsIntervalMs: 500, getSaveFolder: () => readSettings(...).saveFolder })` — no other env/argv is passed; the child inherits the parent's environment (and, load-bearingly per CLAUDE.md/CORRECTNESS-TRAPS.md, the parent's TCC identity, since it's spawned as this app's own child rather than execed standalone).
- **stdio channels**: fd 0 (stdin) — requests, JSON-line, written as `{...params, cmd, seq}\n` (`helper-client.ts:196`). fd 1 (stdout) — **lossy**: stats only, read via `readLines(proc.stdout!, ...)`, cannot resolve a pending request (`:105-107`). fd 2 (stderr) — collected as `recentStderr` for diagnostics on crash/exit. fd 3 — **reliable**: responses (seq-correlated) and lifecycle events, read via `readLines(proc.stdio[3] as Readable, ...)` (`:83-85`).
- **Which `ipcMain` handlers end in a helper command** (i.e. call something on `sup`): `recorder:devices` (`sup.devices()`), `recorder:start`→`runRecordFlow`→ ultimately `sup.startRecording(...)`, `recorder:stop` (`sup.stopRecording()`), `still:capture` (`sup.captureStill(...)`), `still:export`/`still:dragFile` (`sup.exportStill(...)`), and the overlay's window list (`sup.listWindows()`, read fresh each time the overlay opens — called from the record/still flow code in main.ts, not from a bare `ipcMain` channel). Everything else (library, preview/export file I/O, share, settings, shortcuts, panel actions, toasts) is main-process-only file/dialog/shell work with no helper round trip.

## 4. Main-process state that outlives a single request

Module-level `let`s (all in `main.ts` unless noted) and what resets each:

| state | reset by |
|---|---|
| `win: BrowserWindow \| undefined` | set in `createWindow()`; cleared implicitly by `isDestroyed()` checks elsewhere (no explicit `win = undefined` on close was found in the excerpt read — main window is recreated via `createWindow()` when absent/destroyed, consistent with STC-292's menu-bar-first close behavior) |
| `sup: HelperSupervisor \| undefined` | set once in `startSupervisor()`; the supervisor itself respawns its *own* child process internally without `sup` ever being reassigned |
| `pillContentWidthPx` | updated on every `pill:contentWidth` push from the renderer; never explicitly reset (starts at `MIN_PILL_WIDTH_PX`) |
| `openTakes: Map<number, string>` | per-`sender.id` entry deleted on that `WebContents`' `"destroyed"` event (`main.ts:117-127`); also cleared by `preview:close` (`clearOpenTake`) |
| `cleanedUpSenders: WeakSet<WebContents>` | never explicitly cleared — a `WeakSet` so GC reclaims entries once the `WebContents` itself is collected |
| `tray: TrayHandle \| undefined` | set once at startup; not reassigned elsewhere in the read range |
| `shortcuts` / `shortcutReport` | updated by `shortcuts:set`/`shortcuts:reset` |
| `capturing: boolean` | set around a capture request/response window (per its own header comment, deliberately not derived from `overlayIsOpen()`) |
| `recordFlowActive: boolean` | toggled around the record flow, guarding the Record hotkey from cancelling a still's overlay/countdown |
| `lastStillFile: string \| undefined` | set on every successful still write; read by `still:reveal` |
| `pendingTrash: PendingTrash` (const, but mutable instance) | entries removed by its own sweep (`TRASH_SWEEP_INTERVAL_MS`) or by `panel:undoTrash` |
| `trayKnownRecording: boolean` | compared against `sup.state` each heartbeat in `reconcileTrayRecording`, updated on transition |
| `systemShuttingDown`, `quitting: boolean` | set during app shutdown sequencing |
| `lastPublishedFile: string \| null` | set by `share:publish`; read by `share:reveal` |
| `active: OverlaySession \| undefined` (overlay-session.ts:233) | set in `openOverlay`; cleared to `undefined` in `finish()` |
| `active: Session \| undefined` (countdown-window.ts:87) | set in `runCountdown`; cleared (by identity check) when that session settles |
| `panels: ThumbnailSession[]` (thumbnail-window.ts:172) | panel instances pushed in `presentThumbnail`, removed via `leaveStack()` on each panel's `"closed"` |
| `current: {win, timer} \| undefined` (toast-window.ts:69) | replaced by `buildToastWindow`'s `hideToast()` call, or cleared in `hideToast()` itself |
| `duplicating: Set<string>` (takes.ts:205) | claimed before an async duplicate, released after (race guard per STC-345) |

## 5. Electron version

`package.json:27`: `"electron": "43.4.1"` (exact pin in `devDependencies`, not a caret range) — consistent with CLAUDE.md's PRE-DEMO-CHECKLIST practice of freezing Electron/deps before a demo week. `package.json:35` main entry: `app/dist/main.mjs` (esbuild output of `app/src/main.ts` per `app/build.mjs`). Whether 43.4.1 is the current Electron release was not independently verified against the public release feed in this pass (no network check performed); flagging only that the pin is exact rather than a range, which is itself the documented intent, not a gap.
