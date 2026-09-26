# Electron review kit (STC-465)

A prompt sequence for reviewing the Electron app in this repo — written for
THIS codebase, not for Electron apps in general. A generic kit was tried first
and reviewed against the code: most of its passes asked about things that do
not exist here (Windows, an auto-updater, electron-builder config, the `remote`
module, Redux), and its "over-engineering" pass would have flagged the repo's
deliberate architecture as defects. What follows is what was kept, what was
replaced, and why.

**Scope.** The Electron app (`app/src/`, `app/renderer/`) and the app's side of
the helper protocol — how `supervisor.ts`/`helper-client.ts` spawn the helper,
what they write to its stdin, how they read fd3 and stdout. The Swift helper's
internals are OUT; they have their own traps (`docs/CORRECTNESS-TRAPS.md`) and
their own grant-gated tests, and a prompt tuned for TypeScript IPC reviews
Swift capture threading badly. `transform/` is out except where main imports
it.

## How to run it

- **Worktree first** (`CLAUDE.md` → Concurrent sessions). The review writes
  files.
- **Each step writes its own file** to `docs/review/<YYYY-MM-DD>/step-N.md`
  and later steps READ those files. That is what makes "one step per session"
  and "Step 6 synthesises everything" both true — the generic kit asked for
  both and could deliver neither.
- **Steps 0–5 change no code.** Findings become Linear tickets after Step 6,
  one at a time, each checked for an existing ticket first
  (`npm run ticket -- STC-NNN` for the numbered ones, and a Linear search for
  the rest — `ticket-check` only greps one key, which is how STC-417/STC-403
  collided).
- The review output under `docs/review/` is a dated snapshot. Commit it with
  the tickets it produced, or not at all; do not keep it current.

### Model routing

| step | model | why |
|---|---|---|
| 0 Orient, 1 Security, 3 Gaps, 4 Quick wins | Sonnet 5 | mechanical sweeps over many files against a fixed checklist |
| 2 Drift, 5 Support triggers, 6 Risk register | Opus 5.5 | each one is judgement against DESIGN INTENT — telling a deliberate split from a dead copy, or a settled decision from a gap |
| Council (optional, after 6) | `/council` | multi-model second opinion on the few genuinely open questions |

### Calibration

Three findings were filed BEFORE this kit was first run, from spot checks
while writing it: **STC-466** (no navigation/window-open/permission guards on
any window), **STC-467** (`overlay.html` is the only page without a CSP) and
**STC-468** (no `unhandledRejection`/`uncaughtException` handler in main).
Steps 1 and 3 should re-find all three on their own. If they don't, the
prompts are too loose — fix the prompt before trusting anything else the run
produced. Once those tickets are closed, delete this paragraph rather than
leaving the kit pointed at fixed code.

---

## Preamble — paste at the top of EVERY step

```
You are reviewing the Electron app in this repo. Before anything else:

1. Read CLAUDE.md in full, and docs/CORRECTNESS-TRAPS.md.
2. Everything under CLAUDE.md "Settled decisions" and every decision a module
   header records as settled is OUT OF SCOPE. Do not re-propose it. If you
   think one is wrong, say so in one line under a heading "Disagreements with
   settled decisions" at the end — never as a finding.
3. Read the header comment of every module you cite. This repo writes its
   reasoning there; a finding that contradicts a header without addressing it
   is not a finding.
4. Do not change any code. Your only output is the file named below.
5. Every finding carries: file:line, what, why it matters, and one of
   CI-CHECKABLE (a test in this repo could pin it) or NEEDS-A-MAC (only real
   hardware, a real TCC grant, or an eye can settle it). This repo runs CI on
   Linux under Xvfb with no window manager — see app/test/pill.e2e.test.ts's
   header for what that cannot observe.
6. If an earlier step's file exists in docs/review/<date>/, read it first and
   do not repeat its findings.
```

---

## Step 0 — Orient → `step-0.md`

```
[preamble]

Map the territory. No findings, no fixes.

1. The windows. For each BrowserWindow (main.ts, editor-window.ts,
   still-editor-window.ts, overlay-session.ts, countdown-window.ts,
   thumbnail-window.ts, toast-window.ts): the html it loads, its preload, its
   webPreferences, and its lifetime (one instance / one per display / a stack).

2. The IPC surface, FROM THE PRELOAD SIDE. For each of the seven *-preload.ts
   files: every channel it exposes on contextBridge, and the argument shape it
   passes. Then for each channel, the handler that answers it (most are in
   main.ts; overlay-session.ts, countdown-window.ts, thumbnail-window.ts and
   still-io.ts register their own). Output one table:
   channel | exposed by (preloads) | handler file:line | args | touches disk? | touches the helper?
   Flag any channel a preload exposes that no handler answers, and any handler
   no preload can reach.

3. The helper boundary. How supervisor.ts starts the helper (binary path,
   argv, env, stdio), what goes to its stdin, which channel is reliable (fd3)
   and which is lossy (stdout). Which IPC handlers end in a helper command.

4. Main-process state that outlives a single request: module-level `let`s in
   main.ts and the window modules, and what resets each one.

5. Electron version (package.json) and whether it is current.
```

---

## Step 1 — Security & trust boundaries → `step-1.md`

The generic kit's headline checks (`contextIsolation`, `nodeIntegration`,
`webSecurity`, `remote`) are already settled here — every window is
context-isolated, sandboxed, `nodeIntegration: false`. They get one line of
confirmation, not a section. The real surface is what main does with what a
renderer hands it.

```
[preamble]

Using step-0.md's IPC table:

1. Paths from the renderer. For every handler whose arguments include a path,
   a directory, a take id or a filename (still:reopen, export, duplicate,
   delete-to-Trash, share, frame grab, save-as, library reads): trace the
   argument to the fs call. Is it confined to the storage root / the temp
   root? Is `..`, an absolute path, a symlink, or another take's id refused?
   main.ts's own comments (search "sandboxed") state the intent — check the
   code keeps it, handler by handler.

2. Documents from the renderer. Any handler that writes a project/shot
   document the renderer supplied: is it parsed and version-checked
   (projectForWrite / shotForWrite / parseShot) before it hits disk, or
   written verbatim?

3. Navigation and new windows. will-navigate, setWindowOpenHandler,
   web-contents-created, setPermissionRequestHandler — present or not, per
   window. What happens if a file is dragged onto each window.

4. CSP. The Content-Security-Policy on every app/renderer/*.html, and which
   page lacks one.

5. Preload breadth. For each preload: is anything exposed that its own window
   never calls? (A bridge wider than its window is a bridge another window's
   compromise could use.)

6. shell.* and dialogs. Every shell.openExternal / openPath /
   showItemInFolder: where does its argument come from?

7. The helper spawn. Is any renderer-supplied value placed into the helper's
   argv, env, or a stdin command without validation? (JSON-line IPC: can a
   string break out of its line?)

8. One line confirming contextIsolation / sandbox / nodeIntegration per
   window, from step-0.md. No more.

Severity: High = a renderer can make main read/write/delete outside its
confinement, or run something. Medium = a guard missing where exploitation
needs another bug first. Low = hardening.
```

---

## Step 2 — Duplication & drift → `step-2.md`

Replaces the generic "over-engineering" pass. That pass looks for
abstractions with one callsite — and this repo splits a pure DECISIONS module
out of nearly every surface on purpose (`selection.ts`, `pill.ts`,
`countdown.ts`, `thumbnail.ts`, `scrubber.ts`, `hotkeys.ts`, `device-picker.ts`,
`library-items.ts`…) so it can be tested without a DOM or Electron, and splits
some files only so a tsconfig pass accepts them (`supervisor-state.ts`,
`project-version.ts`). Those are the architecture, not the defect.

The defect this repo actually keeps finding is **one value, two copies**: a
preload restating an event union that had silently drifted (STC-343), a
byte-for-byte dead copy of `cameraSummary` (STC-345), a second start-param
builder (STC-388), per-window token blocks (STC-443). That is what this pass
hunts.

```
[preamble]

EXCLUDED, with reasons, and do not report them: pure decision modules split
from their window/view for testability (their header says so), and files
split only to satisfy a tsconfig pass (supervisor-state.ts,
project-version.ts, library-items.ts). One callsite is not a finding here.

Find:

1. Types restated instead of imported — especially in *-preload.ts and
   renderer files, where a type-only import is sometimes avoided for the
   browser typecheck pass. For each: is the copy still identical to the
   original? Show the diff if not.

2. Constants and literals with more than one definition — channel names,
   timeouts, sizes, filenames, setting keys, color values outside
   app/renderer/tokens.css.

3. Logic implemented twice — a second scanner, parser, builder, or path
   computation where CLAUDE.md names ONE owner (library.ts's scan,
   recordFlowBody's start params, share.ts's export filenames, still-io.ts's
   funnel, spaces.ts's conversions, output-size.ts's dimensions). Grep for the
   operation, not the function name.

4. Dead code — exported and never imported, handlers no preload reaches (from
   step-0.md), settings keys nothing reads.

5. The docs as a copy: CLAUDE.md table rows describing files that no longer
   exist or no longer do what the row says. (AGENTS.md is regenerated from
   CLAUDE.md — review CLAUDE.md only.)

For each: both locations, whether they have ALREADY drifted (a live bug) or
merely could (a hazard), and which one should be the owner.
```

---

## Step 3 — Gaps → `step-3.md`

```
[preamble]

What is absent. supervisor.ts already makes HELPER crashes and lost
recordings legible — read its header, and do not report "no crash reporter"
for the helper. The question is what nothing covers.

1. Main's own faults. process-level unhandledRejection / uncaughtException
   handlers. Fire-and-forget `void somePromise()` calls in main.ts and the
   window modules: what happens to a rejection from each? (STC-391's countdown
   wedge was this shape.) IPC handlers that throw: does the renderer get a
   usable error, or a hang?

2. Quitting mid-operation. Cmd-Q / window close / app.quit during: a
   recording, a countdown, an export, a still capture, a duplicate, a
   narration-cleanup worker run. For each: is the take/file left recoverable,
   half-written, or silently lost? (STC-393's temp location and crash
   recovery exist — check what they cover and what they don't.)

3. Missing or corrupt state. First launch with no settings file; a
   settings.json that fails to parse; a storage root that was deleted or is on
   an unmounted volume; a take folder missing one sidecar.

4. The world changing under the app. A permission (Screen Recording, Input
   Monitoring, Microphone, Camera) revoked mid-session; a display unplugged
   during a countdown or with the overlay up; a mic/camera unplugged mid-take;
   the disk filling during a recording or an export.

5. Logging. Where do main-process logs go in a launched (not terminal-run)
   app, and could someone send you one after a failure?

For each gap: area, what is missing, the one-sentence fix, and whether the
fix is CI-checkable (a fault env var in the STC_CAPTURE_FAULT /
STC_COUNTDOWN_FAULT style counts) or needs a Mac.
```

---

## Step 4 — Quick wins → `step-4.md`

```
[preamble]

Read step-1.md, step-2.md and step-3.md. Pick the 5 highest-value items that
are each: 1–3 files, under an hour, low regression risk, and pinnable by a
test that runs on CI.

For each: what and where, why it matters, effort (15 / 30 / 60 min), the test
that would pin it, and the change itself (code or a precise description).
Rank by impact / effort.

Before listing an item, search Linear for it (title and key terms). If a
ticket exists, cite it and do not propose it as new.
```

---

## Step 5 — Support triggers → `step-5.md`

The generic kit role-played a locked-down Windows machine. This app is macOS
only, and its real first-run failures are already partly written down —
`docs/PRE-DEMO-CHECKLIST.md` (STC-406) and the TCC/signing section of
`docs/CORRECTNESS-TRAPS.md` are the starting evidence.

```
[preamble]

Read docs/PRE-DEMO-CHECKLIST.md, the TCC and signing entries in
docs/CORRECTNESS-TRAPS.md, and step-3.md.

You are a Mac user installing this app for the first time — not the
developer. You have one or two displays, one of them possibly above 4K. You
have never granted this app anything. Walk through: first launch → first
Record → first still → first export → quitting and reopening a week later
after an Electron update.

The 3 most likely support requests or 1-star reviews. For each:
1. What triggers it.
2. What the user SEES — the exact text or the absence of any (a silent
   failure is worse than a bad message).
3. The cause in the code, file:line.
4. What would prevent it, and whether that is a code change, a copy change,
   or a packaging change (STC-401 is the open packaging ticket).

Consider at least: the Screen Recording and Input Monitoring prompts (NOT
Accessibility — STC-315 refuses a take with no event tap), a take refused
for a reason the user cannot act on, a grant that silently resets after an
update or re-sign, a self-signed build under Gatekeeper, a second display,
a display above 3840x2160 (the capture ceiling — CLAUDE.md), the helper dying
mid-take, and a full disk.
```

---

## Step 6 — Risk register → `step-6.md`

```
[preamble]

Read every step-N.md for this date. Produce:

| # | area | finding | severity H/M/L | effort S/M/L | CI or MAC | existing ticket | recommended action |

Severity: High = data loss, a take lost silently, or a renderer escaping its
confinement. Medium = fails under a real but uncommon condition. Low =
quality or maintainability.
Effort: S < 1 hour, M ≈ 1 day, L > 1 day.
Sort by severity descending, then effort ascending.

"existing ticket": search Linear for each row. Cite the key if one exists.

Each row without a ticket must be fileable as-is: its "recommended action"
reads as a ticket title, and the finding cell carries the file:line evidence.

Then:
- "Calibration": did steps 1 and 3 re-find STC-466, STC-467 and STC-468? Say
  which, plainly.
- "Disagreements with settled decisions": collected from every step, verbatim,
  unranked. These are for Patrick to read, not to act on.
- A one-paragraph Lead Engineer Summary: what you would tell the team at the
  start of the next sprint, in priority order.
```

---

## Council (optional, after Step 6)

Only the questions that are genuinely open. Fill the brackets from the
step files before sending — a council fed a vague question returns a vague
answer.

1. **Is `main.ts` too big?** It is ~2,700 lines with ~50 `ipcMain` handlers.
   "Should the handlers be split by surface (library / still / editor / record)
   into modules main imports, or does one file make the IPC surface easier to
   audit? [step-0's table, step-2's findings]"
2. **A shared channel schema.** "Preloads restate the types their channels
   carry, and at least one copy has drifted before (STC-343). Is one typed
   channel definition — imported by both preload and handler — worth its
   cost here, given the browser typecheck pass that is why the copies exist?
   [step-2's restated-type findings]"
3. **Is the pure-decisions split paying for itself?** "[N] modules exist to
   hold a window's decisions apart from its Electron/DOM half. Here are the
   bugs their tests caught and the bugs that got past them into the wired e2e
   tests [TICKET-LOG]. Is the split earning its keep?"
