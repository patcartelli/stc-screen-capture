# STC-392 — Floating panel: one panel for stills and recordings, waits for a decision

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the post-capture floating panel the one surface where a take's fate is decided — for a shot and for a recording alike — and stop it deciding anything on its own.

**Architecture:** Three moves, in order. (1) Delete the clock: the panel's state machine loses `expiresAt`, its window loses `armTimer`, and the settings lose `timeoutMs`/`settleAction` — the panel now has exactly one exit, an action the user chose. (2) Give the panel a vocabulary of actions that a *pure* module owns (`panel-actions.ts`), so the renderer's buttons, main's handlers and the context menu cannot drift about which action promotes, which closes, and which confirms. (3) Widen `PresentOptions` from "a shot" to "a take", and present the same window from a recording's clean stop.

**Tech Stack:** TypeScript, Electron (main + three sandboxed renderers), vitest (unit) + Playwright-driven Electron (e2e). No new dependencies.

**Spec:** Linear STC-392 — https://linear.app/studio-cartelli/issue/STC-392. Related: STC-393 (temp storage, merged `8326038`), STC-343/STC-296 (the panel as built), STC-395 (GIF/Video output — blocked on this).

> **Revised 2026-09-17 against a changed spec.** The body this plan was first written against (read 2026-09-16 16:31Z) gained five `decided 2026-09-16` blocks afterwards. One confirms a decision the plan had argued toward (the Reconcile item); four change the work. **Read the ticket, not the "verbatim" copy below** — that copy is the *old* body, kept only so a reader can see what moved. Every task below has been re-argued against the current one; the four deltas are called out in D1/D6/D7/D8/D9.

---

## Global Constraints

- **`master` is protected.** Branch, PR, `npm run merge -- <pr>`. Never push to master.
- **Claim first.** `npm run ticket -- STC-392` must be run before the first commit, and the repo's open PRs and recent master commits listed again immediately before pushing. Exit codes: 0 nothing found, 1 something found, 3 the check could not run.
- **Typechecking is THREE passes.** `npm run typecheck`, never bare `tsc`. A file added outside `tsconfig.json`'s `include` has *no* static checking at all.
- **Every wait needs a bound and a reason.** Use `withTimeout(p, ms, what)` from `@transform/timeout`. A new bound must be checked against every bound already covering the same code — see `app/test/thumbnail-bounds.test.ts`, which this plan extends rather than replaces.
- **One value, one owner.** Any rule stated in two places (renderer + main, HTML + TS, a label and its handler) is the defect this repo has hit five ways. `panel-actions.ts` exists to be that owner; do not restate its answers.
- **A test asserting the OLD contract is a finding, not a test to loosen.** Several tests below are *rewritten to state the new contract*, not relaxed.
- **Tests must not depend on `~/Desktop/stc`.** Use `app/test/_take-fixture.ts`; every Electron e2e must set both `STC_RECORDINGS_DIR` and `STC_TEMP_TAKES_DIR`.
- **`CLAUDE.md` is under a size budget** (`transform/test/claude-md-size.test.ts`). When it fails, move something out — do not raise the number.
- Commit after every task. Two PRs (see "Shipping" below).

---

## The spec, verbatim

> **Model** — Every shot and every recording gets this panel. Stills and recordings use the same component with the same behavior. The existing stills panel (STC-343's floating thumbnail) becomes this one. The panel never closes on its own; it waits for you to choose an action. (This reverses the stills panel closing itself.) No action is preselected based on scope. All actions carry equal weight for now.
>
> **Actions** — Copy → clipboard, panel **stays open**, you may still save. GIF / Video → output format for Copy/Save (recordings only; separate ticket), stays open. Save → writes to the library, closes. Edit → opens the editor; the editor has its **own** Save (you may only be trimming), closes. Trash (×) → deletes the take, closes, **timed undo toast**.
>
> "Copy and done" takes two actions from you: Copy, then Trash. The interface never deletes anything as a side effect of another action.
>
> **Focus and stacking** — 1. The panel takes focus when it appears. 2. When a new shot or recording starts, open panels **move out of the way** and never appear in the captured frame. 3. When panels come back, the **most recent** one gets focus. 4. Every action has a keyboard path.
>
> **Reconcile** — The 2026-09-11 window-model decision "Discard gets a confirmation dialog" conflicts with timed undo here. Decide which surface each rule applies to.
>
> **Depends on** — Temp storage (separate ticket): until Save/Edit/Trash, the take lives in a temp location, not the library.
>
> **Out of scope** — GIF conversion (separate ticket), crash recovery (separate ticket).

---

## Decisions taken before planning

Recorded here because each one changes the task list, and a later reader needs to know they were chosen rather than defaulted into.

**D1 — The Reconcile item: confirm what you chose to keep, undo what you never saved.** *(2026-09-17: the spec now decides this itself — "split by where the take lives. Deleting a take still in temp storage (this panel) → timed undo. Deleting from the library → confirmation dialog." Identical to what this section argued toward, so it stands unchanged and is now quoted rather than reasoned.)*
The panel is a pre-keep surface — a take sitting in temp storage that the user has not said yes to — so its ✕ trashes with a timed undo and no modal. The library is a post-keep surface, so `take:delete`'s existing confirmation dialog stays exactly as it is. This is already what the code does (`main.ts:1443` argues for no confirm on a seconds-old shot; `main.ts:1111` argues for a modal on a recording that is minutes of work); STC-392 adds only the toast. The rule now has one sentence and one owner: `panel-actions.ts`'s `trashStyle(origin)`.

**D2 — A recording's panel shows no picture in v1.**
Nothing in this app has ever produced a poster frame for a take — `library-items.ts:298` says so structurally (`thumbnail: { source: "none" }`) and the library grid has lived with it. The panel reuses that same vocabulary: a recording's card shows a duration and a scope line where a shot's card shows the composite. Decoding frame 0 would drag an always-on-top window into the WebCodecs stack for a cosmetic gain; it is a follow-up ticket, named in the runbook.

**D3 — The panel is one size, with its actions always visible.**
`showing` → `expanded` was a door that existed to hide controls until the timeout had passed. With no timeout, a panel that waits forever while showing no buttons is the weaker reading of "waits for you to choose an action". `COLLAPSED_SIZE`/`EXPANDED_SIZE` collapse into one `PANEL_SIZE`; `REDACT_SIZE` survives untouched, because redact mode still needs a line of text to be a target.

**D4 — `thumbnail.timeoutMs` and `thumbnail.settleAction` are removed; `thumbnail.skip` stays.**
The first two describe a clock that no longer exists — a stored `settleAction` after this ticket would be a preference with no code path, which is worse than no preference. `skip` is different: it is an explicit "never show me the panel, go straight to clipboard", and a user who set it is not asking for the panel to wait. The silent path is untouched by this ticket.

**D5 — Copy no longer promotes; Save and Edit do.**
`still:export` currently promotes on *every* call including Copy (`main.ts:1238`), which was right when Copy was terminal. Under "Copy stays open; you may still Save — or Trash", a Copy that promoted would leave a Trash pressed afterwards deleting something already sitting in the library. STC-393's own runbook (`docs/STC-393-RUNBOOK.md:65`) flagged this as the hook to revisit. The predicate becomes "this export writes a file", which is exactly `req.target.file`.

**D6 — Edit is recordings-only in v1, and Copy is stills-only in v1.**
`editor.ts` is a take editor — preview, trim, export, legibility, share — and `editor:open` refuses any path outside `takesRoot`. There is no still editor (STC-300 is not built); a shot's editing is Redact, which lives in the panel and does not close it. In the other direction, a recording has no format to copy *in* until STC-395 gives it one, and the only video file in a fresh take is `display.mp4`, which by design has no cursor in it — copying that would hand someone a file that looks like their recording and is not. Both absences live in `actionsFor()` with the reason attached, so the grid of what-is-available-when is readable in one place and testable with no window.

---

## Decisions forced by the 2026-09-17 spec revision

**D7 — The stack caps at 3 visible, and nothing is ever dropped.** *(new spec block: "Max 3 panels visible, newest on top with focus. Older panels collapse into a '+N' badge; clicking expands a list of waiting takes with the same actions. Nothing is dropped, only hidden.")*

Two changes, and the second is the load-bearing one. `MAX_STACKED` goes 5 → 3, which is a constant. But today the panel pushed past the cap is **settled** — `presentThumbnail` calls `settleAndDestroy()` on the overflow, which under the old model exported the shot and destroyed its window. That was safe precisely *because* the panel had a default outcome; STC-392 removed the default outcome, so the same eviction now destroys a take nobody decided on. "Nothing is dropped, only hidden" is therefore not a UI nicety — it is the correctness half of this ticket applied to the case a burst of captures produces. The overflow panels stay alive and hidden, and the badge is how they are reachable.

**D8 — Quit warns when takes are unhandled, and never blocks a system shutdown.** *(new spec block: "Warn: 'N takes aren't saved.' Save All / Quit Anyway / Cancel (default). Logout / restart / shutdown skips the warning so it never blocks the system; recovery covers those takes.")*

This replaces Task 3's "quit destroys the panels and leaves the takes in temp for recovery". Recovery is still the backstop and still correct — the warning is what stops a user reaching it by accident. **Quit Anyway does not delete**, so the recovery prompt is exactly where those takes reappear; only Save All changes anything on disk.

The one genuinely uncertain mechanic: telling a user ⌘Q apart from a logout. On macOS, Electron's `powerMonitor` exposes `shutdown` on Linux and Windows but its macOS coverage is version-dependent, and `app.on("before-quit")` fires for both. The implementer verifies which signal actually arrives on macOS 27 before building on it; if none does, the fallback is to warn always and say so in the runbook, because a warning that occasionally appears during a logout is a smaller fault than one that blocks a shutdown — and this checkout cannot settle it.

**D9 — Copy on a recording exists, and hands over a clone that outlives the take.** *(new spec block: "Copy on a recording writes an APFS clone (`clonefile`) to temp; the clipboard references the clone. Trash deletes only the take, so the paste still works. Clones purge after 24h, except a clone that is still the current clipboard item at purge time (one pasteboard check at purge, no polling). Stills unchanged: the clipboard holds image data.")*

This overturns D6's Copy half. The mechanism is the interesting part and it is exactly right: a file-URL clipboard entry pointing into a take directory would break the moment the ticket's own "Copy, then Trash" sequence ran, and copying the bytes would cost a full duplicate of a multi-gigabyte recording. `clonefile(2)` is copy-on-write on APFS — the clone costs metadata until one side is written to, and it survives the original's deletion.

**Q1 — ANSWERED 2026-09-17: Copy on a recording is deferred to STC-395.** `actionsFor({kind:"recording"})` stays `["save","edit","trash"]` and D6 stands unchanged — the ticket's two blocks are in tension with each other (Copy needs a format; its format picker is out of scope here), and the trap below is the third reason.

**Ruling that follows from it: the clone machinery is NOT built in this ticket.** With Copy-on-recording deferred, `clonefile` + the 24h purge + the pasteboard check have no consumer — the spec is explicit that "stills are unchanged: the clipboard holds image data", so no still puts a file reference on the pasteboard to keep alive. Building it now would be infrastructure with nothing calling it, which the review rubric treats as a defect and which would rot before STC-395 arrives. What *is* preserved is the decision: the block is quoted verbatim into `docs/STC-392-RUNBOOK.md` and onto STC-395, so the mechanism arrives with its reasoning attached rather than being re-derived. **Cost if wrong:** STC-395 builds it instead, with the design already written down; nothing is lost but the ordering.

**The question, and the reason it was asked.** The spec says a recording's Copy clones "the take", but a fresh take's only video is `display.mp4`, and `CLAUDE.md` carries a standing trap about that file: **"A raw `display.mp4` never has a cursor — `showsCursor` is off by design and the pointer exists only in an export."** So Copy-on-recording as specified hands someone a video of their screen with no pointer in it, which is the failure mode the constitution warns about by name. The rendered output that *would* have a cursor does not exist at panel time — rendering is the editor's job and runs at 1.52x realtime — and the format picker that would choose it is STC-395, explicitly out of scope. Both readings are buildable and the work differs; this is asked rather than ruled because the answer changes what the action *is*, not how it is coded.

---

## File structure

**New**

| File | Responsibility |
|---|---|
| `app/src/panel-actions.ts` | The action vocabulary, with no DOM and no Electron: which actions a take has, which close the panel, which promote it out of temp, and which destruction idiom its origin gets. The one owner of every rule the renderer and main would otherwise each hold a copy of. |
| `app/src/pending-trash.ts` | The undo window as a decision, not a timer: a registry of takes whose deletion has been *promised* but not performed, and the rules for when a promise is kept (the window elapses, or the app shuts down) or broken (undo). Electron-free. |
| `app/src/toast-window.ts` | The undo toast's real `BrowserWindow` — the same split `thumbnail.ts`/`thumbnail-window.ts` makes. Owns nothing but pixels and a dismiss. |
| `app/renderer/toast.html` | The toast's markup. |
| `app/src/toast-preload.ts` | Its two-channel bridge: "undo was pressed", "the window may close". |
| `app/test/panel-actions.test.ts` | The vocabulary, exhaustively, with no window. |
| `app/test/pending-trash.test.ts` | The undo window's decisions, with an injected clock. |
| `app/test/panel-waits.e2e.test.ts` | The contract this ticket reverses: a panel left alone is still there, and its take is still in temp. |
| `app/test/recording-panel.e2e.test.ts` | A recording's clean stop puts up a panel, and does *not* put the take in the library. |
| `app/src/quit-guard.ts` | Whether a quit warns, Electron-free (D8). |
| `app/test/quit-guard.test.ts` | Its three cases, the system-initiated one included. |
| `docs/STC-392-RUNBOOK.md` | What only hardware can settle: focus, the toast's real appearance, panels moving out of a recording's frame, whether macOS 27 distinguishes a logout from ⌘Q, and the deferred clonefile design. |

**Modified**

| File | Change |
|---|---|
| `app/src/thumbnail.ts` | Lose the clock and the expand door; gain a `PanelTake` shape. |
| `app/src/thumbnail-window.ts` | Lose `armTimer` and settle-on-timeout; gain focus-on-appear and focus-newest-on-return; `PresentOptions` takes a take, not a shot. |
| `app/src/thumbnail-renderer.ts` | One size, five actions, keyboard paths, Copy-stays-open, the recording card. |
| `app/renderer/thumbnail.html` | One card, actions always visible, a recording's text card. |
| `app/src/thumbnail-preload.ts` | New channels for save/edit/trash; `onSettle` removed. |
| `app/src/thumbnail-menu.ts` | The menu's ids follow `panel-actions.ts` rather than restating them. |
| `app/src/settings.ts` | `timeoutMs` and `settleAction` removed from `ThumbnailSettings`. |
| `app/src/supervisor.ts` | Stop promoting on a clean stop — the panel decides now. |
| `app/src/main.ts` | `still:export` promotes only on a file write; new `panel:*` handlers; present the panel from a recording's end; hide panels for the length of a recording; commit pending deletions on shutdown. |
| `app/test/thumbnail.test.ts` | States the new contract. |
| `app/test/thumbnail-bounds.test.ts` | The bound that survives, re-anchored to the new size. |
| `app/test/thumbnail.e2e.test.ts` | The "ignore it and it saves" tests become "ignore it and it waits". |
| `app/test/settings.test.ts` | The two removed preferences. |
| `app/test/supervisor.test.ts` | A clean stop no longer promotes. |
| `app/test/nothing-lost.e2e.test.ts` | Re-states what "nothing is lost" now means. |
| `CLAUDE.md` | One compressed line; the ticket row. |

---

# Phase A — the panel waits (stills)

Ships on its own: after Phase A the stills panel never closes itself, has five
actions with keyboard paths, and a Trash you can undo. Recordings are untouched
and keep promoting on a clean stop.

---

### Task 1: The action vocabulary

**Files:**
- Create: `app/src/panel-actions.ts`
- Test: `app/test/panel-actions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type PanelAction = "copy" | "save" | "edit" | "trash"`; `type TakeKind = "shot" | "recording"`; `type TakeOrigin = "fresh" | "library"`; `interface PanelTake { kind: TakeKind; origin: TakeOrigin }`; `actionsFor(take: PanelTake): readonly PanelAction[]`; `closesPanel(a: PanelAction): boolean`; `promotes(a: PanelAction): boolean`; `trashStyle(origin: TakeOrigin): "undo" | "confirm"`; `UNDO_WINDOW_MS: number`.

- [ ] **Step 1: Write the failing test**

Create `app/test/panel-actions.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import {
  actionsFor, closesPanel, promotes, trashStyle, UNDO_WINDOW_MS,
  type PanelAction, type PanelTake,
} from "../src/panel-actions.js";

/**
 * STC-392's action table, with no window and no Electron.
 *
 * The table in the ticket is four columns — action, effect, whether the panel
 * closes, and (for a recording) whether the action exists at all. Every one of
 * those answers is needed in at least two places: the renderer draws the
 * buttons, main performs them, and `thumbnail-menu.ts` offers the same set
 * again in a context menu. Three copies of one table is the defect this repo
 * has hit five ways, so the table lives here and those three ask.
 */

const fresh = (kind: PanelTake["kind"]): PanelTake => ({ kind, origin: "fresh" });

describe("which actions a take has", () => {
  test("a fresh shot has copy, save and trash — and no edit", () => {
    // There is no still editor (STC-300 is not built); a shot's editing is
    // Redact, which lives in the panel and does not close it.
    expect(actionsFor(fresh("shot"))).toEqual(["copy", "save", "trash"]);
  });

  test("a fresh recording has save, edit and trash — and no copy", () => {
    // Copy needs a format, and a recording's format picker is STC-395. The only
    // video in a fresh take is display.mp4, which by design has no cursor in
    // it: copying that hands someone a file that looks like their recording
    // and is not.
    expect(actionsFor(fresh("recording"))).toEqual(["save", "edit", "trash"]);
  });

  test("a take re-opened from the library cannot be saved again", () => {
    // STC-294's re-open: it is already in the library, and a second Save would
    // be the app inventing work nobody asked for.
    expect(actionsFor({ kind: "shot", origin: "library" })).toEqual(["copy", "trash"]);
    expect(actionsFor({ kind: "recording", origin: "library" })).toEqual(["edit", "trash"]);
  });

  test("every take has trash, and it is always last", () => {
    for (const kind of ["shot", "recording"] as const) {
      for (const origin of ["fresh", "library"] as const) {
        const actions = actionsFor({ kind, origin });
        expect(actions.at(-1)).toBe("trash");
      }
    }
  });
});

describe("what an action does to the panel", () => {
  test("copy is the only action that leaves the panel open", () => {
    // The ticket's own words: "Copy and done" takes two actions from you.
    const all: PanelAction[] = ["copy", "save", "edit", "trash"];
    expect(all.filter((a) => !closesPanel(a))).toEqual(["copy"]);
  });

  test("save and edit promote out of temp storage; copy and trash do not", () => {
    // A Copy that promoted would leave a Trash pressed afterwards deleting
    // something already sitting in the library (STC-393 runbook's own note).
    const all: PanelAction[] = ["copy", "save", "edit", "trash"];
    expect(all.filter(promotes)).toEqual(["save", "edit"]);
  });

  test("nothing that promotes also closes without promoting, and vice versa", () => {
    // Composition, not magnitude: the two predicates must not be able to
    // disagree about `save`, which is the one action that does both.
    expect(promotes("save") && closesPanel("save")).toBe(true);
    expect(promotes("copy") || closesPanel("copy")).toBe(false);
  });
});

describe("the reconcile (D1)", () => {
  test("an unsaved take gets a timed undo; a library one gets a confirmation", () => {
    expect(trashStyle("fresh")).toBe("undo");
    expect(trashStyle("library")).toBe("confirm");
  });

  test("the undo window is long enough to read the toast and reach it", () => {
    expect(UNDO_WINDOW_MS).toBeGreaterThanOrEqual(5_000);
    expect(UNDO_WINDOW_MS).toBeLessThanOrEqual(15_000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```
npx vitest run app/test/panel-actions.test.ts
```
Expected: FAIL — `Failed to resolve import "../src/panel-actions.js"`.

- [ ] **Step 3: Write the module**

Create `app/src/panel-actions.ts`:

```ts
/**
 * What the post-capture panel may DO with a take (STC-392), with no DOM and
 * no Electron.
 *
 * The ticket is a four-column table, and every column is needed in at least
 * three places: `thumbnail-renderer.ts` draws the buttons, `main.ts` performs
 * them, and `thumbnail-menu.ts` offers the same set again as a context menu.
 * Three copies of one table is the most repeated defect in this codebase, so
 * the table is here and those three ask it.
 *
 * ## Why a take has a KIND and an ORIGIN, and why they are not one field
 *
 * `kind` answers "what is this" — a shot or a recording — and decides which
 * actions exist at all. `origin` answers "has anyone said yes to it yet" — a
 * fresh capture sitting in temp storage, or something re-opened from the
 * library — and decides what Save and Trash MEAN. Folding them into one enum
 * ("fresh-shot", "library-recording") would make the four combinations look
 * like four cases rather than two independent questions, and the next kind or
 * the next origin would double it again.
 *
 * ## The two absences are deliberate, and each has a reason on it
 *
 * **A shot has no Edit.** There is no still editor — `editor.ts` is a TAKE
 * editor (preview, trim, export, share) and `editor:open` refuses any path
 * outside the recordings root. A shot's editing is Redact, which lives in the
 * panel and does not close it, so it is not one of these actions at all.
 *
 * **A recording has no Copy.** Copy needs a format and a recording's format
 * picker is STC-395, explicitly out of scope here. The only video file in a
 * fresh take is `display.mp4`, which has `showsCursor` off by design — copying
 * it would hand someone a file that looks like their recording and is missing
 * the pointer. An action that looks like it worked is worse than an absent one.
 *
 * Both come back for free when their blocking ticket lands: one row each.
 *
 * NOTE (2026-09-17): the spec's "Copy → Trash on recordings" block overturns
 * the Copy half — see D6/Q1 in the plan. `actionsFor` gains `copy` for a
 * recording once Q1 is answered; the Edit half stands.
 */

export type PanelAction = "copy" | "save" | "edit" | "trash";

/** What the panel is showing. Decides which actions exist. */
export type TakeKind = "shot" | "recording";

/**
 * Whether anyone has said yes to it yet. Decides what Save and Trash mean.
 *
 * `fresh` is a capture still sitting in temp storage (STC-393) — nothing has
 * kept it, so Save promotes and Trash is cheap. `library` is STC-294's
 * re-open: already on disk, already kept, so there is nothing to Save and
 * Trash is destroying something the user chose.
 */
export type TakeOrigin = "fresh" | "library";

export interface PanelTake {
  kind: TakeKind;
  origin: TakeOrigin;
}

/**
 * The actions this take has, in the order the panel lays them out.
 *
 * Trash is always last and always present — it is the ✕, and a panel that
 * never closes on its own must always have a way out.
 */
export function actionsFor(take: PanelTake): readonly PanelAction[] {
  const out: PanelAction[] = [];
  // See the module doc: a recording has no Copy until STC-395.
  if (take.kind === "shot") out.push("copy");
  // Nothing to promote for something already in the library.
  if (take.origin === "fresh") out.push("save");
  // See the module doc: a shot has no Edit until a still editor exists.
  if (take.kind === "recording") out.push("edit");
  out.push("trash");
  return out;
}

/**
 * Whether performing this action ends the panel's life.
 *
 * Copy is the only one that does not, and that is the ticket's whole point:
 * "Copy and done" is two actions from the user, Copy and then Trash, because
 * the interface never deletes anything as a side effect of another action.
 */
export function closesPanel(action: PanelAction): boolean {
  return action !== "copy";
}

/**
 * Whether this action moves the take out of temp storage and into the library
 * (STC-393's `promoteTake`).
 *
 * Save obviously. Edit as well, and not as a convenience: `editor:open`
 * refuses any path outside the recordings root, so a take must be promoted
 * before the editor can be pointed at it. The editor's own Save is about the
 * EXPORT — the ticket's "you may only be trimming" — not about whether the
 * take is kept.
 *
 * Copy deliberately does NOT, which is the change STC-393's runbook asked for:
 * a Copy that promoted would leave a Trash pressed afterwards deleting
 * something already sitting in the library.
 */
export function promotes(action: PanelAction): boolean {
  return action === "save" || action === "edit";
}

/**
 * The ticket's Reconcile item, settled (D1): confirm what the user chose to
 * keep, undo what they never saved.
 *
 * The 2026-09-11 window-model decision ("Discard gets a confirmation dialog")
 * is about the LIBRARY — a grid you browse, holding things you already said
 * yes to, where a misclick lands on a stranger. This panel is the other
 * surface: a take seconds old with the pointer already on it, which the user
 * has not kept yet. A modal there is friction bought with nothing, and a
 * timed undo is the cheaper promise.
 *
 * Both are already the code's behaviour — `still:deleteShot` does not confirm,
 * `take:delete` does — and each file already argues for its own half. This
 * ticket adds only the toast, and this function is the one place the split is
 * stated rather than implied by which handler you happened to reach.
 */
export function trashStyle(origin: TakeOrigin): "undo" | "confirm" {
  return origin === "fresh" ? "undo" : "confirm";
}

/**
 * How long an undo stays reachable.
 *
 * Long enough to notice the toast, read it and move a pointer to it; short
 * enough that a take the user meant to delete is not still sitting in temp
 * storage when they quit. The commit-on-shutdown rule in `pending-trash.ts` is
 * what makes the second half true regardless.
 */
export const UNDO_WINDOW_MS = 8_000;
```

- [ ] **Step 4: Run it and watch it pass**

```
npx vitest run app/test/panel-actions.test.ts
```
Expected: PASS, 10 tests.

- [ ] **Step 5: Prove the vocabulary can fail**

Mutate `closesPanel` to `return true` and re-run. Expected: the "copy is the only action that leaves the panel open" test FAILS. Revert.
Mutate `promotes` to include `"copy"` and re-run. Expected: two tests FAIL. Revert.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add app/src/panel-actions.ts app/test/panel-actions.test.ts
git commit -m "STC-392: the panel's action table, in one place"
```

---

### Task 2: Delete the clock

**Files:**
- Modify: `app/src/thumbnail.ts` — remove `DEFAULT_THUMBNAIL_TIMEOUT_MS`, `MIN_THUMBNAIL_TIMEOUT_MS`, `clampTimeoutMs`, `isExpired`, `SettleAction`, `parseSettleAction`, `PanelSettle`, `expand`; collapse `ThumbnailState` to `idle | open`
- Modify: `app/src/settings.ts:183` region — drop `timeoutMs` and `settleAction` from `ThumbnailSettings`
- Test: `app/test/thumbnail.test.ts`, `app/test/settings.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 yet.
- Produces: `type ThumbnailState = { kind: "idle" } | { kind: "open" }`; `show(): ThumbnailState`; `dismiss(): ThumbnailState`; `PANEL_SIZE: Size`. Everything else in `thumbnail.ts` (`positionFor`, `stackPosition`, `STACK_STEP_PX`, `MAX_STACKED`, the whole swipe/drag group, `parseCorner`, `SETTLE_READY_MS`) is unchanged and still exported.

- [ ] **Step 1: Rewrite the tests to state the new contract**

In `app/test/thumbnail.test.ts`, replace the `describe("the panel state machine")` and `describe("the timeout preference")` blocks entirely with:

```ts
describe("the panel state machine (STC-392: it waits)", () => {
  test("starts idle", () => {
    expect(initialState()).toEqual({ kind: "idle" });
  });

  test("a capture opens it, and there is nowhere else for it to go on its own", () => {
    // The whole of STC-392: `showing` used to carry an `expiresAt`, and
    // `isExpired` used to be the second way out. Both are gone — the only
    // transition off `open` is `dismiss`, which a user action calls.
    expect(show()).toEqual({ kind: "open" });
  });

  test("dismiss always returns to idle, and is idempotent", () => {
    expect(dismiss()).toEqual({ kind: "idle" });
    expect(dismiss()).toEqual(dismiss());
  });

  test("the module exports no clock at all", async () => {
    // A structural guard with a control: the names below were the panel's
    // timeout, and a re-introduced one would be a second way for a take to be
    // decided without the user. The control asserts the guard can see names
    // that ARE there, so a typo in the list cannot make this pass vacuously.
    const mod = await import("../src/thumbnail.js");
    for (const gone of ["isExpired", "clampTimeoutMs", "parseSettleAction",
                        "DEFAULT_THUMBNAIL_TIMEOUT_MS", "MIN_THUMBNAIL_TIMEOUT_MS"]) {
      expect(Object.keys(mod)).not.toContain(gone);
    }
    for (const present of ["show", "dismiss", "positionFor", "stackPosition"]) {
      expect(Object.keys(mod)).toContain(present);
    }
  });
});
```

Delete the `describe("the settle-action preference")` block. Update the import list at the top of the file to drop `expand`, `isExpired`, `clampTimeoutMs`, `parseSettleAction`, `DEFAULT_THUMBNAIL_TIMEOUT_MS`, `MIN_THUMBNAIL_TIMEOUT_MS` and the `ThumbnailState` type import, and add `PANEL_SIZE`.

Then replace the stacking test `"a full stack still fits the work area"` with one anchored to the real size:

```ts
  test("a full stack of the ONE panel size still fits the work area", () => {
    // Re-anchored for STC-392 (D3): the card is one size now, and it is taller
    // than the old collapsed thumbnail because its actions are always visible.
    // The old test measured the collapsed size and would have stayed green
    // while five of the real card ran off the screen.
    const workArea = { x: 0, y: 0, width: 1440, height: 900 };
    const oldest = stackPosition(MAX_STACKED - 1, "bottom-right", workArea, PANEL_SIZE);
    expect(oldest.y).toBeGreaterThanOrEqual(workArea.y);
    expect(oldest.y + PANEL_SIZE.height).toBeLessThanOrEqual(workArea.y + workArea.height);
    // Composition, not magnitude: the clearance must come from the stack's own
    // arithmetic, not from slack in a display that happens to be tall.
    const consumed = PANEL_SIZE.height + (MAX_STACKED - 1) * STACK_STEP_PX + 2 * 20;
    expect(consumed).toBeLessThanOrEqual(workArea.height);
  });
```

- [ ] **Step 2: Run and watch it fail**

```
npx vitest run app/test/thumbnail.test.ts
```
Expected: FAIL — `show` called with no arguments, `PANEL_SIZE` is not exported, and the removed names are still there.

- [ ] **Step 3: Cut the clock out of `thumbnail.ts`**

Replace the `DEFAULT_THUMBNAIL_TIMEOUT_MS` / `MIN_THUMBNAIL_TIMEOUT_MS` / `clampTimeoutMs` block, the `SettleAction` / `parseSettleAction` / `PanelSettle` block, and the `ThumbnailState` / `show` / `expand` / `isExpired` / `dismiss` block with:

```ts
/**
 * The panel's own state machine, after STC-392: two states, and only a person
 * moves between them.
 *
 * It used to be three — `idle` → `showing` → `expanded` — with a deadline on
 * `showing` and `isExpired` as a second way out. STC-392 reverses that: "the
 * panel never closes on its own. It waits for you to choose an action." A
 * state machine with a clock in it could not express that, so the clock is
 * gone rather than set to infinity, which would have left a timeout nobody
 * could see and everybody would have had to reason about.
 *
 * The expand door went with it (D3). It existed to keep controls out of the
 * way until the timeout had passed; with nothing to pass, a panel that waits
 * forever while showing no buttons is the weaker reading of "waits for you to
 * choose an action".
 */
export type ThumbnailState = { kind: "idle" } | { kind: "open" };

export function initialState(): ThumbnailState { return { kind: "idle" }; }

/** A capture arrived. There is no second argument any more; there is no clock. */
export function show(): ThumbnailState { return { kind: "open" }; }

/**
 * Back to nothing on screen. Reached only by an action the user chose — Save,
 * Edit or Trash — or by the app shutting down. Idempotent, the same rule
 * `overlay-session.ts`'s `finish` follows.
 */
export function dismiss(): ThumbnailState { return { kind: "idle" }; }
```

Add, beside the other geometry constants:

```ts
/**
 * The one size the card is (D3).
 *
 * Wider and taller than the old 220×150 collapsed thumbnail, because the
 * actions are on it from the moment it appears rather than behind a click.
 * `app/test/thumbnail.test.ts` asserts a full stack of FIVE of these still
 * fits a 1440×900 work area — the old test measured the collapsed size and
 * would have stayed green while the real card ran off the bottom.
 */
export const PANEL_SIZE: Size = { width: 260, height: 210 };
```

Note: `Size` is declared near the bottom of the file; move the `export interface Size` / `export interface Bounds` pair above this constant, or declare `PANEL_SIZE` after them. Do not duplicate the interface.

- [ ] **Step 4: Follow the type errors out**

```
npm run typecheck
```
Expected errors, and their fixes:
- `app/src/settings.ts` — remove `timeoutMs` and `settleAction` from the `ThumbnailSettings` interface, from `DEFAULT_THUMBNAIL_SETTINGS`, and from `cleanThumbnail`. Leave `corner` and `skip`.
- `app/src/thumbnail-window.ts`, `app/src/thumbnail-renderer.ts`, `app/src/main.ts` — these are Tasks 3–5. For **this** task only, stop them compiling by deleting the now-dangling imports and leaving the call sites broken is NOT acceptable; instead do the minimum mechanical fix: `presentThumbnail`'s `timeoutMs`/`settleAction` fields become optional-and-ignored and `armTimer` is commented out. **If that feels like two tasks fighting, it is** — prefer to do Tasks 2 and 3 in one sitting and commit once.

- [ ] **Step 5: Update `settings.test.ts`**

Add to `app/test/settings.test.ts`:

```ts
  test("the panel's clock is not a preference any more (STC-392)", () => {
    // Both described a timeout that no longer exists. A stored `settleAction`
    // after this ticket would be a preference with no code path, which is
    // worse than no preference: it reads as configurable and changes nothing.
    const s = readSettings(dir);
    expect(s.thumbnail).not.toHaveProperty("timeoutMs");
    expect(s.thumbnail).not.toHaveProperty("settleAction");
    // The controls: what SURVIVES, so this cannot pass by the block being gone.
    expect(s.thumbnail).toHaveProperty("corner");
    expect(s.thumbnail).toHaveProperty("skip");
  });

  test("a settings file written before STC-392 loses the two dead keys", () => {
    // Someone upgrading has both in their settings.json. `cleanThumbnail` must
    // drop them rather than carrying them forward forever.
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      thumbnail: { corner: "top-left", skip: false, timeoutMs: 9000, settleAction: "copy" },
    }));
    const s = readSettings(dir);
    expect(s.thumbnail.corner).toBe("top-left");
    expect(s.thumbnail).not.toHaveProperty("timeoutMs");
  });
```

(Match the existing file's fixture helpers — it already has a temp `dir` and imports `readSettings`; reuse them rather than adding new ones.)

- [ ] **Step 6: Run the unit suites and commit**

```
npx vitest run app/test/thumbnail.test.ts app/test/settings.test.ts app/test/thumbnail-bounds.test.ts
npm run typecheck
```
Expected: PASS.

```bash
git add app/src/thumbnail.ts app/src/settings.ts app/test/thumbnail.test.ts app/test/settings.test.ts
git commit -m "STC-392: the panel has no clock — remove the timeout and its two preferences"
```

---

### Task 3: The window stops deciding, and takes focus

**Files:**
- Modify: `app/src/thumbnail-window.ts`
- Test: `app/test/thumbnail-bounds.test.ts`, `app/test/thumbnail.e2e.test.ts`

**Interfaces:**
- Consumes: `PANEL_SIZE`, `show`, `dismiss` (Task 2); `PANEL_WINDOW_TYPE`, `focusPanel` (`app/src/panel-focus.ts`, existing).
- Produces: `presentThumbnail(opts: PresentOptions): void` where `PresentOptions` loses `timeoutMs` and `settleAction`; `dismissThumbnail(dir: string): void`; `closeThumbnail(): Promise<void>` (unchanged signature, new meaning); `beforeCapture(): Promise<number[]>` and `afterCapture(): void` unchanged in signature, `afterCapture` now focuses the newest.

- [ ] **Step 1: Write the failing e2e for the reversed contract**

Create `app/test/panel-waits.e2e.test.ts`:

```ts
import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * The contract STC-392 reverses, end to end.
 *
 * `thumbnail.e2e.test.ts` used to assert that ignoring the panel WROTE the
 * shot — "there is no path where a capture is silently lost" was STC-296's
 * acceptance criterion and a timeout was how it was kept. STC-392 keeps the
 * same promise a different way: ignoring the panel writes nothing, because
 * the panel is still there and the take is still in temp storage where
 * STC-393's crash recovery will find it.
 *
 * This is a NEW file rather than an edit, because it is a different claim
 * about the same pixels and the two should be readable side by side.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Long enough that a timeout would certainly have fired.
 *
 * The old floor was 3 s and the old default 6 s; waiting 8 s means a
 * re-introduced clock at either value is caught rather than raced. The test's
 * own vitest timeout must exceed this — see the rule this repo learned in
 * `bc9faaf`.
 */
const LONGER_THAN_ANY_OLD_TIMEOUT_MS = 8_000;

describe("the panel waits (STC-392)", () => {
  test("left alone, the panel is still there and the take is still in temp", async () => {
    const { dir: recordings } = makeTakeFolder();
    const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
    const destDir = mkdtempSync(join(tmpdir(), "stc-thumb-dest-"));
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    writeFileSync(join(userData, "settings.json"),
                  JSON.stringify({ still: { destination: destDir } }));

    app = await electron.launch({
      args: [root, `--user-data-dir=${userData}`],
      cwd: root,
      env: {
        ...process.env,
        STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
        STC_HELPER_BIN: FAKE_HELPER, STC_NO_SHUTTER: "1",
      },
    });
    const win = await app.firstWindow();
    await win.waitForSelector("#capturestill");
    await win.click("#capturestill");

    // The panel is up.
    await sleep(1_000);
    let panels = await app.windows();
    expect(panels.some((p) => p.url().includes("thumbnail.html"))).toBe(true);

    await sleep(LONGER_THAN_ANY_OLD_TIMEOUT_MS);

    // Still up — this is the assertion the whole ticket is about.
    panels = await app.windows();
    expect(panels.some((p) => p.url().includes("thumbnail.html"))).toBe(true);
    // And nothing was written anywhere, because nothing was decided.
    expect(readdirSync(destDir)).toEqual([]);
    // The take is exactly where STC-393 put it.
    expect(readdirSync(temp).length).toBe(1);
    expect(readdirSync(recordings).filter((n) => !n.startsWith("."))).toEqual([]);
  }, 40_000);   // must exceed the 8 s wait inside it plus launch — bc9faaf's rule
});
```

- [ ] **Step 2: Run and watch it fail**

```
npx vitest run app/test/panel-waits.e2e.test.ts
```
Expected: FAIL — after 8 s the panel has settled itself and `destDir` holds a PNG.

- [ ] **Step 3: Take the timer out of the window**

In `app/src/thumbnail-window.ts`:

1. Import `PANEL_SIZE` instead of `Size`-sized `COLLAPSED_SIZE`/`EXPANDED_SIZE`; delete both constants. Keep `REDACT_SIZE`.
2. Delete `armTimer()` and the `timer` field. Keep `backstop` — it still bounds the one remaining renderer round trip (Task 4's export-then-close).
3. `PresentOptions`: delete `timeoutMs` and `settleAction`.
4. `ThumbEvent`: delete `"painted"`'s timer duty (keep the event — it is still what makes `showInactive` safe), delete `"expanded"`, keep `"redact"`, `"discarding"`, `"done"`.
5. Rename `settleAndDestroy()` to `dismissNow()` and cut the export out of it:

```ts
  /**
   * Take the panel off the screen without deciding anything.
   *
   * This used to be `settleAndDestroy`, and the difference is the whole
   * ticket: it told the renderer to composite-and-export first, because a
   * panel that vanished on a timeout still had to keep "nothing is lost by
   * doing nothing". Nothing times out now, so the only callers left are the
   * ones where the take's fate is decided elsewhere — the renderer has just
   * performed a Save, an Edit or a Trash — or where there is no fate to
   * decide, which is the app shutting down.
   *
   * A take still in temp storage when this runs is not lost either: STC-393's
   * recovery prompt finds it on the next launch. That is the promise now, and
   * it is a better one than a silent export nobody asked for.
   */
  dismissNow(): void {
    if (this.done) return;
    this.hide();
    this.destroy();
  }
```

6. `onEvent`'s `"painted"` branch: show with focus rather than inactively.

```ts
    if (ev.kind === "painted") {
      this.hasPainted = true;
      // STC-392 focus rule 1: "the panel takes focus when it appears."
      // `showInactive` was right when the panel was a transient notice you
      // could ignore; a panel that waits for a decision and cannot be typed
      // at is a panel whose keyboard paths (rule 4) do not exist.
      //
      // Through `focusPanel`, not `win.focus()`: on macOS an application-level
      // activation raises the main window too, which is the exact fault
      // STC-391's follow-up (5850e4f) spent a session finding. The window is
      // created with `type: PANEL_WINDOW_TYPE` for the same reason.
      this.win.show();
      void focusPanel(this.win);
    }
```

and add `type: PANEL_WINDOW_TYPE` to the `new BrowserWindow({...})` options, importing both from `./panel-focus.js`.

7. `afterCapture()` — focus rule 3:

```ts
export function afterCapture(): void {
  for (const p of panels) p.reshow();
  // STC-392 focus rule 3: "when panels come back, the most recent one gets
  // focus." `panels[0]` IS the most recent — the list is newest-first, the
  // same ordering `stackPosition` reads for its index. Asserted rather than
  // assumed in `thumbnail.test.ts`'s stacking block, because "newest first"
  // is a convention two modules share and a reversed list would put focus on
  // the oldest while every position stayed correct.
  panels[0]?.takeFocus();
}
```

with `takeFocus()` on the session delegating to `focusPanel(this.win)` and refusing when `!hasPainted`.

8. `closeThumbnail()`: replace the `settleAndDestroy` loop with `dismissNow`, and update its doc — quit no longer exports, it leaves takes in temp for recovery. **Task 5c puts a warning in front of this** (D8); this task builds the teardown it runs after, and the two must agree that Quit Anyway deletes nothing.

9. Add `dismissThumbnail(dir: string)` so main can close one specific panel after performing its action. It needs the session to expose which take it is showing, which it currently keeps private inside `opts`:

```ts
// On ThumbnailSession, beside `waitUntilClosed()`:

  /**
   * Which take this panel is showing.
   *
   * Exposed because main's handlers are reached from the RENDERER, and a
   * renderer names a take, never a window — the same rule `still:deleteShot`
   * and `still:revealShot` already follow. `readonly` via the getter: a panel
   * whose directory could be reassigned from outside would be a second owner
   * of a value `promoteTake` already moves.
   */
  get takeDir(): string { return this.opts.dir; }
```

```ts
/**
 * Close the panel showing this take, once its action has been performed.
 *
 * Matched on the dir the panel was PRESENTED with, so it must be called
 * before anything reassigns that dir — `panel:save` promotes first and then
 * dismisses, which works because `promoteTake` returns a new path and leaves
 * the panel's own `opts.dir` alone. A dismiss that ran after the panel had
 * learned its new home would match nothing and leave the window up.
 */
export function dismissThumbnail(dir: string): void {
  for (const p of [...panels]) if (p.takeDir === dir) p.dismissNow();
}
```

- [ ] **Step 4: Run it and watch it pass**

```
npx vitest run app/test/panel-waits.e2e.test.ts
```
Expected: PASS.

- [ ] **Step 5: Re-state, do not loosen, the old e2e**

In `app/test/thumbnail.e2e.test.ts`: the tests named around "ignoring it writes the file" assert the OLD contract. Rewrite each to the new one (the panel is still up; nothing written) or delete it as now covered by `panel-waits.e2e.test.ts`, and remove `thumbnail: { timeoutMs: 3000 }` from `launch()`'s seeded settings. Keep every test about exclusion from the next capture, stacking, the swipe and drag-out — none of those changed.

- [ ] **Step 6: Full app suite, then commit**

```
npm run typecheck
npx vitest run app/test
```
Expected: PASS. Any failure naming `settleAction` or `timeoutMs` is a call site Task 2 left behind — fix it here.

```bash
git add app/src/thumbnail-window.ts app/test/panel-waits.e2e.test.ts app/test/thumbnail.e2e.test.ts
git commit -m "STC-392: the panel window has no timer, and takes focus when it appears"
```

---

### Task 4: One card, five actions, four keyboard paths

**Files:**
- Modify: `app/renderer/thumbnail.html`
- Modify: `app/src/thumbnail-renderer.ts`
- Modify: `app/src/thumbnail-preload.ts`
- Modify: `app/src/thumbnail-menu.ts`
- Test: `app/test/thumbnail-menu.test.ts`

**Interfaces:**
- Consumes: `actionsFor`, `closesPanel`, `PanelAction` (Task 1); `PANEL_SIZE` (Task 2).
- Produces: preload surface gains `save(dir): Promise<{ok, dir?, detail?}>`, `edit(dir): Promise<{ok, detail?}>`, `trash(dir): Promise<{ok, detail?}>`; loses `onSettle` and `deleteShot`. `window.thumb.event` loses `"expanded"`.

- [ ] **Step 1: The markup — one card**

Rewrite the `<body>` of `app/renderer/thumbnail.html`:

```html
<body>
  <div id="card">
    <div id="thumbwrap"><canvas id="thumbcanvas"></canvas></div>
    <!-- A recording has no picture in v1 (D2); this stands in for the canvas,
         using the same vocabulary the library already has for a take with no
         thumbnail (`library-items.ts`'s `source: "none"`). -->
    <div id="takecard" hidden>
      <div id="takekind">Recording</div>
      <div id="takemeta"></div>
    </div>
    <div id="controls">
      <div class="row" id="stylerow">
        <label>Style <select id="mode"></select></label>
        <button id="redact" title="Cover anything private with a solid fill">Redact</button>
      </div>
      <div class="row" id="actions">
        <button id="copy" data-action="copy">Copy</button>
        <button id="save" data-action="save">Save</button>
        <button id="edit" data-action="edit">Edit</button>
        <button id="trash" data-action="trash" title="Delete this take">✕</button>
      </div>
      <div class="row" id="redactrow">
        <span id="redacthint">Drag over anything private.</span>
        <button id="undo" title="Remove the last box">Undo</button>
        <button id="donedact">Done</button>
      </div>
      <div id="status"></div>
    </div>
  </div>
  <script src="../dist/thumbnail-renderer.js"></script>
</body>
```

In the `<style>` block: delete `#expanded { display: none }` and `#card.expanded #expanded { display: block }` and `#card.expanded { cursor: default }`; `#controls` is always shown; `#card { cursor: default }` (the card is no longer one big click target, because there is nothing to expand into); `#trash { margin-left: auto; padding: 4px 9px; }`. Keep every `#card.dragging` and `#card.redacting` rule — the swipe and redact mode are unchanged.

- [ ] **Step 2: Write the failing menu test**

The context menu must offer the same set, from the same source. In `app/test/thumbnail-menu.test.ts`, add:

```ts
  test("the menu offers exactly the actions the panel has, and no others", () => {
    // Two copies of the action table is the defect; the menu asks
    // `panel-actions.ts` the same question the buttons do. This test is what
    // stops the menu growing an action the panel does not have — which is how
    // Save As came to be in one and not the other.
    for (const take of [{ kind: "shot", origin: "fresh" },
                        { kind: "recording", origin: "fresh" }] as const) {
      const ids = buildThumbMenu({ take, redacting: false, busy: false })
        .map((i) => i.id)
        .filter((id) => (["copy", "save", "edit", "trash"] as string[]).includes(id));
      expect(ids).toEqual([...actionsFor(take)]);
    }
  });
```

- [ ] **Step 3: Run and watch it fail**

```
npx vitest run app/test/thumbnail-menu.test.ts
```
Expected: FAIL — `buildThumbMenu` does not take a `take`, and its ids are `delete`/`save-as`, not the vocabulary.

- [ ] **Step 4: Rewire the renderer**

In `app/src/thumbnail-renderer.ts`:

1. Delete `expanded`, `expand()`, the `card.addEventListener("click", ...)` expand handler, and the `"expanded"` event send. The `COLLAPSED_BOX`/`EXPANDED_BOX` pair becomes one `CARD_BOX = { width: 240, height: 128 }`; `REDACT_BOX` is unchanged. In `draw()`, `const box = redacting ? REDACT_BOX : CARD_BOX;`.
2. Delete `settle()`, `markReady`/`ready`'s settle duty (keep the promise — Save still needs the composite), the `window.thumb.onSettle(...)` registration and the whole `settleAction` parse.
3. One dispatcher for the buttons, so no action's rules are written twice:

```ts
/**
 * Perform one action, and do to the panel whatever `panel-actions.ts` says
 * that action does to it.
 *
 * ONE function for all four, rather than a handler each, because the rule
 * that differs between them — whether the panel closes — is not written here.
 * Four handlers each remembering to close (or not) is four chances for Copy to
 * grow a close nobody asked for, which is precisely the behaviour this ticket
 * exists to remove.
 */
async function perform(action: PanelAction): Promise<void> {
  if (busy) return;
  busy = true;
  setActionsEnabled(false);
  try {
    const ok = await run(action);
    // Only a SUCCESSFUL action closes. A failed Save leaves the panel exactly
    // as it was, with the reason in the status line — the same rule `discard`
    // already followed for a failed trash, and the reason it is safe for the
    // panel to be the only place this take exists.
    if (ok && closesPanel(action)) window.thumb.event({ kind: "done" });
  } finally {
    busy = false;
    setActionsEnabled(true);
  }
}

async function run(action: PanelAction): Promise<boolean> {
  if (action === "copy") { setStatus("Copying…"); return runExport("copy"); }
  if (action === "save") {
    setStatus("Saving…");
    const r = await window.thumb.save(dir);
    if (!r.ok) { setStatus(`Could not save: ${r.detail ?? "unknown error"}`); return false; }
    // The take has moved out of temp storage — every later call in this window
    // (reveal, trash) must use its new home. Same reason `dir` is a `let`.
    if (r.dir) dir = r.dir;
    setStatus("Saved");
    return true;
  }
  if (action === "edit") {
    const r = await window.thumb.edit(dir);
    if (!r.ok) setStatus(`Could not open the editor: ${r.detail ?? "unknown error"}`);
    return r.ok;
  }
  // trash
  window.thumb.event({ kind: "discarding" });
  const r = await window.thumb.trash(dir);
  if (!r.ok) { setStatus(`Could not delete: ${r.detail ?? "unknown error"}`); return false; }
  return true;
}
```

4. Draw only the buttons this take has, and disable the rest of the DOM rather than deleting it (a button that is absent cannot be found by a test that expects it to be absent *for a reason*):

```ts
/** Hide the actions this take does not have — see `panel-actions.ts`'s two absences. */
const available = new Set(actionsFor(take));
for (const btn of document.querySelectorAll<HTMLButtonElement>("#actions button")) {
  const action = btn.dataset.action as PanelAction;
  btn.hidden = !available.has(action);
  btn.addEventListener("click", (e) => { e.stopPropagation(); void perform(action); });
}
```

5. Keyboard paths (focus rule 4), replacing the existing `keydown` listener:

```ts
/**
 * Every action has a keyboard path (STC-392 focus rule 4).
 *
 * The accelerators are the system's own for these verbs — ⌘C, ⌘S, ⌘E — and
 * **⌘⌫ for the ✕, never a bare Delete or Backspace** (the spec's own guard,
 * decided 2026-09-16). This panel takes focus the instant it appears, over
 * whatever the user was typing into a moment earlier; a bare ⌫ bound to a
 * destructive action means a stray keystroke aimed at another app's text
 * field deletes a capture. ⌘⌫ is also what the Finder actually uses for
 * "move to Trash" — the bare key there deletes *text*, not files.
 *
 * Dispatched through `perform`, so a keyboard Save and a clicked Save are the
 * same code path and cannot disagree about whether the panel closes.
 *
 * Escape no longer closes the panel. It used to settle-and-close, which was
 * the timeout's manual equivalent; with no "close without deciding" in the
 * action table, Escape's only job left is backing out of redact mode — which
 * was always the thing someone halfway through covering an address reaches for.
 */
const KEYS: ReadonlyArray<[PanelAction, (e: KeyboardEvent) => boolean]> = [
  ["copy",  (e) => e.metaKey && e.key.toLowerCase() === "c"],
  ["save",  (e) => e.metaKey && e.key.toLowerCase() === "s"],
  ["edit",  (e) => e.metaKey && e.key.toLowerCase() === "e"],
  // ⌘⌫, never bare — see the block comment above. Both key names, because
  // Backspace is what the laptop keyboard sends and Delete is the full-size one.
  ["trash", (e) => e.metaKey && (e.key === "Backspace" || e.key === "Delete")],
];

/**
 * When this panel started accepting keys.
 *
 * The panel takes focus the instant it appears (focus rule 1), over whatever
 * the user was typing into. Keystrokes already in flight when it grabbed the
 * keyboard were aimed at the previous app and land here instead — so the first
 * `SETTLE_KEYS_MS` of the panel's life ignore input entirely. The spec calls
 * for "~300ms"; it is a constant rather than a literal because it is a
 * duration with a reason, and a second copy of it in a test would be the
 * defect this repo names five ways.
 *
 * Note this is a settling window, not a debounce: it starts once, at paint,
 * and never re-arms. A panel the user has been looking at for a minute must
 * not swallow a keystroke.
 */
const SETTLE_KEYS_MS = 300;
let keysLiveAt = Number.POSITIVE_INFINITY;   // set to `performance.now() + SETTLE_KEYS_MS` at paint

document.addEventListener("keydown", (e) => {
  // Escape is exempt: backing out of redact mode is not destructive, and a
  // user who has just started a drag they did not mean must be able to cancel
  // it in the same 300 ms.
  if (redacting && e.key === "Escape") { setRedacting(false); return; }
  if (performance.now() < keysLiveAt) return;
  for (const [action, matches] of KEYS) {
    if (!matches(e) || !available.has(action)) continue;
    e.preventDefault();
    void perform(action);
    return;
  }
});
```

Set `keysLiveAt = performance.now() + SETTLE_KEYS_MS` in the `requestAnimationFrame` callback that already sends `{ kind: "painted" }` — the same moment the window is shown and can first hold the keyboard. A `silent` panel never paints and never listens, which is correct: it has no keyboard and no user.

**Test it where it can fail.** Add to `app/test/panel-waits.e2e.test.ts` a case that dispatches `Meta+Backspace` into the panel within the first 100 ms and asserts the take is still in temp, then dispatches it again after 500 ms and asserts it is gone. A guard nobody has watched fire is indistinguishable from one that cannot fire.

6. `discard()` keeps its `"discarding"` event and its restore-on-failure, but delegates to `perform("trash")` so the swipe, the ✕, the ⌫ key and the context menu are one path. Rule 5's comment in `thumbnail.ts` already says why they must be.

- [ ] **Step 5: Rewire the preload and the menu**

`app/src/thumbnail-preload.ts`: delete `onSettle` and `deleteShot`; add

```ts
  // The three actions that CHANGE where a take lives. Each names a directory
  // and main validates it, the same rule `still:revealShot` follows: this
  // window names a take, never a path to act on.
  save: (dir: string) => ipcRenderer.invoke("panel:save", dir),
  edit: (dir: string) => ipcRenderer.invoke("panel:edit", dir),
  trash: (dir: string) => ipcRenderer.invoke("panel:trash", dir),
```

`app/src/thumbnail-menu.ts`: `buildThumbMenu(ctx)` gains `take: PanelTake` in its context and builds its action rows from `actionsFor(take)`, mapping each to a label. `save-as`, `redact` and `reveal` stay as extra rows below a separator — they are panel facilities, not take decisions, and the test above filters to the four on purpose.

- [ ] **Step 6: Run, typecheck, commit**

```
npx vitest run app/test/thumbnail-menu.test.ts app/test/thumbnail.test.ts
npm run typecheck
```
Expected: `panel:save` / `panel:edit` / `panel:trash` do not exist yet — that is Task 5. Typecheck passes (the preload's channels are strings); the e2e will not, so leave `panel-waits.e2e.test.ts` red until Task 5 and say so in the commit message.

```bash
git add app/renderer/thumbnail.html app/src/thumbnail-renderer.ts app/src/thumbnail-preload.ts app/src/thumbnail-menu.ts app/test/thumbnail-menu.test.ts
git commit -m "STC-392: one card, five actions, four keyboard paths (handlers land next)"
```

---

### Task 5: Main performs the actions, and Copy stops promoting

**Files:**
- Modify: `app/src/main.ts` — `still:export` (line ~1238), new `panel:save` / `panel:edit` / `panel:trash`, `still:reopen` (line ~1070), `captureStill`'s `presentThumbnail` call (line ~799)
- Test: `app/test/nothing-lost.e2e.test.ts`, `app/test/panel-waits.e2e.test.ts`

**Interfaces:**
- Consumes: `promotes`, `trashStyle`, `actionsFor` (Task 1); `dismissThumbnail` (Task 3).
- Produces: `panel:save` → `{ ok: boolean; dir?: string; detail?: string }`; `panel:edit` → `{ ok: boolean; detail?: string }`; `panel:trash` → `{ ok: boolean; detail?: string }`.

- [ ] **Step 1: Write the failing test for D5**

Add to `app/test/panel-waits.e2e.test.ts`:

```ts
  test("Copy does not promote — the take is still in temp afterwards", async () => {
    // STC-393's runbook flagged exactly this: every `still:export` used to
    // promote, which was right when Copy was terminal. Under "Copy stays
    // open; you may still Save — or Trash", a Copy that promoted would leave
    // a Trash pressed afterwards deleting something already in the library.
    const { win, app: launched, temp, recordings } = await launchWithPanel();
    const panel = (await launched.windows()).find((p) => p.url().includes("thumbnail.html"))!;
    await panel.click("#copy");
    await panel.waitForFunction(() => document.getElementById("status")!.textContent === "Copied");

    expect(readdirSync(temp).length).toBe(1);
    expect(readdirSync(recordings).filter((n) => !n.startsWith("."))).toEqual([]);
    // And the panel is still up — the other half of the same rule.
    expect((await launched.windows()).some((p) => p.url().includes("thumbnail.html"))).toBe(true);
  }, 40_000);

  test("Save promotes, and closes the panel", async () => {
    const { launched, temp, recordings } = await launchWithPanel();
    const panel = (await launched.windows()).find((p) => p.url().includes("thumbnail.html"))!;
    await panel.click("#save");
    await sleep(2_000);

    expect(readdirSync(temp)).toEqual([]);
    expect(readdirSync(recordings).filter((n) => !n.startsWith("."))).toHaveLength(1);
    expect((await launched.windows()).some((p) => p.url().includes("thumbnail.html"))).toBe(false);
  }, 40_000);
```

Factor the launch in Step 1 of Task 3 into a `launchWithPanel()` helper in the same file and use it from all three tests — one fixture, not three copies.

- [ ] **Step 2: Run and watch it fail**

```
npx vitest run app/test/panel-waits.e2e.test.ts
```
Expected: FAIL — Copy promotes, and `#save` has no handler.

- [ ] **Step 3: Narrow `still:export`'s promotion to a file write**

At `app/src/main.ts:1238`, replace the promote block's condition:

```ts
  // The decision point, narrowed by STC-392 (D5). It used to be "every
  // `still:export` call is a keep", which was true while Copy was terminal.
  // The panel now stays open after a Copy so the user can still Save — or
  // Trash — and a Copy that had promoted would leave that Trash deleting
  // something already sitting in the library.
  //
  // `req.target.file` is the predicate, not an action name: this handler is
  // reached by the panel, the main window and the editor alike, and "does
  // this export write a file" is the one question all three can answer.
  // Save As is a file write and so promotes, which is correct — it is a save
  // that asks first, not a different outcome.
  let dir = req.dir && insideCaptureRoot(process.env, req.dir) ? req.dir : undefined;
  if (dir && req.target.file) {
    try { dir = await promoteTake(process.env, dir); }
    catch (e) {
      console.error("[still] could not move the shot into the library:", dir, e);
    }
  }
```

- [ ] **Step 4: Add the three handlers**

Beside `still:deleteShot` in `main.ts`:

```ts
/**
 * The panel's three take-moving actions (STC-392).
 *
 * Separate from `still:export` on purpose: that handler answers "turn these
 * pixels into a file or a clipboard entry", which the editor and the main
 * window ask too. These three answer "what happens to this TAKE", which only
 * the panel asks — and each of them is reached by four different gestures in
 * the panel (a button, a key, the context menu, and for trash a swipe), so a
 * single handler each is what keeps those four from drifting.
 *
 * Every one validates the directory against the capture roots before it acts.
 * The renderer names a take; it never hands main a path to act on.
 */
ipcMain.handle("panel:save", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideCaptureRoot(process.env, dir)) {
    return { ok: false, detail: "not a take this app wrote" };
  }
  try {
    const promoted = await promoteTake(process.env, dir);
    dismissThumbnail(dir);
    return { ok: true, dir: promoted };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
});

/**
 * Edit promotes first, and not as a convenience: `editor:open` refuses any
 * path outside the recordings root, so a take in temp storage cannot be
 * opened at all. The editor's own Save is about the EXPORT — the ticket's
 * "you may only be trimming" — not about whether the take is kept, which is
 * what this promote settles.
 */
ipcMain.handle("panel:edit", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideCaptureRoot(process.env, dir)) {
    return { ok: false, detail: "not a take this app wrote" };
  }
  try {
    const promoted = await promoteTake(process.env, dir);
    openEditor({ dir: promoted, name: basename(promoted),
                 dist: here, rendererDir: join(here, "..", "renderer") });
    dismissThumbnail(dir);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
});
```

`panel:trash` lands in Task 6 with the undo window. For now, wire it to the existing behaviour so this task's tests can pass:

```ts
ipcMain.handle("panel:trash", async (_e, dir: string) => {
  // The undo window is Task 6; this is the straight-to-Trash behaviour the
  // swipe already had, so the action works from the moment its button exists.
  if (typeof dir !== "string" || !insideCaptureRoot(process.env, dir)) {
    return { ok: false, detail: "not a take this app wrote" };
  }
  if (!existsSync(dir)) { dismissThumbnail(dir); return { ok: true }; }
  try {
    await shell.trashItem(dir);
    dismissThumbnail(dir);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
});
```

- [ ] **Step 5: Tell the panel what it is showing**

At `main.ts:799`, `presentThumbnail` loses `timeoutMs`/`settleAction` and gains the take:

```ts
      presentThumbnail({
        dir, shot: r.shot, take: { kind: "shot", origin: "fresh" },
        corner: thumbnail.corner,
        dist: here, rendererDir: join(here, "..", "renderer"),
        ...(thumbnail.skip ? { silent: true } : {}),
      });
```

and at `main.ts:1076` (`still:reopen`), `take: { kind: "shot", origin: "library" }` replaces `settleAction: "none"` — the same distinction, said in the vocabulary the rest of the panel now uses. `thumbnail-window.ts` passes `take` through as a query param; `thumbnail-renderer.ts` parses it beside `corner`.

- [ ] **Step 6: Run everything, then commit**

```
npm run typecheck
npx vitest run app/test
```
Expected: PASS. `nothing-lost.e2e.test.ts` will fail on its "ignoring it still writes" claim — rewrite that claim to the new one (the take is in temp and recovery would find it), do not loosen it.

```bash
git add app/src/main.ts app/test/panel-waits.e2e.test.ts app/test/nothing-lost.e2e.test.ts
git commit -m "STC-392: main performs the panel's actions, and Copy no longer promotes"
```

---

### Task 5b: The stack caps at three, and nothing is dropped (D7)

**Files:**
- Modify: `app/src/thumbnail.ts` — `MAX_STACKED` 5 → 3; add `visibleCount`/`hiddenCount` helpers
- Modify: `app/src/thumbnail-window.ts` — overflow no longer settles; `restack` hides past the cap
- Modify: `app/renderer/thumbnail.html`, `app/src/thumbnail-renderer.ts` — the `+N` badge and its list
- Test: `app/test/thumbnail.test.ts`, `app/test/panel-waits.e2e.test.ts`

**Interfaces:**
- Consumes: `MAX_STACKED`, `stackPosition` (Task 2).
- Produces: `hiddenCount(total: number): number`; `presentThumbnail` no longer destroys anything.

- [ ] **Step 1: Write the failing test — the eviction is the bug**

```ts
describe("the stack caps at three, and drops nothing (STC-392 D7)", () => {
  test("a fourth capture hides the oldest rather than settling it", () => {
    // THIS IS THE LOAD-BEARING HALF. `presentThumbnail` used to call
    // `settleAndDestroy()` on whatever went past the cap, which was safe only
    // because a panel HAD a default outcome — the timeout's export. STC-392
    // removed the default outcome, so the same eviction now destroys a take
    // nobody decided on. "Nothing is dropped, only hidden" is the correctness
    // half of this ticket applied to a burst of captures, not a UI nicety.
    expect(MAX_STACKED).toBe(3);
    expect(hiddenCount(3)).toBe(0);
    expect(hiddenCount(4)).toBe(1);
    expect(hiddenCount(9)).toBe(6);
  });

  test("the badge counts every panel the stack is not showing", () => {
    // The badge's number and the number of live-but-hidden panels are one
    // value. Two ways to count them would be the defect; `hiddenCount` is the
    // only one, and the renderer is handed its answer rather than deriving it.
    for (const total of [1, 3, 4, 12]) {
      expect(hiddenCount(total)).toBe(Math.max(0, total - MAX_STACKED));
    }
  });
});
```

Add an e2e that fires five captures and asserts **five** panel windows exist with three visible — the old behaviour left four windows, one of them already destroyed.

- [ ] **Step 2: Run and watch it fail**

```
npx vitest run app/test/thumbnail.test.ts
```
Expected: FAIL — `MAX_STACKED` is 5 and `hiddenCount` does not exist.

- [ ] **Step 3: Change the cap and delete the eviction**

In `thumbnail.ts`, `MAX_STACKED = 3` with its doc rewritten (the old one cites "five captures in five seconds" from STC-296's acceptance list — that number is superseded, and leaving the old justification under a new value is how a constant comes to mean nothing). Add `hiddenCount`.

In `thumbnail-window.ts`, `presentThumbnail` loses its overflow loop entirely:

```ts
export function presentThumbnail(opts: PresentOptions): void {
  panels.unshift(new ThumbnailSession(opts));
  // No eviction. Everything past the cap is HIDDEN by `restack`, not settled —
  // see `thumbnail.ts`'s MAX_STACKED doc. A panel destroyed here would be a
  // take the user never decided on, which is the one thing this ticket exists
  // to make impossible.
  restack();
}

function restack(): void {
  panels.forEach((p, i) => {
    p.moveToStackIndex(i);
    // Past the cap: alive, hidden, reachable through the badge.
    if (i >= MAX_STACKED) p.hideForOverflow(); else p.reshowFromOverflow();
  });
  // The newest panel carries the badge — it is the one on top and the one
  // with focus, so it is where a count of what is waiting belongs.
  panels[0]?.setHiddenCount(hiddenCount(panels.length));
}
```

`hideForOverflow`/`reshowFromOverflow` must not collide with `hide()`/`reshow()`, which `beforeCapture`/`afterCapture` own for a different reason — a panel hidden for a capture AND hidden for overflow must stay hidden when only one of the two lifts. Track the two reasons as separate booleans and show only when both are clear; a single flag is the bug this warns about.

- [ ] **Step 4: The badge**

A `+N` pill in the card's action row, `hidden` when N is 0. Clicking it sends `{ kind: "showOverflow" }`; main answers by bringing every hidden panel back at a stacked offset (the spec's "clicking expands a list of waiting takes with the same actions" — they are already panels with the same actions, so *expanding the stack* is the list, and no second list UI is built).

**Ruling recorded in the plan rather than left to the implementer:** the spec says "clicking expands a list of waiting takes with the same actions". A separate list window would be a second surface with a second copy of the action row — the defect this repo names five ways. Showing the hidden panels themselves *is* a list of waiting takes with the same actions, because they are the same component. If the visual result is wrong on hardware, the runbook has the item.

- [ ] **Step 5: Run, typecheck, commit**

```
npm run typecheck && npx vitest run app/test
git commit -m "STC-392: the stack caps at three, and stops destroying what it evicts"
```

---

### Task 5c: Quitting with unhandled takes (D8)

**Files:**
- Modify: `app/src/main.ts` — `before-quit`, and the `window-all-closed`/shutdown path (~line 460)
- Create: `app/src/quit-guard.ts` — the decision, Electron-free
- Test: `app/test/quit-guard.test.ts`, `app/test/quit.e2e.test.ts`

**Interfaces:**
- Consumes: `thumbnailCount()` (existing), `promoteTake` (existing).
- Produces: `quitDecision(input: { unhandled: number; systemInitiated: boolean }): "quit" | "warn"`; `QuitChoice = "save-all" | "quit-anyway" | "cancel"`.

- [ ] **Step 1: Write the failing test**

```ts
describe("quitting with takes nobody has decided on (STC-392 D8)", () => {
  test("no unhandled takes, no warning", () => {
    expect(quitDecision({ unhandled: 0, systemInitiated: false })).toBe("quit");
  });

  test("unhandled takes and a user-initiated quit warns", () => {
    expect(quitDecision({ unhandled: 2, systemInitiated: false })).toBe("warn");
  });

  test("a logout, restart or shutdown NEVER warns, however many are waiting", () => {
    // The spec's own reason: "so it never blocks the system; recovery covers
    // those takes." A modal nobody is looking at, holding up a shutdown, is a
    // worse failure than the takes it was protecting — and it is not even
    // protecting them, because Quit Anyway does not delete and recovery finds
    // them either way.
    expect(quitDecision({ unhandled: 9, systemInitiated: true })).toBe("quit");
  });
});
```

- [ ] **Step 2: Run, watch it fail, write the module**

`quit-guard.ts` is three lines of logic and a long comment explaining why the system-initiated case is not a special case but the *primary* one. Cancel is `defaultId` **and** `cancelId` — the spec names it the default, and a dialog whose Escape key does something other than its default button is its own defect.

- [ ] **Step 3: Wire it, and find out what macOS actually sends**

`app.on("before-quit", (e) => …)`. The uncertain part is `systemInitiated`: Electron's `powerMonitor` documents `shutdown` for Linux and Windows, and macOS coverage is version-dependent. **Verify what arrives on macOS 27 before building on it** — subscribe to `powerMonitor.on("shutdown")`, log it, and trigger a real logout.

If nothing distinguishes the two, the fallback is `systemInitiated: false` always — warn every time — and a runbook item saying so. A warning that occasionally appears during a logout is a smaller fault than one that blocks a shutdown, and this checkout cannot settle which happens. **Do not guess and leave it silent**: whichever way it lands, say which in a comment, because a reader six months from now cannot tell a verified answer from an assumed one.

- [ ] **Step 4: Save All**

Promotes every panel's take in turn, then quits. Failures are reported and do **not** cancel the quit — a user who chose Save All and hit a full disk must not be trapped in a dialog loop; the takes that failed stay in temp and recovery finds them, which is the same backstop Quit Anyway relies on.

- [ ] **Step 5: e2e, typecheck, commit**

Extend `app/test/quit.e2e.test.ts` (it already drives a real quit) with a stubbed dialog, the same way `crash-recovery.e2e.test.ts` stubs one — including its timing note: the stub has to land in the instant after `electron.launch()` resolves, before `firstWindow()`.

```
npm run typecheck && npx vitest run app/test
git commit -m "STC-392: quitting with unsaved takes asks, unless the system is going down"
```

---

### Task 6: The timed undo

**Files:**
- Create: `app/src/pending-trash.ts`, `app/src/toast-window.ts`, `app/src/toast-preload.ts`, `app/renderer/toast.html`
- Modify: `app/src/main.ts` — `panel:trash`, and the shutdown path (line ~460)
- Test: `app/test/pending-trash.test.ts`, `app/test/panel-waits.e2e.test.ts`

**Interfaces:**
- Consumes: `UNDO_WINDOW_MS` (Task 1).
- Produces: `class PendingTrash { promise(dir: string, at: number): void; undo(dir: string): boolean; due(now: number): string[]; all(): string[]; }`; `showUndoToast(opts): void`; `hideUndoToast(): void`.

- [ ] **Step 1: Write the failing test**

Create `app/test/pending-trash.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { PendingTrash } from "../src/pending-trash.js";
import { UNDO_WINDOW_MS } from "../src/panel-actions.js";

/**
 * The undo window as a DECISION, with an injected clock (`thumbnail.ts`'s
 * rule 2, applied to a different panel): "the undo expired" has to be
 * producible on demand rather than waited for.
 */
describe("the undo window", () => {
  test("a promised deletion is not due until the window has elapsed", () => {
    const p = new PendingTrash();
    p.promise("/t/a", 1_000);
    expect(p.due(1_000 + UNDO_WINDOW_MS - 1)).toEqual([]);
    expect(p.due(1_000 + UNDO_WINDOW_MS)).toEqual(["/t/a"]);
  });

  test("due() is a one-shot — a deletion is handed out once, never twice", () => {
    // `due` is what the caller trashes from. Returning the same directory on
    // the next tick would trash it twice: the second call sees a path that no
    // longer exists and reports a failure for something that worked.
    const p = new PendingTrash();
    p.promise("/t/a", 0);
    expect(p.due(UNDO_WINDOW_MS)).toEqual(["/t/a"]);
    expect(p.due(UNDO_WINDOW_MS + 10_000)).toEqual([]);
  });

  test("undo takes it back, and only before it is due", () => {
    const p = new PendingTrash();
    p.promise("/t/a", 0);
    expect(p.undo("/t/a")).toBe(true);
    expect(p.due(UNDO_WINDOW_MS)).toEqual([]);
    // Already handed out: there is nothing left to take back, and saying
    // otherwise would let the panel reappear for a take already in the Trash.
    p.promise("/t/b", 0);
    p.due(UNDO_WINDOW_MS);
    expect(p.undo("/t/b")).toBe(false);
  });

  test("everything still promised is nameable, for the shutdown commit", () => {
    // Quit must not leave a promised deletion in temp storage: STC-393's
    // recovery prompt would offer it back on the next launch, and the user
    // pressed delete.
    const p = new PendingTrash();
    p.promise("/t/a", 0);
    p.promise("/t/b", 0);
    expect(p.all().sort()).toEqual(["/t/a", "/t/b"]);
    p.undo("/t/a");
    expect(p.all()).toEqual(["/t/b"]);
  });

  test("promising the same take twice does not queue two deletions", () => {
    const p = new PendingTrash();
    p.promise("/t/a", 0);
    p.promise("/t/a", 5_000);
    expect(p.all()).toEqual(["/t/a"]);
    // The LATER promise decides when: the panel was reopened by an undo and
    // deleted again, and the second press is the one the user is watching.
    expect(p.due(5_000 + UNDO_WINDOW_MS - 1)).toEqual([]);
    expect(p.due(5_000 + UNDO_WINDOW_MS)).toEqual(["/t/a"]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```
npx vitest run app/test/pending-trash.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `pending-trash.ts`**

```ts
import { UNDO_WINDOW_MS } from "./panel-actions.js";

/**
 * Deletions the user has asked for and can still take back (STC-392).
 *
 * ## Why the deletion is DEFERRED rather than undone
 *
 * `shell.trashItem` has no inverse — nothing in Node or Electron can pull a
 * file back out of the Trash, and asking the user to do it in the Finder is
 * not an undo. So the ✕ does not trash anything: it PROMISES to, closes the
 * panel, and puts up a toast. The promise is kept when the window elapses.
 * Undo simply breaks it, and nothing was ever moved.
 *
 * The user cannot tell the difference — the panel is gone either way — and it
 * is the only version of "timed undo toast" that is honest about what the
 * filesystem can do.
 *
 * ## Why quitting KEEPS the promise
 *
 * A promised deletion still sitting in temp storage when the app quits would
 * be found by STC-393's recovery prompt on the next launch and offered back
 * as an unsaved take — the app handing someone a thing they deleted eight
 * seconds before they quit. So `all()` exists, and `main.ts`'s shutdown
 * commits every outstanding promise before the recovery path can ever see
 * them. The direction that fails safe here is honouring the delete, not
 * resurrecting it.
 *
 * ## Electron-free, and the clock is a parameter
 *
 * The same split `thumbnail.ts`/`thumbnail-window.ts` makes, and the same
 * rule: `due` takes `now` rather than reading a clock, so "the undo expired"
 * is producible in a test rather than waited for.
 */
export class PendingTrash {
  /** dir → the moment the promise was made. */
  private readonly promised = new Map<string, number>();

  /**
   * The user pressed ✕. Nothing is moved yet.
   *
   * A second promise for the same take REPLACES the first rather than queuing
   * beside it: the path there is an undo followed by another delete, and the
   * window the user is watching is the one that started with the second press.
   */
  promise(dir: string, at: number = Date.now()): void {
    this.promised.set(dir, at);
  }

  /**
   * Take it back. `false` when there was nothing to take back — already
   * committed, or never promised — so a caller cannot reopen a panel for a
   * take that is already in the Trash.
   */
  undo(dir: string): boolean {
    return this.promised.delete(dir);
  }

  /**
   * Every promise whose window has elapsed, handed out ONCE.
   *
   * One-shot because this is what the caller trashes from: returning the same
   * directory on a later tick would trash it twice, and the second attempt
   * would report a failure for something that worked.
   */
  due(now: number = Date.now()): string[] {
    const out: string[] = [];
    for (const [dir, at] of this.promised) {
      if (now - at >= UNDO_WINDOW_MS) out.push(dir);
    }
    for (const dir of out) this.promised.delete(dir);
    return out;
  }

  /** Everything still outstanding — the shutdown commit's whole input. */
  all(): string[] {
    return [...this.promised.keys()];
  }
}
```

- [ ] **Step 4: Run and watch it pass**

```
npx vitest run app/test/pending-trash.test.ts
```
Expected: PASS, 5 tests. Then mutate `due` to leave entries in the map and re-run — the one-shot test must FAIL. Revert.

- [ ] **Step 5: The toast window**

`app/src/toast-window.ts` — one instance at a time, `type: PANEL_WINDOW_TYPE`, `alwaysOnTop`, positioned with `positionFor(corner, workArea, TOAST_SIZE)` so it lands where the panel it replaced was. It must **not** take focus: it is a notice, and stealing the keyboard to say "deleted" would be the panel's focus rule applied to the wrong window. `showInactive()`, deliberately, with that reason in a comment.

`app/renderer/toast.html` — the same CSP header the other renderers use, a card with `Deleted` and an `Undo` button, and a CSS-animated progress bar whose duration is set from a query param so the bar and the timer cannot disagree about the length of the window.

`app/src/toast-preload.ts` — two channels: `undo()` invokes `panel:undoTrash`, and `onExpire(cb)` for main telling it to go.

- [ ] **Step 6: Wire it into main, and commit the promise on shutdown**

`panel:trash` becomes:

```ts
ipcMain.handle("panel:trash", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideCaptureRoot(process.env, dir)) {
    return { ok: false, detail: "not a take this app wrote" };
  }
  // A take re-opened from the library is a different surface and a different
  // rule (D1): `trashStyle` says "confirm" for it, and `take:delete`'s modal
  // is what that means. Nothing is promised; the take is already kept.
  const origin = insideTempTakesRoot(process.env, dir) ? "fresh" : "library";
  if (trashStyle(origin) === "confirm") return trashWithConfirmation(dir);
  // ^ `trashWithConfirmation` is `take:delete`'s existing body (main.ts:1111)
  //   lifted into a named function and called from both handlers, NOT a second
  //   copy of the dialog: two modals asking the same question with two strings
  //   is exactly the "one value, two copies" defect. Extract it in this step.

  pendingTrash.promise(dir);
  dismissThumbnail(dir);
  showUndoToast({ dir, corner: readSettings(app.getPath("userData")).thumbnail.corner,
                  dist: here, rendererDir: join(here, "..", "renderer") });
  return { ok: true };
});
```

with a single `setInterval` sweeping `pendingTrash.due()` and trashing what it hands back, `panel:undoTrash` calling `pendingTrash.undo(dir)` and re-presenting the panel when it returns `true`, and — in the `window-all-closed`/shutdown path at `main.ts:460` —

```ts
  // Every promised deletion is KEPT before we go (see pending-trash.ts). A
  // take the user deleted eight seconds ago must not be sitting in temp
  // storage for STC-393's recovery prompt to offer back on the next launch.
  await Promise.all(pendingTrash.all().map((d) =>
    shell.trashItem(d).catch((e) => console.error("[trash] could not commit:", d, e))));
```

placed **before** `closeThumbnail()`, so a panel re-presented by an undo racing the quit cannot re-promise into a list already drained.

- [ ] **Step 7: The e2e, then commit**

Add to `panel-waits.e2e.test.ts`: pressing `#trash` closes the panel and puts up the toast; pressing Undo brings the panel back and leaves the take in temp; letting the toast expire leaves temp empty. Bound the last one's wait at `UNDO_WINDOW_MS + 4_000` and set the test's own vitest timeout above that.

```
npm run typecheck && npx vitest run app/test
git add app/src/pending-trash.ts app/src/toast-window.ts app/src/toast-preload.ts app/renderer/toast.html app/src/main.ts app/test/pending-trash.test.ts app/test/panel-waits.e2e.test.ts
git commit -m "STC-392: Trash is a promise you can take back for eight seconds"
```

---

### Task 7: Ship Phase A

- [ ] **Step 1: List the repo's open PRs and recent master commits again**

```bash
gh pr list --state open --limit 20
git log origin/master --oneline -10
npm run ticket -- STC-392
```
A branch reset from master an hour ago does not know what master says now.

- [ ] **Step 2: The whole suite, and the typecheck CI runs**

```bash
npm run typecheck
npm test
```
Expected: green. Two failures are known-pre-existing on this machine and must be confirmed against unmodified master before being dismissed — `helper/test/ipc.test.ts`'s still-timeout assertion and `frame-png.e2e.test.ts` (see `docs/TICKET-LOG.md`'s STC-393 row). Reproduce them on master; if they do not reproduce, they are yours.

- [ ] **Step 3: PR**

```bash
git push -u origin HEAD
gh pr create --base master --title "STC-392 (1/2): the panel waits for a decision" --body "..."
```
Confirm a CI run exists for the PR's head SHA before watching it — `gh pr checks --watch` exits 0 when no checks exist yet. Then `npm run merge -- <pr>`, not piped through `tail`.

**Get it read before merging.** A PR nobody has read is not ready to merge just because CI is green — this repo lost that argument twice in one hour on 2026-09-09.

---

# Phase B — recordings get the panel

Second PR, on top of Phase A.

---

### Task 8: A take is a take

**Files:**
- Modify: `app/src/thumbnail-window.ts` — `PresentOptions`
- Modify: `app/src/thumbnail-renderer.ts` — the recording card
- Modify: `app/renderer/thumbnail.html` — `#takecard`'s styles
- Test: `app/test/thumbnail.test.ts`

**Interfaces:**
- Consumes: `PanelTake`, `actionsFor` (Task 1).
- Produces: `PresentOptions` becomes `{ dir; take: PanelTake; corner; dist; rendererDir; shot?: unknown; recording?: { durationMs: number; scope: string }; silent?: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
  test("a recording's panel is the same component, with a different card", () => {
    // D2: no poster frame in v1, reusing the library's own `source: "none"`
    // vocabulary. The point of the assertion is that the ACTIONS are the same
    // component's — the ticket's "stills and recordings use the same component
    // with the same behavior" — while the picture is the one thing that differs.
    expect(actionsFor({ kind: "recording", origin: "fresh" })).toContain("trash");
    expect(closesPanel("trash")).toBe(closesPanel("trash"));
  });
```

(This is thin on purpose; the real assertion for this task is the e2e in Task 10. Keep the pure test honest about what it can see rather than inflating it.)

- [ ] **Step 2: Make `shot` optional and `take` required**

In `PresentOptions`, `shot?: unknown` and a new `recording?: { durationMs: number; scope: string }`, with a doc comment saying exactly one is present and which `take.kind` implies which. Pass `take` through the load query as JSON, beside `shot`.

- [ ] **Step 3: The recording branch in the renderer**

At the top of `thumbnail-renderer.ts`, everything after `const shot = parseShot(...)` currently assumes a shot. Guard it:

```ts
const take: PanelTake = JSON.parse(params.get("take") ?? '{"kind":"shot","origin":"fresh"}');

/**
 * A recording has no picture in v1 (D2) — nothing in this app has ever
 * produced a poster frame for a take, and `library-items.ts` already says so
 * structurally with `thumbnail: { source: "none" }`. The card shows what IS
 * known: how long it ran and what it was pointed at.
 *
 * The decode that would produce a real poster is a follow-up ticket. It is
 * left out rather than approximated: a panel showing the wrong frame is worse
 * than one showing none, and pulling a 4K frame through `VideoDecoder` into an
 * always-on-top window is not a thing to do for a thumbnail.
 */
const recording = JSON.parse(params.get("recording") ?? "null") as
  { durationMs: number; scope: string } | null;

/** `0:42`, `1:07:03` — the same shape the library's own take rows use. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

if (take.kind === "recording") {
  $("thumbwrap").hidden = true;
  $("stylerow").hidden = true;
  $("takecard").hidden = false;
  // A missing `recording` block is a bug in the caller, not a reason to show
  // nothing: the panel still needs to be actionable, so the meta line is what
  // degrades, never the buttons.
  $("takemeta").textContent = recording
    ? `${formatDuration(recording.durationMs)} · ${recording.scope}`
    : "";
}
```

Before writing `formatDuration`, grep for an existing one — `app/src/library-items.ts` and `app/src/renderer.ts` both render take durations, and if either already exports this shape, import it rather than writing a third. A duration formatted two ways in two windows is the same defect as a filename built twice.

Every shot-only path — `draw`, `runExport`, `refreshDragFile`, the redact listeners, the mode picker — returns early for a recording. Do this with one `if (take.kind !== "shot") return;` at the top of each rather than by wrapping the wiring in a conditional block: a guard at the entry is greppable, and a listener that was never attached is invisible when someone asks why nothing happened.

- [ ] **Step 4: Run, typecheck, commit**

```
npm run typecheck && npx vitest run app/test/thumbnail.test.ts app/test/panel-actions.test.ts
git add app/src/thumbnail-window.ts app/src/thumbnail-renderer.ts app/renderer/thumbnail.html app/test/thumbnail.test.ts
git commit -m "STC-392: the panel can show a recording"
```

---

### Task 9: A clean stop puts up the panel instead of saving

**Files:**
- Modify: `app/src/supervisor.ts:108-155` — `promote`, `stopRecording`, `endRecording`
- Modify: `app/src/main.ts` — `recorder:stop` (line ~1003), the `recording-ended` listener (line ~232), `recorder:start` (line ~594)
- Test: `app/test/supervisor.test.ts`, `app/test/recording-panel.e2e.test.ts`

**Interfaces:**
- Consumes: `presentThumbnail` with `take: { kind: "recording", origin: "fresh" }` (Task 8).
- Produces: `HelperSupervisor` no longer promotes; `stopRecording()` and the `recording-ended` event both report the take's **temp** directory.

- [ ] **Step 1: Write the failing test**

In `app/test/supervisor.test.ts`:

```ts
  test("a clean stop no longer promotes — the panel decides now (STC-392)", async () => {
    // STC-393 put the promote here because "no recording panel exists yet
    // (STC-392), so a clean stop IS the save". The panel exists now, and a
    // stop that promoted would have kept the take before the user was asked —
    // which is exactly the side-effect the ticket forbids ("the interface
    // never deletes anything as a side effect of another action", and the same
    // reasoning in the other direction for keeping).
    const { sup, tempDir } = await startFakeRecording();
    await sup.stopRecording();
    expect(existsSync(tempDir)).toBe(true);
    expect(readdirSync(takesRoot(env)).filter((n) => !n.startsWith("."))).toEqual([]);
  });
```

Use the file's existing fake-helper harness; do not add a second one.

- [ ] **Step 2: Run and watch it fail**

```
npx vitest run app/test/supervisor.test.ts
```
Expected: FAIL — the take was promoted.

- [ ] **Step 3: Cut the promote out of the supervisor**

Delete the `promote` method, the `promoteTake` import and the `recording-promote-failed` event. `stopRecording` and `endRecording` report `dir` unchanged. Replace the method's doc with a short note saying where the decision moved and why, so the next reader does not re-add it:

```ts
  /**
   * A clean stop reports the take's directory and nothing more (STC-392).
   *
   * STC-393 promoted here, correctly for its own moment: there was no
   * recording panel, so a clean stop WAS the save. The panel exists now and
   * the take is not kept until someone presses Save or Edit on it, so
   * promoting here would decide the take's fate before it was put on screen.
   * `main.ts` presents the panel from the `recording-ended` event and from
   * `recorder:stop`, and `panel:save` is the only thing that promotes.
   */
```

Remove the `recording-promote-failed` listener at `main.ts:241` and the `recording-not-promoted` warning code it sends — a warning for a thing that no longer happens is worse than none.

- [ ] **Step 4: Present the panel from the one place a recording ends**

`main.ts`'s `recording-ended` listener (line ~232) is the single funnel — it fires for a user Stop, a display change, a stream death and a window resize alike. Present from there, not from `recorder:stop`, for the same reason STC-393 centralised the promote in the supervisor:

```ts
  sup.on("recording-ended", (i) => {
    send("helper:stopped", i);
    // STC-392: the panel is where a take's fate is decided, and this is the
    // ONE place a recording ends regardless of who asked — a Stop press, a
    // display change, a stream death, a resized window. Presenting from
    // `recorder:stop` instead would have covered only the first.
    if (!i.dir) return;
    try {
      presentThumbnail({
        dir: i.dir, take: { kind: "recording", origin: "fresh" },
        recording: { durationMs: Number(i.info?.durationMs ?? 0),
                     scope: scopeLabel(readSettings(app.getPath("userData")).scope) },
        // `scopeLabel` does not exist yet — no module in `app/src` turns a
        // `ScopeSettings` into a human string today (checked: nothing named
        // scopeLabel / labelForScope / describeScope). Add it to
        // `app/src/scope-indicator.ts`, which already owns the vocabulary for
        // what a scope points at (`resolveIndicatorTarget`), and unit-test it
        // there beside that function rather than inventing a module for one
        // string. Three cases: "Display", "Area", the window's own app name.
        corner: readSettings(app.getPath("userData")).thumbnail.corner,
        dist: here, rendererDir: join(here, "..", "renderer"),
      });
    } catch (e) {
      // Never let a panel failure cost the TAKE — it is on disk in temp
      // storage and recovery will find it, the same rule the capture path
      // has followed since STC-296.
      console.error("[thumbnail] could not present a recording:", e);
    }
  });
```

`recorder:stop`'s own handler loses its promote comment and simply returns; the event does the rest.

- [ ] **Step 5: Panels move out of the way, and come back**

At `main.ts:594`, `recorder:start` currently calls `closeThumbnail()` — settling every panel — because hiding one would leave its timer running out of sight. There is no timer now, so hiding is both possible and what focus rule 2 asks for:

```ts
  // STC-392 focus rule 2: "when a new shot or recording starts, open panels
  // move out of the way and never appear in the captured frame." This used to
  // be `closeThumbnail()` — settling them — because a hidden panel's own
  // timer would have run out of sight and the shot would have settled where
  // nobody could act on it. Nothing times out any more, so hiding is now the
  // honest answer and the panels are still there afterwards.
  //
  // Unlike a still capture there is no exclusion list for `start` to be added
  // to, so the hide is the whole mechanism rather than belt-and-braces: it
  // must complete before the helper is told to record.
  await hideThumbnailForCapture();
```

and the `recording-ended` listener calls `showThumbnailsAfterCapture()` **before** presenting the new panel, so `presentThumbnail`'s unshift puts the recording's own panel at the corner and the returning stack behind it — and focus rule 3 (`afterCapture` focuses `panels[0]`) is immediately superseded by the new panel's own focus-on-paint, which is the correct outcome and worth a comment saying so.

Every exit from `recorder:start` that returns early after the hide — `start-failed`, a thrown helper error — must reshow. Put `showThumbnailsAfterCapture()` in the `catch`, and check it against the `no-capture-target` and `capture-in-flight` returns, which happen **before** the hide and so must not.

- [ ] **Step 6: Run, typecheck, commit**

```
npm run typecheck && npx vitest run app/test/supervisor.test.ts app/test
git add app/src/supervisor.ts app/src/main.ts app/test/supervisor.test.ts
git commit -m "STC-392: a clean stop puts up the panel; the panel decides"
```

---

### Task 10: The recording panel, end to end

**Files:**
- Create: `app/test/recording-panel.e2e.test.ts`

- [ ] **Step 1: Write it**

Against `_fake-helper.mjs`, which already answers `start` and `stop`:

```ts
describe("a recording's panel (STC-392)", () => {
  test("a clean stop puts up a panel and leaves the take in temp", async () => {
    // The two halves are one claim: the panel is what keeps the take, so a
    // panel with the take already in the library would mean the Save button
    // had nothing to do and the Trash button was deleting something kept.
    const { launched, temp, recordings, win } = await launchRecording();
    await win.click("#record");
    await sleep(500);
    await win.click("#stop");
    await sleep(1_500);

    const panel = (await launched.windows()).find((p) => p.url().includes("thumbnail.html"));
    expect(panel).toBeDefined();
    // The recording card, not the canvas (D2).
    expect(await panel!.isVisible("#takecard")).toBe(true);
    expect(await panel!.isVisible("#thumbwrap")).toBe(false);
    // Copy is absent for a recording and Edit is present — the two deliberate
    // asymmetries in `panel-actions.ts`, asserted where they are visible.
    expect(await panel!.isHidden("#copy")).toBe(true);
    expect(await panel!.isVisible("#edit")).toBe(true);

    expect(readdirSync(temp).length).toBe(1);
    expect(readdirSync(recordings).filter((n) => !n.startsWith("."))).toEqual([]);
  }, 40_000);

  test("a panel on screen is not in the recording, and comes back after it", async () => {
    // Focus rule 2. There is no exclusion list for `start`, so the hide is the
    // whole mechanism — and a panel that stayed hidden afterwards would be a
    // capture silently lost, which is the failure the reshow exists for.
    const { launched, win } = await launchRecording();
    await win.click("#capturestill");
    await sleep(1_000);
    const panelBefore = (await launched.windows()).find((p) => p.url().includes("thumbnail.html"))!;
    expect(await panelBefore.evaluate(() => document.visibilityState)).toBe("visible");

    await win.click("#record");
    await sleep(800);
    expect(await panelBefore.evaluate(() => document.visibilityState)).toBe("hidden");

    await win.click("#stop");
    await sleep(1_500);
    expect(await panelBefore.evaluate(() => document.visibilityState)).toBe("visible");
  }, 40_000);
});
```

- [ ] **Step 2: Run it**

```
npx vitest run app/test/recording-panel.e2e.test.ts
```
Expected: PASS. If the second test is flaky, check `uptime` and count Electron orphans by absolute path before calling it flake — on this machine "E2E flake" is usually saturation.

- [ ] **Step 3: Commit**

```bash
git add app/test/recording-panel.e2e.test.ts
git commit -m "STC-392: the recording panel, end to end"
```

---

### Task 11: Write down what only hardware can settle

**Files:**
- Create: `docs/STC-392-RUNBOOK.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: The runbook**

One section per thing this checkout cannot answer:
- **Focus rule 1, on real hardware.** `focusPanel` has a fallback that escalates to app-level activation; STC-391's follow-up found that path raising the library. Which path does a capture-from-the-menu-bar take, and does the main window come forward?
- **Focus rule 3.** Take five shots, start a recording, stop it. Does the newest panel have the keyboard, and do ⌘S and ⌫ reach it?
- **Focus rule 2, for a recording.** Record a display with three panels up. Are they in the file? (`excludeWindowIds` does not exist for `start` — the hide is the whole mechanism.)
- **The toast.** Does "Deleted · Undo" read right, does the bar match the eight seconds, and does the toast land where the panel was on a second display?
- **The relabelled ✕.** It used to close-and-save and now deletes. Watch someone who has used the old panel press it.
- **The recording card (D2).** Is a duration and a scope line enough to tell two takes apart, or does the poster ticket need to be filed now?

- [ ] **Step 2: `CLAUDE.md` — one line, and the ticket row**

Under "Rules that bite everywhere", one compressed line:

> - **The panel is where a take's fate is decided, and nothing else decides it.** A clean stop, a timeout, an export — none of them keep or delete a take. `panel-actions.ts` owns which action promotes, which closes and which confirms; a second copy of that table is the defect (STC-392).

Then the ticket's outcome row. **Check which file that is first**: on `master` it is `CLAUDE.md`'s own ticket table; if `accounts/claudemd-scale` (e8807bc) has landed by then it is `docs/TICKET-LOG.md`. Putting it in the wrong one is a silent loss.

- [ ] **Step 3: Size budget, then commit**

```bash
npx vitest run transform/test/claude-md-size.test.ts
git add docs/STC-392-RUNBOOK.md CLAUDE.md
git commit -m "STC-392: the runbook, and one line in the constitution"
```

- [ ] **Step 4: Ship Phase B**

`gh pr create --base master --title "STC-392 (2/2): recordings get the panel"`, get it read, `npm run merge -- <pr>`. Then STC-395 (GIF/Video) is unblocked, and `actionsFor` grows one row.

---

## Self-review against the spec

| Spec line | Where |
|---|---|
| Every shot and every recording gets this panel | Task 5 (shot), Task 9 (recording) |
| Same component, same behavior | Task 8 — one window, one renderer, one action table |
| The panel never closes on its own | Tasks 2 + 3, asserted by `panel-waits.e2e.test.ts` |
| No action is preselected | Task 4 — no `autofocus`, no default button |
| Copy → clipboard, stays open | Tasks 1 (`closesPanel`), 4 (`perform`), 5 (D5) |
| GIF / Video | Out of scope (STC-395); `actionsFor` is where it lands |
| Save → library, closes | Tasks 1, 4, 5 |
| Edit → editor, its own Save | Tasks 1 (D6), 5 (`panel:edit` promotes first) |
| Trash → deletes, closes, timed undo toast | Task 6 |
| Never deletes as a side effect | Task 5's D5 change, asserted by the Copy test |
| Focus rule 1 (takes focus) | Task 3 |
| Focus rule 2 (out of the frame) | Task 9 Step 5, asserted in Task 10 |
| Focus rule 3 (newest gets focus) | Task 3's `afterCapture` |
| Focus rule 4 (keyboard paths) | Task 4's `KEYS` |
| Focus 1 guards: ⌘⌫ only, ~300ms settling window | Task 4 (`SETTLE_KEYS_MS`), asserted in `panel-waits.e2e.test.ts` |
| Stacking cap: 3 visible, +N badge, nothing dropped | Task 5b (D7) |
| Quit with unhandled takes | Task 5c (D8) |
| Copy → Trash on recordings (clonefile, 24h purge) | Deferred to STC-395 (Q1); the block is quoted into the runbook and onto STC-395 |
| Reconcile the confirm/undo conflict | D1, owned by `trashStyle` |
| Depends on temp storage | Task 5 + Task 9 — nothing promotes but Save and Edit |

**Known gaps, stated rather than hidden:** a recording has no poster (D2) and no Copy (D6); both are named follow-ups with their blocking reason attached, not oversights. `thumbnail.skip`'s silent path is untouched (D4) and never shows a panel, so "every shot gets this panel" is true of every shot the user has not explicitly opted out of.
