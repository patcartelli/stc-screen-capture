import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from "node:fs";
import { rm, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./_editor-fixture.js";
import { hasWindow } from "./_windows.js";
import { toastPage, toastText } from "./_toast.js";
import { tagMp4 } from "@transform/media-tag.js";
import { mintCaptureId } from "@transform/capture-id.js";
import { captureDocForWrite, CAPTURE_DOC_FILE } from "@transform/capture-doc.js";
import { renameCapture } from "../src/takes.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The library's two-object delete (STC-413 Task 11): a capture is now a
 * finished FILE at the top level of the folder, plus its source BUNDLE one
 * level down in `raw/`, linked by an id embedded in both. Before this task,
 * `renderer.ts`'s delete handler did `item.dir ?? item.file` — a single
 * target — so a matched item (both halves present) only ever trashed the
 * bundle and silently left the finished file behind. These tests drive that
 * through the REAL app rather than the pure scan (`library-scan.test.ts`
 * already covers the scan's own matching rules), because the bug lived in
 * the IPC boundary and the renderer's fallback, not in `library.ts`.
 *
 * `refreshLibrary`/`itemCount`/`deleteFirstItem`/`openFirstItem`/
 * `renameFirstItem`/`editorIsOpen` are defined here and nowhere else — Task
 * 13 (rename/open-a-file) reuses them. They close over the module-level
 * `app`/`page` rather than taking them as parameters, which is what lets the
 * brief's own call shape (`deleteFirstItem(page)`, one argument) still reach
 * the ElectronApplication a native dialog stub and a main-process window
 * count both need (STC-416: window presence must be asked of the main
 * process, never inferred from `app.windows()`).
 */

const repoRoot = join(__dirname, "..", "..");
const BUNDLE = "2026-09-22_14-30-01";

/** Everything the "matched item" fixture needs: one finished file, one bundle, one shared id. */
function seedFixture(root: string): void {
  const bundleDir = join(root, "raw", BUNDLE);
  mkdirSync(bundleDir, { recursive: true });
  // A real, valid recording bundle — the same three sidecars
  // `_take-fixture.ts`'s `makeTakeFolder` uses, copied by hand here because
  // the fixture also needs a `capture.json` and a matching top-level file,
  // which `makeTakeFolder` knows nothing about (it predates STC-413).
  for (const f of ["anchors.json", "events.json", "display.mp4"]) {
    const bytes = readFileSync(join(repoRoot, "fixtures", "basic", f));
    writeFileSync(join(bundleDir, f), bytes);
  }
  const id = mintCaptureId();
  writeFileSync(join(bundleDir, CAPTURE_DOC_FILE), JSON.stringify(captureDocForWrite(id)));
  const videoBytes = readFileSync(join(repoRoot, "fixtures", "basic", "display.mp4"));
  writeFileSync(join(root, "login-bug.mp4"), tagMp4(new Uint8Array(videoBytes), id));
}

let app: ElectronApplication | undefined;
let page: Page;
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "stc-libfolder-"));
  seedFixture(root);
  const launched = await launchApp(root);
  app = launched.app;
  page = launched.win;
});
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

/** Poll until the tile set stops changing — the render is a single synchronous
 *  DOM replace once the IPC round trip resolves, so this converges in at most
 *  a couple of polls; the bound is a backstop, not the expected path. */
async function stableTileList(p: Page, timeoutMs = 10_000): Promise<void> {
  const snapshot = () => p.evaluate(() =>
    [...document.querySelectorAll(".libtile")]
      .map((t) => (t as HTMLElement).dataset.id ?? "")
      .join(","));
  const start = Date.now();
  let last = await snapshot();
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    const now = await snapshot();
    if (now === last) return;
    if (Date.now() - start > timeoutMs) return;   // best effort; the caller's own assertion says whether it settled right
    last = now;
  }
}

/**
 * Force a re-scan after the filesystem changed out from under the app.
 *
 * There is no dedicated refresh control — `renderer.ts`'s `setFilter` calls
 * `refreshTakes()` UNCONDITIONALLY, so re-clicking the already-selected
 * "All" chip is the one user-reachable way to trigger it.
 */
export async function refreshLibrary(p: Page): Promise<void> {
  await p.click('.libfilters .chip[data-filter="all"]');
  await stableTileList(p);
}

export async function itemCount(p: Page): Promise<number> {
  return p.locator(".libtile").count();
}

/**
 * The first tile's rendered PRIMARY title text (Task 13 fix round 1) — the
 * reviewer's own point: a unit test on `LibraryItem.label` alone does not
 * prove the screen updated, since `library-view.ts`'s `titleFor` reads
 * `item.label ? item.label : item.id`, and only the rendered DOM shows
 * which of the two actually won.
 *
 * `titleFor` sets `.libtitle`'s `textContent` to the label/id FIRST, then
 * (when there is a label) appends a `.stamp` child span showing `item.id`
 * too — so `.innerText()` on the whole element would always contain the
 * bundle's stamp regardless of whether the label itself updated. Reading
 * only the element's own first text node (before that child is appended)
 * is what actually discriminates "the title still says the old stamp" from
 * "the title says the new name, with the stamp as a secondary annotation".
 */
export async function tileTitle(p: Page): Promise<string> {
  return p.locator(".libtile:first-child .libtitle").first()
    .evaluate((el) => el.childNodes[0]?.textContent ?? "");
}

/**
 * Click Delete on the first tile, auto-confirming the native "Move to
 * Trash?" dialog — `manage.e2e.test.ts`'s own idiom (STC-294) for the same
 * dialog `trashWithConfirmation` puts up.
 */
export async function deleteFirstItem(p: Page): Promise<void> {
  if (!app) throw new Error("deleteFirstItem: no app launched");
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await p.click('.libtile:first-child button[data-action="delete"]');
  await stableTileList(p);
}

export async function openFirstItem(p: Page): Promise<void> {
  await p.click('.libtile:first-child button[data-action="open"]');
}

export async function renameFirstItem(p: Page, name: string): Promise<void> {
  await p.click('.libtile:first-child button[data-action="rename"]');
  await p.fill(".labelinput", name);
  await p.press(".labelinput", "Enter");
  await stableTileList(p);
}

/** Whether the editor window (`editor.html`) is up, read from the main process (STC-416). */
export async function editorIsOpen(_p: Page): Promise<boolean> {
  if (!app) throw new Error("editorIsOpen: no app launched");
  return hasWindow(app, "editor.html");
}

describe("delete removes both objects (STC-413)", () => {
  test("delete removes the finished file and its bundle together", async () => {
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(true);   // control
    expect(existsSync(join(root, "raw", BUNDLE))).toBe(true);
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);

    await deleteFirstItem(page);

    expect(existsSync(join(root, "login-bug.mp4"))).toBe(false);
    expect(existsSync(join(root, "raw", BUNDLE))).toBe(false);
  }, 60_000);

  test("a bundle whose file was deleted in Finder lists as unfinished", async () => {
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);
    await rm(join(root, "login-bug.mp4"));
    await refreshLibrary(page);
    expect(await itemCount(page)).toBe(1);   // the bundle, now orphaned
  }, 60_000);

  test("deleting a foreign file with no bundle does not throw", async () => {
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);
    await writeFile(join(root, "holiday.mp4"), await readFile(join(root, "login-bug.mp4")));
    await rm(join(root, "login-bug.mp4"));
    await rm(join(root, "raw", BUNDLE), { recursive: true });
    await refreshLibrary(page);
    expect(await itemCount(page)).toBe(1);   // the foreign file, unmatched

    await deleteFirstItem(page);

    expect(existsSync(join(root, "holiday.mp4"))).toBe(false);
  }, 60_000);
});

/**
 * STC-413 review round 1: two objects means two trash calls, and either can
 * fail or hit its bound. The naive version — a sequential loop that throws
 * out of its own iteration on the first failure — recreates exactly the bug
 * this task closes: one object gone, the other left behind, and (worse) a
 * RETRY on the stale tile throws immediately on the half that already went,
 * before ever reaching the half still there. Three rules close it:
 * (1) both paths are attempted independently; (2) a path already gone is a
 * SUCCESS, not a failure; (3) the grid refreshes on any non-cancelled
 * outcome, not only full success.
 */
describe("a partial trash failure does not strand the other half (STC-413 review round 1)", () => {
  /**
   * `shell.trashItem` is monkey-patched (the reviewer's own repro shape,
   * via `app.evaluate`) so its FIRST call rejects and every later call goes
   * through for real. `take:delete` builds its targets as `[file, dir]`
   * (STC-413's own field order), so the FIRST call is the FILE — failing
   * it and letting the BUNDLE succeed is what makes the refresh DOM-visible:
   * `recordingItem`'s badge/summary/actions never depend on whether `file`
   * is set, but once the bundle is gone the survivor is re-scanned as an
   * unmatched loose file, and `looseFileItem` WITHHOLDS "open" (and, with it,
   * "share" — STC-429's action is recording-only and needs a bundle to open
   * into an editor) for one with no bundle (`library-items.ts`) — a drop
   * from 5 action buttons to 3 that a stale, un-refreshed render could not
   * produce.
   *
   * Updated for Task 13: the survivor's action count used to drop to 2
   * (`looseFileItem` withheld "rename" too, for want of a bundle to write
   * `take.json` beside). Rename no longer needs one — it renames the FILE
   * directly now — so the honest post-refresh count is 3 (rename, reveal,
   * delete), and asserting the stale 2 here would be exactly the "test
   * pinning the old contract" CLAUDE.md already warns against re-flattening
   * rather than restating.
   */
  test("the survivor is trashed, the grid refreshes, and a retry finishes rather than throwing", async () => {
    if (!app) throw new Error("no app launched");
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);
    const actionCount = () => page.locator(".libtile:first-child .libactions button").count();
    expect(await actionCount()).toBe(5);   // open, share, rename, reveal, delete

    await app.evaluate(({ shell }) => {
      const real = shell.trashItem.bind(shell);
      let call = 0;
      (shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = (p: string) => {
        call += 1;
        return call === 1 ? Promise.reject(new Error("synthetic trash failure")) : real(p);
      };
    });
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });

    await page.click('.libtile:first-child button[data-action="delete"]');

    // (a) the OTHER object still went — the failing first call must not
    // have skipped, or rolled back, the second.
    await expect.poll(() => existsSync(join(root, "raw", BUNDLE)), { timeout: 20_000 }).toBe(false);
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(true);   // the failed half is still there

    // The widened failure message names BOTH halves, not just the one that
    // failed — "Its source materials were removed; the file could not be."
    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 10_000 }).toBe(true);
    const alert = await toastText(app!);
    expect(alert).toContain("Its source materials");
    expect(alert).toContain("were removed");
    expect(alert).toContain("the file could not be");

    // (b) the grid refreshed — 3 now (Task 13: rename no longer needs a
    // bundle, so it survives alongside reveal/delete rather than dropping
    // out with "open").
    await expect.poll(() => actionCount(), { timeout: 20_000 }).toBe(3);
    expect(await itemCount(page)).toBe(1);

    // (c) a retry finishes rather than throwing — the refreshed tile now
    // carries only the surviving file, so this click sends a single target.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await page.click('.libtile:first-child button[data-action="delete"]');
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(0);
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(false);
    // 60_000 here was BELOW the five bounds waiting inside this test
    // (20+20+10+20+20 = 90 s), which `timeout-budget.test.ts` exists to
    // catch and duly did. Not theoretical: the reviewer saw it fail on one
    // run and pass the next, because whether the outer timeout or an inner
    // poll fires first is a race on a loaded machine — and the outer one
    // firing reports "test timed out", which names nothing.
    //
    // Raised rather than tightened. Each of those polls waits on a real
    // window-server round trip (a grid refresh, a toast window appearing),
    // and this repo has already paid for trimming an e2e wait to make an
    // arithmetic constraint fit. The number is a ceiling on a failure, not
    // a budget the passing path spends: this test runs in a few seconds.
  }, 120_000);

  /**
   * Rule 2, tested by CONSTRUCTION rather than by reasoning that Rule 3's
   * refresh makes it moot: the file is removed out from under the item
   * directly (as if an earlier partial attempt, or Finder, already moved
   * it), then `deleteTake` is called with that now-stale path alongside the
   * bundle path that IS still there — reproducing exactly the shape of a
   * stale click on an un-refreshed tile, without depending on the DOM
   * actually being stale to construct it.
   */
  test("a path that no longer exists is a success, not a failure", async () => {
    if (!app) throw new Error("no app launched");
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    const file = join(root, "login-bug.mp4");
    const dir = join(root, "raw", BUNDLE);
    await rm(file);   // as if an earlier attempt (or Finder) already moved it

    const result = await page.evaluate(
      ([f, d]) => (window as any).recorder.deleteTake(f, d),
      [file, dir],
    );
    expect(result.deleted).toBe(true);    // did not throw, did not report a failure
    expect(existsSync(dir)).toBe(false);  // the half that WAS still there is gone too
  }, 60_000);

  /**
   * The SAME rules with the failure on the other side — restored as a
   * permanent test rather than left as a behaviour someone once checked by
   * hand (review round 2).
   *
   * It is not the first test with the roles swapped for symmetry's sake.
   * The naive sequential loop this describe block exists to rule out fails
   * ASYMMETRICALLY: throwing out of iteration one leaves target two
   * unattempted, so a first-call failure is the loud case and a SECOND-call
   * failure is the quiet one — target one already succeeded, the user sees
   * something happen, and only the leftover bundle in `raw/` says otherwise.
   * A rewrite that reintroduced the loop would still pass the first test if
   * it happened to attempt them in the other order.
   *
   * `describeTrashOutcome`'s grammar also only picks the singular branch
   * here: "the file" is `plural: false`, where the first test exercises
   * "its source materials"/`plural: true`. One of the two sentences was
   * unasserted.
   */
  test("the failure on the OTHER half is reported just as honestly", async () => {
    if (!app) throw new Error("no app launched");
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);

    // Targets are built as [file, dir], so failing the SECOND call fails the
    // BUNDLE and lets the file go — the reverse of the test above.
    await app.evaluate(({ shell }) => {
      const real = shell.trashItem.bind(shell);
      let call = 0;
      (shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = (p: string) => {
        call += 1;
        return call === 2 ? Promise.reject(new Error("synthetic trash failure")) : real(p);
      };
    });
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });

    await page.click('.libtile:first-child button[data-action="delete"]');

    // The file really went, and the bundle really did not — independently
    // attempted, with no rollback pretending otherwise.
    await expect.poll(() => existsSync(join(root, "login-bug.mp4")), { timeout: 20_000 }).toBe(false);
    expect(existsSync(join(root, "raw", BUNDLE))).toBe(true);

    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 10_000 }).toBe(true);
    const alert = await toastText(app!);
    // The singular branch of the sentence — "The file was removed", not
    // "were" — which the first test's plural label cannot reach.
    expect(alert).toContain("The file");
    expect(alert).toContain("was removed");
    expect(alert).toContain("its source materials could not be");
  }, 120_000);

  /**
   * Cancelling is a decision, not a fault — and specifically, it must not
   * refresh the grid. Restored as a permanent test (review round 2).
   *
   * The refresh rule is "on any NON-CANCELLED outcome", and the tempting
   * simplification is "always refresh, it is cheap and idempotent". It is
   * not equivalent: a refresh on cancel would re-render the tile the user
   * just declined to touch, which is the app doing visible work in answer
   * to "no". Nothing else in this file pins the negative, so the
   * simplification would pass every other test here.
   */
  test("cancelling deletes nothing and does not refresh the grid", async () => {
    if (!app) throw new Error("no app launched");
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);

    // Response 1 is Cancel (`buttons: ["Move to Trash", "Cancel"]`).
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    // Change the folder UNDER the app. A refresh would pick the new file up;
    // not refreshing leaves the grid exactly as the user left it. This is
    // what makes "did not refresh" observable at all — without it, a refresh
    // that found the same one item is indistinguishable from no refresh.
    await writeFile(join(root, "holiday.mp4"), await readFile(join(root, "login-bug.mp4")));

    await page.click('.libtile:first-child button[data-action="delete"]');

    // Nothing was trashed...
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(true);
    expect(existsSync(join(root, "raw", BUNDLE))).toBe(true);
    // ...and the grid still shows what it showed, not the new file.
    expect(await itemCount(page)).toBe(1);

    // The control, and it is what stops this asserting a slow refresh rather
    // than no refresh: an EXPLICIT refresh does see the second file, so the
    // count above is a choice the code made, not a race this test won.
    await refreshLibrary(page);
    expect(await itemCount(page)).toBe(2);
  }, 60_000);
});

/**
 * Task 13 — the filename IS the label. Renaming a matched capture through
 * the grid renames the top-level FILE on disk (`takes.ts`'s new
 * `renameCapture`), never `take.json`; a file renamed by hand in Finder is
 * still found afterward, because matching is by the embedded capture id, not
 * by name. `seedFixture`'s own file is already named "login-bug.mp4" (Task
 * 11's own fixture, reused rather than duplicated), so these tests rename
 * IT rather than reproducing the brief's literal "2026-09-22_14-30-01.mp4"
 * starting name — renaming "login-bug.mp4" TO "login-bug" would be a no-op
 * and prove nothing; renaming it to something else, or renaming it away and
 * expecting the bundle to still be found, are the same claims with a
 * discriminating fixture. See the report's Decisions section.
 */
describe("the filename is the label (STC-413 Task 13)", () => {
  test("renaming a capture renames the file on disk", async () => {
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);

    await renameFirstItem(page, "renamed-clip");

    expect(existsSync(join(root, "renamed-clip.mp4"))).toBe(true);
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(false);
    // Fix round 1: on disk is not enough — the tile itself must say the new
    // name, or the rename reads as a failure to whoever is looking at it.
    await expect.poll(() => tileTitle(page), { timeout: 20_000 }).toBe("renamed-clip");
  }, 60_000);

  /**
   * Fix round 1's own regression, driven through the REAL app rather than
   * `library.ts` alone: a matched (bundle + file) capture — the normal
   * outcome of any real recording, not the degraded loose-file shapes the
   * rest of this describe block exercises — renamed through the grid, with
   * the TILE checked before and after. `library.ts`'s scan clears the
   * sidecar-sourced `label` on a match (right, so a stale `take.json`
   * cannot leak through) but the FIRST fix discarded it outright, leaving
   * `LibraryItem.label` unset — `library-view.ts`'s `titleFor` then falls
   * back to `item.id`, which for a matched item is deliberately the
   * BUNDLE's immune stamp, so the tile went on showing the OLD name
   * forever: correct on disk, wrong (and unchanged) on screen. A unit
   * assertion on `label` alone (`library-scan.test.ts`) cannot see that —
   * only the rendered tile can.
   */
  test("the tile's title changes when a matched capture is renamed — not just the file", async () => {
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);
    const before = await tileTitle(page);
    expect(before).not.toBe("");
    expect(before).not.toBe("renamed-again");   // control: not already this value

    await renameFirstItem(page, "renamed-again");

    expect(existsSync(join(root, "renamed-again.mp4"))).toBe(true);
    const after = await tileTitle(page);
    expect(after).toBe("renamed-again");
    expect(after).not.toBe(before);
  }, 60_000);

  test("a file renamed in Finder still opens its bundle", async () => {
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);

    // A plain filesystem rename — no IPC, no app involvement — is exactly
    // what a Finder rename looks like from here.
    await rename(join(root, "login-bug.mp4"), join(root, "totally-different.mp4"));
    await refreshLibrary(page);
    expect(await itemCount(page)).toBe(1);   // still one capture, not a new orphan plus a stray

    await openFirstItem(page);

    // Found by the embedded id, not by name: `openItem` opens on `item.dir`,
    // which the scan only ever sets by matching the file's tag against
    // capture.json — nothing here ever compared a filename. Polled, not a
    // bare read: the editor's `BrowserWindow` is created and navigated
    // asynchronously, and its url only commits ~80-150ms later (STC-416) —
    // a synchronous read right after the click is a real race, not a flake.
    await expect.poll(() => editorIsOpen(page), { timeout: 15_000 }).toBe(true);
  }, 60_000);

  /**
   * A direct call, no app needed — `renameCapture` is exported for this. The
   * validation lives in `takes.ts`, not behind the IPC boundary, so this is
   * the same kind of unit-level check `insideTakesRoot`'s own tests use in
   * `takes.test.ts`; it lives here because `takes.test.ts` is not part of
   * this task's own file list and the brief's own example test sits beside
   * the UI tests it complements.
   */
  test("a rename refuses to escape the folder", async () => {
    await expect(renameCapture({} as NodeJS.ProcessEnv, root,
      join(root, "login-bug.mp4"), "../../evil")).rejects.toThrow();
    // The file must be untouched — a refused rename is not a partial one.
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(true);
  });

  test("a rename refuses a bare path separator too, not only \"..\"", async () => {
    await expect(renameCapture({} as NodeJS.ProcessEnv, root,
      join(root, "login-bug.mp4"), "sub/dir")).rejects.toThrow();
  });

  /**
   * STC-413 M1: a LEADING DOT was allowed, and it is not cosmetic.
   *
   * Rule 2 of the scan skips dotfiles, so ".secret.mp4" vanishes from the
   * library — and with its file invisible, the bundle behind it reads as
   * orphaned and the sweep trashes it. Observed. A rename is a rename, not
   * a way to delete something by accident.
   */
  test("a rename refuses a leading dot — it would hide the capture", async () => {
    await expect(renameCapture({} as NodeJS.ProcessEnv, root,
      join(root, "login-bug.mp4"), ".secret")).rejects.toThrow(/dot/i);
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(true);
    expect(existsSync(join(root, ".secret.mp4"))).toBe(false);
  });

  /**
   * The live bug this task closes: Task 8's `looseFileItem` already offers
   * "rename" on an item with NO bundle at all (a genuinely foreign file —
   * see `library-items.ts`'s case 1), and the old renderer handler did
   * `const dir = item.dir; if (!dir) return;` before ever calling the
   * bridge — a click that visibly does nothing. This drives that exact
   * button, on that exact kind of item, and checks the file actually moved.
   */
  test("renaming a bundle-less item actually renames the file — the silent no-op is closed", async () => {
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);
    // A genuinely foreign file: the bytes (and the id they carry) survive,
    // but its bundle is gone, so the scan can match nothing — `dir` absent.
    await writeFile(join(root, "holiday.mp4"), await readFile(join(root, "login-bug.mp4")));
    await rm(join(root, "login-bug.mp4"));
    await rm(join(root, "raw", BUNDLE), { recursive: true });
    await refreshLibrary(page);
    expect(await itemCount(page)).toBe(1);

    await renameFirstItem(page, "vacation-clip");

    expect(existsSync(join(root, "vacation-clip.mp4"))).toBe(true);
    expect(existsSync(join(root, "holiday.mp4"))).toBe(false);
  }, 60_000);
});
