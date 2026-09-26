# STC-465 review — Step 4: Quick wins

Worktree `stc-465-review-run`, commit `a998725`. Builds on step-1/2/3; no code
changed by this pass. Every candidate below was re-read against the current
file (not just quoted from the earlier step) to confirm the line numbers and
that nothing has since made it stale.

**Linear access.** This session has no authenticated Linear MCP tool
(`plugin:productivity:linear` is in this session's unauthenticated-connector
list) — searches below are `npm run ticket -- STC-NNN` against GitHub only
(open PRs, merged commits, branches), not a Linear title/keyword search. Per
the task brief, STC-466/467/468 are the three known-filed calibration
tickets; each was checked:

```
STC-466  Nothing on GitHub names STC-466.
STC-467  Nothing on GitHub names STC-467.
STC-468  Nothing on GitHub names STC-468.
```

So all three are filed in Linear (per `docs/ELECTRON-REVIEW-KIT.md`'s
calibration paragraph) but nothing has started against them in code yet —
they are still open to pick up. Two of the five items below match one of
these and are cited rather than proposed as new. For the other three, no
Linear search was possible; they are offered as new and should be checked in
Linear before filing, not assumed unfiled.

---

## Ranked list

| # | item | ticket | impact/effort |
|---|---|---|---|
| 1 | Process-level crash backstop in main | **STC-468** (matches) | High / 30 min |
| 2 | `export:write` refusal list misses `capture.json`/`thumb.png` | none found | High / 20 min |
| 3 | `overlay.html` has no CSP | **STC-467** (matches) | Med / 15 min |
| 4 | Dead `recorder.takes`/`recorder.exportStill` bridge members | none found | Med / 30 min |
| 5 | `insideTempTakesRoot` is a byte-for-byte copy of `insideTakesRoot` | none found | Low-Med / 40 min |

---

## 1. Process-level crash backstop in main — matches STC-468

**What and where.** `app/src/main.ts` registers no
`process.on("unhandledRejection", …)` and no `process.on("uncaughtException",
…)` anywhere (confirmed by grep across `app/`, `transform/`, `scripts/` —
zero matches). Node's default action for an unhandled rejection is to crash
the process; Electron's main process is a Node process. Step-3 §1 traces four
fire-and-forget call sites with no `.catch` between them and the process
(`main.ts:591-592` tray callback, `:1409` global shortcut callback,
`onRecordHotkey` at `:1430-1443`, `recoverUnsavedTakes`'s `dialog.showMessageBox`
at `:408-415`) — but the two process-level handlers are the cheap, general
backstop that makes *every* such site (present or future) fail loud instead of
killing the whole app silently. `captureStill` (`main.ts:1183-1186`) already
states the reasoning this generalizes: "a hotkey has no caller to reject to."

**Why it matters.** Without this, any unanticipated rejection anywhere in
main — not just the four traced sites — takes down the entire app with no
dialog, no crash report, and (per step-3 §5) nothing in a place a user would
find it. A user mid-recording who hits this loses the app outright, with a
worse failure mode than any single traced site: total silence.

**Effort: 30 min.** One file. Scoped narrowly to the two handlers themselves
(the broader "wrap every fire-and-forget call site" work step-3 recommends is
real but larger — leave it as a follow-up on the same ticket, not part of this
quick win).

**The change** — `app/src/main.ts`, immediately before `app.whenReady()`
(`:517`), using the file's existing `[tag] message` console convention (e.g.
`:504-506`):

```ts
// A rejection or throw with nothing downstream to catch it would otherwise
// kill the whole Electron main process silently (Node's default action) —
// no dialog, no crash report, nothing in a place a user could find (see
// docs/review/2026-09-26/step-3.md §1/§5). This is the general backstop;
// captureStill's own "never throws" catch-all is the same reasoning at one
// call site.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection in main:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception in main:", err);
});
```

**The test that would pin it.** An e2e test can stub a promise-returning
Electron API to reject once (e.g. `dialog.showMessageBox`, matching
`recoverUnsavedTakes`'s own unwrapped call at `main.ts:408-415`), trigger the
path that calls it, and assert the Electron process is still alive and
answering an unrelated IPC call (`recorder:status`) afterward, rather than
having exited. **Class: CI-CHECKABLE.**

---

## 2. `export:write`'s refusal list misses `capture.json` and `thumb.png`

**What and where.** `app/src/main.ts:1877-1916` (`export:write`) refuses to
overwrite a name in `TAKE_FILES` (`:199`) or literally `"take.json"` before
writing an export to the bundle root (`:1888-1890`). `TAKE_FILES` is the
Swift helper's own recording outputs and was confirmed current against
`helper/src/*.swift` in step-2. It was never updated for STC-413's
`capture.json` (`transform/src/capture-doc.ts:18`,
`CAPTURE_DOC_FILE = "capture.json"`, read via `capture-identity.ts` — already
imported in `main.ts:58`) or STC-294's `thumb.png`
(`THUMBNAIL_FILE = "thumb.png"`, `library-items.ts:253` — **already imported**
in `main.ts:38`). A `.json`-named export is written straight into the bundle
unchecked (`:1892-1895`), so `editor.writeExport("capture.json", …)` silently
replaces the id that links a finished export back to its bundle, breaking
`export:write`'s own identity lookup two lines later, `share:publish`, and the
orphan sweep.

**Why it matters.** This is a live gap in a document that three other systems
(`export:write` itself, `share:publish`, `sweepOrphanedBundles`) depend on for
correctness, not merely a hardening nice-to-have — and the reason it exists is
exactly the "hand-kept copy of which files belong to a bundle, never updated
when the set grew" failure mode CLAUDE.md's `capture.json`/`THUMBNAIL_FILE`
rows already name as the fix for this class of bug elsewhere in the codebase.
Only a buggy or compromised editor renderer can reach it today (step-1
treated the path-confinement half of this as sound), which is why it reads as
a drift finding rather than a path-traversal one — but the consequence if it
fires is real data corruption of the bundle's identity, not a crash.

**Effort: 20 min.** One file (`main.ts`): one new import line, one changed
condition.

**The change** — `app/src/main.ts`:

```ts
// add to the existing import block, e.g. beside the capture-identity import at :58
import { CAPTURE_DOC_FILE } from "@transform/capture-doc.js";
```

```ts
// :1888, was:
//   if (TAKE_FILES.has(name) || name === "take.json") {
  if (TAKE_FILES.has(name) || name === "take.json"
      || name === CAPTURE_DOC_FILE || name === THUMBNAIL_FILE) {
    throw new Error(`refusing to overwrite the take's own "${name}"`);
  }
```

(`THUMBNAIL_FILE` is already imported at `main.ts:38` for `library.js`; no new
import needed for it.) This deliberately does **not** widen `TAKE_FILES`
itself, which also gates `preview:read`/`:size`/`:chunk` (`:2459`, `:2467`,
`:2482`) — a separate concern (what the editor may *read*) that this fix
leaves untouched.

**The test that would pin it.** Extend the existing export-write test
coverage (or add one) that drives `editor:writeExport` /
`ipcMain.handle("export:write", …)` with `name: "capture.json"` against a
fixture take that has one, and asserts the call throws/rejects rather than
succeeding. **Class: CI-CHECKABLE.**

---

## 3. `overlay.html` has no Content-Security-Policy — matches STC-467

**What and where.** Every other renderer HTML file in `app/renderer/` carries
a `<meta http-equiv="Content-Security-Policy" …>` tag; `overlay.html` is the
only one of the seven that has none at all (confirmed by grep — see the table
in step-1 §4). It does load a script
(`overlay.html:131` in the step-1 excerpt, actually the file's closing
`<script src="../dist/overlay.js">`), so with no policy, `script-src`/
`default-src` restrictions the other six windows all get do not apply here.

**Why it matters.** `overlay-preload.ts`'s bridge is already the narrowest in
the app (`send`/`onState` only — confirmed in step-1 §5), so the blast radius
of a compromised overlay page is small on its own, and no `will-navigate`
guard exists anywhere in the app to get untrusted content into it in the
first place (step-1 §3, a separate and larger finding, STC-466, not scoped
here). But this is a real, zero-cost gap: every sibling window gets this
protection, and this one silently doesn't.

**Effort: 15 min.** One file. Confirmed by reading `overlay.html` in full:
no `<img>`, no `data:` URI, no `@font-face` — its inline `<style>` block is
its only content-security-relevant feature beyond the one external script, so
the same minimal shape `countdown.html`/`toast.html` already use is the right
fit, not `index.html`'s wider one.

**The change** — `app/renderer/overlay.html`, add as line 5 (after
`<meta charset="utf-8">`, matching every sibling file's position):

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'">
```

**The test that would pin it.** No such test exists today (grepped
`app/test/`, `transform/test/` for `Content-Security-Policy`: zero hits) —
this is itself part of the gap. Add a small test that reads all seven
`app/renderer/*.html` files and asserts each contains a
`<meta http-equiv="Content-Security-Policy"` tag; it fails today on
`overlay.html` alone and guards all seven against a future regression, not
just this one file. **Class: CI-CHECKABLE.**

---

## 4. Dead `recorder.takes` / `recorder.exportStill` bridge members on the main window

**What and where.** Two members of the main window's bridge
(`app/src/preload.ts`) are exposed but never called from that window's own
renderer script:
- `takes: () => ipcRenderer.invoke("recorder:takes")` (`preload.ts:13`) →
  `ipcMain.handle("recorder:takes", …)` (`main.ts:1580-1581`, calling
  `listTakes`). `renderer.ts` still declares `takes()` in its `declare const
  recorder` block (around the `Take` interface, `renderer.ts:46-50`) and the
  `Take` interface itself, but grepping `app/src` and `app/test` for a call
  site finds none — confirmed directly, not assumed from step-2.
- `exportStill: (req) => ipcRenderer.invoke("still:export", req)`
  (`preload.ts:43`) — its own comment (`:38-42`) says the justification
  predates STC-373 moving the preview into the editor window.
  `renderer.ts`'s `declare const recorder` block does not list it at all.

**Why it matters.** `recorder.exportStill` is a channel that writes a file to
disk and calls the helper's encoder, sitting on the widest bridge in the app
(the main window's), reachable by any code running in that window, for a
feature the main window doesn't use — exactly the "a bridge wider than its
window's code" property step-1 §5 was checking for and, on these two members,
missed. Removing them shrinks that bridge to what the main window actually
needs, with no behavior change (nothing calls them today) and no user-visible
risk. `recorder:takes`'s handler becomes fully unreachable once its only
caller is gone, so it comes out too, along with `renderer.ts`'s dead
`takes()` declaration and `Take` interface.

**Effort: 30 min.** Three files, each a deletion: `preload.ts` (two members),
`main.ts` (one handler, `:1580-1581`), `renderer.ts` (the `takes()` decl and
the now-unused `Take` interface). No other file references any of these four
names (confirmed by grep). Low regression risk — the whole point of the
finding is that nothing calls them.

**The change:**
- `app/src/preload.ts:13` — delete the `takes:` line.
- `app/src/preload.ts:38-43` — delete `exportStill` and its stale comment.
- `app/src/main.ts:1580-1581` — delete the `recorder:takes` handler.
- `app/src/renderer.ts` — delete the `Take` interface and the `takes()` line
  from `declare const recorder`.

**The test that would pin it.** A seam test on `library-seam.test.ts`'s
model: for every `^  <key>:` line in each `*-preload.ts`, require
`<namespace>.<key>` to appear somewhere in `app/src` outside the preloads
themselves. It fails today on both of these (and would have caught `thumb.reveal`,
step-2 D4's third dead member, if that were included — deliberately left out
of this item's scope to keep it to three files; worth a follow-up once this
lands). **Class: CI-CHECKABLE.**

---

## 5. `insideTempTakesRoot` is `insideTakesRoot`'s body with the root swapped

**What and where.** `app/src/takes.ts:22-27` (`insideTakesRoot`) and
`app/src/temp-takes.ts:93-98` (`insideTempTakesRoot`) are line-for-line
identical except for which root they resolve against — confirmed by reading
both in full. `temp-takes.ts:92`'s own comment says as much: "`insideTakesRoot`'s
traversal/sibling closure, against the temp root instead." `takes.ts`'s header
(`:6-21`) explains in detail why this exact prefix-test logic already had two
security-relevant holes (`../../tmp/evil` traversal, `<root>-other` sibling)
found "in five places" before being consolidated once. This is a sixth place,
just not yet a sixth divergence.

**Why it matters.** Nothing has drifted yet, which is exactly the HAZARD
class this is filed as. But a future fix to the shared closure — step-1 §1
already names one candidate (symlink handling: `resolve()` does not follow
symlinks, and `sweepOrphanedBundles` had to reach for `lstat` instead of
`stat` for exactly that reason) — would reach one root and not the other if
applied by hand to two copies, silently reopening the hole in whichever file
gets missed. `temp-takes.ts` already imports three other names from
`takes.js` (`rawRoot`, `stamp`, `uniqueTakeName`), so there is no new
dependency direction to introduce.

**Effort: 40 min.** Two files. Mechanical: extract the shared body into one
function, have both existing exports call it with their own root, keep both
exported names (nothing that imports `insideTakesRoot`/`insideTempTakesRoot`
needs to change).

**The change** — `app/src/takes.ts`, replacing the body of
`insideTakesRoot` and adding a small shared helper:

```ts
/**
 * Is `dir` a real directory INSIDE `root`? ... (keep the existing header)
 */
function insideRoot(root: string, dir: string): boolean {
  if (typeof dir !== "string" || dir.length === 0) return false;
  const resolvedRoot = resolve(root);
  const target = resolve(dir);
  return target !== resolvedRoot && (target + sep).startsWith(resolvedRoot + sep);
}

export function insideTakesRoot(env: NodeJS.ProcessEnv, saveFolder: string | null, dir: string): boolean {
  return insideRoot(takesRoot(env, saveFolder), dir);
}
```

`app/src/temp-takes.ts:93-98`:

```ts
import { insideRoot } from "./takes.js"; // exported alongside insideTakesRoot, or export insideRoot itself

export function insideTempTakesRoot(env: NodeJS.ProcessEnv, dir: string): boolean {
  return insideRoot(tempTakesRoot(env), dir);
}
```

(`insideRoot` needs an `export` in `takes.ts` for `temp-takes.ts` to import
it — a one-line addition, not a new module.)

**The test that would pin it.** The existing traversal/sibling tests already
in `app/test/takes.test.ts` and `app/test/temp-takes.test.ts` continue to
pass unchanged (same behavior, same exported names) and now exercise the
shared function from both call sites — no new test is strictly required, but
a parameterized test running the traversal/sibling cases against both
`insideTakesRoot` and `insideTempTakesRoot` in one `it.each` makes the "one
fix reaches both" property explicit rather than incidental. **Class:
CI-CHECKABLE.**

---

## Considered and not selected

For completeness, these were the next-best candidates and why they were left
out of the top 5 (effort or file-count, not value):

- **Step-2 D1** (still-editor's composited-export sequence has drifted from
  the panel's: wrong scale, wrong colour space) is the single highest-value
  finding in the whole review, but its fix is a new shared pure module used
  by three call sites (`thumbnail-renderer.ts`, `still-editor-renderer.ts`,
  `renderer.ts`) plus rewiring each — real refactor work, not a quick win.
- **Step-1 §3 / STC-466** (no `will-navigate`/`setWindowOpenHandler` on any of
  seven windows) matches a filed ticket, but doing it properly touches all
  seven window-creation sites plus the shared `panel-focus.ts` recipe
  (step-2 D13) — worth bundling as one ticket's work, not a 3-file slice.
- **Step-3 §2** (quitting mid-export in the editor is invisible to
  `before-quit`) is real and Medium-High value, but the fix needs a new piece
  of cross-window state (an "export in progress" flag reaching `main.ts`'s
  `unsavedTakeDirs()`), which is more than a mechanical edit.
- **Step-3 §5** (no persistent log file) is high value for support but is new
  infrastructure (a log writer, rotation, a menu item), not a 1-3 file fix.
- **Step-2 D14/D15/D16/D12** (scrubber tick-threshold duplicate, corner-margin
  duplicate, dead formatters, unused `PILL_THEME`) are all legitimate,
  similarly-sized quick wins that didn't make the top 5 only because items
  1-5 above rank higher on impact for comparable effort — any of them is a
  reasonable next pick from the same list.
