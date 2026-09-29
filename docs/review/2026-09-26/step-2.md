# STC-465 review: Step 2, duplication and drift

Worktree `stc-465-review-run`, commit `a998725`. Line numbers are as of that
checkout. No code was changed.

**What this pass looked for.** One value with two copies: a type restated
instead of imported, a constant or literal defined twice, logic implemented
twice where CLAUDE.md names one owner, code that nothing reaches, and
CLAUDE.md rows that no longer describe their file. For every candidate I read
the owning module's header before deciding whether the copy is deliberate.

**Method.**
- Read all seven preloads, and every renderer's `declare global` /
  `declare const` bridge block.
- Scanned every `export` in `app/src/` for importers across `app/`,
  `transform/`, `harness/`, `scripts/`, `helper/test/` and `tools/`.
- Scanned every top-level declaration in `app/src/` for a second use in its
  own file.
- Checked every `*-preload.ts` member for a caller in `app/src/` and
  `app/test/`.
- Checked every `Settings` key for a reader outside `settings.ts`.
- Grepped for take filenames, colour literals, `_MS`/`_PX` constants, time
  formatters and `padStart(2`, `getContext("2d"`, `new BrowserWindow`,
  `setAlwaysOnTop`, and the start-param, export-filename and still-funnel
  operations.
- Checked every path in the CLAUDE.md table for existence. Then read the rows
  for `app/` files against their code.

**Excluded, as the brief requires.** The pure-decisions/window split
(`selection.ts`, `pill.ts`, `countdown.ts`, `thumbnail.ts`, `scrubber.ts`,
`hotkeys.ts`, `device-picker.ts`, `library-items.ts` and others). Files split
only to satisfy a tsconfig pass (`supervisor-state.ts`, `project-version.ts`,
`library-items.ts`). Any abstraction that is simply single-callsite. None of
these appear below.

Each finding carries the three things the brief asks for:
- **Status:** DRIFTED (the copies already disagree; a live bug or a live lie)
  or HAZARD (identical today, nothing stops them diverging).
- **Owner:** where the one copy should live.
- **Class:** CI-CHECKABLE (a test in this repo could pin it) or NEEDS-A-MAC.

---

## Summary

| # | severity | status | one line |
|---|---|---|---|
| D1 | **High** | DRIFTED | The still-editor's copy of the "composite, then export" sequence has drifted from the panel's. It ignores the scale preference and draws into an sRGB canvas, then labels the pixels P3. |
| D2 | Medium | DRIFTED | `Settings.displayId` is written by a live "Source" control that nothing reads since STC-388. |
| D3 | Medium | DRIFTED | `export:write`'s hand-kept list of "the take's own files" missed STC-413's `capture.json`. |
| D4 | Medium | dead | Three bridge members no renderer calls: `recorder.takes`, main-window `recorder.exportStill`, `thumb.reveal`. The latter carries its handler and `lastStillFile` along with it. |
| D5 | Medium | DRIFTED | `Settings` is restated in four renderers. `editor.ts`'s copy still carries `still.destination`, which STC-412 removed. |
| D6 | Medium | HAZARD | The IPC event and payload unions live in Electron-side modules. Renderers restate them (`ThumbEvent`) or send untyped (`OverlayEvent`, overlay/countdown payloads). |
| D7 | Low–Med | HAZARD | More restated wire shapes: `StillResult`, the helper's `devices` reply (and a same-name-different-shape `DisplayInfo`), and the `still:export` request. |
| D8 | Low–Med | HAZARD | The anchors-version list exists twice behind a "cannot share a constant" claim, the same claim STC-318 disproved for project versions. |
| D9 | Low | HAZARD | Bundle filenames and the rule for which kind a bundle is are respelled per call site. `shot.json` is read and parsed in 7 places. |
| D10 | Low | HAZARD | `insideTempTakesRoot` is a line-for-line copy of `insideTakesRoot`'s body. |
| D11 | Low | HAZARD | Colour tokens copied: `editor.html` restates `tokens.css`'s whole dark block; the panels copy the accent literal. |
| D12 | Low | dead | `PILL_THEME` is the declared owner of the pill's colours, and nothing reads it. |
| D13 | Low | HAZARD | The panel `BrowserWindow` recipe is written four times; `panel-focus.ts` owns only `type`. |
| D14 | Low | HAZARD | `scrubber.ts` rule 9's 6 px tick threshold is redeclared in `editor.ts`. |
| D15 | Low | HAZARD | The 20 px corner margin is defined three times, and the toast relies on a default. |
| D16 | Low | DRIFTED (dead copy) | The duration formatter exists three times. `renderer.ts`'s dead copy of the size formatter disagrees with the live one. |
| D17 | Low | HAZARD | `readSettings` and `writeSettings` each spell every field's cleaning rule. |
| D18 | Low | DRIFTED | `PanelTake` is validated and defaulted in two places, with different strictness. |
| D19 | Low | DRIFTED | `CARD_CHROME` restates `thumbnail.html`'s CSS and no longer matches it. |
| D20 | Low | HAZARD | `overlay.ts` hand-writes the global↔display-local conversion that `spaces.ts` owns. |
| D21 | Low | dead | Dead exports and parameters, several of them labelled "for tests". |
| D22 | Low | HAZARD | Label and title literals kept in two places. |
| §5 | — | DRIFTED | CLAUDE.md rows and code comments that no longer describe their file. |

---

## 1–3. Restated types, duplicated constants, logic implemented twice

### D1: Three copies of the still "composite, then export" sequence; the still editor's copy has drifted twice. **High, DRIFTED**

**Where the three copies are.** Each one turns a `shot` and a `frame` into
export bytes: decorate, `layoutStill`, `planRender`, create a canvas,
`sampleRedactionFills`, `renderStill`, `getImageData`, then `still:export`.
- `app/src/thumbnail-renderer.ts:178-208` (`draw`) and `:259-285`
  (`runExport`).
- `app/src/still-editor-renderer.ts:92-107` (`draw`) and `:231-262`
  (`saveFinished`). The export half of this copy was added by STC-446.
- `app/src/renderer.ts:1026-1070` (`renderThumbnail`, the library cache,
  which is not an export).

**Drift 1: the scale preference.** `planRender`'s `RenderPlan.layout` is
documented as "already at the output scale"
(`transform/src/still-export.ts:433`). The panel sizes and renders its
composite from `plan.layout`. Its comment at `thumbnail-renderer.ts:192-197`
records the bug of *not* doing so: a 2x canvas for a 1x export. The still
editor builds its composite from the **unscaled** `layout`
(`still-editor-renderer.ts:95-99`). `saveFinished` then computes a plan
(`:242`), but sends `composite.width/height` and the composite's pixels
(`:255-256`). So when the stored scale is `1x` on a retina capture, Save in
the still editor writes a 2x image, while Copy/Save from the panel writes 1x.
The default scale is `native` (factor 1), which is why nothing has noticed.

**Drift 2: colour space.** The panel creates its context with
`colorSpace: colorSpaceFor(shot.display.colorSpace)`
(`thumbnail-renderer.ts:200`). The still editor's is
`getContext("2d", { alpha: true })` with no colour space
(`still-editor-renderer.ts:99`), which means sRGB. The P3-tagged `frame.png`
is converted into sRGB when drawn. `getImageData` returns sRGB values. The
request then still says `colorSpace: shot.display.colorSpace`
(`:257`). `main.ts:2021` maps that to `display-p3`, and the helper embeds a P3
profile over sRGB numbers. On a P3 display, which is every current Mac panel,
a still saved from the editor should come out visibly oversaturated. That is
the round-trip STC-293's acceptance criterion forbids.

**A third, latent difference.** The panel lays out `shot` directly. The
still editor and the library thumbnail first apply `decorationForMode`, which
fills preset padding, shadow and background. For every document reachable
today the two agree: nothing changes `decoration.mode` any more, and the
helper writes `window-only`/`selected-area`, where the preset adds nothing.
It becomes a live difference the moment a mode can change again.

**Why this matters.** `still-editor-renderer.ts:227-230`'s header says the
fallback "is the panel's, for the panel's reason". The copy was taken on
purpose, and the part that mattered didn't come with it. This is the
"fourth caller assembled a project outside `parseProject`" shape from
CORRECTNESS-TRAPS, one layer up.

**Owner.** One pure renderer-side helper. It takes `(shot, frame, options)`
and returns `{ canvas, plan, request }`: it applies `decorationForMode`,
renders at `plan.layout` with the plan's colour space, applies the
PNG fallback, and builds the `info` block. The natural home is next to
`still-render.ts` in `transform/src/`. The panel, the still editor and
(for everything but the request) the library thumbnail all call it.

**Class: CI-CHECKABLE.** `redaction.e2e.test.ts:332-354` already drives
`#save` with `STC_FAKE_STILL_LOG`. Stored `scale: "1x"` on a fixture with
`pxPerPoint` 2 should log the helper being asked for half-size pixels, and
the context's `getContextAttributes().colorSpace` can be asserted equal to
what the request declares. Seeing the P3 shift itself is NEEDS-A-MAC.

### D2: `Settings.displayId` is a live control that nothing reads. **Medium, DRIFTED**

**What the control does.** The Settings sheet's "Source" `<select>`
(`app/renderer/index.html:451`, wired at `app/src/renderer.ts:163-212`) writes
`displayId` through `recorder:setSettings`. It survives a restart
(`display-picker.e2e.test.ts` asserts that).

**What reads it.** Nothing in main. `recordFlowBody` takes the display from
the overlay's outcome (`main.ts:1007`). `captureStill` takes it from the
pointer (`main.ts:1338`). `display-picker.e2e.test.ts:89-106` says so outright
("NOTHING in the shipped app currently reads `Settings.displayId` at all") and
leaves the control's fate as "unscoped follow-up work for STC-388".

**What still describes the dead behaviour:**
- `settings.ts:36-44`: "if that display is gone at `start`, the helper refuses
  with `display-not-found`".
- `renderer.ts:153-162`: the same.
- CLAUDE.md's STC-374 row: "the same way a chosen display already was".

**Why this matters.** A user picks a display and the app silently records
another one. It is also a `Settings` key that nothing reads: category 4.

**Owner.** Either `runRecordFlow` reads it (a product decision, not this
review's), or the control, the key and three doc passages go. This is not a
settled decision: the test names it as unscoped.

**Class: CI-CHECKABLE.** A grep test can hold that every `Settings` key has a
reader in `main.ts` or a module main imports, beyond `settings.ts` and the
renderers.

### D3: `export:write`'s list of files it must not overwrite missed `capture.json`. **Medium, DRIFTED**

**The check.** `main.ts:1888` refuses `TAKE_FILES.has(name) || name === "take.json"`.
`TAKE_FILES` (`main.ts:199`) is the helper's recording outputs, and it still
matches the Swift writers; I checked `helper/src/*.swift`.

**What it misses.** STC-413 added a bundle identity document,
`CAPTURE_DOC_FILE = "capture.json"` (`transform/src/capture-doc.ts:18`,
read by `capture-identity.ts`). It is not on the list. A `.json` name is
written straight into the bundle (`main.ts:1892-1895`), so
`writeExport("capture.json", …)` replaces the id that links the finished file
to its bundle. That breaks `export:write`'s own identity lookup, `share:publish`
and the orphan sweep.

**Why this matters.** Only a buggy or compromised editor renderer can reach
this, which is why step 1 didn't treat it as a path finding. Here it is a
drift finding: the list is a hand-kept copy of "which files belong to a take",
and it was never updated when that set grew. `shot.json` and `thumb.png`
aren't on it either. Neither exists in a recording bundle today, but nothing
guarantees that.

**Owner.** One exported "files a bundle owns" set built from the owners'
constants (`CAPTURE_DOC_FILE`, `THUMBNAIL_FILE`, and a `TAKE_LABEL_FILE` for
`take.json`). `library-items.ts` already holds `THUMBNAIL_FILE`, so that is the
natural home.

**Class: CI-CHECKABLE.** A unit test can assert that every `*_FILE` constant
in `app/src`/`transform/src` is in the refusal set, or an e2e can call
`editor.writeExport("capture.json", …)` and expect a refusal.

### D4: Bridge members no renderer calls, and what hangs off them. **Medium, dead code**

Every one of these checks out as reachable in step 0 (preload → handler), but
nothing calls them:

- **`recorder.takes`** (`preload.ts:13`) → the `recorder:takes` handler
  (`main.ts:1580-1581`). `renderer.ts` still declares `takes()` (`:64`) and a
  `Take` interface just for it (`:46-50`). Nothing in `app/src` or `app/test`
  calls it. `listTakes` itself stays live: tests use it and `library.ts`
  defines it as a filter.
- **`recorder.exportStill`** (`preload.ts:43`), in the **main** window. Its
  justification comment (`:38-42`, "the preview's frame grab goes through
  `still:export`") dates from before STC-373 moved the preview into the editor
  window. `renderer.ts`'s own `declare const recorder` doesn't list it. The
  main window's bridge therefore carries a channel that writes to disk and
  calls the helper, and the main window never uses it.
- **`thumb.reveal`** (`thumbnail-preload.ts:19`, declared at
  `thumbnail-renderer.ts:84`) → `still:reveal` (`main.ts:2369-2374`), which
  exists only to read `lastStillFile` (`main.ts:162`, set at `:2057`). The
  panel's "Reveal in Finder" menu item uses `thumb.revealShot`
  (`thumbnail-renderer.ts:768`). The comment in `still:dragFile`
  (`main.ts:2135-2137`, `:2159`) is careful not to set `lastStillFile` for a
  drag, which protects a feature nothing can reach.

**Why this matters.** This corrects step 1 §5. That section says `preload.ts`
has "nothing unused … riding along" and that the thumbnail bridge has "no
exported channel [that] goes uncalled by its own window". Both are wrong on
these three members. A bridge wider than its window's code is the property
step 1 §5 was checking for.

**Owner.** Delete all three bridge members, their handlers, `lastStillFile`,
the `Take` interface and the stale comments.

**Class: CI-CHECKABLE.** The check behind this finding is about ten lines of
shell: for each `^  key:` in a preload, require `<namespace>.key` somewhere in
`app/src` outside the preloads. It could be a seam test.

### D5: `Settings` restated in four renderers; one copy has drifted. **Medium, DRIFTED**

**The owner and the copies.** `settings.ts:33-172` owns `Settings`. It imports
`node:fs`, so the browser pass cannot follow a type-only import into it. That
is the same reason `supervisor-state.ts` and `library-items.ts` were split.
Instead of a split, each renderer restates the parts it reads:
- `renderer.ts:11-45`: `AppSettings`, `StillSettingsView`,
  `ThumbnailSettingsView`. The `corner` union is restated rather than taken
  from `thumbnail.ts`'s `Corner`, which is pure and already importable.
- `editor.ts:11-24`: `AppSettings` / `StillSettingsView`.
- `thumbnail-renderer.ts:59` and `still-editor-renderer.ts:37`: inline
  `{ still: ExportOptions; saveFolder }`.

**Drift.** `editor.ts:13` declares `still.destination: string | null`. STC-412
removed that field (`settings.ts:155-157`: "Replaces
StillSettings.destination"). Nothing reads it, so it is a lie in the type
rather than a crash. Every other copy is currently a correct subset.

**Owner.** A pure `settings-types.ts` holding `Settings`, `StillSettings`,
`ThumbnailSettings` and `ShareSettings`. `settings.ts` re-exports it, and the
four renderers `import type` from it. `supervisor-state.ts` is the precedent.

**Class: CI-CHECKABLE.** Once the split exists, the typecheck is the test.

### D6: IPC message types are owned on the Electron side. **Medium, HAZARD**

**The pattern.** STC-343 fixed the preload side of this correctly: the
preloads take `unknown`, per `thumbnail-preload.ts:48-55` and
`countdown-preload.ts:12-15`. The renderer side was never fixed, because each
event or payload union lives in a module that imports `electron`, which the
browser pass cannot follow:

| message | receiver's type | sender |
|---|---|---|
| `thumbnail:event` | `ThumbEvent`, `thumbnail-window.ts:134-160` (not exported) | restated **identically** at `thumbnail-renderer.ts:85`, even though `thumbnail-preload.ts:54` calls `ThumbEvent` "the one place this shape is decided". This is exactly the copy that drifted before (the missing `"redact"`). |
| `overlay:event` | `OverlayEvent`, `overlay-session.ts:58-61` | `overlay.ts:82` sends `unknown`. The seven `send({ t: … })` calls (`:327-379`) are unchecked, so a typo'd `t` is silently ignored by `reduce`. |
| `overlay:state` | `OverlayPayload`, `overlay.ts:33-52` | `overlay-session.ts:466-481` sends an untyped object literal. Renaming a key there typechecks. |
| `countdown:state` | `StatePayload`, `countdown-renderer.ts:27-31` | `countdown-window.ts:230-233`, also untyped. |

**Why this matters.** None of these has drifted yet. Each one is the STC-343
defect with the second copy moved from the preload into the renderer (or
missing from the sender).

**Owner.** Put each union in the pure module that already owns the
interaction, and type both ends:
- `ThumbEvent` → `thumbnail.ts`.
- `OverlayEvent` → `selection.ts` or `record-options.ts`. `SelectionEvent` and
  `ControlId` are already there, and `overlay.ts` already imports both modules.
- `OverlayPayload` → the same place, with the sender annotated.
- `StatePayload` → `countdown.ts`, which the renderer already imports.

**Class: CI-CHECKABLE.** It becomes a typecheck once moved.

### D7: More restated wire shapes. **Low–Medium, HAZARD**

- **`StillResult`.** `main.ts:1166-1179` *exports* it. `renderer.ts:51-55`
  restates it under the same name, with the same fields, and with `source`
  widened to `string` and `shot` to `any`. It is `still:capture`'s reply and
  the `still:captured` push.
- **The helper's `devices` reply** has no TypeScript owner except
  `MicInfo` (`mic-devices.ts`). `renderer.ts:2-10` restates the display and
  camera entries. `main.ts:1027-1028` re-narrows `displays`/`mics` inline with
  `(known as any)`. `micsForBar` (`main.ts:1137-1145`) does it a third way.
  Separately, `renderer.ts:2`'s `DisplayInfo` (`pointW/pixelW/originX`, the
  helper's shape) shares its **name** with `selection.ts:125`'s `DisplayInfo`
  (`bounds/scaleFactor`, Electron's shape). CORRECTNESS-TRAPS calls this "the
  two-copies defect inverted": one name, two meanings.
- **The `still:export` request** is written out three times:
  `main.ts:1948-1956` (handler parameter), `main.ts:2139-2144`
  (`still:dragFile`, a subset), and `editor.ts:34-45`. The two main-side
  handlers also each build a `CompositedStill` from it (`:2016-2022` and
  `:2149-2152`). A field added to `CompositedStill`, such as a premultiplied
  flag, has two builders to miss.

**Owner.**
- `StillResult` → a pure module; `main.ts` already exports it, so the move is
  mechanical.
- Helper `devices` entries → next to `MicInfo` in `mic-devices.ts`, or a
  `helper-devices.ts`, with the display type renamed so it cannot be confused
  with `selection.ts`'s.
- `still:export` request → `transform/src/still-export.ts`, which is node-free,
  plus one `compositedFrom(req)` in `still-io.ts`.

**Class: CI-CHECKABLE.**

### D8: The anchors-version list exists twice, for a reason STC-318 disproved. **Low–Medium, HAZARD**

**The two copies.** `library-items.ts:250` has `SUPPORTED_ANCHORS_VERSIONS = [1..6]`.
`transform/src/session.ts:138-141` has an `if` chain plus an error message
("expected 1, 2, 3, 4, 5 or 6"), which is a third spelling.

**The reason given.** `library-items.ts:246-248`: "The two cannot share a
constant: this runs in the Electron main process and imports only node
builtins, while the transform is bundled for the renderer."

**Why the reason fails.** It is the same claim CORRECTNESS-TRAPS'
PROJECT-4 entry records as "simply untrue". `library.ts` imports
`@transform/shot.js`, `media-probe.js` and `media-tag.js`. `library-items.ts`
already imports from `@transform/shot.js` (`:110`). `project-version.ts`
exists precisely to be imported by both. Two tests hold the lists together
today (`take-list.test.ts:70-114`: a regex over both sources, and a check
against the schema files on disk), so nothing has drifted. But that is three
artefacts, one of them a source-regex, kept alive by a false premise.

**Owner.** `transform/src/anchors-version.ts`, on `project-version.ts`'s
pattern. Delete the source-regex test when it lands.

**Class: CI-CHECKABLE.**

### D9: Bundle filenames and the bundle-kind rule, respelled per call site. **Low, HAZARD**

- **Reading `shot.json`.** Read and `JSON.parse`d at `main.ts:432`, `:1528`,
  `:1554`, `:1575`, `:2352`, `:2432` and `library.ts:795`. Five of these run
  `parseShot`; two (`:432`, `:2352`) pass the raw object on to
  `presentThumbnail`. That is fine per `PresentOptions.shot`'s doc, but it is a
  second policy for the same read.
- **The kind rule.** "`shot.json` → still, else `anchors.json` → recording"
  appears at `library.ts:526` and `:700`, and again at
  `temp-takes.ts:382-383` (`listTempTakes`). `library.ts`'s header
  (`:44-49`) explains why a second pass that has to "agree with the first
  about what a still is" is the thing to avoid. `TempTakeInfo.kind` is that
  second agreement.
- **`take.json`.** Spelled at `takes.ts:125` (write), `library.ts:363` (read)
  and `main.ts:1888` (refusal).
- **By contrast:** `THUMBNAIL_FILE` and `CAPTURE_DOC_FILE` already have owners
  and are imported everywhere. That is the pattern to follow.

**Owner.** Filename constants beside `THUMBNAIL_FILE` in `library-items.ts`,
a `bundleKind(names)` exported there and used by `listTempTakes`, and one
`readShotAt(dir)` in main.

**Class: CI-CHECKABLE.** A grep test forbidding the bare literals in
`app/src`, on `library-seam.test.ts`'s model.

### D10: Confinement predicate copied. **Low, HAZARD**

`temp-takes.ts:93-98` (`insideTempTakesRoot`) is `takes.ts:22-27`'s body with
the root swapped. Its own doc says so ("`insideTakesRoot`'s traversal/sibling
closure, against the temp root instead"). It is identical today.

**Why this matters.** `takes.ts`'s header records the prefix-test bug being
found "in five places". A future fix to the closure, for example symlink
handling (step 1 notes `resolve()` doesn't follow symlinks), would reach one
root and not the other.

**Owner.** `insideRoot(root, dir)` in `takes.ts`, with both predicates
reduced to one line each.

**Class: CI-CHECKABLE.** The existing traversal tests, parameterised over both
roots.

### D11: Colour tokens copied outside `tokens.css`. **Low, HAZARD**

- **`editor.html`.** Lines 24-52 restate every value in `tokens.css:95-109`'s
  dark block (the only deliberate difference is `--bg`). The comment explains
  why: the video editor is dark regardless of OS setting, which is Patrick's
  decision and not reopened here. The mechanism, though, is exactly what
  `tokens.css:7-9` forbids ("must not redefine a token declared here"), and
  CLAUDE.md's editor row still says the window "keeps only its own
  `--clip`/`--zoom`". A future change to the shared dark `--accent` will not
  reach the editor.
- **`toast.html` and `countdown.html`.** `toast.html:109` and
  `countdown.html:39,57` hard-code `#7aa2ff` / `122,162,255`, which is
  `tokens.css`'s dark `--accent`. They don't link `tokens.css`.
- **`overlay.html`.** Lines 106 and 108 use macOS system blue/red
  (`10,132,255`, `#ff453a`), which differ from the app's `--accent` and `--rec`
  without a comment saying that's intended.
- **`editor.ts` fallbacks.** `:521-522` and `:615` repeat `editor.html:22`'s
  `--clip`/`--wave` values as `getPropertyValue` fallbacks.

**Owner.**
- `tokens.css` exposes its dark block under a selector a window can opt into
  (for example `:root[data-theme="dark"]`), so `editor.html` sets an attribute
  and overrides `--bg` only.
- The dark-always panels link `tokens.css` and use that selector.

**Class: CI-CHECKABLE.** A test that parses `tokens.css`'s custom properties
and refuses a redefinition in any `app/renderer/*.html`, with an explicit
per-token allowlist (`--bg` in the editor).

### D12: `PILL_THEME` is an owner nothing reads. **Low, dead code**

`pill.ts:157-163` declares the pill's fixed palette and nothing imports it:
the export scan finds only a mention in an `index.html` comment. The real
values live in CSS: `index.html:320`, `:327`, `:337` and `:348`. The comment
at `index.html:299-301` says they "match pill.ts's PILL_THEME", and nothing
checks that they do.

**Why this matters.** This is CORRECTNESS-TRAPS' "a funnel nothing goes
through is not a funnel", with the TS constant as the unused funnel.

**Owner.** Either delete `PILL_THEME`, making the CSS the owner (as
custom properties on `body.pill-collapsed`), or keep it and add a test that
reads it back out of `index.html`.

**Class: CI-CHECKABLE.**

### D13: The panel `BrowserWindow` recipe is written four times. **Low, HAZARD**

`overlay-session.ts:386-412`, `countdown-window.ts:153-182`,
`thumbnail-window.ts:516-535` and `toast-window.ts:86-103` each spell the same
options:
- `transparent`, `frame:false`, `hasShadow:false`, `resizable/movable/
  minimizable/maximizable/fullscreenable:false`, `skipTaskbar`, `show:false`.
- `webPreferences` `{contextIsolation, nodeIntegration:false,
  backgroundThrottling:false}`.
- Then `setAlwaysOnTop(true, "screen-saver")` and
  `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})`.

**Why this matters.** `panel-focus.ts` pulled out `PANEL_WINDOW_TYPE` "in ONE
place so `overlay-session.ts` and `countdown-window.ts` cannot drift"
(CLAUDE.md), and stopped there. A new hardening flag (step 1's navigation
guards, a `sandbox` change, content protection) is four edits plus three for
the ordinary windows. Nothing has drifted yet.

**Owner.** `panel-focus.ts`: `panelWindowOptions({ preload, bounds, extra })`
plus `raisePanel(win)`.

**Class: CI-CHECKABLE.**

### D14: `scrubber.ts` rule 9's threshold redeclared in `editor.ts`. **Low, HAZARD**

`editor.ts:188` `MIN_TICK_SPACING_PX = 6` ("scrubber.ts rule 9, applied to
the ruler") duplicates `scrubber.ts:114` `MIN_TICK_PX = 6`. It comes with a
second copy of the ladder search (`editor.ts:185`, `:227`, versus
`tickStrideFrames`, `scrubber.ts:389-401`).

**Why this matters.** `editor.ts`'s header says it "inherits `scrubber.ts`'s
vocabulary verbatim". This is the one place it copies instead of imports.

**Owner.** Import `MIN_TICK_PX`. `tickStrideFrames` could also take a ladder
argument.

**Class: CI-CHECKABLE.**

### D15: The corner margin is defined three times. **Low, HAZARD**

`thumbnail-window.ts:74` `CORNER_MARGIN = 20`, passed explicitly at `:281` and
`:515`. `thumbnail.ts:327` and `:508` default `margin = 20`.
`toast-window.ts:85` passes nothing and relies on the default. Changing
`CORNER_MARGIN` moves the panels and leaves the toast behind.

**Owner.** Export the constant from `thumbnail.ts` and use it as the default.

**Class: CI-CHECKABLE.**

### D16: Duration and size formatters. **Low, DRIFTED (dead copy)**

- **Duration.** `m:ss` from milliseconds is written at
  `library-items.ts:315-318` (live), `renderer.ts:879-882` (**dead**, never
  called), and `editor.ts:95-98` (`fmtClock`, from nanoseconds, same rounding).
  `pill.ts:118-125`'s `formatElapsedTimer` is a deliberately different rule
  (floor, `mm:ss`, then `h:mm:ss`) and is excluded.
- **Size.** `renderer.ts:883-884`'s dead `fmtSize` disagrees with the live
  `fmtBytes` (`library-items.ts:308-313`). It has no KB tier and rounds MB to
  whole numbers, so 1.5 MB reads "2 MB" and 400 KB reads "0 MB". Leftovers
  from before STC-294 moved the library to `library-items.ts`.

**Owner.** `library-items.ts`, exported. Delete both `renderer.ts` copies.

**Class: CI-CHECKABLE.**

### D17: The settings cleaning rules are written twice. **Low, HAZARD**

`readSettings` (`settings.ts:367-385`) and `writeSettings` (`:408-430`) each
restate every field's cleaning. They agree today: `=== true` versus
`typeof … boolean ? … : false` give the same result, and so do
`!== false` versus `typeof … boolean ? … : true`. The TypeScript type forces
every field to be *present* in both, but not the rule to be the same.

**Owner.** One `cleanSettings(raw: Record<string, unknown>): Settings`, called
by both.

**Class: CI-CHECKABLE.**

### D18: `PanelTake` validated and defaulted in two places, with different strictness. **Low, DRIFTED**

`thumbnail-renderer.ts:114-123` (`parseTake`) checks that `kind` and `origin`
are known literals, then defaults. `main.ts:2113` (`thumbnail:menu`) only does
`ctx?.take ?? default`, so `{ kind: "bogus" }` goes straight into
`buildThumbMenu`. The renderer's comment claims "the same defensive default
`main.ts`'s `thumbnail:menu` handler uses". The default is the same; the
validation is not. The literal checks also won't notice a new `TakeKind`.

**Owner.** `panel-actions.ts` `parsePanelTake(v)`.

**Class: CI-CHECKABLE.**

### D19: `CARD_CHROME` restates CSS and no longer matches it. **Low, DRIFTED**

`thumbnail-renderer.ts:143-159` derives the canvas box from `PANEL_SIZE`
minus `CARD_CHROME = { width: 40, height: 100 }`. The comment names what that
is made of: `#card { inset: 8px }` on both sides, `#thumbwrap`'s padding, and
"the style row, the actions row, the status line".

**How it has drifted.** There is no style row any more
(`thumbnail.html:130-138`). The horizontal parts it names add up to 36 px
(8+8 inset, plus 10+10 padding, at `thumbnail.html:21` and `:56`), not 40.
The comment claims this derivation stops the window and the box drifting
apart, and it has drifted. The visible effect is a few pixels of letterbox,
masked by `max-width: 100%`.

**Owner.** Measure `#thumbwrap`'s content box at runtime. Failing that, keep
the constant next to the CSS as a custom property and read it back.

**Class: CI-CHECKABLE.** In-page layout is measurable under Xvfb; only the
WM-dependent window geometry isn't.

### D20: `overlay.ts` hand-writes a conversion `spaces.ts` owns. **Low, HAZARD**

`overlay.ts:77-80` (`toGlobal`/`toLocal`) is `transform/src/spaces.ts:295-303`'s
`toDisplayLocal`/`rectToDisplayLocal` (and its inverse) written by hand.
`spaces.ts`'s header (`:127-130`) names exactly one app-side exception
(`selection.ts`, for the choice of display) and says "the conversion itself
is `rectToDisplayLocal`". `spaces-seam.test.ts` greps `transform/src/` only,
so this can't be caught.

**Owner.** `spaces.ts`. `overlay.ts` already imports `selection.js`, which
re-exports a display-local helper.

**Class: CI-CHECKABLE.** Extend the seam grep to `app/src/overlay.ts`.

### D21: Dead exports and parameters. **Low, dead code**

**Exports labelled "for tests" that no test imports.** Since STC-416, window
counts in tests go through `app/test/_windows.ts`, and nothing imports these:
- `editor-window.ts:76` `editorIsOpen` ("For tests and for main's own
  bookkeeping": main doesn't import it, and `library-folder.e2e.test.ts:154`
  defines its *own* function of that name).
- `editor-window.ts:80` `closeEditor`.
- `still-editor-window.ts:63` `stillEditorIsOpen` and `:67` `closeStillEditor`.
- `thumbnail-window.ts:429` `thumbnailIsOpen` and `:432` `thumbnailCount`.

**Other exports nothing imports:**
- `selection.ts:395` `displayContaining`: no caller anywhere, tests included.
- `quit-guard.ts:40` `QuitChoice`. Its doc says `main.ts` is "the only
  reader". `main.ts:751-763` doesn't import it and encodes the choice as
  button **indices** (`response === 0/2`) against a `buttons` array.
  Reordering the labels would silently swap Save All and Quit Anyway.

**Parameters no caller sends:**
- `still:writeShot`'s `mode` (`main.ts:2427`, `:2439`). No preload sends it:
  `still-editor-preload.ts:22` sends redactions only, and the thumbnail bridge
  has no `writeShot`.
- `export:write`'s `png` extension (`main.ts:1882`). Nothing writes a PNG
  through it, because the frame grab moved to `still:export`.

**Class: CI-CHECKABLE.** An unused-export check over `app/src`. The scanner
used for this pass could become a test with an allowlist.

### D22: Label and title literals kept in two places. **Low, HAZARD**

- The panel actions' names appear in `thumbnail-menu.ts:68-73` (`ACTION_LABEL`)
  and as button text in `thumbnail.html:132-135`.
- `index.html:6` and `editor.html:6` carry `<title>Capture</title>`, a second
  copy of `PRODUCT_NAME` (`product.ts:30`). `product.test.ts` pins
  `PRODUCT_NAME` to `package.json`, not to the HTML. Electron takes the
  window title from `document.title` on load, so the HTML copy is the one
  users see.

**Class: CI-CHECKABLE.**

---

## 4. Dead code

Collected above: D4 (bridge members and their handlers), D12 (`PILL_THEME`),
D16 (`renderer.ts` formatters) and D21 (exports and parameters). D2 is the
one `Settings` key that nothing reads. Every other key, including
`share.embedTemplate`, `showDiagnostics`, `libraryView`, `thumbnail.skip`,
`countdownMs`, `previewMuted`, `cameraDeviceUid` and `systemAudio`, has a
reader. No `ipcMain` handler lacks a preload entry, which matches step 0.

## 5. The docs as a copy

**CLAUDE.md rows.** All of these are **DRIFTED**, and CI-CHECKABLE only in the
narrow sense that a grep could pin a phrase; realistically they are reading
fixes.

| row | what it says | what is true |
|---|---|---|
| `app/renderer/editor.html`, `app/src/editor.ts` | Zoom lane is "the auto-zoom automation curve, read-only" | Editable since STC-330/331, as the `zoom-override.ts` row and `editor.ts:1-6` both say. |
| same row | "Geist + Geist Mono land here … Silkscreen does not move" | No Geist Mono exists in the repo. `tokens.css:11-45` loads JetBrains Mono and Silkscreen for every window that links it. |
| same row | "this window keeps only its own `--clip`/`--zoom`" | `editor.html:35-52` redefines the whole dark palette (D11). |
| `app/renderer/still-editor.html` … | "follows the OS preference like the other two windows" | The video editor is dark regardless of OS setting (`editor.html:24-34`). |
| `app/src/thumbnail.ts` (STC-343) | rule 6 "stop the panel's own timer"; "the timeout floor"; "the stack's offsets" | The module header itself says timers were removed by STC-392 (`thumbnail.ts:24-31`). Offsets are `stackLayout` (STC-426). |
| `app/src/thumbnail-window.ts` | "each keeps its OWN timer … drains oldest-first … settle-then-destroy … clears a panel's timer" | No timers. `discarding` is a no-op (`thumbnail-window.ts:141-151`). Overflow is hidden, not drained. |
| `app/renderer/thumbnail.html`, … | "expanded mode picker, redact" | Both moved to the still editor (STC-300). The panel is Copy/Save/Edit/Trash. |
| `docs/STC-343-RUNBOOK.md` | "the 26 px stack step" | `STACK_GAP_PX = 12` (`thumbnail.ts:244`), with a layout that gives each panel a full-height slot. |
| `app/src/pill.ts` | "no audio capture exists anywhere in the helper" (also `pill.ts:128`) | Mic (STC-233) and system audio (STC-418) are captured. |
| `app/src/countdown.ts` | "deliberately NO control" (also `countdown.ts:60`, `settings.ts:118`) | `#countdownms` exists, built from `COUNTDOWN_OPTIONS` (`renderer.ts:936-995`). |
| `app/src/countdown-window.ts` | opens with "at the bottom centre of the target display's WORK area" | The same row later says "CENTRED as of the first hardware pass". The first sentence is stale. |
| `app/src/still-io.ts` | "the only thing in main that writes an image" (also its header, `still-io.ts:20-23`) | `library:writeThumbnail` (`main.ts:1509-1520`) writes a renderer-`toBlob`'d PNG. That's fine for a cache; the claim is still false. |
| `app/renderer/index.html`, `app/src/renderer.ts` (STC-374) | "the way a chosen display already was" sticky | `displayId` is dead (D2). |
| `app/src/selection.ts` | appears in **two** rows (STC-290, then STC-342) | One file, two descriptions: the doc's own two-copies case. |

**Code comments with the same kind of drift** (not CLAUDE.md, same class):
- `main.ts:1954`: "for the 'beside the shot' default destination". That
  destination was removed by STC-412.
- `settings.ts:399`: `still` is deep-merged so as "not [to] drop the
  destination folder". `still` has had no destination since STC-412.
- `still-editor-preload.ts:10`: "`still:writeShot` [is] the thumbnail panel's
  own channel". The thumbnail bridge has no `writeShot`.
- `still-editor-renderer.ts:60`: "see `thumbnail-renderer.ts`'s identical
  constant and reasoning". That constant no longer exists there.
- `still-editor-renderer.ts:8`: "v1's whole job is Redact". STC-446 added
  Save.
- `main.ts:931`: "the countdown set to Off (a shipped option)". This
  contradicts `countdown.ts:74-77` ("'Off' is deliberately not offered").
- `preload.ts:38-42`: see D4.
- `settings.ts:62-63`: a doubled `/**`. Trivial.

---

## Considered and excluded

Checked against the code and headers, and deliberately **not** reported:

- **`library.ts:415-420` `findBuriedExport`** spells `export-${name}.mp4`
  outside `share.ts`. This is the *legacy* rule, which `exportMediaName`
  deliberately no longer produces (`share.ts:80-95`, `library.ts:395-414`). A
  split with its reasons written down.
- **`sweepOrphanedBundles`** walks `raw/` a second time. It reuses
  `scanFinishedFilesAt` and `readBundleId` instead of matching ids again, and
  its header (`temp-takes.ts:262-275`) says why.
- **Preload `unknown` payloads.** Correct and deliberate (STC-343). D6 is
  about the renderer and sender sides.
- **The `on` allowlist in `preload.ts:81-107`** matches main's `send()` sites
  one for one (11 channels).
- **The start-param builder** is single (`main.ts:986-1014`). No second
  builder found.
- **`share.ts` export filenames** are imported by `editor.ts` and `main.ts`.
  No inline copy remains, and `share.test.ts` greps for one.
- **The still funnel.** Every still export reaches `still-io.ts`'s
  `exportStill` (main's only two callers are `still:export` and
  `still:dragFile`). D1 is about what renderers do *before* the funnel. D7
  covers the request type.
- **`TAKE_FILES`** matches what the Swift helper writes into a recording
  bundle.
- **Single owners confirmed:** `MicInfo`, `UNDO_WINDOW_MS` (toast-window and
  pending-trash both import it), `HIDE_SETTLE_MS`, `THUMBNAIL_FILE`,
  `CAPTURE_DOC_FILE`, and `PRODUCT_NAME` (pinned to `package.json`).
- **`editor-window.ts` and `still-editor-window.ts`** share a
  single-instance shape. That is two small call sites, the header says it's
  the same shape on purpose, and it is excluded as one-callsite territory.

## Corrections to earlier steps

- **Step 1 §5** says `preload.ts` has "nothing unused … riding along" and that
  no thumbnail-bridge channel "goes uncalled by its own window". D4 finds
  three members uncalled, one of them a disk-writing, helper-calling channel
  on the main window.
- **Step 0 §2** lists `still:writeShot`'s arguments as `dir, redactions, mode`.
  No caller sends `mode` (D21).
- **Step 0 §4** says `lastStillFile` is "read by `still:reveal`". True, but
  nothing can call `still:reveal`, so that state is dead (D4).

## Disagreements with settled decisions

- `pill.ts:127-137`'s hatched-only meter was settled on the premise that "no
  audio capture exists anywhere in the helper". Mic (STC-233) and system audio
  (STC-418) now exist, so the reason behind the decision no longer holds. It
  may be worth asking again; it is not a finding here.
