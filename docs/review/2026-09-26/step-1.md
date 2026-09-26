# STC-465 review — Step 1: Security & trust boundaries

Builds on step-0.md's IPC table and window inventory; not repeated here except
where a specific row is the finding's evidence.

## 0. Generic checklist (settled)

Confirmed against step-0.md §1 and by re-reading every `webPreferences` block
directly (`main.ts:237`, `editor-window.ts:61`, `still-editor-window.ts:53`,
`overlay-session.ts:400`, `countdown-window.ts:171`, `thumbnail-window.ts:528`,
`toast-window.ts:96`): all seven windows set `contextIsolation: true`,
`nodeIntegration: false`, none sets `sandbox: false`, none sets `webviewTag`
or `webSecurity: false`. Settled, per the task brief — one line, no section.

## 1. Paths from the renderer

Traced every handler in step-0's IPC table whose arguments include a path,
directory, take id or filename. All of them route through one of two
confinement predicates before touching `fs`:

- `insideTakesRoot` (`app/src/takes.ts:22-27`) — resolves both the root and
  the target with `resolve()` and compares against a separator-terminated
  prefix, closing both the `../../tmp/evil` traversal and the `<root>-other`
  sibling hazard its own header documents finding in five places historically.
- `insideCaptureRoot` (`main.ts:174-176`) — `insideTakesRoot` OR
  `insideTempTakesRoot` (`temp-takes.ts:93-98`, the identical closure against
  the temp root), for the handlers a take must reach before it's promoted.

Every handler that takes a `dir`/`file` argument calls one of these before
any `fs` operation: `library:writeThumbnail` (`main.ts:1511`), `library:shot`
(`:1525`), `still:reopen` (`:1548`), `still:duplicate` (`:1570`), `take:delete`
(`:1804`), `preview:open` (`:1814`), `editor:open` (`:1833`), `still:export`'s
`dir` fallback (`:1981`, explicitly `insideCaptureRoot` not `startsWith` —
comment at `:1993` names why), `still:revealShot` (`:2201`), `panel:save`/
`edit`/`dismiss`/`trash`/`undoTrash` (`:2224`, `:2256`, `:2287`, `:2312`,
`:2348`), `still:frame` (`:2386`), `still:writeShot` (`:2429`), `recorder:reveal`
(`:2691`). `take:rename`/`take:delete`'s label path defers to `renameCapture`/
`setTakeLabel` (`takes.ts:117`, `:147`), which validate internally — confirmed
those two really do now (both do; `take:rename`'s own comment at `main.ts:1594`
flags that this was previously true of only one of them and was fixed in
`takes.ts`, not by adding a second check in `main.ts` — read and confirmed
current).

**Symlinks:** `sweepOrphanedBundles` (`temp-takes.ts:309-315`) uses `lstat`,
not `stat`, specifically because `resolve()` does not follow symlinks and a
symlinked entry under `raw/` would otherwise let this function operate through
it outside the declared root — the header names this explicitly and the code
matches it.

**Filenames constrained to a leaf, not just a directory:** `export:write`
(`main.ts:1882`) regexes the name to `^[A-Za-z0-9._-]+\.(mp4|json|png)$` and
re-checks `..`, then separately refuses `TAKE_FILES`/`take.json` names so an
export can't overwrite source media (`:1888`). `still:frame` (`:2389`) and
`renameCapture` (`takes.ts:155-168`) apply the same leaf-only discipline,
the latter additionally refusing a leading dot because a hidden file drops
out of the library scan and its bundle reads as orphaned (`:161-168`, a
correctness finding turned into a security-relevant refusal — a renderer
that could rename to `.evil` could make the sweep silently orphan-and-later-
delete its own source bundle).

**`preview:read`/`:size`/`:chunk`** (`main.ts:2456`, `:2464`, `:2479`) never
see a path at all: `name` is checked against the fixed `TAKE_FILES` set
(`:199`), so there is no traversal surface here regardless of what a
compromised renderer sends — this is tighter than a regex.

No finding in this area. The confinement predicate is applied consistently,
the traversal/sibling holes CORRECTNESS-TRAPS.md already documents fixing
are closed at the one place they're defined, and the two `lstat`-vs-`stat`
and dot-file gaps have been deliberately addressed rather than overlooked.

## 2. Documents from the renderer

`still:writeShot` (`main.ts:2427-2454`) reads the stored document, replaces
only `decoration.redactions`/`decoration.mode`, and pushes the result through
`parseShot` before `shotForWrite` before the write — a region or mode the
schema refuses cannot reach disk, and `shot.ts`'s `additionalProperties: false`
means an attempt to smuggle any other field is rejected by the parse.

**`preview:writeProject` (`main.ts:1840-1860`) does not do the equivalent.**
It `JSON.parse`s the renderer's bytes, checks only that `doc.version` is one
of `PROJECT_VERSIONS` (`isProjectVersion`, `transform/src/project-version.ts:32`),
and writes the original bytes verbatim — no `parseProject`, no
`projectForWrite`, no schema check on any other field. `transform/src/trim.ts`
exports both (`:136`, `:387`) and `app/src/editor.ts` calls `projectForWrite`
before every `writeProject` call it makes (`editor.ts:398-399`) — but that
call is in the renderer, which is exactly the boundary this review is told to
treat as untrusted. A renderer that sent version `12` with an otherwise
arbitrary body — oversized arrays, wrong types on `crop`/`zoom` fields,
whatever `parseProject`'s lenient defaulting does or doesn't handle — would
have it written to `project.json` unchanged. `project-version.ts`'s own header
explains at length why the version check itself is centralised (two hand-rolled
copies drifted twice), but says nothing about validating the rest of the
document; this is not a decision the module records as settled, just a gap
next to a well-documented one.

Contrast with `library:writeThumbnail`'s PNG magic-number check
(`main.ts:1507-1520`) and `still:writeShot`'s full parse-before-write: this is
the one document-writing handler in the app that trusts the renderer's byte
stream completely once a bare version tag matches.

- **Medium** (`main.ts:1840`). A guard missing where exploitation needs
  another bug first (a compromised or buggy editor renderer), and the
  document is read back only by `parseProject`'s lenient/defaulting path
  (`trim.ts:136`) rather than a refusing one — so a malformed field is more
  likely to surface as a downstream rendering/export bug than a crash, but
  nothing at the write boundary enforces that. **CI-CHECKABLE**: a test can
  call the `preview:writeProject` handler (or drive it via
  `window.editor.writeProject` in an e2e harness) with a version-12 document
  carrying a field `parseProject`/`projectForWrite` would never produce, and
  assert it is refused or normalised rather than written byte-for-byte.

## 3. Navigation and new windows

`grep -rn "will-navigate|setWindowOpenHandler|web-contents-created|setPermissionRequestHandler" app/src/*.ts`
returns **zero matches**. No window — not the main window, not the editor,
not the still editor, not the overlay, not the countdown panel, not the
thumbnail stack, not the toast — registers any of the four. Confirmed by
reading every `*-window.ts`/`main.ts` window-creation site; none follows
`.loadFile(...)` with a `will-navigate` or `setWindowOpenHandler` call on
that `webContents`.

Practical read: `nodeIntegration: false` + `contextIsolation: true` bounds
what a navigated-to page could reach directly (no `require`, no raw
`ipcRenderer`), and on this Electron version (`43.4.1`, per step-0 §5)
`window.open()` with no `setWindowOpenHandler` defaults to **denied**, not to
the pre-Electron-14 "opens with the same webPreferences" behaviour — so the
`setWindowOpenHandler` gap is close to cosmetic here. `will-navigate` is not:
Electron's own security guidance names "a link or a file dragged into the
window" as the standard way a top-level frame navigates without any renderer
code asking for it, and a `preload` script is attached to the `WebContents`,
not to the specific document — it reruns and re-exposes its whole
`contextBridge` surface on whatever the frame navigates to next. Every one of
the seven windows would hand its *own* bridge (the main window's 24-channel
one, in particular — see step-0 §2) to whatever a dropped file or a
pasted/dragged URL navigated it to.

Nothing in this repo demonstrates the drop actually works (that needs a Mac
and a real drag), and nothing rules it out either — no renderer registers a
`dragover`/`drop` listener anywhere (`grep -rn "\"dragover\"|'dragover'|\"drop\"|'drop'" app/src` :
zero matches), so Chromium's default handling is whatever it is, unmodified.

- **Medium** (absence, all seven window-creation sites — no single
  file:line, since the gap is the lack of a call, not a wrong one).
  Exploitation needs a second event (a user dragging an untrusted file or
  link onto an app window) to reach it, which is why this is Medium rather
  than High — but the consequence if it fires is not cosmetic: the target
  window keeps its preload bridge. **NEEDS-A-MAC** to confirm whether this
  Electron version's default drag handling actually triggers a top-level
  navigation for a dropped file/link in the first place (a sandboxed renderer
  with no drop handler may or may not get Chromium's default file-navigation
  behavior depending on how the window was constructed) — but the guard
  Electron's own docs recommend for exactly this is absent regardless of that
  answer, so the fix (a `will-navigate` handler on each `webContents` refusing
  anything but the app's own `file://` page) does not need the Mac finding to
  be worth adding.

## 4. CSP

| file | CSP |
|---|---|
| `app/renderer/index.html:5` | `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'` |
| `app/renderer/editor.html:5` | `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; worker-src 'self'` |
| `app/renderer/still-editor.html:5` | `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'` |
| `app/renderer/thumbnail.html:5` | `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:` |
| `app/renderer/countdown.html:5` | `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'` |
| `app/renderer/toast.html:5` | `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'` |
| `app/renderer/overlay.html` | **none** |

**`overlay.html` has no `<meta http-equiv="Content-Security-Policy">` at
all** — the only one of the seven that doesn't. It does load a script
(`overlay.html:131`, `<script src="../dist/overlay.js">`), so with no CSP the
page has no `default-src`/`script-src` restriction: inline scripts, `eval`,
and (bounded only by the absent-elsewhere `will-navigate` guard from §3)
whatever the page can otherwise reach would not be blocked by policy the way
every sibling window's is.

- **Low-Medium** (`app/renderer/overlay.html`, no CSP anywhere in the file).
  `overlay-preload.ts`'s bridge is already the narrowest in the app (`send`/
  `onState` only, no file access — see step-0 §1 and this file §5 below), so
  the blast radius of a compromised overlay renderer is small on its own; the
  gap is real but the exposed surface behind it is already minimal. Medium
  bound only because it's a guard missing where something else (getting
  arbitrary content into a `file://`-loaded, contextIsolated page with no
  navigation surface of its own) would need to go wrong first.
  **CI-CHECKABLE** — a test reading the file for the same
  `<meta http-equiv="Content-Security-Policy"` string every other renderer
  HTML carries would catch this today and would catch a future regression in
  any of the other six.

## 5. Preload breadth

Read all seven `*-preload.ts` files in full. Each is narrower than the
previous one's own comment claims for it, checked rather than assumed:

- `overlay-preload.ts` — `send`/`onState` only. No file, capture or settings
  channel; matches its header's claim exactly.
- `countdown-preload.ts` — `send`/`onState` only, and explicitly "not even
  the take directory the thumbnail's bridge needs" per its own comment;
  confirmed no take-shaped channel is present.
- `toast-preload.ts` — `undo`/`dismiss`/`onExpire`; `dir` and the undo
  window's length ride the page's own URL query string instead of the bridge
  (per its comment), so there's nothing wider to find here.
- `thumbnail-preload.ts`, `still-editor-preload.ts`, `editor-preload.ts` —
  each exposes exactly the channels its own window's renderer script calls
  (spot-checked `still-editor-renderer.ts`'s calls against
  `still-editor-preload.ts`'s five exports and `editor.ts`'s calls against
  `editor-preload.ts`'s twelve — no exported channel goes uncalled by its
  own window, and no channel that window uses is missing from its preload).
- `preload.ts` (main window) is the widest, as expected — it is the one
  window that surfaces recording, capture, the library, hotkeys and settings
  — but every channel it exposes is one the renderer script (`renderer.ts`)
  actually calls; nothing unused was found riding along.

No finding — every bridge is at or below what its own window's code calls,
which is the property item 5 asks about (a bridge wider than its window is a
bridge another window's compromise could use; none is).

## 6. `shell.*` and dialogs

`grep -rn "shell\.(openExternal|openPath|showItemInFolder|trashItem)" app/src/*.ts`:
**no `shell.openExternal` or `shell.openPath` call exists anywhere in this
app.** Only two `shell.*` calls are used at all:

- `shell.showItemInFolder(...)` — five call sites (`main.ts:2204`, `:2372`,
  `:2683`, `:2694`, `still:revealShot` already covered in §1). Every argument
  is either a path already validated by `insideCaptureRoot`/`insideTakesRoot`
  moments earlier, or one of the module-level, main-owned strings
  (`lastStillFile`, `lastPublishedFile`) that are never set from a renderer-
  supplied value — `lastStillFile`'s own comment (`main.ts:152-161`) states
  this is deliberate: widening `recorder:reveal`'s guard to accept an
  arbitrary renderer path "would hand the sandboxed renderer the ability to
  open anything."
- `shell.trashItem(...)` — every call site takes a path already checked by
  `insideCaptureRoot`/`insideTakesRoot` in the calling handler, or a path this
  process derived itself (the orphan sweep's own `rawRoot`-scanned
  directories, the quit-time `pendingTrash` commits).

No dialog (`dialog.showOpenDialog`/`showSaveDialog`) result is ever handed
back to a renderer as a path to act on unchecked — `share:chooseDestination`
and `still:chooseDestination` write the chosen folder into main-owned
settings/state rather than returning it for a later renderer-named write.

No finding.

## 7. The helper spawn

- **argv**: `HelperClient.spawn` (`helper-client.ts:161-163`) takes only
  `["--stats-interval-ms", String(opts.statsIntervalMs)]` or `[]`; the one
  caller (`main.ts`'s `startSupervisor`, per step-0 §3) passes a fixed
  `{ statsIntervalMs: 500, ... }` — no renderer-controlled value ever reaches
  argv.
- **env**: inherited from the Electron main process wholesale (no explicit
  `env` passed to `spawn`), which is the documented TCC-inheritance mechanism
  (CLAUDE.md, `CORRECTNESS-TRAPS.md`) rather than a renderer-influenced value.
- **stdin command injection**: `request()` (`helper-client.ts:196`) builds
  every line as `JSON.stringify({ ...params, cmd, seq }) + "\n"`. A renderer-
  supplied string (a filename template, an `info.title` window title, a
  captured take directory) can contain a literal newline or arbitrary
  control characters, but `JSON.stringify` escapes them (`\n`, `\u0000`,
  etc.) inside the JSON string value — there is no way for a value to inject
  a second, attacker-controlled JSON line, and `cmd`/`seq` are spread *after*
  `...params` so a `params.cmd` cannot override the command being sent. No
  finding here; the framing is closed by construction, not by luck.
- Every `ipcMain` handler that ends in a helper command (`recorder:devices`,
  `recorder:start`→`runRecordFlow`, `recorder:stop`, `still:capture`,
  `still:export`/`still:dragFile`, per step-0 §3) passes only main-derived
  or already-validated values (paths pre-checked by §1's guards; dimensions,
  quality, format, template strings that are sanitized downstream by
  `sanitizeSegment`/`renderTemplate` in `transform/src/still-export.ts`
  before becoming any filename component, stripping `/`, `\`, `:` and control
  characters and any leading dot).

No finding.

## Disagreements with settled decisions

None. `lastStillFile`'s scope-widening refusal (`main.ts:152-161`),
`export:write`'s identity-over-name destination resolution (STC-413), and
the version-only gate on `preview:writeProject` (`project-version.ts`'s
header) are all decisions this review either confirms hold in the code or,
for the last one, treats as an adjacent gap rather than a rejection of the
decision itself — the header settles *which version check*, not *whether
the rest of the document needs validating*.
