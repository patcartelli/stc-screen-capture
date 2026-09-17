# STC-388 Record Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the main window's sticky Scope picker with one Record flow — scope → options → Record → countdown — reachable identically from the window button, the menu-bar item and a new toggling ⌃⌥⇧⌘4 hotkey.

**Architecture:** `record` becomes a bindable action beside the four `ShotAction`s, with one ordered `BINDABLE_ACTIONS` list that `SHOT_ACTIONS` derives from. The options bar is a **second phase of the existing selection overlay**, not a window of its own, so the marquee stays live and the rect is never copied. The whole flow runs in the main process as `runRecordFlow()`, so scope reaches the helper without passing through the renderer.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Electron main + preload + renderer, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-16-stc-388-record-flow-design.md` — read it first; this plan argues from it.

## Global Constraints

- **Typechecking is THREE passes.** Always `npm run typecheck`, never bare `tsc`. A green `npx tsc --noEmit` proves one pass, not three.
- **`tsconfig.json` includes every `.ts` in the repo**, so new files get static checking automatically. Do not add an `include` entry; do check `npm run typecheck` after creating one.
- **Action ids are persisted.** `"region"`, `"window"`, `"display"`, `"self-timer"` are what `settings.json` binds against and MUST NOT be renamed. `"record"` is new and may be chosen freely — it is chosen here and then frozen.
- **`selection.ts` is not modified by this plan.** Not one line. If a task seems to need a change there, stop and escalate.
- **Every wait needs a bound and a reason** (`withTimeout(p, ms, what)`). The options phase is deliberately unbounded and must say so in a comment naming why.
- **A test asserting the OLD contract is a finding, not a test to loosen.** If an existing test fails, state the new contract; do not relax the assertion.
- **`expect(found).toEqual([])` passes just as well for a pattern that matches nothing.** Every structural guard must be watched failing against a planted violation before it counts.
- **Commit after every task.** Branch `accounts/stc-388-record-flow`; `master` is protected.
- Run from the worktree root: `/Users/pcartelli/dev/stc-screen-recorder/.claude/worktrees/stc-388`.

## Task order and why it is this order

Every task leaves the tree compiling and green. The removals come **last** on purpose: `main.ts` reads `Settings.scope` until Task 6 replaces that read, so deleting the field earlier would break the build between commits.

| # | Task | Leaves green because |
|---|---|---|
| 1 | The action model | purely additive |
| 2 | Settings learn `record` | additive; `scope` untouched |
| 3 | The tray's Record item | additive |
| 4 | `record-options.ts` | new file, nothing imports it yet |
| 5 | The overlay's options phase | `purpose` defaults to `"shot"` |
| 6 | `runRecordFlow` + toggle | the last reader of `scope` goes here |
| 7 | The renderer loses its picker | `scope` is already unread |
| 8 | The removals | nothing references them any more |
| 9 | The E2E | proves the whole flow |

---

## File Structure

**Created**
- `app/src/mic-devices.ts` — `MicInfo` and `micLabel`, lifted verbatim out of `renderer.ts`. The bar and the window's mic picker must name one device identically, and a Bluetooth suffix invented twice is CLAUDE.md's "two literals for one rule" in its worst form: two files, no typecheck across the pair.
- `app/src/record-options.ts` — the options bar's decisions. Pure: bar placement, control layout, hit-testing, the mic menu, enable rules. No DOM, no Electron. Sits beside `selection.ts` and `overlay-hittest.ts` for exactly the reason those do.
- `app/test/record-options.test.ts` — exercises it with no screen.
- `app/test/record-flow.e2e.test.ts` — the whole flow, in a real app.

**Modified**
- `app/src/hotkeys.ts` — `BINDABLE_ACTIONS` and the derived `SHOT_ACTIONS`.
- `app/src/settings.ts` — `cleanShortcuts` over the wider list; later, `scope` removed.
- `app/src/tray-menu.ts` — the Record item, and "Stop Recording".
- `app/src/overlay-session.ts` — `purpose`, the options phase, the `control` event.
- `app/src/overlay.ts` + `app/renderer/overlay.html` — drawing the bar.
- `app/src/overlay-preload.ts` — unchanged surface, new event shape flows through `send`.
- `app/src/main.ts` — `runRecordFlow`, the toggle, the widened `shortcuts:set`.
- `app/src/renderer.ts` + `app/renderer/index.html` — the picker goes; Record becomes a bare trigger.
- `app/src/preload.ts` — `pickCaptureTarget` goes.

**Deleted**
- `app/src/scope-indicator.ts`, `app/src/scope-indicator-window.ts`, `app/renderer/scope-indicator.html`
- `app/test/scope-indicator.test.ts`, `app/test/scope-indicator.e2e.test.ts` (Task 8), `app/test/scope-picker.e2e.test.ts` (Task 6, which invalidates it)

---

### Task 1: The action model — one ordered list

**Files:**
- Modify: `app/src/hotkeys.ts:35-110` (the type, the lists, the labels, the defaults), plus `ShortcutPlan`/`planShortcuts`/`explainShortcut`
- Test: `app/test/hotkeys.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BINDABLE_ACTIONS: readonly BindableAction[]`, `type BindableAction`, `type RecordAction = "record"`, `type ShotAction = Exclude<BindableAction, RecordAction>`, `isShotAction(a: BindableAction): a is ShotAction`, `SHOT_ACTIONS: readonly ShotAction[]`, `ACTION_LABELS: Record<BindableAction, string>`, `Shortcuts = Record<BindableAction, string | null>`, `DEFAULT_SHORTCUTS` with `record: "Control+Alt+Shift+Command+4"`. `ShortcutPlan.action` widens to `BindableAction`.

- [ ] **Step 1: Write the failing tests**

Append to `app/test/hotkeys.test.ts`:

```ts
describe("Record is a bindable action, not a Shot (STC-388)", () => {
  test("record is bindable but is not a shot", () => {
    expect(BINDABLE_ACTIONS).toContain("record");
    expect([...SHOT_ACTIONS] as string[]).not.toContain("record");
    expect(isShotAction("record")).toBe(false);
    for (const a of SHOT_ACTIONS) expect(isShotAction(a)).toBe(true);
  });

  test("SHOT_ACTIONS is DERIVED, so the two lists cannot disagree", () => {
    // Not a second literal: every shot action must appear in the wider list,
    // in the same relative order, and nothing else may be in it.
    expect(SHOT_ACTIONS).toEqual(BINDABLE_ACTIONS.filter((a) => a !== "record"));
    expect(new Set(BINDABLE_ACTIONS).size).toBe(BINDABLE_ACTIONS.length);
  });

  test("the four persisted shot ids are unchanged — renaming one costs a hotkey", () => {
    expect([...SHOT_ACTIONS]).toEqual(["region", "window", "display", "self-timer"]);
  });

  test("Record's default is the slot STC-391 left open", () => {
    expect(DEFAULT_SHORTCUTS.record).toBe(`${HYPER}+4`);
    expect(parseAccelerator(DEFAULT_SHORTCUTS.record!)).toEqual({
      ok: true, accelerator: `${HYPER}+4`,
    });
  });

  test("the action list and the numeric defaults cannot drift apart", () => {
    // BINDABLE_ACTIONS' order is load-bearing twice over: it is the order
    // preferences lists actions in, and the order planShortcuts resolves
    // duplicates in. The numeric defaults are a second statement of the same
    // ordering, so they are asserted to agree rather than left to drift.
    const digits = BINDABLE_ACTIONS.map((a) => {
      const acc = DEFAULT_SHORTCUTS[a];
      expect(acc, `${a} has no default binding`).toBeTruthy();
      const m = /^(.*)\+(\d)$/.exec(acc!);
      expect(m, `${a}'s default is not HYPER+<digit>: ${acc}`).not.toBeNull();
      expect(m![1]).toBe(HYPER);
      return Number(m![2]);
    });
    expect(digits).toEqual([...digits].sort((x, y) => x - y));
    expect(new Set(digits).size).toBe(digits.length);
  });

  test("every bindable action has a label, and Record's says Record", () => {
    for (const a of BINDABLE_ACTIONS) expect(ACTION_LABELS[a]).toBeTruthy();
    expect(ACTION_LABELS.record).toBe("Record");
  });

  test("planShortcuts covers record, and resolves a duplicate in list order", () => {
    const plans = planShortcuts({
      ...DEFAULT_SHORTCUTS, region: `${HYPER}+9`, record: `${HYPER}+9`,
    });
    expect(plans.map((p) => p.action)).toEqual([...BINDABLE_ACTIONS]);
    // region comes first in BINDABLE_ACTIONS, so it keeps the key.
    expect(plans.find((p) => p.action === "region")!.problem).toBeUndefined();
    expect(plans.find((p) => p.action === "record")!.problem).toBe("duplicate");
  });
});
```

Extend the import at the top of the file to add `BINDABLE_ACTIONS` and `isShotAction`.

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npx vitest run app/test/hotkeys.test.ts
```

Expected: FAIL — `BINDABLE_ACTIONS` is not exported.

- [ ] **Step 3: Implement**

Replace `app/src/hotkeys.ts` lines 35–57 (the `ShotAction` doc comment, the type and `SHOT_ACTIONS`) with:

```ts
/**
 * What a global shortcut can be bound to.
 *
 * ONE ordered list, and everything else derives from it. The order is
 * load-bearing twice: it is the order preferences lists actions in, and the
 * order `planShortcuts` resolves duplicates in (first claimant keeps the key).
 * A second hand-written list in a different order would be CLAUDE.md's
 * restated-ordering trap — "a list written in the reader's order, compared in
 * the code's order, matches nothing and looks implemented" — so `SHOT_ACTIONS`
 * is filtered from this rather than typed out again.
 *
 * `record` (STC-388) is the first member that does not produce a shot, which is
 * why the shot-only list still has to exist: `captureStill` takes a
 * `ShotAction` and the typechecker must refuse to hand it `record`.
 *
 * The VALUES are the ids `settings.json` stores bindings against. The four shot
 * ids may not be renamed without a settings migration; `record` is new here and
 * is frozen from this commit on.
 */
export const BINDABLE_ACTIONS = [
  "region", "window", "display", "record", "self-timer",
] as const;

export type BindableAction = (typeof BINDABLE_ACTIONS)[number];

/** Motion. Exactly one member, named so the shot type can Exclude it. */
export type RecordAction = "record";

/**
 * Stills (STC-398): it names the OUTCOME rather than the timing, and all four
 * produce a shot — `self-timer` after a countdown, the rest immediately.
 */
export type ShotAction = Exclude<BindableAction, RecordAction>;

export function isShotAction(a: BindableAction): a is ShotAction {
  return a !== "record";
}

/** DERIVED, never restated — see `BINDABLE_ACTIONS`. */
export const SHOT_ACTIONS: readonly ShotAction[] = BINDABLE_ACTIONS.filter(isShotAction);
```

Then, in the same file:

1. `ACTION_LABELS` becomes `Record<BindableAction, string>` and gains `record: "Record",` between `display` and `"self-timer"`, with this comment above it:

```ts
  // "Record", bare: STC-398 settled that motion keeps this word while stills
  // became "Shot", so it needs no qualifier to be unambiguous in the menu.
  record: "Record",
```

2. `Shortcuts` becomes `Record<BindableAction, string | null>`.
3. `DEFAULT_SHORTCUTS` gains, between `display` and `"self-timer"`:

```ts
  // The slot STC-391 deliberately left open, in a comment naming this ticket:
  // 1/2/3 shot, 4 records, 5 shoots on a timer — adjacent, not interleaved.
  record: `${HYPER}+4`,
```

4. `ShortcutPlan.action` becomes `BindableAction`.
5. `planShortcuts` maps over `BINDABLE_ACTIONS` instead of `SHOT_ACTIONS`.
6. `explainShortcut`'s `"duplicate"` case: change `"Another capture action already uses this."` to `"Another action already uses this."` — "capture action" no longer names the set now that Record is in it.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npx vitest run app/test/hotkeys.test.ts && npm run typecheck
```

Expected: PASS. `typecheck` will report errors in `main.ts`/`settings.ts`/`renderer.ts` only if they narrow on the old types — if it does, the fix is a `BindableAction` annotation, never a widening of `captureStill`.

- [ ] **Step 5: Watch the drift guard actually fire**

A guard nobody has seen fail is indistinguishable from one that cannot fail. Temporarily change `DEFAULT_SHORTCUTS.record` to `` `${HYPER}+9` `` and re-run:

```bash
npx vitest run app/test/hotkeys.test.ts -t "cannot drift apart"
```

Expected: FAIL (digits `[1,2,3,9,5]` are not ascending). **Revert the change** and confirm green again.

- [ ] **Step 6: Commit**

```bash
git add app/src/hotkeys.ts app/test/hotkeys.test.ts
git commit -m "STC-388: record is a bindable action, derived from one ordered list

SHOT_ACTIONS is filtered from BINDABLE_ACTIONS rather than written out a
second time, so the two orderings cannot drift; a test asserts the numeric
defaults ascend in the same order, and was watched failing against a planted
renumber. The four persisted shot ids are unchanged, so no settings migration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Settings learn the `record` binding

**Files:**
- Modify: `app/src/settings.ts:3-5` (import), `app/src/settings.ts:350-364` (`cleanShortcuts`)
- Test: `app/test/settings.test.ts`

**Interfaces:**
- Consumes: `BINDABLE_ACTIONS`, `DEFAULT_SHORTCUTS` from Task 1.
- Produces: nothing new; `readSettings(dir).shortcuts.record` is now always present.

- [ ] **Step 1: Write the failing tests**

Append to `app/test/settings.test.ts` (match the file's existing tmpdir helper — read the top of the file and reuse it rather than inventing a second one):

```ts
describe("the Record binding (STC-388)", () => {
  test("a settings file written before Record existed gains its default", () => {
    const dir = tmpSettingsDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      shortcuts: {
        region: "Control+Alt+Shift+Command+1",
        window: "Control+Alt+Shift+Command+2",
        display: "Control+Alt+Shift+Command+3",
        "self-timer": "Control+Alt+Shift+Command+5",
      },
    }));
    // Absent means "never set" and takes the default — the rule every other
    // binding already follows. An upgrade must not cost the user the feature.
    expect(readSettings(dir).shortcuts.record).toBe(DEFAULT_SHORTCUTS.record);
  });

  test("a deliberately unbound Record survives a round trip", () => {
    const dir = tmpSettingsDir();
    writeSettings(dir, { shortcuts: { ...DEFAULT_SHORTCUTS, record: null } });
    expect(readSettings(dir).shortcuts.record).toBeNull();
  });

  test("every bindable action is cleaned, not just the shots", () => {
    const dir = tmpSettingsDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ shortcuts: {} }));
    const s = readSettings(dir).shortcuts;
    for (const a of BINDABLE_ACTIONS) expect(s[a]).toBe(DEFAULT_SHORTCUTS[a]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run app/test/settings.test.ts
```

Expected: FAIL — `shortcuts.record` is `undefined`, because `cleanShortcuts` loops `SHOT_ACTIONS`.

- [ ] **Step 3: Implement**

In `app/src/settings.ts`, change the import on line 3–5 from `SHOT_ACTIONS` to `BINDABLE_ACTIONS`, and in `cleanShortcuts` change the loop:

```ts
  // BINDABLE_ACTIONS, not SHOT_ACTIONS: Record is bindable and is not a shot
  // (STC-388), and a loop over the narrower list would leave `record`
  // undefined in a Shortcuts that claims to be total.
  for (const action of BINDABLE_ACTIONS) {
```

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run app/test/settings.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/settings.ts app/test/settings.test.ts
git commit -m "STC-388: settings clean every bindable action, not just the shots

A loop over SHOT_ACTIONS left \`record\` undefined in a Shortcuts that claims
to be total. An upgraded settings.json takes the default, on the same rule
every other absent binding already follows.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The tray's Record item

**Files:**
- Modify: `app/src/tray-menu.ts:13-71`
- Modify: `app/src/main.ts` — the `installTray` callback (around line 411) and every `tray?.update(...)` call site
- Test: `app/test/tray-menu.test.ts`

**Interfaces:**
- Consumes: `BINDABLE_ACTIONS`, `ACTION_LABELS`, `isShotAction` from Task 1.
- Produces: `TrayItemId = \`action:${BindableAction}\` | "library" | "quit" | "separator"`; `TrayContext` gains `recording?: boolean`; `STOP_RECORDING_LABEL = "Stop Recording"`.

**Note on the id prefix:** it changes from `capture:` to `action:`. These ids are internal — `tray.ts` maps them straight to a callback and nothing persists them — so this is a rename, not a migration. It is worth doing because "Capture" is now the app's own name (STC-397) and `capture:record` would read as a contradiction.

- [ ] **Step 1: Write the failing tests**

Append to `app/test/tray-menu.test.ts`:

```ts
describe("Record in the menu bar (STC-388)", () => {
  const ctx = { shortcuts: DEFAULT_SHORTCUTS };

  test("every bindable action gets an item, in list order", () => {
    const ids = trayTemplate(ctx).filter((i) => i.id.startsWith("action:")).map((i) => i.id);
    expect(ids).toEqual(BINDABLE_ACTIONS.map((a) => `action:${a}`));
  });

  test("Record draws its own accelerator", () => {
    const item = trayTemplate(ctx).find((i) => i.id === "action:record")!;
    expect(item.label).toBe("Record");
    expect(item.accelerator).toBe(DEFAULT_SHORTCUTS.record);
  });

  test("mid-take the item says Stop Recording and stays clickable", () => {
    // The hotkey toggles, so the menu item must too — an item that went grey
    // the moment a take started would be the only entry point that cannot
    // stop one, which is the gap this ticket exists to close.
    const item = trayTemplate({ ...ctx, recording: true, busy: true })
      .find((i) => i.id === "action:record")!;
    expect(item.label).toBe(STOP_RECORDING_LABEL);
    expect(item.enabled).toBe(true);
  });

  test("a shot is still refused while something is in flight", () => {
    const items = trayTemplate({ ...ctx, busy: true });
    for (const a of SHOT_ACTIONS) {
      expect(items.find((i) => i.id === `action:${a}`)!.enabled).toBe(false);
    }
  });

  test("Record is refused while a SHOT is in flight — busy without recording", () => {
    const item = trayTemplate({ ...ctx, busy: true }).find((i) => i.id === "action:record")!;
    expect(item.enabled).toBe(false);
    expect(item.label).toBe("Record");
  });
});
```

Update the file's imports to add `BINDABLE_ACTIONS`, `SHOT_ACTIONS`, `STOP_RECORDING_LABEL`. Existing tests in this file that assert `capture:` ids must be updated to `action:` — that is restating the new contract, which is correct; do not add a compatibility alias.

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run app/test/tray-menu.test.ts
```

Expected: FAIL — no `action:record` item.

- [ ] **Step 3: Implement**

In `app/src/tray-menu.ts`, change the import to pull `ACTION_LABELS, BINDABLE_ACTIONS, type BindableAction, type Shortcuts`, then:

```ts
export type TrayItemId = `action:${BindableAction}` | "library" | "quit" | "separator";

export interface TrayContext {
  shortcuts: Shortcuts;
  /** A shot is already in flight (the overlay is up). Pressing another one
   * would be refused as `overlay-open`, so it is shown as unavailable instead
   * of offered and then declined. */
  busy?: boolean;
  /** A take is running. Record stays live so it can stop it (STC-388). */
  recording?: boolean;
}

/** What the Record item reads mid-take. Exported so the test and the menu
 * cannot hold two different spellings of it. */
export const STOP_RECORDING_LABEL = "Stop Recording";
```

Replace `trayTemplate`'s map:

```ts
/**
 * Every bindable action, then the way back to a window, then quit.
 *
 * `BINDABLE_ACTIONS`, not `SHOT_ACTIONS` (STC-388): Record belongs on this menu
 * beside the shots, and it is the only item whose label and enablement depend
 * on whether a take is running — because it is the only one that toggles.
 *
 * Quit is not optional decoration: with the Dock icon hidden while no window
 * is open, this menu is the only way to end the app, and an app a user cannot
 * quit is worse than one with no menu-bar item at all.
 */
export function trayTemplate(ctx: TrayContext): TrayItem[] {
  const items: TrayItem[] = BINDABLE_ACTIONS.map((action) => {
    const accelerator = ctx.shortcuts[action];
    const stopping = action === "record" && ctx.recording === true;
    return {
      id: `action:${action}` as TrayItemId,
      label: stopping ? STOP_RECORDING_LABEL : ACTION_LABELS[action],
      // Mid-take Record is the STOP control, so `busy` must not grey it out —
      // that would leave the menu bar as the one entry point that can start a
      // recording and not end it.
      enabled: stopping ? true : !ctx.busy,
      // Only when there is one: an item showing "—" where a shortcut would be
      // reads as a broken binding rather than as one nobody has set.
      ...(accelerator ? { accelerator } : {}),
    };
  });
  items.push({ id: "separator", type: "separator" });
  items.push({ id: "library", label: "Open Library" });
  items.push({ id: "separator", type: "separator" });
  items.push({ id: "quit", label: `Quit ${PRODUCT_NAME}` });
  return items;
}
```

In `app/src/main.ts`, update the `installTray` callback so the tree still compiles. `runRecordFlow` does not exist until Task 6, so route Record to a named stub that throws — a stub is acceptable here **only** because Task 6 replaces it in the same branch; it must not survive the branch.

```ts
  tray = installTray({ shortcuts, busy: capturing }, (id) => {
    if (id === "library") return openLibrary();
    if (id === "quit") return app.quit();
    const action = BINDABLE_ACTIONS.find((a) => id === `action:${a}`);
    if (!action) return;
    // STC-388 Task 6 replaces this branch with runRecordFlow("menu-bar").
    if (!isShotAction(action)) return;
    void captureStill(action, "menu-bar");
  });
```

Add `BINDABLE_ACTIONS` and `isShotAction` to main.ts's `hotkeys.js` import.

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run app/test/tray-menu.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/tray-menu.ts app/src/main.ts app/test/tray-menu.test.ts
git commit -m "STC-388: a Record item in the menu bar, which says Stop mid-take

Record is the only item that toggles, so it is the only one whose label and
enablement depend on a take being live — and \`busy\` must NOT grey it out
mid-take, or the menu bar becomes the one entry point that can start a
recording and not end it.

The item id prefix moves from capture: to action:. These ids are internal
(tray.ts maps them straight to a callback, nothing persists them), and
'capture:record' would contradict the app's own name since STC-397.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `record-options.ts` — the bar's decisions

**Files:**
- Create: `app/src/record-options.ts`
- Test: `app/test/record-options.test.ts`

**Interfaces:**
- Consumes: `Rect`, `Point`, `DisplayInfo`, `rectContains`, `pixelSize` from `selection.ts` (imported, never modified); `MicInfo`, `micLabel` from the new `mic-devices.ts`.
- Also produces: `app/src/mic-devices.ts` exporting `interface MicInfo { name: string; uid: string; bluetooth: boolean }` and `micLabel(m: MicInfo): string`.
- Produces, all used by Task 5:
  - `type ControlId = "size" | "expand" | "mic" | "camera" | "record"`
  - `CONTROL_IDS: readonly ControlId[]`
  - `interface OptionsState { micDeviceUid: string | null; camera: boolean; mics: readonly MicInfo[]; fullDisplay: boolean; micMenuOpen: boolean }` — `MicInfo` from `mic-devices.ts`, never redeclared here
  - `BAR_HEIGHT: number`, `BAR_GAP: number`, `BAR_MARGIN: number`, `barWidth(): number`
  - `interface BarLayout { rect: Rect; placement: "below" | "above" | "inside"; controls: readonly { id: ControlId; rect: Rect }[] }`
  - `barLayout(selection: Rect, display: DisplayInfo): BarLayout`
  - `controlAt(p: Point, layout: BarLayout): ControlId | undefined`
  - `controlEnabled(id: ControlId, s: OptionsState): boolean`
  - `interface MicMenuLayout { rect: Rect; items: readonly { uid: string | null; label: string; rect: Rect }[] }`
  - `micMenuLayout(layout: BarLayout, s: OptionsState, display: DisplayInfo): MicMenuLayout | undefined`
  - `micItemAt(p: Point, menu: MicMenuLayout): { uid: string | null } | undefined`
  - `expandedSelection(display: DisplayInfo): Rect`
  - `sizeLabel(selection: Rect, display: DisplayInfo): string`

- [ ] **Step 1: Write the failing tests**

Create `app/test/record-options.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import {
  BAR_GAP, BAR_HEIGHT, BAR_MARGIN, CONTROL_IDS, barLayout, barWidth,
  controlAt, controlEnabled, expandedSelection, micItemAt, micMenuLayout,
  sizeLabel, type OptionsState,
} from "../src/record-options.js";
import type { DisplayInfo, Rect } from "../src/selection.js";

/**
 * The options bar's decisions (STC-388), with no screen and no Electron — the
 * arrangement `selection.test.ts` and `overlay-hittest.test.ts` already have.
 *
 * What this file can settle: where the bar goes, which control a press lands
 * on, and what is offered. What it CANNOT settle, and the runbook therefore
 * owns: whether the bar READS well against a marquee near a screen edge.
 */

const display: DisplayInfo = {
  id: 1, bounds: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 2,
};
const options = (over: Partial<OptionsState> = {}): OptionsState => ({
  micDeviceUid: null, camera: false, mics: [], fullDisplay: false,
  micMenuOpen: false, ...over,
});
const bottom = (r: Rect) => r.y + r.height;
const right = (r: Rect) => r.x + r.width;
const overlaps = (a: Rect, b: Rect) =>
  a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);

describe("where the bar goes", () => {
  test("rule 1: below the marquee, centred on it", () => {
    const sel = { x: 400, y: 300, width: 400, height: 200 };
    const l = barLayout(sel, display);
    expect(l.placement).toBe("below");
    expect(l.rect.y).toBe(bottom(sel) + BAR_GAP);
    expect(l.rect.x + l.rect.width / 2).toBe(sel.x + sel.width / 2);
    expect(l.rect.height).toBe(BAR_HEIGHT);
    expect(l.rect.width).toBe(barWidth());
  });

  test("rule 2: flips above when below would not fit", () => {
    // A marquee whose bottom leaves less than gap + height + margin below it.
    const sel = { x: 400, y: 300, width: 400, height: 1000 - 300 - 10 };
    const l = barLayout(sel, display);
    expect(l.placement).toBe("above");
    expect(bottom(l.rect)).toBe(sel.y - BAR_GAP);
  });

  test("rule 3: neither placement overlaps the marquee", () => {
    for (const sel of [
      { x: 400, y: 300, width: 400, height: 200 },
      { x: 400, y: 300, width: 400, height: 1000 - 300 - 10 },
    ]) {
      const l = barLayout(sel, display);
      expect(l.placement).not.toBe("inside");
      expect(overlaps(l.rect, sel)).toBe(false);
    }
  });

  test("rule 4: inside ONLY when neither below nor above fits", () => {
    // A full-display marquee leaves nowhere that satisfies rule 3, so rule 3
    // cannot be absolute — the fallback is explicit rather than a bar half
    // off the screen with an unreachable Record button.
    const l = barLayout(expandedSelection(display), display);
    expect(l.placement).toBe("inside");
    expect(bottom(l.rect)).toBe(display.bounds.height - BAR_MARGIN);
  });

  test("the bar is always fully inside the display, in every placement", () => {
    for (const sel of [
      { x: 0, y: 0, width: 40, height: 40 },                  // hard top-left
      { x: 1560, y: 960, width: 40, height: 40 },             // hard bottom-right
      { x: 780, y: 0, width: 40, height: 1000 },              // full height, thin
      expandedSelection(display),
    ]) {
      const l = barLayout(sel, display);
      expect(l.rect.x).toBeGreaterThanOrEqual(BAR_MARGIN);
      expect(right(l.rect)).toBeLessThanOrEqual(display.bounds.width - BAR_MARGIN);
      expect(l.rect.y).toBeGreaterThanOrEqual(BAR_MARGIN);
      expect(bottom(l.rect)).toBeLessThanOrEqual(display.bounds.height - BAR_MARGIN);
    }
  });

  test("the bar is placed in GLOBAL points — a display at an offset moves it", () => {
    const second: DisplayInfo = {
      id: 2, bounds: { x: 1600, y: -200, width: 1280, height: 800 }, scaleFactor: 1,
    };
    const sel = { x: 1800, y: 0, width: 300, height: 200 };
    const l = barLayout(sel, second);
    expect(l.rect.x).toBeGreaterThanOrEqual(second.bounds.x + BAR_MARGIN);
    expect(right(l.rect)).toBeLessThanOrEqual(second.bounds.x + second.bounds.width - BAR_MARGIN);
  });
});

describe("the controls", () => {
  const l = barLayout({ x: 400, y: 300, width: 400, height: 200 }, display);

  test("every control is laid out, in order, inside the bar", () => {
    expect(l.controls.map((c) => c.id)).toEqual([...CONTROL_IDS]);
    for (const c of l.controls) {
      expect(c.rect.x).toBeGreaterThanOrEqual(l.rect.x);
      expect(right(c.rect)).toBeLessThanOrEqual(right(l.rect));
    }
  });

  test("controls do not overlap each other", () => {
    for (let i = 1; i < l.controls.length; i++) {
      expect(l.controls[i]!.rect.x).toBeGreaterThanOrEqual(right(l.controls[i - 1]!.rect));
    }
  });

  test("a press finds the control under it, and nothing outside the bar", () => {
    for (const c of l.controls) {
      const mid = { x: c.rect.x + c.rect.width / 2, y: c.rect.y + c.rect.height / 2 };
      expect(controlAt(mid, l)).toBe(c.id);
    }
    expect(controlAt({ x: l.rect.x - 1, y: l.rect.y - 1 }, l)).toBeUndefined();
    expect(controlAt({ x: right(l.rect) + 50, y: l.rect.y }, l)).toBeUndefined();
  });

  test("the mic control is offered only when there is a mic to offer", () => {
    expect(controlEnabled("mic", options())).toBe(false);
    expect(controlEnabled("mic", options({
      mics: [{ name: "Built-in", uid: "u", bluetooth: false }],
    }))).toBe(true);
    // Everything else is always available — Record most of all.
    for (const id of CONTROL_IDS) {
      if (id === "mic") continue;
      expect(controlEnabled(id, options())).toBe(true);
    }
  });
});

describe("the mic menu", () => {
  const mics = [
    { name: "Built-in", uid: "a", bluetooth: false },
    { name: "AirPods", uid: "b", bluetooth: true },
  ];
  const l = barLayout({ x: 400, y: 300, width: 400, height: 200 }, display);

  test("closed by default, and absent when there is nothing to list", () => {
    expect(micMenuLayout(l, options({ mics }), display)).toBeUndefined();
    expect(micMenuLayout(l, options({ micMenuOpen: true }), display)).toBeUndefined();
  });

  test("open, it lists Off first and then every device", () => {
    const menu = micMenuLayout(l, options({ mics, micMenuOpen: true }), display)!;
    expect(menu.items.map((i) => i.uid)).toEqual([null, "a", "b"]);
    expect(menu.items[0]!.label).toBe("Off");
    // The SAME label rule the window's mic picker uses — one owner, so the two
    // surfaces cannot name one device differently.
    expect(menu.items.map((i) => i.label)).toEqual(["Off", "Built-in", "AirPods (Bluetooth)"]);
  });

  test("a press picks the item under it", () => {
    const menu = micMenuLayout(l, options({ mics, micMenuOpen: true }), display)!;
    for (const item of menu.items) {
      const mid = { x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 };
      expect(micItemAt(mid, menu)).toEqual({ uid: item.uid });
    }
    expect(micItemAt({ x: menu.rect.x - 5, y: menu.rect.y - 5 }, menu)).toBeUndefined();
  });

  test("the menu stays inside the display", () => {
    const menu = micMenuLayout(l, options({ mics, micMenuOpen: true }), display)!;
    expect(menu.rect.y).toBeGreaterThanOrEqual(BAR_MARGIN);
    expect(bottom(menu.rect)).toBeLessThanOrEqual(display.bounds.height - BAR_MARGIN);
  });
});

describe("expand, and the readout", () => {
  test("expandedSelection is the display's own bounds, in global points", () => {
    expect(expandedSelection(display)).toEqual(display.bounds);
  });

  test("the readout is PIXELS, not points — it is what the file will be", () => {
    // scaleFactor 2: a 400x200 point marquee records 800x400 pixels, and the
    // number a user checks against a spec is the pixel one.
    expect(sizeLabel({ x: 0, y: 0, width: 400, height: 200 }, display)).toBe("800 × 400");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run app/test/record-options.test.ts
```

Expected: FAIL — cannot resolve `../src/record-options.js`.

- [ ] **Step 3a: Extract the mic label rule into one owner**

Create `app/src/mic-devices.ts`, moving both declarations out of `renderer.ts:7-10` and `:239-241` unchanged:

```ts
/**
 * What a microphone IS, and what it is called — the one owner of both.
 *
 * Lifted out of `renderer.ts` by STC-388, which gave the options bar a second
 * mic control. The window's picker and the bar must name one device
 * identically, and a Bluetooth suffix written out twice in two files is
 * CLAUDE.md's worst variant of the copy trap: "a filename built in the renderer
 * and looked for in main … because no typecheck can see the pair."
 */

/** STC-233. Mirrors `Watchers.enumerateDevices`'s own "mics" shape. */
export interface MicInfo {
  name: string; uid: string; bluetooth: boolean;
}

/**
 * Bluetooth is called out because it is the class of device that once stalled
 * capture and wedged CoreAudio system-wide (phase 0) — a user picking one
 * should know that is what they are picking.
 */
export function micLabel(m: MicInfo): string {
  return m.bluetooth ? `${m.name} (Bluetooth)` : m.name;
}
```

Then in `app/src/renderer.ts`, delete the local `MicInfo` interface and the local `micLabel`, and import both from `./mic-devices.js`. Nothing else in that file changes; `refreshMics` keeps working verbatim.

Confirm there is now exactly one of each:

```bash
grep -rn "bluetooth ?" app/src | grep -v mic-devices.ts || echo "one owner"
```

- [ ] **Step 3b: Implement the bar**

Create `app/src/record-options.ts`:

```ts
import { pixelSize, rectContains, type DisplayInfo, type Point, type Rect } from "./selection.js";
import { micLabel, type MicInfo } from "./mic-devices.js";

/**
 * The options bar's decisions (STC-388), with no DOM and no Electron.
 *
 * Same arrangement `selection.ts` has for the marquee and `overlay-hittest.ts`
 * for its handles: everything that DECIDES — where the bar sits, what is in it,
 * which control a press lands on, what the mic menu offers — lives here and is
 * exercised by `app/test/record-options.test.ts` without a screen, a pointer or
 * an app. `overlay.ts` draws it; it does not repeat the reasoning.
 *
 * Every rect here is in GLOBAL points, the same space `selection.ts` works in,
 * so the bar and the marquee can be compared without conversion and a bar on a
 * second display needs no special case.
 */

export type ControlId = "size" | "expand" | "mic" | "camera" | "record";

/** Left to right, as drawn. The readout first because it is the thing being
 * confirmed; Record last because it is the thing being committed to. */
export const CONTROL_IDS: readonly ControlId[] = ["size", "expand", "mic", "camera", "record"];

export interface OptionsState {
  /** Sticky (`Settings.micDeviceUid`); null is "no mic", never "the default". */
  micDeviceUid: string | null;
  /** Sticky (`Settings.camera`). */
  camera: boolean;
  /** What the mic menu can offer. Empty disables the control outright. */
  mics: readonly MicInfo[];
  /**
   * Set by the `expand` control, NEVER inferred from the marquee's geometry.
   *
   * `SelectionOutcome` has only `region` and `window` kinds, so "the whole
   * display" has no representation in it — and the two candidate encodings are
   * not equivalent downstream: `{ displayId, region }` covering the full screen
   * takes the helper's crop path, a bare `{ displayId }` takes its full-display
   * path. Deriving this from "does the rect equal the display bounds" would be
   * a second rule for one answer, and would silently reclassify someone who
   * happened to drag to the edges.
   */
  fullDisplay: boolean;
  micMenuOpen: boolean;
}

// ── the bar's geometry ──────────────────────────────────────────────────────

export const BAR_HEIGHT = 44;
/** Between the marquee's edge and the bar. */
export const BAR_GAP = 12;
/** The closest the bar or its menu may come to a display edge. */
export const BAR_MARGIN = 8;
const BAR_PADDING = 10;
const CONTROL_GAP = 8;

/** Each control's width. The bar's width is DERIVED from these, so a control
 * cannot be widened into a bar that has no room for it. */
const CONTROL_WIDTHS: Record<ControlId, number> = {
  size: 104, expand: 36, mic: 88, camera: 36, record: 92,
};
const CONTROL_HEIGHT = BAR_HEIGHT - BAR_PADDING;

/** The one place the bar's width is decided — never a literal. */
export function barWidth(): number {
  const controls = CONTROL_IDS.reduce((n, id) => n + CONTROL_WIDTHS[id], 0);
  return BAR_PADDING * 2 + controls + CONTROL_GAP * (CONTROL_IDS.length - 1);
}

export interface BarLayout {
  rect: Rect;
  /**
   * `inside` is the fallback, not a preference: a marquee covering the whole
   * display leaves nowhere that does not overlap it, so "never overlaps" cannot
   * be absolute. Named rather than silent so the view can style it.
   */
  placement: "below" | "above" | "inside";
  controls: readonly { id: ControlId; rect: Rect }[];
}

const clamp = (v: number, lo: number, hi: number): number =>
  hi < lo ? lo : Math.min(Math.max(v, lo), hi);

/**
 * Where the bar sits for a given marquee, in global points.
 *
 * Below, else above, else inside — and the choice is reported rather than
 * inferred from the numbers, so a caller cannot arrive at a different answer
 * from the same rect.
 */
export function barLayout(selection: Rect, display: DisplayInfo): BarLayout {
  const b = display.bounds;
  const width = barWidth();
  const minX = b.x + BAR_MARGIN;
  const maxX = b.x + b.width - BAR_MARGIN - width;
  const x = clamp(selection.x + selection.width / 2 - width / 2, minX, maxX);

  const below = selection.y + selection.height + BAR_GAP;
  const above = selection.y - BAR_GAP - BAR_HEIGHT;
  let y: number;
  let placement: BarLayout["placement"];
  if (below + BAR_HEIGHT <= b.y + b.height - BAR_MARGIN) {
    y = below; placement = "below";
  } else if (above >= b.y + BAR_MARGIN) {
    y = above; placement = "above";
  } else {
    // Anchored to the bottom inner edge: the marquee's own bottom is where the
    // eye already is after a drag, and it is the edge least likely to cover
    // what the user was pointing at.
    y = clamp(selection.y + selection.height - BAR_MARGIN - BAR_HEIGHT,
              b.y + BAR_MARGIN, b.y + b.height - BAR_MARGIN - BAR_HEIGHT);
    placement = "inside";
  }

  const rect: Rect = { x, y, width, height: BAR_HEIGHT };
  const controls: { id: ControlId; rect: Rect }[] = [];
  let cx = x + BAR_PADDING;
  for (const id of CONTROL_IDS) {
    const w = CONTROL_WIDTHS[id];
    controls.push({
      id, rect: { x: cx, y: y + (BAR_HEIGHT - CONTROL_HEIGHT) / 2, width: w, height: CONTROL_HEIGHT },
    });
    cx += w + CONTROL_GAP;
  }
  return { rect, placement, controls };
}

/** Which control a press landed on, or undefined for the bar's own padding
 * and everything outside it. */
export function controlAt(p: Point, layout: BarLayout): ControlId | undefined {
  if (!rectContains(layout.rect, p)) return undefined;
  return layout.controls.find((c) => rectContains(c.rect, p))?.id;
}

/**
 * A control with nothing behind it is shown disabled rather than hidden: a bar
 * that changes width depending on the machine would move Record out from under
 * the pointer between one take and the next.
 */
export function controlEnabled(id: ControlId, s: OptionsState): boolean {
  if (id === "mic") return s.mics.length > 0;
  return true;
}

// ── the mic menu ────────────────────────────────────────────────────────────

const MIC_ITEM_HEIGHT = 28;
const MIC_MENU_WIDTH = 220;

export interface MicMenuLayout {
  rect: Rect;
  items: readonly { uid: string | null; label: string; rect: Rect }[];
}

/**
 * The open mic menu, or undefined when it is closed or has nothing to list.
 *
 * Drawn by the overlay rather than opened as a native menu: this is a
 * transparent always-on-top panel, and a native popup would take key focus off
 * it — the failure 5850e4f cost us once already on the countdown.
 */
export function micMenuLayout(layout: BarLayout, s: OptionsState,
                              display: DisplayInfo): MicMenuLayout | undefined {
  if (!s.micMenuOpen || s.mics.length === 0) return undefined;
  const anchor = layout.controls.find((c) => c.id === "mic");
  if (!anchor) return undefined;

  // "Off" first, and always present: null is a real choice here, not an
  // absence — there is no automatic mic (settings.ts), so the list has to be
  // able to say so.
  const entries: { uid: string | null; label: string }[] =
    [{ uid: null, label: "Off" },
     ...s.mics.map((m) => ({ uid: m.uid, label: micLabel(m) }))];

  const b = display.bounds;
  const height = entries.length * MIC_ITEM_HEIGHT;
  const x = clamp(anchor.rect.x, b.x + BAR_MARGIN, b.x + b.width - BAR_MARGIN - MIC_MENU_WIDTH);
  // Above the bar when the bar is low, below it otherwise — the menu follows
  // the bar's own reasoning rather than inventing a second one.
  const belowBar = layout.rect.y + layout.rect.height + 4;
  const y = belowBar + height <= b.y + b.height - BAR_MARGIN
    ? belowBar
    : clamp(layout.rect.y - 4 - height, b.y + BAR_MARGIN, b.y + b.height - BAR_MARGIN - height);

  return {
    rect: { x, y, width: MIC_MENU_WIDTH, height },
    items: entries.map((e, i) => ({
      ...e,
      rect: { x, y: y + i * MIC_ITEM_HEIGHT, width: MIC_MENU_WIDTH, height: MIC_ITEM_HEIGHT },
    })),
  };
}

export function micItemAt(p: Point, menu: MicMenuLayout): { uid: string | null } | undefined {
  const hit = menu.items.find((i) => rectContains(i.rect, p));
  return hit ? { uid: hit.uid } : undefined;
}

// ── what the controls mean ──────────────────────────────────────────────────

/** What `expand` selects: the display's own bounds, in global points. */
export function expandedSelection(display: DisplayInfo): Rect {
  return { ...display.bounds };
}

/**
 * The W×H readout, in PIXELS.
 *
 * Points are what the marquee is drawn in; pixels are what the file will be,
 * and are the number anyone checks against a spec. `pixelSize` is the overlay's
 * existing conversion — used rather than re-derived, so the bar and the
 * selection chip cannot disagree about one rect.
 */
export function sizeLabel(selection: Rect, display: DisplayInfo): string {
  const { width, height } = pixelSize(selection, display);
  return `${width} × ${height}`;
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run app/test/record-options.test.ts && npm run typecheck
```

Expected: PASS, all three typecheck passes clean. If `pixelSize`'s signature differs from the call above, read it in `app/src/selection.ts:420` and adapt the call — do not change `selection.ts`.

- [ ] **Step 5: Watch the placement guards fire**

Mutate and confirm each catches something. Run after each, then revert:

1. In `barLayout`, change the `below` branch condition to `if (true)`. Expected: the "flips above" and "rule 4" tests FAIL.
2. Change `clamp(…, minX, maxX)` for `x` to just the raw centred value. Expected: "always fully inside the display" FAILS.
3. In `expandedSelection`, return `{ ...display.bounds, height: display.bounds.height - 100 }`. Expected: "inside ONLY when neither fits" FAILS.

```bash
npx vitest run app/test/record-options.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add app/src/mic-devices.ts app/src/renderer.ts \
        app/src/record-options.ts app/test/record-options.test.ts
git commit -m "STC-388: the options bar's decisions, with no screen

Pure, beside selection.ts and overlay-hittest.ts for the same reason: the bar
has real geometry (placement, edge flip, hit-testing, a drawn mic menu) and
none of it needs a display server to be checked.

Two things are deliberate rather than incidental. fullDisplay is a flag the
expand control sets, never inferred from 'does the rect match the display' —
the two encodings take different helper paths and inferring would reclassify
someone who dragged to the edges. And 'inside' is a named third placement,
because a full-display marquee leaves nowhere that does not overlap it, so
'never overlaps' cannot be absolute; each placement rule is asserted alone
and was watched failing against a planted mutation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The overlay's options phase

**Files:**
- Modify: `app/src/overlay-session.ts` (OpenOptions, OverlayResult, the session class)
- Modify: `app/src/overlay.ts` (draw the bar and the menu)
- Modify: `app/renderer/overlay.html` (the bar's elements and styles)
- Test: `app/test/overlay-options.test.ts` (new — the session's phase logic, via the pure seam)

**Interfaces:**
- Consumes: everything Task 4 produces.
- Produces: `OpenOptions.purpose?: "shot" | "record"`, `OpenOptions.initialOptions?: Pick<OptionsState,"micDeviceUid"|"camera"|"mics">`, `OverlayResult.options?: OptionsState`, and `type OverlayEvent = SelectionEvent | { t: "control"; id: ControlId } | { t: "micPick"; uid: string | null }`.

**The phase rule, stated once:**

| purpose | `reduce` yields a non-cancelled outcome | effect |
|---|---|---|
| `"shot"` | anything | finish immediately — today's behaviour, unchanged |
| `"record"`, phase `select` | region or window | advance to phase `options`, hold the outcome |
| `"record"`, phase `options` | region or window | replace the held outcome, stay in `options` |
| either | `cancelled` | finish, always |

- [ ] **Step 1: Write the failing test**

Create `app/test/overlay-options.test.ts`. It tests the phase decision as a pure function, so no Electron is needed — which means that decision must BE a pure function. Export it from `overlay-session.ts`:

```ts
import { describe, test, expect } from "vitest";
import { nextPhase } from "../src/overlay-session.js";
import type { SelectionOutcome } from "../src/selection.js";

const region: SelectionOutcome = {
  kind: "region", displayId: 1, crop: { x: 0, y: 0, width: 10, height: 10 },
  global: { x: 0, y: 0, width: 10, height: 10 },
};
const cancelled: SelectionOutcome = { kind: "cancelled" };

describe("what an outcome means, per purpose (STC-388)", () => {
  test("a shot finishes on its outcome, exactly as before", () => {
    expect(nextPhase("shot", "select", region)).toEqual({ act: "finish", outcome: region });
  });

  test("a record holds its first outcome and shows the options bar", () => {
    expect(nextPhase("record", "select", region)).toEqual({ act: "options", outcome: region });
  });

  test("re-confirming in the options phase REPLACES the held outcome", () => {
    // The marquee stays live through the options phase, so Enter after an
    // adjustment must update what would be recorded — not start a take with
    // the rect the user has just moved away from.
    expect(nextPhase("record", "options", region)).toEqual({ act: "options", outcome: region });
  });

  test("cancelled always finishes, in either purpose and either phase", () => {
    for (const p of ["shot", "record"] as const) {
      for (const ph of ["select", "options"] as const) {
        expect(nextPhase(p, ph, cancelled)).toEqual({ act: "finish", outcome: cancelled });
      }
    }
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run app/test/overlay-options.test.ts
```

Expected: FAIL — `nextPhase` is not exported.

- [ ] **Step 3: Implement the session changes**

In `app/src/overlay-session.ts`, add the imports and the pure decision:

```ts
import {
  barLayout, controlAt, expandedSelection, micItemAt, micMenuLayout,
  type ControlId, type OptionsState,
} from "./record-options.js";

export type OverlayPurpose = "shot" | "record";
export type OverlayPhase = "select" | "options";

/** Events the overlay window can send. The selection ones are `selection.ts`'s
 * own and are reduced by it; the rest belong to the options bar and are handled
 * here, which is what keeps `selection.ts` unchanged by STC-388. */
export type OverlayEvent =
  | SelectionEvent
  | { t: "control"; id: ControlId }
  | { t: "micPick"; uid: string | null };

/**
 * What an outcome means, given what the overlay was opened for.
 *
 * Pure and exported so `app/test/overlay-options.test.ts` can settle the phase
 * rule without an Electron window — the session below does no reasoning of its
 * own about it, it just does what this says.
 */
export function nextPhase(purpose: OverlayPurpose, phase: OverlayPhase,
                          outcome: SelectionOutcome):
  { act: "finish" | "options"; outcome: SelectionOutcome } {
  // Cancelled always ends it: the caller's cleanup is the same either way, and
  // a cancel that only backed out of the options bar would strand the user in
  // a selection they have already said no to.
  if (outcome.kind === "cancelled") return { act: "finish", outcome };
  if (purpose === "shot") return { act: "finish", outcome };
  // Both phases land here: the first outcome opens the bar, and a later one
  // (the marquee stays live) replaces what would be recorded.
  return { act: "options", outcome };
}
```

Extend `OpenOptions`:

```ts
  /**
   * What the overlay is being opened for (STC-388).
   *
   * `"shot"` is the historical behaviour and the default, so every still path
   * is untouched: confirm resolves. `"record"` adds a second phase — the
   * options bar, with the marquee still live — and resolves only when Record
   * is pressed.
   */
  purpose?: OverlayPurpose;
  /** The sticky options the bar opens with, and the devices it can offer. */
  initialOptions?: Pick<OptionsState, "micDeviceUid" | "camera" | "mics">;
```

Extend `OverlayResult`:

```ts
  /** Present only when `purpose` was `"record"`. */
  options?: OptionsState;
```

In the session class, add fields and initialise them in the constructor:

```ts
  private phase: OverlayPhase = "select";
  private pending: SelectionOutcome | undefined;
  private options: OptionsState;
```

```ts
    this.options = {
      micDeviceUid: opts.initialOptions?.micDeviceUid ?? null,
      camera: opts.initialOptions?.camera ?? false,
      mics: opts.initialOptions?.mics ?? [],
      fullDisplay: false,
      micMenuOpen: false,
    };
```

Replace `onEvent`:

```ts
  private onEvent = (_e: unknown, ev: OverlayEvent): void => {
    if (this.done) return;
    if (ev.t === "control") return this.onControl(ev.id);
    if (ev.t === "micPick") {
      this.options = { ...this.options, micDeviceUid: ev.uid, micMenuOpen: false };
      return this.broadcast();
    }
    const r = reduce(this.state, ev, this.ctx);
    this.state = r.state;
    if (r.outcome) {
      const next = nextPhase(this.opts.purpose ?? "shot", this.phase, r.outcome);
      if (next.act === "finish") { this.broadcast(); void this.finish(next.outcome); return; }
      this.phase = "options";
      this.pending = next.outcome;
    }
    this.broadcast();
  };

  /**
   * A press on the options bar. Only reachable in the options phase, which only
   * a `"record"` overlay ever enters.
   */
  private onControl(id: ControlId): void {
    if (this.phase !== "options") return;
    switch (id) {
      case "size":
        return;                       // a readout, not a button
      case "expand": {
        const d = this.displayForSelection();
        if (!d) return;
        // The FLAG and the rect together, in one place: a rect covering the
        // display without the flag would take the helper's crop path instead
        // of its full-display one (record-options.ts).
        this.state = { ...this.state, rect: expandedSelection(d) };
        this.options = { ...this.options, fullDisplay: true, micMenuOpen: false };
        const outcome = confirm(this.state, this.ctx);
        if (outcome) this.pending = outcome;
        return this.broadcast();
      }
      case "mic":
        if (this.options.mics.length === 0) return;
        this.options = { ...this.options, micMenuOpen: !this.options.micMenuOpen };
        return this.broadcast();
      case "camera":
        this.options = { ...this.options, camera: !this.options.camera, micMenuOpen: false };
        return this.broadcast();
      case "record": {
        const outcome = this.pending ?? confirm(this.state, this.ctx);
        // No outcome means the marquee has been dragged to nothing since the
        // bar opened. Ignored rather than finished: starting a take with no
        // target is the failure `no-capture-target` used to report, and the
        // user is one drag away from a valid one.
        if (!outcome) return;
        return void this.finish(outcome);
      }
    }
  }

  /** Which display the current marquee belongs to, for `expand`. */
  private displayForSelection(): DisplayInfo | undefined {
    const r = this.state.rect;
    if (!r) return this.ctx.displays[0];
    return dominantDisplay(r, this.ctx.displays) ?? this.ctx.displays[0];
  }
```

Add `confirm` and `dominantDisplay` and `DisplayInfo` to the `selection.js` import if not already there.

In `push`, send the phase and the bar layout so the view draws without deciding:

```ts
    const sel = this.state.rect;
    const layout = this.phase === "options" && d && sel ? barLayout(sel, d) : undefined;
    w.webContents.send("overlay:state", {
      display: d,
      displays: this.ctx.displays,
      windows: this.ctx.windows,
      state: this.state,
      preview: confirm(this.state, this.ctx),
      phase: this.phase,
      options: this.phase === "options" ? this.options : undefined,
      bar: layout,
      micMenu: layout && d ? micMenuLayout(layout, this.options, d) : undefined,
    });
```

In `finish`, include the options in the settled result:

```ts
    this.settle({
      outcome, excludeWindowIds,
      ...(this.opts.purpose === "record" ? { options: this.options } : {}),
    });
```

Finally, document the unbounded wait. Above `openOverlay`, extend the doc comment:

```ts
 * DELIBERATELY UNBOUNDED, in both phases. Every other wait in this app carries
 * a `withTimeout` and a reason, because mp4box, VideoDecoder and SCStream all
 * signal trouble by never calling back. This one waits on a PERSON: a bound
 * would mean tearing an overlay off the screen mid-drag, or starting a take the
 * user had not committed to. Escape and ⌃⌥⇧⌘4 are the ways out, and quit calls
 * `closeOverlay`, so it is bounded by the user rather than by a clock.
```

- [ ] **Step 4: Draw the bar**

In `app/renderer/overlay.html`, add inside `<body>`, after `#legend`:

```html
  <div id="bar" hidden>
    <div class="ctl" id="ctl-size"></div>
    <div class="ctl" id="ctl-expand" title="Record the whole display">⤢</div>
    <div class="ctl" id="ctl-mic">Mic: Off</div>
    <div class="ctl" id="ctl-camera" title="Camera">◉</div>
    <div class="ctl primary" id="ctl-record">Record</div>
  </div>
  <div id="micmenu" hidden></div>
```

and, in the existing `<style>` block, styles that match the file's current chip/legend look (read them and follow, rather than inventing a second visual language):

```css
  #bar { position: fixed; display: flex; align-items: center; gap: 8px;
         padding: 0 10px; border-radius: 10px; background: rgba(28,28,30,.92);
         box-shadow: 0 6px 24px rgba(0,0,0,.45); font: 13px -apple-system, system-ui; color: #fff; }
  #bar .ctl { display: flex; align-items: center; justify-content: center;
              border-radius: 6px; background: rgba(255,255,255,.10); cursor: default; }
  #bar .ctl[data-on="1"] { background: rgba(10,132,255,.85); }
  #bar .ctl[data-enabled="0"] { opacity: .4; }
  #bar .ctl.primary { background: #ff453a; font-weight: 600; }
  #micmenu { position: fixed; border-radius: 8px; background: rgba(28,28,30,.96);
             box-shadow: 0 6px 24px rgba(0,0,0,.45); overflow: hidden;
             font: 13px -apple-system, system-ui; color: #fff; }
  #micmenu .item { display: flex; align-items: center; padding: 0 10px; }
  #micmenu .item[data-on="1"]::before { content: "✓ "; }
```

In `app/src/overlay.ts`, extend `OverlayPayload` and draw. The view **positions from the payload** and decides nothing:

```ts
interface OverlayPayload {
  display?: DisplayInfo;
  displays: DisplayInfo[];
  windows: WindowInfo[];
  state: SelectionState;
  preview?: SelectionOutcome;
  /** STC-388 — absent on a shot overlay, which never leaves "select". */
  phase?: "select" | "options";
  options?: OptionsState;
  bar?: BarLayout;
  micMenu?: MicMenuLayout;
}
```

Add the imports and the element lookups:

```ts
import {
  controlAt, controlEnabled, micItemAt, sizeLabel,
  type BarLayout, type ControlId, type MicMenuLayout, type OptionsState,
} from "./record-options.js";
import { micLabel } from "./mic-devices.js";

const bar = $("bar"), micmenu = $("micmenu");
const ctl = (id: ControlId) => $(`ctl-${id}`);
```

Add a render function, called from wherever the existing state handler redraws:

```ts
/**
 * Draw the options bar (STC-388). Every rect comes from the payload already
 * decided by `record-options.ts`; this converts global points to this window's
 * local space and sets text, and does no geometry of its own.
 */
function renderBar(p: OverlayPayload): void {
  if (p.phase !== "options" || !p.bar || !p.options || !p.display) {
    bar.hidden = true; micmenu.hidden = true; return;
  }
  const l = toLocal(p.bar.rect);
  bar.hidden = false;
  bar.style.left = `${l.x}px`; bar.style.top = `${l.y}px`;
  bar.style.width = `${l.width}px`; bar.style.height = `${l.height}px`;
  for (const c of p.bar.controls) {
    const el = ctl(c.id), r = toLocal(c.rect);
    el.style.width = `${r.width}px`; el.style.height = `${r.height}px`;
    el.dataset.enabled = controlEnabled(c.id, p.options) ? "1" : "0";
  }
  const sel = p.state.rect;
  ctl("size").textContent = sel ? sizeLabel(sel, p.display) : "—";
  ctl("expand").dataset.on = p.options.fullDisplay ? "1" : "0";
  ctl("camera").dataset.on = p.options.camera ? "1" : "0";
  const mic = p.options.mics.find((m) => m.uid === p.options!.micDeviceUid);
  // micLabel, not a second spelling — see mic-devices.ts.
  ctl("mic").textContent = `Mic: ${mic ? micLabel(mic) : "Off"}`;

  if (!p.micMenu) { micmenu.hidden = true; return; }
  const m = toLocal(p.micMenu.rect);
  micmenu.hidden = false;
  micmenu.style.left = `${m.x}px`; micmenu.style.top = `${m.y}px`;
  micmenu.style.width = `${m.width}px`; micmenu.style.height = `${m.height}px`;
  micmenu.replaceChildren(...p.micMenu.items.map((it) => {
    const row = document.createElement("div");
    row.className = "item";
    row.style.height = `${it.rect.height}px`;
    row.textContent = it.label;
    row.dataset.on = it.uid === p.options!.micDeviceUid ? "1" : "0";
    return row;
  }));
}
```

Route presses. In the existing `pointerdown` handler, **before** it forwards to `selection.ts`, give the bar first refusal — a press on the bar is not a press on the desktop:

```ts
  // The bar sits over the scrim, so a press on it must not also start a new
  // marquee underneath. First refusal, then the selection as before.
  if (current?.phase === "options" && current.bar) {
    const g = toGlobal(e);
    if (current.micMenu) {
      const item = micItemAt(g, current.micMenu);
      if (item) { send({ t: "micPick", uid: item.uid }); return; }
    }
    const hit = controlAt(g, current.bar);
    if (hit) {
      if (controlEnabled(hit, current.options!)) send({ t: "control", id: hit });
      return;
    }
    if (current.micMenu) { send({ t: "micPick", uid: current.options!.micDeviceUid }); return; }
  }
```

- [ ] **Step 5: Run everything and typecheck**

```bash
npx vitest run app/test/overlay-options.test.ts app/test/record-options.test.ts && npm run typecheck
```

Expected: PASS. `overlay.ts` is checked by `tsconfig.browser.json`, so a `process` reference there is a type error, by design.

- [ ] **Step 6: Confirm the shot path is untouched**

```bash
npx vitest run app/test/selection.test.ts app/test/overlay-hittest.test.ts app/test/overlay-listeners.test.ts
git diff --stat app/src/selection.ts
```

Expected: PASS, and **`selection.ts` shows zero changes**. If it has changed, revert it and escalate.

- [ ] **Step 7: Commit**

```bash
git add app/src/overlay-session.ts app/src/overlay.ts app/renderer/overlay.html app/test/overlay-options.test.ts
git commit -m "STC-388: the overlay gains an options phase, with the marquee still live

One window stack, one reducer, one broadcast — the selection rect is never
copied into a second surface, which is what a panel window would have forced
and is this codebase's most repeated defect. It also avoids a second focus
handoff of the kind 5850e4f already cost us.

The phase rule is a pure exported function (nextPhase) so it can be settled
without an Electron window; purpose defaults to 'shot', so every still path is
byte-for-byte what it was. The wait is deliberately unbounded and now says so:
it waits on a person, and a bound would mean tearing an overlay off mid-drag.

selection.ts is unchanged — the control events are handled by the session, not
folded into its reducer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `runRecordFlow`, and the toggle

**Files:**
- Modify: `app/src/main.ts` — `recorder:start` (around line 520), `applyShortcuts` (around 951), `shortcuts:set` (around 975), the tray callback from Task 3
- Test: `app/test/record-flow.e2e.test.ts` is Task 9; this task is covered by typecheck plus the existing suites staying green

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `runRecordFlow(source: RecordSource): Promise<RecordResult>` in `main.ts` (not exported — `main.ts` is the app's entry, and the three doors are all inside it).

- [ ] **Step 1: Write `runRecordFlow`**

Add above the existing `recorder:start` handler in `app/src/main.ts`:

```ts
type RecordSource = "window" | "menu-bar" | "hotkey";
type RecordResult =
  | { ok: true; dir: string; info: unknown }
  | { ok: false; cancelled: true }
  | { ok: false; code: string; detail?: string };

/**
 * Scope, then options, then a countdown, then a take (STC-388).
 *
 * A FUNCTION, not just an IPC handler, for exactly the reason `captureStill`
 * already is one: the hotkey and the menu-bar item have no renderer to route
 * through, and the window's button must not be a second implementation that can
 * drift. One flow, three doors.
 *
 * Scope is chosen FRESH every time and is never persisted — the settled shape
 * of this ticket, which rejected sticky scope outright. It also keeps the
 * invariant `recorder:start` used to carry: what the helper is pointed at is
 * decided in the main process, never handed up from the renderer. The overlay
 * is main's, so the outcome is already here.
 */
async function runRecordFlow(source: RecordSource): Promise<RecordResult> {
  if (!sup) return { ok: false, code: "no-supervisor" };
  // A shot in flight owns the overlay, the countdown panel and the helper's
  // attention. Refused with something to read rather than left to race.
  if (capturing || overlayIsOpen() || countdownIsOpen()) {
    return { ok: false, code: "capture-in-flight" };
  }
  if (sup.state === "recording") return { ok: false, code: "already-recording" };

  let windows: WindowInfo[] = [];
  try {
    windows = windowsFromReply(await sup.listWindows());
  } catch {
    // Without a Screen Recording grant the helper cannot enumerate anything.
    // Area mode needs no window list, so the overlay still opens; window mode
    // will offer nothing to click, same as a shot.
  }

  const stored = readSettings(app.getPath("userData"));
  const mics = await micsForBar();

  // The flag covers the overlay AND the countdown, because ⌃⌥⇧⌘4 must be able
  // to cancel either — and it is cleared in a `finally` so a throw anywhere
  // inside cannot leave the hotkey believing a flow is still up.
  recordFlowActive = true;
  try {
    return await recordFlowBody(source, stored, mics, windows);
  } finally {
    recordFlowActive = false;
  }
}

/** The flow proper. Split out so `recordFlowActive` has exactly one `finally`
 * covering every step it needs to cover. */
async function recordFlowBody(
  source: RecordSource, stored: Settings, mics: MicInfo[], windows: WindowInfo[],
): Promise<RecordResult> {
  const { outcome, options } = await openOverlay({
    windows, mode: "region", purpose: "record",
    initialOptions: { micDeviceUid: stored.micDeviceUid, camera: stored.camera, mics },
    dist: here, renderer: join(here, "..", "renderer"),
  });
  if (outcome.kind === "cancelled" || !options) return { ok: false, cancelled: true };

  // The bar's toggles ARE the sticky settings, so they are written back — only
  // SCOPE is per-take. Written before the countdown, so a cancelled countdown
  // still keeps a mic the user just chose.
  writeSettings(app.getPath("userData"),
                { camera: options.camera, micDeviceUid: options.micDeviceUid });

  const startParams: Record<string, unknown> = { camera: options.camera };
  if (options.micDeviceUid != null) startParams.micDeviceUid = options.micDeviceUid;
  let countdownDisplay: number | undefined;
  if (outcome.kind === "window") {
    startParams.windowId = outcome.windowId;
  } else {
    startParams.displayId = outcome.displayId;
    countdownDisplay = outcome.displayId;
    // `region` ONLY when this is not a full-display take: a crop covering the
    // whole screen takes the helper's crop path instead of its full-display
    // one. One expression, so the two paths cannot be chosen by two rules.
    if (!options.fullDisplay) startParams.region = { ...outcome.crop };
  }

  // Record ALWAYS counts down (STC-391) — it is what makes Record feel weightier
  // than a shot. After the overlay has gone, never during it.
  const ms = clampCountdownMs(stored.countdownMs);
  if (needsCountdown(ms)) {
    const counted = await runCountdown({
      ms, purpose: "record", displayId: countdownDisplay,
      dist: here, rendererDir: join(here, "..", "renderer"),
    });
    if (!countdownFired(counted.outcome)) return { ok: false, cancelled: true };
  }

  // Any floating panel still on screen would be IN the take, and unlike a shot
  // there is no exclusion list for `start` to be added to. SETTLED rather than
  // hidden, the same call quit makes.
  await closeThumbnail().catch(() => {});

  const root = tempTakesRoot(process.env);
  const existing = existsSync(root) ? readdirSync(root) : [];
  const dir = newTempTakeDir(process.env, new Date(), existing);
  try {
    const r = await sup.startRecording(dir, startParams);
    console.log(`[record] started from ${source}`);
    return { ok: true, dir, info: r };
  } catch (e: any) {
    return { ok: false, code: e?.code ?? "start-failed",
             detail: e?.detail ?? String(e?.message ?? e) };
  }
}
```

Add the module-level flag beside the other flow state (`capturing`, etc.):

```ts
/**
 * Whether the overlay/countdown currently on screen belongs to a RECORD flow.
 *
 * ⌃⌥⇧⌘4 cancels its own flow but must NOT cancel a shot's overlay or a
 * self-timer's countdown — ending someone's self-timer with the Record key is
 * not what "Record toggles" means, and that possibility is new (STC-388 makes a
 * latent hazard reachable: nothing could interrupt an in-flight capture from a
 * hotkey before).
 */
let recordFlowActive = false;
```

And the mic list helper, near `windowsFromReply`:

```ts
/**
 * The mics the bar can offer.
 *
 * `sup.devices()` — the SAME call the window's mic picker already makes through
 * `recorder:devices`, and the same `mics` shape it already reads. A second
 * enumeration with its own field names would be two answers to one question.
 *
 * Failure is not fatal and is not reported: an empty list disables the control,
 * which is exactly what "no mic available" should look like, and a modal about
 * it would sit between the user and a recording they asked for.
 */
async function micsForBar(): Promise<MicInfo[]> {
  try {
    const r = await sup!.devices();
    const mics = (r as { mics?: unknown }).mics;
    return Array.isArray(mics) ? mics as MicInfo[] : [];
  } catch {
    return [];
  }
}
```

Import `MicInfo` from `./mic-devices.js` in `main.ts`. Note `devices()` can answer `{ stalled: true }` — the picker already tolerates that, and so does this: `mics` is simply absent and the control disables.

- [ ] **Step 2: Replace `recorder:start` with a door onto it**

```ts
/**
 * The window's Record button. Carries NO parameters — see `runRecordFlow`: what
 * the helper is pointed at is main's to decide, and the renderer supplying any
 * of it would be a second source of truth for what turns on a camera.
 */
ipcMain.handle("recorder:start", async () => runRecordFlow("window"));
```

Delete the old body wholesale, including its `readSettings` scope read, the `scope.kind` branches and the `no-capture-target` refusal. Leave `Settings.scope` itself alone — Task 8 removes it.

- [ ] **Step 3: Wire the hotkey toggle and the tray**

In `applyShortcuts`, replace the registration callback:

```ts
      ok = globalShortcut.register(plan.accelerator, () => {
        if (plan.action === "record") return void onRecordHotkey();
        if (isShotAction(plan.action)) void captureAndAnnounce(plan.action, "hotkey");
      });
```

Add, near `captureAndAnnounce`:

```ts
/**
 * ⌃⌥⇧⌘4 — one key, three meanings, in priority order (STC-388).
 *
 * Stop first: mid-take is the state where a dead key would be worst, and it is
 * the gap the ticket exists to close ("no hotkey can stop a recording").
 * Cancel second, and ONLY our own flow — see `recordFlowActive`.
 */
async function onRecordHotkey(): Promise<void> {
  if (sup?.state === "recording") {
    await sup.stopRecording().catch((e) => console.error("[record] stop failed:", e));
    return;
  }
  if (recordFlowActive) {
    // Whichever of the two is up; both are no-ops when they are not.
    cancelCountdown();
    await closeOverlay().catch(() => {});
    return;
  }
  const r = await runRecordFlow("hotkey");
  if (!r.ok && !("cancelled" in r)) console.error(`[record] ${r.code}`, r.detail ?? "");
}
```

Update the tray callback from Task 3, replacing the stub:

```ts
    if (action === "record") {
      if (sup?.state === "recording") { void onRecordHotkey(); return; }
      void runRecordFlow("menu-bar");
      return;
    }
    if (isShotAction(action)) void captureStill(action, "menu-bar");
```

Make the tray reflect the take. Find every `tray?.update({ shortcuts, busy: capturing })` and add `recording: sup?.state === "recording"`, and add a `tray?.update(...)` where the supervisor's state changes (the supervisor already emits for the pill — reuse that listener rather than adding a poll).

- [ ] **Step 4: Widen `shortcuts:set`**

```ts
ipcMain.handle("shortcuts:set", async (_e, action: BindableAction, accelerator: string | null) => {
  if (!BINDABLE_ACTIONS.includes(action)) throw new Error(`unknown action: ${action}`);
```

- [ ] **Step 5: Delete the test this task invalidates**

```bash
git rm app/test/scope-picker.e2e.test.ts
```

`scope-picker.e2e.test.ts` drives `recorder:pickCaptureTarget` and asserts that the Record button records the sticky scope it picked. This task is what makes that false, so this task is what removes it — leaving it to Task 8 would mean three commits in a row with a red suite, and a test asserting the OLD contract is a finding, not something to carry. Its replacement is Task 9.

- [ ] **Step 6: Typecheck and run the full suite**

```bash
npm run typecheck && npm test
```

Expected: three typecheck passes clean, and the whole suite **green**. If anything else fails, it is a real regression in this task — do not defer it to Task 8.

- [ ] **Step 7: Commit**

```bash
git add -A app/src/main.ts app/test/scope-picker.e2e.test.ts
git commit -m "STC-388: one Record flow in main, with three doors and a toggling hotkey

recorder:start now carries no parameters at all. Scope is chosen fresh in an
overlay main already owns, so what the helper is pointed at is still decided
here and never handed up from the renderer — a stronger position than the
comment that invariant used to need.

region is sent ONLY when the take is not full-display: a crop covering the
whole screen would take the helper's crop path rather than its full-display
one, and the flag decides it in one expression rather than two rules.

The hotkey stops, cancels, or starts, in that order — and cancels only a
Record flow. Nothing could interrupt an in-flight capture from a hotkey
before, so 'cancel' is a newly reachable path; ending someone's self-timer
with the Record key is not what Record toggling means.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The renderer loses its Scope picker

**Files:**
- Modify: `app/src/renderer.ts:21-41` (the view types), `:294-420` (the picker), `:520-545`, `:630-645`
- Modify: `app/renderer/index.html` — the scope `<select>`, the source rows and the clear buttons
- Modify: `app/src/preload.ts` — drop `pickCaptureTarget`
- Test: existing E2E suites must stay green

- [ ] **Step 1: Remove the picker from the renderer**

In `app/src/renderer.ts`, delete: `ScopeSettingsView`, the `scope` field on the settings view interface, `scopeSel`, `currentScope`, `scopeHasTarget`, `renderScope`, the `scopeSel` change listener, the pick handlers, and `pickCaptureTarget` from the `recorder` bridge type.

The Record button's enablement loses its scope precondition. Replace both sites that read `scopeHasTarget()`:

```ts
  // No precondition left to check (STC-388): Record opens the scope overlay
  // itself, so there is nothing that can be unset when the button is pressed.
  // It is disabled only while a take is running, which `setRecording` owns.
  if (!recording) recordBtn.disabled = false;
```

In `setRecording`/`locked`, remove `scopeSel.disabled = locked;` and the clear-button lines.

Where the shortcuts editor iterates actions, change `CAPTURE_ACTIONS`/`SHOT_ACTIONS` to `BINDABLE_ACTIONS` so a Record row appears. Check its import at `renderer.ts:91`.

- [ ] **Step 2: Remove the markup**

In `app/renderer/index.html`, delete the `#scope` `<select>`, its label, the window/region source rows (`#windowSourceLabel`, `#regionSourceLabel`), and `#clearWindowBtn` / `#clearRegionBtn`. Grep afterwards to be sure nothing still looks them up:

```bash
grep -rn "scopeSel\|clearWindowBtn\|clearRegionBtn\|regionSourceLabel\|windowSourceLabel\|pickCaptureTarget" app/src app/renderer app/test
```

Expected: matches only in `main.ts` (`recorder:pickCaptureTarget`, removed in Task 8) and in `scope-picker.e2e.test.ts` (deleted in Task 8).

- [ ] **Step 3: Remove the bridge**

In `app/src/preload.ts`, delete the `pickCaptureTarget` entry from the exposed `recorder` object.

- [ ] **Step 4: Build and run the app suites**

```bash
npm run typecheck && npx vitest run app/test/shell.e2e.test.ts app/test/legibility.e2e.test.ts
```

Expected: PASS. If a legibility test asserts the Scope control exists, that assertion is the old contract — restate it, do not preserve the control.

- [ ] **Step 5: Commit**

```bash
git add app/src/renderer.ts app/renderer/index.html app/src/preload.ts
git commit -m "STC-388: the main window's Record button is a bare trigger

The sticky Scope picker goes: scope is chosen fresh in the overlay on every
take, so there is no precondition left for the button to check and nothing
that can be unset when it is pressed. The shortcuts editor iterates
BINDABLE_ACTIONS, so Record gets a rebindable row like every other action.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The removals

**Files:**
- Modify: `app/src/settings.ts` — drop `ScopeSettings`, `ScopeRegion`, `DEFAULT_SCOPE_SETTINGS`, `cleanScope`, the `scope` field and both call sites
- Modify: `app/src/main.ts` — drop `pickCaptureTarget`, `recorder:pickCaptureTarget`, every `flashScopeIndicator`/`hideScopeIndicator` call and their import, `countdownDisplayFor`
- Delete: `app/src/scope-indicator.ts`, `app/src/scope-indicator-window.ts`, `app/renderer/scope-indicator.html`, `app/test/scope-indicator.test.ts`, `app/test/scope-indicator.e2e.test.ts` (`scope-picker.e2e.test.ts` is already gone — Task 6 removed it, being the change that invalidated it)
- Test: `app/test/settings.test.ts` gains the stray-key test

- [ ] **Step 1: Write the failing test**

Append to `app/test/settings.test.ts`:

```ts
test("a settings file from before STC-388 keeps a stray scope key, harmlessly", () => {
  // readSettings builds a fresh document field by field, so a key nothing
  // reads is simply never read — there is nothing to migrate, and a rollback
  // finds its own data intact.
  const dir = tmpSettingsDir();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    camera: true,
    scope: { kind: "window", windowId: 42, windowLabel: "Safari — x", region: null },
  }));
  const s = readSettings(dir);
  expect(s.camera).toBe(true);
  expect((s as Record<string, unknown>).scope).toBeUndefined();
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run app/test/settings.test.ts -t "stray scope key"
```

Expected: FAIL — `scope` is still a field.

- [ ] **Step 3: Delete**

```bash
git rm app/src/scope-indicator.ts app/src/scope-indicator-window.ts \
       app/renderer/scope-indicator.html \
       app/test/scope-indicator.test.ts app/test/scope-indicator.e2e.test.ts
```

In `app/src/settings.ts`: delete `ScopeRegion`, `ScopeSettings`, `DEFAULT_SCOPE_SETTINGS`, `cleanScope`, the `scope` field on `Settings` and its long doc comment, `scope:` in `DEFAULT_SETTINGS`, `scope: cleanScope(doc.scope)` in `readSettings`, and both `scope:` lines in `writeSettings`.

In `app/src/main.ts`: delete the `scope-indicator-window.js` import, `pickCaptureTarget`, the `recorder:pickCaptureTarget` handler, `countdownDisplayFor` (the flow now names its display directly), and every `flashScopeIndicator`/`hideScopeIndicator` call — including the one in the quit path and the one guarded on `clean.scope` in the settings handler.

- [ ] **Step 4: Verify nothing is left**

```bash
grep -rn "scope-indicator\|flashScopeIndicator\|hideScopeIndicator\|ScopeSettings\|cleanScope\|pickCaptureTarget\|no-capture-target\|countdownDisplayFor" app/ scripts/ || echo "clean"
npm run typecheck && npm test
```

Expected: `clean`, three typecheck passes, and the whole suite green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "STC-388: remove the sticky scope, and retire STC-381 with it

Settings.scope is gone, not just unread: an old settings.json keeps a stray
key that readSettings never looks at, so there is nothing to migrate and
nothing left to drift.

STC-381's indicator is RETIRED rather than unwired. This ticket asked whether
it still makes sense once scope is chosen fresh on every take; it does not —
the marquee was on screen a moment earlier and the countdown is about to be,
so a third confirmation between them is noise. Its own runbook already found
that showing it persistently read as naggy; showing it redundantly is the
same finding one step further on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The end-to-end flow

**Files:**
- Create: `app/test/record-flow.e2e.test.ts`

**Read first:** `app/test/still-overlay.e2e.test.ts` and `app/test/countdown.e2e.test.ts`. Copy their harness — how the app is launched, how `STC_OVERLAY_SYNTHETIC_INPUT=1` injects pointer events, how `STC_RECORDINGS_DIR`/`STC_TEMP_TAKES_DIR` are pointed away from the Desktop, and how `app/test/_timeout-budget.ts` is used. Do not invent a second harness.

**Two constraints this file must honour:**
- **The test's own timeout must exceed every bound waiting inside it** (`bc9faaf`). Compose it from the named parts — the countdown's `ms`, the helper start budget, `HIDE_SETTLE_MS` — and assert the composition, never a round number with slack.
- **Tests must not depend on `~/Desktop/stc`.** Set both env overrides.

- [ ] **Step 1: Write the tests**

```ts
/**
 * The whole Record flow, in a real app (STC-388).
 *
 * What this settles: that the four steps happen in order, from a door that has
 * no renderer; that Escape at each step writes nothing; and that the hotkey's
 * second press stops a take. What it CANNOT settle, and the runbook owns: that
 * the bar READS well, and that the flow feels like one gesture.
 */
```

Cover, each as its own `test`:

1. **The bar appears only after a selection.** Open the flow, assert `#bar` is hidden; drag a marquee; assert `#bar` is visible and `#ctl-record` is present.
2. **Record reaches the countdown, then the helper.** Press `#ctl-record`; assert the countdown window appears; let it fire; assert the supervisor reports `recording` and a take directory exists under `STC_TEMP_TAKES_DIR`.
3. **Escape in the select phase writes nothing.** Assert the temp root's entry count is unchanged — the same property `still-overlay.e2e.test.ts` already checks for a cancelled shot.
4. **Escape in the options phase writes nothing.** The newly reachable one: the marquee exists and the bar is up, and it must still leave no directory.
5. **The marquee stays adjustable with the bar up.** Drag a handle; assert `#ctl-size`'s text changes. This is the property that justifies the bar living in the overlay at all, so it is asserted directly rather than assumed.
6. **`expand` selects the whole display**, and `#ctl-expand` reads as on.
7. **The hotkey toggles.** With a take running, fire the Record action and assert the supervisor leaves `recording`. Drive it through the same seam the hotkey E2E already uses rather than synthesising a global keypress.

- [ ] **Step 2: Run it**

```bash
npx vitest run app/test/record-flow.e2e.test.ts
```

Expected: PASS. If it is flaky, check `uptime` and count Electron orphans before calling it flake — on this machine that is usually saturation, and the tell is a pure-computation test timing out alongside the Electron suites.

- [ ] **Step 3: Full suite, then the gates**

```bash
npm run typecheck && npm test && npm run gate
```

- [ ] **Step 4: Commit**

```bash
git add app/test/record-flow.e2e.test.ts
git commit -m "STC-388: the Record flow end to end, including both cancel points

Escape in the OPTIONS phase is the newly reachable path — before this ticket
there was no state between a selection and a take — so it gets its own test
asserting nothing is written, beside the select-phase cancel that already had
one. The marquee staying adjustable with the bar up is asserted directly
rather than assumed: it is the property that justifies the bar living in the
overlay window at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Before opening the PR

- [ ] **Re-run the duplicate-work checks.** A branch cut from master hours ago does not know what master says now, and the keyed check is blind to work filed under another ticket.

```bash
npm run ticket -- STC-388
gh pr list --state open --limit 30
git log --oneline origin/master -15
```

- [ ] **Rebase onto current master and re-run the suite.**
- [ ] **File the three follow-up tickets** named in the spec's §7: system audio, show keystrokes, show-clicks toggle.
- [ ] **Write `docs/STC-388-RUNBOOK.md`** for what only hardware can settle: bar legibility near each screen edge, the `inside` placement on a full-display marquee, the mic menu's focus behaviour, and whether the flow feels like one gesture.
- [ ] **Open the PR, and get it read.** A PR nobody has read is not ready to merge just because CI is green. Then `npm run merge -- <pr>` — never piped through `tail`.
