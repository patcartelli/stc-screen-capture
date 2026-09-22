import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from "node:fs";
import { rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./_editor-fixture.js";
import { hasWindow } from "./_windows.js";
import { toastPage, toastText } from "./_toast.js";
import { tagMp4 } from "@transform/media-tag.js";
import { mintCaptureId } from "@transform/capture-id.js";
import { captureDocForWrite, CAPTURE_DOC_FILE } from "@transform/capture-doc.js";

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
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

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
   * unmatched loose file, and `looseFileItem` WITHHOLDS "open"/"rename" for
   * one with no bundle (`library-items.ts`) — a drop from 4 action buttons
   * to 2 that a stale, un-refreshed render could not produce.
   */
  test("the survivor is trashed, the grid refreshes, and a retry finishes rather than throwing", async () => {
    if (!app) throw new Error("no app launched");
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(1);
    const actionCount = () => page.locator(".libtile:first-child .libactions button").count();
    expect(await actionCount()).toBe(4);   // open, rename, reveal, delete

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

    // (b) the grid refreshed.
    await expect.poll(() => actionCount(), { timeout: 20_000 }).toBe(2);
    expect(await itemCount(page)).toBe(1);

    // (c) a retry finishes rather than throwing — the refreshed tile now
    // carries only the surviving file, so this click sends a single target.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await page.click('.libtile:first-child button[data-action="delete"]');
    await expect.poll(() => itemCount(page), { timeout: 20_000 }).toBe(0);
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(false);
  }, 60_000);

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
});
