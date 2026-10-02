# STC-488 Copy a Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recording's floating panel gets Copy. Pressing it renders the take, with cursor and zoom, to an MP4 in a copies folder, puts that file on the macOS pasteboard as a file reference, and keeps the panel open. Copies are purged after 24 h unless one is still on the clipboard.

**Architecture:** A hidden render window per job loads the take through the same guarded `preview:*` IPC the editor uses (lifted into a shared `session-io.ts`), runs the unchanged `exportSession`, and hands the bytes to main, which writes them atomically into `copiesRoot`. Main then asks the Swift helper's new `copy-file` command to put the file on the pasteboard. Pure decisions (paths, cache, purge, which actions lock during a copy) live in Electron-free modules and are unit-tested.

**Tech Stack:** Electron (main, preload, renderer), TypeScript, WebCodecs via `transform/src/export.ts`, Swift/AppKit (`NSPasteboard`), vitest, Playwright-Electron.

**Spec:** `docs/superpowers/specs/2026-10-01-stc-488-copy-recording-design.md`

## Deviations from the spec, found while planning

Each one is updated in the spec in Task 8, Step 4, so the two don't disagree.

1. **Cancel destroys the render window** instead of aborting an `AbortSignal`. `exportSession` returns its bytes only when it finishes, so destroying the window cancels instantly and leaves nothing to clean up in the renderer. No signal plumbing crosses IPC.
2. **No ` (2)` collision suffix.** The copy is named `<take leaf>.mp4`. The leaf is unique within the temp root by construction (`newTempTakeDir` → `uniqueTakeName`), and a copy exists only for a take in that root.
3. **The pasteboard round trip is a grant-suite test (`copy-file.grant.test.ts`), not CI.** This repo already decided that `NSPasteboard.general` needs a real logged-in session and does not belong in `npm test` (`helper/test/still-clipboard.grant.test.ts`'s header). The pure request decisions still run on CI.
4. **The purge has its own hourly timer, with a first run 60 s after launch.** The existing `TEMP_PURGE_INTERVAL_MS` is 12 h, which would let a "24 h" copy live 36 h. Waiting 60 s keeps the purge's helper request out of startup.
5. **The copy file is written by main from the finished bytes,** to `<name>.mp4.partial` then renamed. That rename is the "a name without the suffix is complete" guarantee.

## Global Constraints

- `render()` stays pure, and sinks may not fork the transform: the copy goes through the unchanged `exportSession`, and the editor and the render window share ONE session loader (`app/src/session-io.ts`).
- The renderer never names a filesystem path. Reads go through `preview:read`/`preview:size`/`preview:chunk`, and the one write goes through `copy:write` to a path main chose.
- `actionsFor` (`app/src/panel-actions.ts`) is the only owner of which actions a take has. The button row, ⌘C/⌘⌫ and the right-click menu all ask it.
- Copy never closes the panel and never promotes the take (`closesPanel("copy") === false`, `promotes("copy") === false`).
- Copies live in `copiesRoot(env)` = `STC_COPIES_DIR` or `~/Library/Application Support/<PRODUCT_NAME>/copies`. Never inside a take.
- `COPY_MAX_AGE_MS` = 24 h; `PARTIAL_MAX_AGE_MS` = 1 h; `COPY_PURGE_INTERVAL_MS` = 1 h; `COPY_PURGE_FIRST_DELAY_MS` = 60 s.
- The purge never deletes when the clipboard can't be read (the helper is down or times out): it skips the round.
- `hash: false` for a copy's export. A copy carries the take's `captureId` when it resolves (STC-413).
- E2E: takes are started with `startRecordFlow`, windows counted with `_windows.ts`, and every test's timeout is a numeric LITERAL that `_timeout-budget.ts` can read.
- Build the helper with `helper/build.sh`, never `swift build`. Run `npm run typecheck` (all three passes), not bare `tsc`.

## Review Focus

These are the inputs most likely to bite that no other step would exercise. Each has its test in the owning task.

1. **A keyboard Save (⌘S) or Edit pressed while a copy renders.** It must be refused, exactly as the disabled buttons are. Task 6, E2E test "Save and Edit are locked while a copy renders, by key as well as by click".
2. **Escape or the panel's ✕ during a render.** It cancels the render: no render window left, no `.partial`, and no `copy-file` ever sent. Task 7, E2E test "dismissing mid-render cancels it".
3. **A take with a camera track.** `loadSession` refuses a take whose anchors claim `camera.mp4` when it isn't supplied, and the render window must supply it the way the editor does. Task 6, E2E test "a camera take copies, PiP and all".
4. **The helper refuses `copy-file`.** The panel shows the reason, every button is enabled again, and the take is untouched. Task 6, E2E test "a refused pasteboard write is reported, and the panel recovers".
5. **The clipboard can't be read at purge time.** Nothing is deleted, however old. Task 1's unit test "deletes nothing when the clipboard is unknown", plus Task 7's wiring step.

---

### Task 1: `recording-copy.ts` — paths, cache, purge decision

**Files:**
- Create: `app/src/recording-copy.ts`
- Modify: `app/src/temp-takes.ts` (export `appSupportDir`)
- Test: `app/test/recording-copy.test.ts`

**Interfaces:**
- Produces:
  - `copiesRoot(env: NodeJS.ProcessEnv): string`
  - `copyPathFor(env: NodeJS.ProcessEnv, takeDir: string): string`: `join(copiesRoot(env), basename(takeDir) + ".mp4")`
  - `PARTIAL_SUFFIX = ".partial"`
  - `COPY_MAX_AGE_MS`, `PARTIAL_MAX_AGE_MS`, `COPY_PURGE_INTERVAL_MS`, `COPY_PURGE_FIRST_DELAY_MS`
  - `interface CopyEntry { name: string; mtimeMs: number }`
  - `purgeDecision(entries: readonly CopyEntry[], now: number, onClipboard: ReadonlySet<string> | undefined, root: string): string[]`, which returns the NAMES (not paths) in `root` to delete. `onClipboard` holds absolute paths; `undefined` means the clipboard couldn't be read.

- [ ] **Step 1: Write the failing test**

```ts
// app/test/recording-copy.test.ts
import { describe, test, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  copiesRoot, copyPathFor, purgeDecision, PARTIAL_SUFFIX,
  COPY_MAX_AGE_MS, PARTIAL_MAX_AGE_MS,
} from "../src/recording-copy.js";
import { PRODUCT_NAME } from "../src/product.js";

/**
 * STC-488: where a recording's rendered copy lives, and which copies the
 * purge may delete. No Electron, no filesystem: main does the I/O.
 */
describe("where a copy lives", () => {
  test("STC_COPIES_DIR wins, so tests never touch a real Application Support", () => {
    expect(copiesRoot({ STC_COPIES_DIR: "/tmp/x" })).toBe("/tmp/x");
  });

  test("otherwise beside temp-takes, under the product's own folder", () => {
    expect(copiesRoot({})).toBe(join(homedir(), "Library", "Application Support", PRODUCT_NAME, "copies"));
  });

  test("a copy is named after its take, which is what a paste shows", () => {
    expect(copyPathFor({ STC_COPIES_DIR: "/c" }, "/t/2026-10-01_18-04-12"))
      .toBe("/c/2026-10-01_18-04-12.mp4");
  });
});

describe("the purge", () => {
  const now = 10 * COPY_MAX_AGE_MS;
  const root = "/c";
  const old = { name: "a.mp4", mtimeMs: now - COPY_MAX_AGE_MS - 1 };
  const young = { name: "b.mp4", mtimeMs: now - COPY_MAX_AGE_MS + 1_000 };
  const stalePartial = { name: `c.mp4${PARTIAL_SUFFIX}`, mtimeMs: now - PARTIAL_MAX_AGE_MS - 1 };
  const freshPartial = { name: `d.mp4${PARTIAL_SUFFIX}`, mtimeMs: now - 1_000 };

  test("deletes copies older than 24 h, keeps younger ones", () => {
    expect(purgeDecision([old, young], now, new Set(), root)).toEqual(["a.mp4"]);
  });

  test("keeps the copy still on the clipboard, however old", () => {
    expect(purgeDecision([old], now, new Set([join(root, "a.mp4")]), root)).toEqual([]);
  });

  test("deletes a partial a crash left behind, keeps one a render may still be writing", () => {
    expect(purgeDecision([stalePartial, freshPartial], now, new Set(), root)).toEqual([`c.mp4${PARTIAL_SUFFIX}`]);
  });

  test("deletes nothing when the clipboard is unknown (Review Focus 5)", () => {
    expect(purgeDecision([old, stalePartial], now, undefined, root)).toEqual([]);
  });

  test("ignores anything that is not a copy or a partial", () => {
    expect(purgeDecision([{ name: ".DS_Store", mtimeMs: 0 }], now, new Set(), root)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run app/test/recording-copy.test.ts`
Expected: FAIL, "Cannot find module '../src/recording-copy.js'".

- [ ] **Step 3: Export `appSupportDir` from `temp-takes.ts`**

In `app/src/temp-takes.ts` change `function appSupportDir(name: string): string {` to `export function appSupportDir(name: string): string {`. Leave the doc comment as it is. It already says this is "the one place that shape is spelled", which is why `copiesRoot` imports it instead of spelling the path again.

- [ ] **Step 4: Write the module**

```ts
// app/src/recording-copy.ts
/**
 * A recording's Copy, decided without Electron (STC-488).
 *
 * Copy on a recording RENDERS: a fresh take's only video is display.mp4, which
 * has no cursor and no zoom (the pointer exists only in a render). The render
 * is a new file, independent of the take, so Trash after Copy can't break the
 * paste and STC-392's APFS clone has nothing to do. What carries over from
 * STC-392 is the purge: copies go after 24 h, except the one still on the
 * clipboard.
 *
 * Main does every filesystem and pasteboard call; this module only decides,
 * the same split `temp-takes.ts`'s `sweepOrphanedBundles` follows.
 */
import { basename, join } from "node:path";
import { appSupportDir } from "./temp-takes.js";
import { PRODUCT_NAME } from "./product.js";

export const PARTIAL_SUFFIX = ".partial";
/** STC-392's own number. */
export const COPY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A partial this old is a crash's leftover; a render writing one finishes in seconds. */
export const PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;
/** Its own timer: the temp-takes sweep runs every 12 h, which would let a 24 h copy live 36 h. */
export const COPY_PURGE_INTERVAL_MS = 60 * 60 * 1000;
/** Out of startup's way: the purge asks the helper, which may not be up yet. */
export const COPY_PURGE_FIRST_DELAY_MS = 60 * 1000;

/** Overridable for tests, exactly as `tempTakesRoot` is. Never inside a take. */
export function copiesRoot(env: NodeJS.ProcessEnv): string {
  return env.STC_COPIES_DIR || join(appSupportDir(PRODUCT_NAME), "copies");
}

/**
 * `<take leaf>.mp4`, which is what a paste shows the person. The leaf is unique
 * within the temp root (`newTempTakeDir` → `uniqueTakeName`), and a copy is
 * only ever made for a take in that root, so the name is also the cache key:
 * if this file exists, it IS this take's finished copy.
 */
export function copyPathFor(env: NodeJS.ProcessEnv, takeDir: string): string {
  return join(copiesRoot(env), `${basename(takeDir)}.mp4`);
}

export interface CopyEntry { name: string; mtimeMs: number }

/**
 * Which entries of `copiesRoot` to delete. `onClipboard` is the set of
 * absolute paths on the pasteboard right now, or `undefined` when it couldn't
 * be read, in which case NOTHING is deleted: a file that might be on the
 * clipboard is worth one more hour on disk.
 */
export function purgeDecision(entries: readonly CopyEntry[], now: number,
                              onClipboard: ReadonlySet<string> | undefined,
                              root: string): string[] {
  if (!onClipboard) return [];
  const out: string[] = [];
  for (const e of entries) {
    const age = now - e.mtimeMs;
    if (e.name.endsWith(`.mp4${PARTIAL_SUFFIX}`)) {
      if (age > PARTIAL_MAX_AGE_MS) out.push(e.name);
      continue;
    }
    if (!e.name.endsWith(".mp4")) continue;
    if (onClipboard.has(join(root, e.name))) continue;
    if (age > COPY_MAX_AGE_MS) out.push(e.name);
  }
  return out;
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run app/test/recording-copy.test.ts && npm run typecheck`
Expected: PASS, and all three typecheck passes clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/recording-copy.ts app/src/temp-takes.ts app/test/recording-copy.test.ts
git commit -m "STC-488: where a recording's copy lives, and what the purge deletes"
```

---

### Task 2: Copy joins a recording's actions, and three of them lock while it renders

**Files:**
- Modify: `app/src/panel-actions.ts` (module doc, `actionsFor`, new `lockedWhileCopying`)
- Modify: `app/src/thumbnail-menu.ts` (`ThumbMenuContext.copying`)
- Test: `app/test/panel-actions.test.ts`, `app/test/thumbnail-menu.test.ts`

**Interfaces:**
- Produces: `lockedWhileCopying(action: PanelAction): boolean`, true for `copy`, `save` and `edit`. `ThumbMenuContext` gains `copying?: boolean`.

- [ ] **Step 1: Change the tests first**

In `app/test/panel-actions.test.ts`, replace the test "a fresh recording has save, edit and trash — and no copy" with:

```ts
  test("a fresh recording has copy, save, edit and trash", () => {
    // STC-488: Copy RENDERS a recording (cursor and zoom included) to a file
    // in the copies folder, so a Trash afterwards cannot break the paste.
    expect(actionsFor(fresh("recording"))).toEqual(["copy", "save", "edit", "trash"]);
  });
```

In the "re-opened from the library" test, change the recording line to:

```ts
    expect(actionsFor({ kind: "recording", origin: "library" })).toEqual(["copy", "edit", "trash"]);
```

Append:

```ts
describe("what a recording's copy locks while it renders (STC-488)", () => {
  test("copy, save and edit lock; trash and dismiss never do", () => {
    // Save would move the take out from under the render reading it, and Edit
    // promotes first, the same move. A second Copy would start a second job.
    // Trash and dismiss are the panel's way out, and they cancel the render.
    const all: PanelAction[] = ["copy", "save", "edit", "trash", "dismiss"];
    expect(all.filter(lockedWhileCopying)).toEqual(["copy", "save", "edit"]);
  });
});
```

Add `lockedWhileCopying` to that file's import list.

In `app/test/thumbnail-menu.test.ts`, replace "a fresh recording offers save, edit, reveal, delete — no copy, and no save-as" with:

```ts
  test("a fresh recording offers copy, save, edit, reveal, delete — and no save-as", () => {
    // STC-488 gave a recording Copy. Save As still writes the decorated
    // PICTURE, and a recording's panel has none.
    const actions = ids(buildThumbMenu({ take: RECORDING_FRESH })).filter((id) => id !== "separator");
    expect(actions).toEqual(["copy", "save", "edit", "reveal", "trash"]);
  });

  test("while a recording's copy renders, copy, save and edit are unavailable and delete is not", () => {
    const items = buildThumbMenu({ take: RECORDING_FRESH, copying: true });
    const enabled = Object.fromEntries(items.filter((i) => i.id !== "separator").map((i) => [i.id, i.enabled]));
    expect(enabled).toEqual({ copy: false, save: false, edit: false, reveal: true, trash: true });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run app/test/panel-actions.test.ts app/test/thumbnail-menu.test.ts`
Expected: FAIL. The recording action lists don't contain `copy`, `lockedWhileCopying` isn't exported, and `copying` has no effect.

- [ ] **Step 3: `panel-actions.ts`**

Replace the module-doc section `## One absence is deliberate, and has a reason on it` (including its 2026-09-17 NOTE) with:

```ts
 * ## A recording's Copy renders (STC-488)
 *
 * This used to be the deliberate absence: a fresh take's only video is
 * `display.mp4`, which has `showsCursor` off by design, so copying it would
 * hand someone a file that looks like their recording and is missing the
 * pointer. STC-488 makes Copy RENDER the take, with cursor and zoom, through
 * the same `exportSession` the editor's Export uses, into `copiesRoot`
 * (`recording-copy.ts`). The rendered file belongs to nobody's take, so
 * "Copy, then Trash" still pastes. While that render runs, `lockedWhileCopying`
 * says which actions must wait.
```

In `actionsFor`, replace

```ts
  // See the module doc: a recording has no Copy until STC-395.
  if (take.kind === "shot") out.push("copy");
```

with

```ts
  // Both kinds copy. A recording's Copy renders first (STC-488, module doc).
  out.push("copy");
```

Append after `promotes`:

```ts
/**
 * Whether this action must wait while a recording's Copy is rendering
 * (STC-488).
 *
 * Save moves the take into the library, and the render is reading it. Edit
 * promotes first, the same move. A second Copy would start a second render of
 * the same take. Trash and dismiss do NOT wait: a panel that never closes on
 * its own must always have a way out, so they cancel the render instead
 * (`main.ts`'s `panel:trash`/`panel:dismiss`).
 */
export function lockedWhileCopying(action: PanelAction): boolean {
  return action === "copy" || action === "save" || action === "edit";
}
```

- [ ] **Step 4: `thumbnail-menu.ts`**

Add to `ThumbMenuContext`, after `busy`:

```ts
  /**
   * A recording's Copy is rendering (STC-488). `lockedWhileCopying` decides
   * which rows that disables. Not folded into `busy`: busy leaves Edit
   * enabled, and a copy must not.
   */
  copying?: boolean;
```

Import `lockedWhileCopying` from `./panel-actions.js`. In `buildThumbMenu`, add `const copying = ctx.copying === true;` beside `busy`, and change the pushed item's `enabled` to:

```ts
      enabled: !(copying && lockedWhileCopying(action)) && (touchesExporter(action) ? !busy : true),
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run app/test/panel-actions.test.ts app/test/thumbnail-menu.test.ts && npm run typecheck`
Expected: PASS. `thumbnail-renderer.ts` still typechecks: its `run("copy")` returns false for a recording until Task 6.

- [ ] **Step 6: Commit**

```bash
git add app/src/panel-actions.ts app/src/thumbnail-menu.ts app/test/panel-actions.test.ts app/test/thumbnail-menu.test.ts
git commit -m "STC-488: a recording has Copy; copy, save and edit wait while it renders"
```

---

### Task 3: The helper puts a file on the pasteboard, and reads back what's there

**Files:**
- Create: `helper/src/CopyFileDecisions.swift` (pure)
- Create: `helper/src/CopyFile.swift` (AppKit)
- Modify: `helper/src/main.swift` (two `case`s)
- Create: `helper/test/copy-file/main.swift` (decisions harness)
- Create: `helper/test/copy-file-decisions.test.ts` (CI)
- Create: `helper/test/copy-file.grant.test.ts` (grant suite: the real pasteboard)
- Modify: `app/src/supervisor.ts` (`copyFile`, `pasteboardFiles`)
- Modify: `app/test/_fake-helper.mjs` (two `case`s)

**Interfaces:**
- Produces:
  - helper command `copy-file { path }`, which replies with event `copied-file { changeCount: number }`, or `error { code: "copy-refused" | "pasteboard-failed", detail }`;
  - helper command `pasteboard-files`, which replies with event `pasteboard-files { paths: string[] }`;
  - `HelperSupervisor.copyFile(path: string): Promise<HelperLine>` and `HelperSupervisor.pasteboardFiles(): Promise<HelperLine>`;
  - fake helper: `STC_FAKE_COPY_LOG` (appends each `copy-file` request as a JSON line), `STC_FAKE_COPY_ERROR` (refuses `copy-file` with that code), `STC_FAKE_PASTEBOARD` (a JSON array of paths returned by `pasteboard-files`; when unset, `pasteboard-files` replies `error`, so a test machine's purge always skips).

- [ ] **Step 1: Write the failing decisions harness**

```swift
// helper/test/copy-file/main.swift
// Pure-function tests for `copy-file`'s request decisions (STC-488), compiled
// together with the production source. No pasteboard is touched: whether
// NSPasteboard accepts the URL is `copy-file.grant.test.ts`.
import Foundation

var failures = 0
func check(_ label: String, _ got: some Equatable, _ want: some Equatable) {
    if String(describing: got) == String(describing: want) {
        print("ok   \(label)")
    } else {
        let line = "FAIL \(label): got \(got), want \(want)"
        print(line)
        FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
        failures += 1
    }
}

let dir = FileManager.default.temporaryDirectory.appendingPathComponent("copy-file-\(getpid())")
try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
let file = dir.appendingPathComponent("take.mp4")
FileManager.default.createFile(atPath: file.path, contents: Data([0]))

func reason(_ r: Result<URL, CopyFileRefusal>) -> String {
    switch r { case .success: return "ok"; case .failure(let e): return e.reason }
}

check("a real file is accepted", reason(parseCopyFileRequest(["path": file.path])), "ok")
check("no path", reason(parseCopyFileRequest([:])), "path is required")
check("an empty path", reason(parseCopyFileRequest(["path": ""])), "path is required")
check("a relative path", reason(parseCopyFileRequest(["path": "take.mp4"])), "path must be absolute")
check("a missing file", reason(parseCopyFileRequest(["path": dir.appendingPathComponent("nope.mp4").path])),
      "no such file")
check("a directory", reason(parseCopyFileRequest(["path": dir.path])), "not a regular file")

try? FileManager.default.removeItem(at: dir)
print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
```

```ts
// helper/test/copy-file-decisions.test.ts
import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * STC-488: `copy-file`'s request decisions, without a pasteboard. Runs on CI.
 * The pasteboard itself needs a logged-in session and lives in the grant suite
 * (`copy-file.grant.test.ts`), the same split the still path has.
 */
describe("copy-file decisions (STC-488)", () => {
  test("Swift pure-function assertions pass", async () => {
    const out = await runSwiftHarness({
      label: "copy-file",
      sources: ["helper/src/CopyFileDecisions.swift", "helper/test/copy-file/main.swift"],
    });
    expect(out, out).toContain("ALL PASS");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run helper/test/copy-file-decisions.test.ts`
Expected: FAIL. The compile fails with `cannot find 'parseCopyFileRequest' in scope`.

- [ ] **Step 3: Write the decisions**

```swift
// helper/src/CopyFileDecisions.swift
// `copy-file`'s pure half (STC-488): is this request a file we will put on the
// pasteboard? No AppKit, so `helper/test/copy-file/` checks it without one.
import Foundation

struct CopyFileRefusal: Error { let reason: String }

/// A non-empty, absolute path to an existing regular file. Anything else is
/// refused with a sentence, never silently copied as something it isn't.
func parseCopyFileRequest(_ cmd: [String: Any]) -> Result<URL, CopyFileRefusal> {
    guard let path = cmd["path"] as? String, !path.isEmpty else {
        return .failure(CopyFileRefusal(reason: "path is required"))
    }
    guard path.hasPrefix("/") else { return .failure(CopyFileRefusal(reason: "path must be absolute")) }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else {
        return .failure(CopyFileRefusal(reason: "no such file"))
    }
    guard !isDir.boolValue else { return .failure(CopyFileRefusal(reason: "not a regular file")) }
    return .success(URL(fileURLWithPath: path))
}
```

- [ ] **Step 4: Run the decisions test**

Run: `npx vitest run helper/test/copy-file-decisions.test.ts`
Expected: PASS ("ALL PASS").

- [ ] **Step 5: The AppKit half, and the dispatch**

```swift
// helper/src/CopyFile.swift
// `copy-file` and `pasteboard-files` (STC-488): a rendered recording on the
// general pasteboard as a FILE REFERENCE, the representation Finder, Slack,
// Mail and Messages read for a pasted file. Writing an NSURL object (rather
// than a raw public.file-url string on an item, as a still's extra fileURL
// does) is what makes AppKit add the legacy filename types those apps still
// look for.
import AppKit

enum CopyFile {
    static func copy(_ cmd: [String: Any]) -> Result<[String: Any], CopyFileRefusal> {
        switch parseCopyFileRequest(cmd) {
        case .failure(let e): return .failure(e)
        case .success(let url):
            let pb = NSPasteboard.general
            pb.clearContents()
            guard pb.writeObjects([url as NSURL]) else {
                return .failure(CopyFileRefusal(reason: "NSPasteboard refused the file"))
            }
            return .success(["changeCount": pb.changeCount])
        }
    }

    /// Absolute paths of every file URL on the general pasteboard. Read-only;
    /// the purge's one check (no polling).
    static func files() -> [String] {
        let urls = NSPasteboard.general.readObjects(forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.map(\.path)
    }
}
```

In `helper/src/main.swift`, add these cases beside `case "export-still":`:

```swift
        case "copy-file":
            // STC-488. State-free, like export-still: copying a finished
            // render must never be refused because a take happens to be running.
            switch CopyFile.copy(cmd) {
            case .success(let o): IO.send("copied-file", seq: seq, o)
            case .failure(let e):
                let code = e.reason == "NSPasteboard refused the file" ? "pasteboard-failed" : "copy-refused"
                IO.send("error", seq: seq, ["code": code, "detail": e.reason])
            }
        case "pasteboard-files":
            IO.send("pasteboard-files", seq: seq, ["paths": CopyFile.files()])
```

- [ ] **Step 6: Build the helper**

Run: `helper/build.sh && echo '{"cmd":"pasteboard-files","seq":1}' | helper/build/stc-helper`
Expected: the build succeeds, and the output contains a `pasteboard-files` JSON line with a `paths` array.

- [ ] **Step 7: The grant test (the real pasteboard)**

```ts
// helper/test/copy-file.grant.test.ts
import { describe, test, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * STC-488: `copy-file` puts a real file reference on the SYSTEM pasteboard,
 * and `pasteboard-files` reads the same path back.
 *
 * In the grant suite though it needs no TCC grant, for the reason
 * `still-clipboard.grant.test.ts` gives: NSPasteboard.general needs a real
 * logged-in session, which a CI runner can't be relied on to provide. What
 * Slack or Mail then accept is docs/STC-488-RUNBOOK.md.
 */
const BIN = join(__dirname, "..", "build", "stc-helper");

function ask(lines: object[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", reject);
    p.on("close", () => resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    for (const l of lines) p.stdin.write(JSON.stringify(l) + "\n");
    p.stdin.end();
  });
}

describe("copy-file on the real pasteboard (STC-488)", () => {
  test("the file goes on, and reads back as the same path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stc-copy-"));
    const file = join(dir, "take.mp4");
    writeFileSync(file, Buffer.from([0]));
    const replies = await ask([
      { cmd: "copy-file", seq: 1, path: file },
      { cmd: "pasteboard-files", seq: 2 },
    ]);
    expect(replies.find((r) => r.seq === 1)?.ev, JSON.stringify(replies)).toBe("copied-file");
    expect(replies.find((r) => r.seq === 2)?.paths).toEqual([file]);
  }, 30_000);
});
```

Before relying on `ask`, check how `still-clipboard.grant.test.ts` reads the helper's reliable channel (fd3 vs stdout) and copy its `Line` reader rather than the bare stdout reader above. A bare terminal run falls back to stdout (CLAUDE.md, IPC), which is what this sketch assumes.

- [ ] **Step 8: The supervisor and the fake helper**

In `app/src/supervisor.ts`, after `exportStill`:

```ts
  /**
   * Put a finished file on the pasteboard as a file reference (STC-488).
   * State-free, like `exportStill`: a copy must not be refused because a take
   * is running.
   */
  async copyFile(path: string): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    return this.client.request("copy-file", { path });
  }

  /** The file paths on the pasteboard right now: the copy purge's one check. */
  async pasteboardFiles(): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    return this.client.request("pasteboard-files", {});
  }
```

In `app/test/_fake-helper.mjs`, add before `default:`:

```js
      // ── STC-488: a recording's copy on the pasteboard ───────────────────
      case "copy-file": {
        if (process.env.STC_FAKE_COPY_LOG) {
          try { writeFileSync(process.env.STC_FAKE_COPY_LOG, JSON.stringify(cmd) + "\n", { flag: "a" }); }
          catch { /* a test seam is not worth killing the stand-in */ }
        }
        if (process.env.STC_FAKE_COPY_ERROR) {
          send("error", { seq, code: process.env.STC_FAKE_COPY_ERROR, detail: "stand-in refused the pasteboard" });
          break;
        }
        send("copied-file", { seq, changeCount: 1 });
        break;
      }
      case "pasteboard-files": {
        // Unset: an error, so a test machine's copy purge always SKIPS rather
        // than deleting a developer's real copies (purgeDecision's undefined).
        if (!process.env.STC_FAKE_PASTEBOARD) {
          send("error", { seq, code: "unavailable", detail: "stand-in has no pasteboard" });
          break;
        }
        let paths = [];
        try { paths = JSON.parse(process.env.STC_FAKE_PASTEBOARD); } catch { /* keep [] */ }
        send("pasteboard-files", { seq, paths });
        break;
      }
```

Check how `HelperClient.request` treats an `ev: "error"` reply (it rejects, or resolves with the line). Main's code in Tasks 6 and 7 handles both by checking `line.ev`.

- [ ] **Step 9: Typecheck and run the unit tests**

Run: `npm run typecheck && npx vitest run helper/test/copy-file-decisions.test.ts app/test/supervisor.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add helper/src/CopyFileDecisions.swift helper/src/CopyFile.swift helper/src/main.swift \
  helper/test/copy-file helper/test/copy-file-decisions.test.ts helper/test/copy-file.grant.test.ts \
  app/src/supervisor.ts app/test/_fake-helper.mjs
git commit -m "STC-488: the helper copies a file to the pasteboard and reads back what is there"
```

Hand Patrick `npx vitest run helper/test/copy-file.grant.test.ts`, to run from his own terminal. Agent shells can't reach the pasteboard server reliably (memory: grant tests run from Patrick's terminal).

---

### Task 4: One session loader for the editor and the copy (`session-io.ts`)

**Files:**
- Create: `app/src/session-io.ts`
- Modify: `app/src/editor.ts` (delete `readVideo`, `ipcSource`, the load block; import them)
- Modify: `tsconfig.browser.json` (include), `tsconfig.node.json` (exclude)
- Test: existing `app/test/export.e2e.test.ts`, `app/test/preview.e2e.test.ts`, `app/test/export-size.e2e.test.ts` as the regression net; new `app/test/session-io-seam.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TakeIO {
  read(name: string): Promise<ArrayBuffer>;
  size(name: string): Promise<number>;
  chunk(name: string, offset: number, length: number): Promise<ArrayBuffer>;
}
export type CountingSource = ByteSource & { readonly bytesRead: number };
export function ipcSource(io: TakeIO, name: string): Promise<CountingSource>;
export function readWhole(io: TakeIO, name: string): Promise<ArrayBuffer>;
export interface LoadedTake {
  session: LoadedSession; project: Project; anchors: any;
  sources: { display: CountingSource; camera?: CountingSource };
}
export function loadTake(io: TakeIO): Promise<LoadedTake>;
```

- [ ] **Step 1: Write the seam test (it fails first)**

```ts
// app/test/session-io-seam.test.ts
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-488: the editor and the copy render load a take through ONE module.
 * A second hand-built loader is how a sink starts to fork the transform
 * (CLAUDE.md, the non-negotiable), so this greps for it, with a control
 * proving the pattern fires.
 */
const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
const BUILDS_A_SESSION = /\bloadSession\s*\(/;

describe("one session loader (STC-488)", () => {
  test("control: session-io.ts itself calls loadSession", () => {
    expect(src("session-io.ts")).toMatch(BUILDS_A_SESSION);
  });
  test("the editor and the copy render import it instead of calling loadSession", () => {
    for (const f of ["editor.ts", "copy-render.ts"]) {
      expect(src(f), f).not.toMatch(BUILDS_A_SESSION);
      expect(src(f), f).toMatch(/from "\.\/session-io\.js"/);
    }
  });
});
```

Run: `npx vitest run app/test/session-io-seam.test.ts`
Expected: FAIL (no `session-io.ts`). The `copy-render.ts` half keeps failing until Task 5, which is intended. Mark it `test.todo` here and switch it on in Task 5.

- [ ] **Step 2: Write `session-io.ts`, moving the editor's code**

Move `VIDEO_CHUNK_BYTES`, `readVideo` (renamed `readWhole`, taking `io` first), and `ipcSource` (taking `io` first) out of `editor.ts`, unchanged apart from replacing `editor.takeFileSize`/`editor.readTakeChunk`/`editor.readTakeFile` with `io.size`/`io.chunk`/`io.read`. Then lift the body of `openTakeOrThrow` from `const dec = new TextDecoder();` to the `parseProject(...)` call into `loadTake`:

```ts
// app/src/session-io.ts
/**
 * Loading a take over IPC, for every window that renders one (STC-488).
 *
 * Lifted VERBATIM out of `editor.ts` so the editor's preview and a recording's
 * copy render read the take through one loader. The renderer never names a
 * path: `io` is the window's own bridge onto the guarded
 * preview:read/size/chunk handlers. See `ipcSource`'s doc (moved with it) for
 * why video is read by range and audio whole.
 */
import { loadSession, type LoadedSession } from "@transform/session";
import type { ByteSource } from "@transform/chunk-reader";
import { parseProject } from "@transform/trim";
import type { Project } from "@transform/types";

export interface TakeIO {
  read(name: string): Promise<ArrayBuffer>;
  size(name: string): Promise<number>;
  chunk(name: string, offset: number, length: number): Promise<ArrayBuffer>;
}
export type CountingSource = ByteSource & { readonly bytesRead: number };

const VIDEO_CHUNK_BYTES = 32 * 1024 * 1024;

export async function readWhole(io: TakeIO, name: string): Promise<ArrayBuffer> {
  // (editor.ts's readVideo body, with editor.* → io.*)
}

export async function ipcSource(io: TakeIO, name: string): Promise<CountingSource> {
  // (editor.ts's ipcSource body, with editor.* → io.*)
}

export interface LoadedTake {
  session: LoadedSession;
  project: Project;
  anchors: any;
  sources: { display: CountingSource; camera?: CountingSource };
}

export async function loadTake(io: TakeIO): Promise<LoadedTake> {
  const dec = new TextDecoder();
  const [anchors, events, displaySrc, projectRaw] = await Promise.all([
    io.read("anchors.json").then((b) => JSON.parse(dec.decode(b))),
    io.read("events.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => ({ version: 1, events: [] })),
    ipcSource(io, "display.mp4"),
    io.read("project.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => null),
  ]);
  const cameraSrc = anchors.files?.camera ? await ipcSource(io, anchors.files.camera) : undefined;
  // STC-233: same reasoning as cameraSrc above (only when the anchors claim the track), one track over.
  const micM4a = anchors.files?.mic ? await readWhole(io, anchors.files.mic) : undefined;
  // STC-418: and again for system audio — loadSession refuses a claimed track that was not supplied.
  const systemM4a = anchors.files?.system ? await readWhole(io, anchors.files.system) : undefined;
  const session = await loadSession({ anchors, events, displayMp4: displaySrc, cameraMp4: cameraSrc, micM4a, systemM4a });
  const durationNs = session.frames[session.frames.length - 1] ?? 0;
  const project = parseProject(
    projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
    anchors.camera?.present === true,
  );
  return { session, project, anchors, sources: { display: displaySrc, camera: cameraSrc } };
}
```

Copy the two function bodies across character for character; the comments above are where they go. Check `editor.ts`'s import of `parseProject` and use the same module specifier (`@transform/trim` or whatever `editor.ts` imports it from).

- [ ] **Step 3: Rewire the editor**

In `editor.ts`, delete `VIDEO_CHUNK_BYTES`, `readVideo` and `ipcSource`. Add near the other local imports:

```ts
import { loadTake, ipcSource, readWhole, type TakeIO, type CountingSource } from "./session-io.js";

/** This window's bridge as `session-io.ts`'s `TakeIO`. */
const takeIO: TakeIO = {
  read: (n) => editor.readTakeFile(n),
  size: (n) => editor.takeFileSize(n),
  chunk: (n, o, l) => editor.readTakeChunk(n, o, l),
};
```

Retype `openVideoSources` as `{ display: CountingSource; camera?: CountingSource } | undefined`. In `openTakeOrThrow`, replace everything from `const dec = new TextDecoder();` through the `parseProject(...)` statement with:

```ts
  const { session, project, anchors, sources } = await loadTake(takeIO);
  openVideoSources = sources;
```

and leave the lines after it (`openSession = session;` …) as they are. Run `grep -n "readVideo\|ipcSource(" app/src/editor.ts`. Any remaining caller becomes `readWhole(takeIO, …)` or `ipcSource(takeIO, …)`.

- [ ] **Step 4: tsconfig**

Add `"app/src/session-io.ts"` to `tsconfig.browser.json`'s `include`, and to `tsconfig.node.json`'s `exclude` with the comment `// STC-488: a renderer module (imports @transform/session).`

- [ ] **Step 5: Typecheck, then the editor's own e2e as the regression net**

Run: `npm run typecheck && npm run app:build && npx vitest run app/test/session-io-seam.test.ts app/test/export.e2e.test.ts app/test/preview.e2e.test.ts app/test/export-size.e2e.test.ts`
Expected: typecheck clean; the seam test passes (with its `copy-render.ts` half still a todo); the three e2e files pass unchanged. A failure here means the move changed behaviour. Compare against the original lines; don't adjust the tests.

- [ ] **Step 6: Commit**

```bash
git add app/src/session-io.ts app/src/editor.ts tsconfig.browser.json tsconfig.node.json app/test/session-io-seam.test.ts
git commit -m "STC-488: one session loader for every window that renders a take"
```

---

### Task 5: The render window — one hidden window per copy job

**Files:**
- Create: `app/renderer/copy-render.html`, `app/src/copy-render-preload.ts`, `app/src/copy-render.ts`
- Create: `app/src/copy-render-window.ts` (Electron, main side: the job registry)
- Modify: `app/build.mjs`, `tsconfig.browser.json`, `tsconfig.node.json`
- Modify: `app/test/session-io-seam.test.ts` (turn the todo on)

**Interfaces:**
- Consumes: `loadTake`, `TakeIO` (Task 4); `copyPathFor`, `PARTIAL_SUFFIX` (Task 1).
- Produces (from `copy-render-window.ts`):

```ts
export type CopyOutcome =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; detail: string };
export interface CopyJobOptions {
  takeDir: string;
  outPath: string;                 // final .mp4; main writes outPath + PARTIAL_SUFFIX first
  dist: string; rendererDir: string;
  delayMs?: number;                // test seam, STC_COPY_RENDER_DELAY_MS (see Task 5 Step 2)
  grant(webContentsId: number, takeDir: string): void;   // main's openTakes.set
  revoke(webContentsId: number): void;                   // main's openTakes.delete
  onProgress(done: number, total: number): void;
}
export function startCopyRender(opts: CopyJobOptions): Promise<CopyOutcome>;
export function cancelCopyRender(takeDir: string): Promise<void>;   // resolves once the job has settled
export function copyRenderInFlight(takeDir: string): boolean;
export function copyRenderWindowCount(): number;                    // tests
export function cancelAllCopyRenders(): Promise<void>;              // quit
```

- [ ] **Step 1: The page and the preload**

```html
<!-- app/renderer/copy-render.html -->
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <!-- STC-488: never shown. A page only so WebCodecs and OffscreenCanvas exist. -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; worker-src 'self' blob:">
  <title>copy render</title>
</head>
<body>
  <script src="../dist/copy-render.js"></script>
</body>
</html>
```

```ts
// app/src/copy-render-preload.ts
import { contextBridge, ipcRenderer } from "electron";

/**
 * The copy render's bridge (STC-488): exactly the take reads `session-io.ts`
 * needs, the capture id, and three ways to report back. It names no path;
 * `copy:write` writes to the one main chose for this window's job.
 */
contextBridge.exposeInMainWorld("copyRender", {
  read: (name: string) => ipcRenderer.invoke("preview:read", name),
  size: (name: string) => ipcRenderer.invoke("preview:size", name),
  chunk: (name: string, offset: number, length: number) =>
    ipcRenderer.invoke("preview:chunk", name, offset, length),
  captureId: () => ipcRenderer.invoke("take:captureId"),
  progress: (done: number, total: number) => ipcRenderer.send("copy:progress", done, total),
  write: (bytes: ArrayBuffer) => ipcRenderer.invoke("copy:write", bytes),
  failed: (detail: string) => ipcRenderer.send("copy:failed", detail),
});
```

- [ ] **Step 2: The renderer**

```ts
// app/src/copy-render.ts
/**
 * A recording's Copy, rendered (STC-488). Loads the take through
 * `session-io.ts` (the editor's own loader) and runs the unchanged
 * `exportSession` with the take's project: the default one, since a panel
 * only ever shows an unedited take. Never shown; cancelled by main
 * destroying this window, so nothing here listens for a cancel.
 */
import { loadTake, type TakeIO } from "./session-io.js";
import { exportSession } from "@transform/export";

declare global {
  interface Window {
    copyRender: TakeIO & {
      captureId(): Promise<string>;
      progress(done: number, total: number): void;
      write(bytes: ArrayBuffer): Promise<void>;
      failed(detail: string): void;
    };
  }
}

/** At most 10 progress messages a second: the panel draws a bar, not a frame counter. */
const PROGRESS_EVERY_MS = 100;

/**
 * Test seam: `STC_COPY_RENDER_DELAY_MS`, read by main and passed as `delayMs`.
 * The 5 s fixture renders in a second or two, so without it a test can't
 * reliably see a render IN PROGRESS: its progress bar, its locked buttons, or
 * a Trash landing mid-render. The natural trigger is a long take, which no
 * test can afford, the same reason STC_COUNTDOWN_FAULT exists. Zero/absent in
 * the product.
 */
const delayMs = Number(new URLSearchParams(location.search).get("delayMs")) || 0;

void (async () => {
  const io = window.copyRender;
  try {
    if (delayMs > 0) {
      io.progress(0, 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const { session, project } = await loadTake(io);
    let captureId: string | undefined;
    try { captureId = await io.captureId(); }
    catch (e) { console.error("[copy] could not resolve a capture id:", e); }
    let last = 0;
    const result = await exportSession(session, project, {
      captureId,
      onProgress: (done, total) => {
        const now = performance.now();
        if (now - last < PROGRESS_EVERY_MS && done < total) return;
        last = now;
        io.progress(done, total);
      },
    });
    if (!result.encoded) throw new Error("the export produced no file");
    await io.write(result.encoded.buffer.slice(
      result.encoded.byteOffset, result.encoded.byteOffset + result.encoded.byteLength) as ArrayBuffer);
  } catch (e: any) {
    io.failed(String(e?.message ?? e));
  }
})();
```

Before writing this, read `exportSession`'s `encode` option: if `encoded` is only produced when `encode` isn't `false`, leave it at its default. Check that the editor's call passes no `encode` and gets `result.encoded`, which is what `editor.ts`'s `runExport` relies on.

- [ ] **Step 3: The job registry (main side)**

```ts
// app/src/copy-render-window.ts
/**
 * The hidden windows that render a recording's Copy (STC-488), one per job,
 * keyed by take directory. The panel never renders: it stays small and
 * responsive, and the job doesn't care if the panel restacks or is hidden
 * for a capture.
 *
 * Cancel DESTROYS the window. `exportSession` hands its bytes over only at
 * the end, so a destroyed window has written nothing, and there is no signal
 * to thread across IPC. A cancel that lands while `copy:write` is mid-write
 * is caught by the `cancelled` flag below, which deletes the partial.
 */
import { BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { rename, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PARTIAL_SUFFIX } from "./recording-copy.js";

export type CopyOutcome =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; detail: string };

export interface CopyJobOptions {
  takeDir: string;
  outPath: string;
  dist: string;
  rendererDir: string;
  /** Test seam (STC_COPY_RENDER_DELAY_MS): the render waits this long before loading. */
  delayMs?: number;
  grant(webContentsId: number, takeDir: string): void;
  revoke(webContentsId: number): void;
  onProgress(done: number, total: number): void;
}

interface Job {
  opts: CopyJobOptions;
  win: BrowserWindow;
  senderId: number;
  cancelled: boolean;
  settle(o: CopyOutcome): void;
  settled: Promise<CopyOutcome>;
}

const jobs = new Map<string, Job>();
const bySender = new Map<number, Job>();

ipcMain.on("copy:progress", (e, done: number, total: number) => {
  bySender.get(e.sender.id)?.opts.onProgress(Number(done) || 0, Number(total) || 0);
});
ipcMain.on("copy:failed", (e, detail: string) => {
  bySender.get(e.sender.id)?.settle({ ok: false, detail: String(detail) });
});
ipcMain.handle("copy:write", async (e, bytes: ArrayBuffer) => {
  const job = bySender.get(e.sender.id);
  if (!job) throw new Error("not a copy job");
  const partial = job.opts.outPath + PARTIAL_SUFFIX;
  await mkdir(dirname(partial), { recursive: true });
  await writeFile(partial, Buffer.from(bytes));
  if (job.cancelled) { await rm(partial, { force: true }); return; }
  await rename(partial, job.opts.outPath);
  job.settle({ ok: true, path: job.opts.outPath });
});

export function startCopyRender(opts: CopyJobOptions): Promise<CopyOutcome> {
  const existing = jobs.get(opts.takeDir);
  if (existing) return existing.settled;
  const win = new BrowserWindow({
    show: false, width: 64, height: 64, skipTaskbar: true,
    webPreferences: {
      preload: join(opts.dist, "copy-render-preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
      // A hidden window is throttled by default, which would stretch a
      // 40 s render well past it.
      backgroundThrottling: false,
    },
  });
  const senderId = win.webContents.id;
  let settle!: (o: CopyOutcome) => void;
  const settled = new Promise<CopyOutcome>((res) => { settle = res; });
  const job: Job = {
    opts, win, senderId, cancelled: false, settled,
    settle: (o) => {
      if (!jobs.has(opts.takeDir)) return;            // one outcome per job
      jobs.delete(opts.takeDir);
      bySender.delete(senderId);
      opts.revoke(senderId);
      if (!win.isDestroyed()) win.destroy();
      if (!o.ok) void rm(opts.outPath + PARTIAL_SUFFIX, { force: true });
      settle(o);
    },
  };
  jobs.set(opts.takeDir, job);
  bySender.set(senderId, job);
  opts.grant(senderId, opts.takeDir);
  win.webContents.on("render-process-gone", (_e, d) =>
    job.settle({ ok: false, detail: `the render stopped (${d.reason})` }));
  void win.loadFile(join(opts.rendererDir, "copy-render.html"),
    opts.delayMs ? { query: { delayMs: String(opts.delayMs) } } : undefined);
  return settled;
}

export async function cancelCopyRender(takeDir: string): Promise<void> {
  const job = jobs.get(takeDir);
  if (!job) return;
  job.cancelled = true;
  job.settle({ ok: false, cancelled: true });
  await job.settled;
}

export function copyRenderInFlight(takeDir: string): boolean { return jobs.has(takeDir); }
export function copyRenderWindowCount(): number { return jobs.size; }
export async function cancelAllCopyRenders(): Promise<void> {
  await Promise.all([...jobs.keys()].map(cancelCopyRender));
}
```

The render window resolves its own capture id through `take:captureId`, which `grant` makes work, so `CopyJobOptions` carries none.

- [ ] **Step 4: Build entries and tsconfig**

In `app/build.mjs`, after the still-editor lines:

```js
// STC-488: the hidden window that renders a recording's Copy.
await build({ ...common, entryPoints: ["app/src/copy-render-preload.ts"], outfile: "app/dist/copy-render-preload.cjs", format: "cjs" });
await build({ ...common, entryPoints: ["app/src/copy-render.ts"], outfile: "app/dist/copy-render.js", format: "iife", platform: "browser" });
```

Add `"app/src/copy-render.ts"` to `tsconfig.browser.json`'s `include` and to `tsconfig.node.json`'s `exclude`. In `session-io-seam.test.ts`, turn the `copy-render.ts` half back on.

- [ ] **Step 5: Typecheck, build, seam test**

Run: `npm run typecheck && npm run app:build && npx vitest run app/test/session-io-seam.test.ts`
Expected: all clean. The window is exercised end to end in Task 6.

- [ ] **Step 6: Commit**

```bash
git add app/renderer/copy-render.html app/src/copy-render-preload.ts app/src/copy-render.ts \
  app/src/copy-render-window.ts app/build.mjs tsconfig.browser.json tsconfig.node.json app/test/session-io-seam.test.ts
git commit -m "STC-488: a hidden window renders a recording's copy through the editor's loader"
```

---

### Task 6: Copy on the panel, end to end

**Files:**
- Modify: `app/src/main.ts` (`panel:copyRecording`; import the registry)
- Modify: `app/src/thumbnail-preload.ts` (`copyRecording`, `onCopyProgress`)
- Modify: `app/src/thumbnail-renderer.ts` (the copying state)
- Modify: `app/renderer/thumbnail.html` (`#copyprogress`)
- Create: `app/test/recording-copy.e2e.test.ts`

**Interfaces:**
- Consumes: `startCopyRender`, `copyRenderInFlight`, `copyRenderWindowCount` (Task 5); `copyPathFor` (Task 1); `lockedWhileCopying` (Task 2); `sup.copyFile` (Task 3).
- Produces: IPC `panel:copyRecording(dir) → { ok: true } | { ok: false; cancelled?: true; detail?: string }`; main → panel `thumb:copyProgress(done, total)`; a test hook `copy:windowCount` is NOT added; tests count render windows with `_windows.ts`'s `windowCount(app, "copy-render.html")`.

- [ ] **Step 1: Write the e2e tests (failing)**

```ts
// app/test/recording-copy.e2e.test.ts
import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { windowCount, pageWithUrl, clickThatCloses } from "./_windows.js";

/**
 * A recording's Copy (STC-488): rendered with cursor and zoom, written to the
 * copies folder, put on the pasteboard through the helper, panel left open.
 * Real WebCodecs H.264, which the macos-15 runner already exercises in
 * export.e2e.test.ts. Against `_fake-helper.mjs`, which logs `copy-file`
 * instead of touching a pasteboard; what Slack or Mail accept is
 * docs/STC-488-RUNBOOK.md.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const POLL_MS = 15_000;

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

interface Launched { win: Page; temp: string; copies: string; copyLog: string }

async function launch(env: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const copies = mkdtempSync(join(tmpdir(), "stc-copies-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  const copyLog = join(mkdtempSync(join(tmpdir(), "stc-log-")), "copy.log");
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`], cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
      STC_COPIES_DIR: copies, STC_FAKE_COPY_LOG: copyLog,
      // Long enough to see a render in progress (copy-render.ts's seam).
      STC_COPY_RENDER_DELAY_MS: "3000",
      STC_HELPER_BIN: FAKE_HELPER, STC_OVERLAY_SYNTHETIC_INPUT: "1", STC_NO_SHUTTER: "1", ...env,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#record");
  await withoutCountdown(win);
  return { win, temp, copies, copyLog };
}

/** Record and stop through the real flow, with a REAL renderable take in the temp dir. */
async function recordAndStop(l: Launched, fixture = "basic"): Promise<string> {
  await startRecordFlow(app!, l.win);
  await expect.poll(() => readdirSync(l.temp).length, { timeout: POLL_MS }).toBe(1);
  const dir = join(l.temp, readdirSync(l.temp)[0]!);
  for (const f of readdirSync(join(root, "fixtures", fixture))) {
    if (/\.(json|mp4|m4a)$/.test(f) && f !== "project.json" && f !== "frames.json") {
      cpSync(join(root, "fixtures", fixture, f), join(dir, f));
    }
  }
  await l.win.evaluate(() => (window as any).recorder.stop());
  return dir;
}

async function readyPanel(): Promise<Page> {
  await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: POLL_MS }).toBe(1);
  const panel = await pageWithUrl(app!, "thumbnail.html");
  await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className),
                     { timeout: POLL_MS }).toContain("in");
  return panel;
}

const copyRequests = (log: string): Array<{ path: string }> =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

describe("copying a recording (STC-488)", () => {
  test("Copy renders an MP4 into the copies folder, hands it to the pasteboard, and leaves the panel open", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    expect(await panel.isVisible("#copy")).toBe(true);

    await panel.click("#copy");
    await expect.poll(() => panel.isVisible("#copyprogress"), { timeout: POLL_MS }).toBe(true);
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);

    const { path } = copyRequests(l.copyLog)[0]!;
    expect(path).toBe(join(l.copies, `${dir.split("/").pop()}.mp4`));
    const mp4 = readFileSync(path);
    expect(mp4.includes("avc1"), "an H.264 video track").toBe(true);
    expect(readdirSync(l.copies).filter((n) => n.endsWith(".partial"))).toEqual([]);
    await expect.poll(() => panel.textContent("#status"), { timeout: POLL_MS }).toContain("Copied");
    expect(await windowCount(app!, "thumbnail.html")).toBe(1);
    expect(await panel.isVisible("#copyprogress")).toBe(false);
    expect(existsSync(dir), "Copy does not promote").toBe(true);
  }, 300_000);

  test("Save and Edit are locked while a copy renders, by key as well as by click (Review Focus 1)", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => panel.isVisible("#copyprogress"), { timeout: POLL_MS }).toBe(true);
    expect(await panel.isDisabled("#save")).toBe(true);
    expect(await panel.isDisabled("#edit")).toBe(true);
    expect(await panel.isDisabled("#copy")).toBe(true);
    expect(await panel.isEnabled("#trash")).toBe(true);
    await panel.keyboard.press("Meta+s");
    await panel.waitForTimeout(500);
    expect(existsSync(dir), "a ⌘S during the render must not move the take").toBe(true);

    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);
    await expect.poll(() => panel.isEnabled("#save"), { timeout: POLL_MS }).toBe(true);
  }, 300_000);

  test("a camera take copies, PiP and all (Review Focus 3)", async () => {
    const l = await launch();
    await recordAndStop(l, "pip");
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);
    expect(existsSync(copyRequests(l.copyLog)[0]!.path)).toBe(true);
  }, 300_000);

  test("a refused pasteboard write is reported, and the panel recovers (Review Focus 4)", async () => {
    const l = await launch({ STC_FAKE_COPY_ERROR: "pasteboard-failed" });
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => panel.textContent("#status"), { timeout: 120_000 }).toContain("Could not copy");
    expect(await panel.isEnabled("#save")).toBe(true);
    expect(await panel.isEnabled("#copy")).toBe(true);
    expect(existsSync(dir)).toBe(true);
  }, 300_000);
});
```

Before running: check `fixtures/pip`'s file names against the copy filter in `recordAndStop` (it needs `anchors.json`, `events.json`, `display.mp4`, `camera.mp4`). Look at `makePipTakeFolder` in `_take-fixture.ts` and mirror its file list exactly if it differs. Compose the literal `300_000`s against `_timeout-budget.ts`'s rule the way `recording-panel.e2e.test.ts`'s header does, and write the arithmetic in this file's header.

Run: `npm run app:build && npx vitest run app/test/recording-copy.e2e.test.ts`
Expected: FAIL. `#copyprogress` doesn't exist, and Copy on a recording does nothing.

- [ ] **Step 2: `thumbnail.html`**

Inside `#takecard`, after `#takemeta`, add:

```html
        <!-- STC-488: a recording's Copy renders first. Hidden unless one is running. -->
        <progress id="copyprogress" max="1000" value="0" hidden></progress>
```

And in its `<style>`:

```css
    #copyprogress { width: 100%; height: 4px; margin-top: 6px; accent-color: var(--accent); }
    #copyprogress[hidden] { display: none; }
```

(The explicit `[hidden]` rule is there because #262 found `display: flex` outranking `[hidden]` on `#thumbwrap`.)

- [ ] **Step 3: The preload**

In `app/src/thumbnail-preload.ts`'s `exposeInMainWorld("thumb", { … })`, add:

```ts
  // STC-488: a recording's Copy renders, then goes on the pasteboard.
  copyRecording: (dir: string) => ipcRenderer.invoke("panel:copyRecording", dir),
  onCopyProgress: (cb: (done: number, total: number) => void) => {
    const listener = (_e: unknown, done: number, total: number) => cb(done, total);
    ipcRenderer.on("thumb:copyProgress", listener);
    return () => { ipcRenderer.removeListener("thumb:copyProgress", listener); };
  },
```

And in `thumbnail-renderer.ts`'s `Window["thumb"]` declaration:

```ts
      copyRecording(dir: string): Promise<{ ok: boolean; cancelled?: boolean; detail?: string }>;
      onCopyProgress(cb: (done: number, total: number) => void): () => void;
```

- [ ] **Step 4: The renderer's copying state**

In `thumbnail-renderer.ts`, import `lockedWhileCopying` beside `closesPanel`. After `let busy = false;` add:

```ts
/**
 * A recording's Copy is rendering (STC-488). Not `busy`: busy holds EVERY
 * action for the length of `perform()`, and a render can take a minute, during
 * which Trash and dismiss must still work (they cancel it). `lockedWhileCopying`
 * says which buttons wait.
 */
let copying = false;
const copyProgress = $("copyprogress") as HTMLProgressElement;
window.thumb.onCopyProgress((done, total) => {
  if (!copying || total <= 0) return;
  copyProgress.value = Math.round((done / total) * 1000);
  setStatus(`Rendering… ${Math.round((done / total) * 100)}%`);
});
```

Change `setActionsEnabled`'s loop body to:

```ts
    if (btn.hidden) continue;
    const action = btn.dataset.action as PanelAction;
    btn.disabled = !on || (copying && lockedWhileCopying(action));
```

Add, before `perform`:

```ts
/**
 * A recording's Copy: render, then the pasteboard. Runs OUTSIDE `perform()`'s
 * `busy`, so Trash and dismiss stay live for its whole length.
 */
async function copyRecording(): Promise<boolean> {
  if (copying) return false;
  copying = true;
  copyProgress.value = 0;
  copyProgress.hidden = false;
  setActionsEnabled(true);           // applies the copying locks
  setStatus("Rendering… 0%");
  try {
    const r = await window.thumb.copyRecording(dir);
    if (r.ok) setStatus("Copied, paste anywhere");
    else if (r.cancelled) setStatus("");
    else setStatus(`Could not copy: ${r.detail ?? "unknown error"}`);
    return r.ok;
  } finally {
    copying = false;
    copyProgress.hidden = true;
    setActionsEnabled(true);
  }
}
```

At the top of `perform`, before `if (busy) return false;`:

```ts
  if (copying && lockedWhileCopying(action)) return false;   // a key or menu id reaching a locked action
  if (action === "copy" && take.kind === "recording") return copyRecording();
```

In `run`, replace the recording guard comment and line (`// A recording has no Copy until STC-395 …` / `if (take.kind !== "shot") return false;`) with:

```ts
    // A recording's Copy never reaches here: `perform` routes it to
    // `copyRecording`, outside `busy` (STC-488).
    if (take.kind !== "shot") return false;
```

In the right-click handler, change `window.thumb.menu({ take, busy })` to `window.thumb.menu({ take, busy, copying })`, and find `thumbnail:menu` in `main.ts` and confirm it forwards the whole context object to `buildThumbMenu` (add `copying` to whatever it destructures if it doesn't).

- [ ] **Step 5: Main's handler**

In `app/src/main.ts`, import:

```ts
import { startCopyRender, cancelCopyRender, copyRenderInFlight, cancelAllCopyRenders } from "./copy-render-window.js";
import {
  copiesRoot, copyPathFor, purgeDecision, COPY_PURGE_INTERVAL_MS, COPY_PURGE_FIRST_DELAY_MS,
} from "./recording-copy.js";
```

Add beside the other `panel:` handlers:

```ts
/**
 * A recording's Copy (STC-488): render the take to `copiesRoot`, then put the
 * file on the pasteboard. A finished copy that still exists is reused, so a
 * second Copy is instant. Only a recording comes here; a shot's Copy is still
 * `still:export`.
 */
ipcMain.handle("panel:copyRecording", async (e, dir: string) => {
  if (typeof dir !== "string" || !insideTempTakesRoot(process.env, dir) || takeFor(dir)?.kind !== "recording") {
    return { ok: false, detail: "not a recording on a panel" };
  }
  if (!sup) return { ok: false, detail: "the helper is not running" };
  const out = copyPathFor(process.env, dir);
  if (!existsSync(out)) {
    const panel = e.sender;
    const r = await startCopyRender({
      takeDir: dir, outPath: out, dist: here, rendererDir: join(here, "..", "renderer"),
      delayMs: Number(process.env.STC_COPY_RENDER_DELAY_MS) || undefined,
      grant: (id, d) => openTakes.set(id, d),
      revoke: (id) => openTakes.delete(id),
      onProgress: (done, total) => {
        if (!panel.isDestroyed()) panel.send("thumb:copyProgress", done, total);
      },
    });
    if (!r.ok) return r.cancelled ? { ok: false, cancelled: true } : { ok: false, detail: r.detail };
  }
  try {
    const line = await sup.copyFile(out);
    if (line?.ev === "error") return { ok: false, detail: String(line.detail ?? line.code ?? "the pasteboard refused it") };
  } catch (err: any) {
    return { ok: false, detail: String(err?.detail ?? err?.message ?? err) };
  }
  return { ok: true };
});
```

`openTakes` is the existing `Map<number, string>` at the top of `main.ts`; `grant` writes the render window's sender id into it, which is all the guarded `preview:*` and `take:captureId` handlers check. Confirm `insideTempTakesRoot` is already imported (it is, from `./temp-takes.js`).

- [ ] **Step 6: Typecheck, build, run the e2e**

Run: `npm run typecheck && npm run app:build && npx vitest run app/test/recording-copy.e2e.test.ts app/test/recording-panel.e2e.test.ts app/test/panel-waits.e2e.test.ts`
Expected: the four new tests PASS; `recording-panel.e2e`'s first test now FAILS on `expect(await panel.isVisible("#copy")).toBe(false)`. Change that line to `.toBe(true)`, and its test name from "with no Copy" to "with Copy", with a comment `// STC-488 gave a recording Copy.` Re-run: all pass. Before calling any failure flake, count orphaned Electron processes (`pgrep -fl Electron | wc -l`) and check `uptime` (CLAUDE.md, e2e).

- [ ] **Step 7: Commit**

```bash
git add app/src/main.ts app/src/thumbnail-preload.ts app/src/thumbnail-renderer.ts app/renderer/thumbnail.html \
  app/test/recording-copy.e2e.test.ts app/test/recording-panel.e2e.test.ts
git commit -m "STC-488: Copy on a recording's panel renders it and puts the file on the pasteboard"
```

---

### Task 7: Cancel, reuse, quit, and the purge

**Files:**
- Modify: `app/src/main.ts` (`panel:trash`, `panel:dismiss`, `runQuitTeardown`, the purge timers)
- Modify: `app/test/recording-copy.e2e.test.ts` (four more tests)

**Interfaces:**
- Consumes: `cancelCopyRender`, `cancelAllCopyRenders` (Task 5); `purgeDecision`, `copiesRoot`, `COPY_PURGE_*` (Task 1); `sup.pasteboardFiles` (Task 3).

- [ ] **Step 1: Write the failing e2e tests**

Append inside the `describe` in `recording-copy.e2e.test.ts`:

```ts
  test("Copy, then Trash: the copy outlives the take", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);
    const { path } = copyRequests(l.copyLog)[0]!;
    await clickThatCloses(panel, "#trash");
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: POLL_MS }).toBe(0);
    expect(existsSync(path), "the paste still works").toBe(true);
    void dir;
  }, 300_000);

  test("Trash during a render cancels it: no render window, no partial, no pasteboard write", async () => {
    const l = await launch();
    await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: POLL_MS }).toBe(1);
    await clickThatCloses(panel, "#trash");
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: POLL_MS }).toBe(0);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(readdirSync(l.copies)).toEqual([]);
    expect(copyRequests(l.copyLog)).toEqual([]);
  }, 300_000);

  test("dismissing mid-render cancels it (Review Focus 2)", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: POLL_MS }).toBe(1);
    await clickThatCloses(panel, "#dismiss");
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: POLL_MS }).toBe(0);
    expect(readdirSync(l.copies)).toEqual([]);
    expect(copyRequests(l.copyLog)).toEqual([]);
    expect(existsSync(dir), "dismiss leaves the take where it was").toBe(true);
  }, 300_000);

  test("a second Copy reuses the finished file without rendering again", async () => {
    const l = await launch();
    await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);
    await expect.poll(() => panel.isEnabled("#copy"), { timeout: POLL_MS }).toBe(true);
    await panel.click("#copy");
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: POLL_MS }).toBe(2);
    expect(await windowCount(app!, "copy-render.html"), "no second render").toBe(0);
    expect(copyRequests(l.copyLog)[1]!.path).toBe(copyRequests(l.copyLog)[0]!.path);
  }, 300_000);
```

Run: `npm run app:build && npx vitest run app/test/recording-copy.e2e.test.ts`
Expected: the cancel tests FAIL (the render window survives the panel closing, and a copy file appears).

- [ ] **Step 2: Cancel on Trash and dismiss**

In `panel:dismiss`, after the `insideCaptureRoot` guard:

```ts
  // STC-488: closing the panel ends any render of its Copy. Nobody is
  // waiting for it any more.
  await cancelCopyRender(dir);
```

In `panel:trash`, immediately before `if (!existsSync(dir)) { dismissThumbnail(dir); …`, which is AFTER the confirm branch:

```ts
  // STC-488: a Trash cancels a running Copy render, and only once the Trash
  // is decided. A declined confirmation leaves the render running.
  await cancelCopyRender(dir);
```

and inside the confirm branch, cancel only when the confirmation went through:

```ts
  if (trashStyle(origin) === "confirm") {
    const r = await trashWithConfirmation([{ path: dir, label: "this take", plural: false }]);
    if (r.ok) await cancelCopyRender(dir);
    return r;
  }
```

(Check `trashWithConfirmation`'s return shape; the renderer reads `ok`/`cancelled`, so `ok` is there.)

- [ ] **Step 3: Quit**

In `runQuitTeardown`, beside `cancelCountdown();`:

```ts
  // STC-488: a Copy render at quit is abandoned and its partial deleted.
  // The take itself is the unsaved-takes warning's business, and is already
  // counted (its panel is open).
  void cancelAllCopyRenders();
```

- [ ] **Step 4: The purge**

Add a function near `presentRecordingPanel`:

```ts
/**
 * STC-488: delete copies older than 24 h, except the one on the clipboard.
 * The clipboard is asked ONCE, here. If it can't be read, the round is
 * skipped (`purgeDecision`'s undefined): a file that might be on the clipboard
 * is worth one more hour on disk.
 */
async function purgeCopies(): Promise<void> {
  const root = copiesRoot(process.env);
  let names: string[];
  try { names = await readdir(root); } catch { return; }   // no folder yet: nothing to purge
  let onClipboard: Set<string> | undefined;
  try {
    const line = await sup?.pasteboardFiles();
    if (line && line.ev !== "error" && Array.isArray(line.paths)) onClipboard = new Set(line.paths.map(String));
  } catch { /* undefined: skip this round */ }
  const entries = [];
  for (const name of names) {
    try { entries.push({ name, mtimeMs: (await stat(join(root, name))).mtimeMs }); } catch { /* gone */ }
  }
  for (const name of purgeDecision(entries, Date.now(), onClipboard, root)) {
    await rm(join(root, name), { force: true }).catch((e) => {
      console.error("[copy-purge] could not delete:", name, e);
    });
  }
}
```

and after the `TRASH_SWEEP_INTERVAL_MS` `setInterval` in `app.whenReady()`:

```ts
  // STC-488: its own timer (see COPY_PURGE_INTERVAL_MS), and the first round
  // after startup rather than during it, since it asks the helper.
  setTimeout(() => { void purgeCopies(); }, COPY_PURGE_FIRST_DELAY_MS);
  setInterval(() => { void purgeCopies(); }, COPY_PURGE_INTERVAL_MS);
```

Confirm `readdir`, `stat` and `rm` are imported from `node:fs/promises` in `main.ts`, and add any that are missing. Never let `purgeCopies` touch anything outside `copiesRoot`: `purgeDecision` returns bare names, joined to `root` here.

- [ ] **Step 5: Run everything that touches the panel**

Run: `npm run typecheck && npm run app:build && npx vitest run app/test/recording-copy.e2e.test.ts app/test/recording-panel.e2e.test.ts app/test/panel-waits.e2e.test.ts app/test/thumbnail.e2e.test.ts app/test/nothing-lost.e2e.test.ts && npm test`
Expected: all PASS. `npm test` is the whole CI suite and must be green.

- [ ] **Step 6: Commit**

```bash
git add app/src/main.ts app/test/recording-copy.e2e.test.ts
git commit -m "STC-488: Trash, dismiss and quit cancel a copy render; a second Copy reuses the file; copies purge after 24 h"
```

---

### Task 8: What only a Mac can settle, and the record

**Files:**
- Create: `docs/STC-488-RUNBOOK.md`
- Modify: `docs/TICKET-LOG.md` (a row), `CLAUDE.md` (one table row)
- Modify: `docs/superpowers/specs/2026-10-01-stc-488-copy-recording-design.md` (the five deviations)

- [ ] **Step 1: The runbook**

```markdown
# STC-488 runbook — copying a recording

Run from branch `accounts/stc-488-copy-recording` until it merges, then `master`.

```bash
git fetch origin && git checkout accounts/stc-488-copy-recording
helper/build.sh && npm run app:start
```

## 0. The pasteboard test (needs your terminal, not an agent's)

```bash
npx vitest run helper/test/copy-file.grant.test.ts
```

Must show 1 passed. A failure here means the helper never put the file on the pasteboard, and nothing below will paste.

## 1. Paste targets

Record 10 s of anything with the pointer moving. On the panel, press Copy and wait for "Copied, paste anywhere". Then paste into each of these and write down what arrives:

| target | expected |
|---|---|
| Finder (a folder, ⌘V) | the `.mp4`, named after the take, with the cursor visible when played |
| Slack (a DM to yourself) | an uploaded video |
| Mail (a new message) | an attachment |
| Messages | a video bubble |

A target that pastes a file path as text instead is a finding. Note which one.

## 2. Copy, then Trash

Copy, wait for "Copied", press Trash and let the undo toast expire. Then paste in Finder. It must still paste the video.

## 3. A real 4K minute

Record 60 s at full resolution. Press Copy and time "Rendering…" to "Copied". Expect around 40 s (export is about 1.5× faster than realtime). Write the number down. Also: does the progress bar read as progress, or does it look stalled at any point?

## 4. Cancel

Start a Copy on a 60 s take and press Trash halfway. Then check that `~/Library/Application Support/Capture/copies/` has no `.partial` file and no new `.mp4`.

## 5. The purge (optional, slow)

Set a copy's mtime back 25 h (`touch -t` to yesterday minus an hour), copy a DIFFERENT file to the clipboard, and relaunch. After about 60 s the old copy must be gone. Repeat with the old copy itself on the clipboard: it must survive.
```

- [ ] **Step 2: TICKET-LOG and CLAUDE.md**

Append a row to `docs/TICKET-LOG.md`'s table:

```markdown
| STC-488 | **Copy a recording from the panel — DONE <date>.** Split out of STC-395 (2026-10-01). Copy RENDERS (a raw display.mp4 has no cursor), so STC-392's APFS clone was dropped: the render is already independent of the take. A hidden window per job (`copy-render-window.ts`) loads the take through `session-io.ts`, the editor's loader lifted so the two cannot fork, runs the unchanged `exportSession`, and main writes `<take>.mp4` into `copiesRoot` via `.partial` + rename, then the helper's new `copy-file` puts it on the pasteboard as an NSURL. Save/Edit/Copy lock during the render (`lockedWhileCopying`); Trash/dismiss/quit cancel it by destroying the window. Copies purge after 24 h on their own hourly timer, except the clipboard's, and skip a round when the clipboard can't be read. Runbook `docs/STC-488-RUNBOOK.md`: paste targets and 4K render time are unverified on hardware. |
```

Add to `CLAUDE.md`'s "Where things are" table, after the `transform/src/waveform.ts` row:

```markdown
| `app/src/recording-copy.ts`, `app/src/copy-render-window.ts`, `app/src/session-io.ts`, `helper/src/CopyFile.swift` | a recording's Copy (STC-488): rendered, not cloned (a raw display.mp4 has no cursor), in a hidden window per job that loads through `session-io.ts`, the ONE take loader the editor also uses; written to `copiesRoot` via `.partial` + rename; put on the pasteboard by the helper's `copy-file` as an NSURL; purged after 24 h except the clipboard's file. `lockedWhileCopying` (panel-actions.ts) owns which actions wait. `docs/STC-488-RUNBOOK.md` |
```

Then run the CLAUDE.md size budget test if one exists: `ls transform/test | grep -i claude`, then run it.

- [ ] **Step 3: Bring the spec in line**

In the spec, edit §2 (drop the ` (2)` suffix sentence and say why), §3 (cancel = destroy the window; main writes the partial), §5 (the purge's own hourly timer and 60 s first run) and §6 (the pasteboard round trip is `copy-file.grant.test.ts`, not CI). Each edit cites this plan's "Deviations" list.

- [ ] **Step 4: Commit, push, PR**

```bash
git add docs/STC-488-RUNBOOK.md docs/TICKET-LOG.md CLAUDE.md docs/superpowers/specs/2026-10-01-stc-488-copy-recording-design.md
git commit -m "STC-488: runbook, ticket-log row, and the spec brought in line with the build"
git push -u origin HEAD
gh pr create --base master --title "STC-488: copy a recording from the panel"
```

Then `npm run merge -- <pr>` only once CI is green. Hand Patrick the runbook with the branch name (CLAUDE.md: hand off a runbook WITH its branch).
