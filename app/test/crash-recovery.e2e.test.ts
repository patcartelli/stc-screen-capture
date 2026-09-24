import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder, makeStillFolder } from "./_take-fixture.js";
import { windowCount } from "./_windows.js";
import { stamp, RAW_SUBDIR } from "../src/takes.js";

/**
 * A temp-take folder name that is recent, not a hardcoded calendar date.
 *
 * `purgeStaleTempTakes` computes age from the directory NAME's own timestamp
 * (`temp-takes.ts`'s `ageMs`), against `TEMP_TAKE_MAX_AGE_MS` (7 days) — so a
 * fixture hardcoded to a date early in this file's life (e.g. "2026-09-15")
 * silently crosses that threshold the moment real calendar time carries the
 * test machine's clock 7 days past it, and gets purged before
 * `recoverUnsavedTakes` ever reaches the dialog these tests exist to check.
 * Every one of this file's non-stale fixtures must stay comfortably under a
 * week old regardless of what day it is actually run, the same way the
 * deliberately-old "2020-01-01" fixture in the purge test must stay
 * comfortably OVER it. `offsetMs` also keeps multiple fixtures in one test
 * orderable (older offset = older take) without the two ever landing on the
 * same second.
 */
const recentStamp = (offsetMs: number): string => stamp(new Date(Date.now() - offsetMs));

/**
 * Crash recovery, end to end (STC-393 requirement 3).
 *
 * `recoverUnsavedTakes` in `main.ts` cannot be unit-tested directly — it is
 * Electron-glue (a `dialog.showMessageBox`, `presentThumbnail`, `openLibrary`)
 * with no pure half to split off, the same shape every other main-process-only
 * behaviour in this app is in. So this drives the REAL startup path: seed temp
 * storage as a crashed previous run would have left it, launch, and watch what
 * happens before a person could ever click anything.
 *
 * ## The dialog has to be stubbed before it can fire, not after
 *
 * `manage.e2e.test.ts`'s stub pattern (`app.evaluate` replacing
 * `dialog.showMessageBox`) works for a USER-TRIGGERED dialog, stubbed any time
 * before the click that opens it. This one fires automatically at
 * `app.whenReady()`, racing the test's own setup — so the stub has to land the
 * INSTANT `electron.launch()` resolves, before `firstWindow()` is even
 * awaited. Playwright's CDP connection to the main process is live as soon as
 * `launch()` returns; `app.whenReady()` still has real async work ahead of it
 * (`mkdir` the temp root, start the supervisor) before `recoverUnsavedTakes`
 * can even call the dialog, which is the margin this relies on.
 */
const root = join(__dirname, "..", "..");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

interface Seeded { recordings: string; tempTakes: string; userData: string }

function seed(): Seeded {
  return {
    recordings: mkdtempSync(join(tmpdir(), "stc-recovery-lib-")),
    tempTakes: mkdtempSync(join(tmpdir(), "stc-recovery-temp-")),
    userData: mkdtempSync(join(tmpdir(), "stc-ud-")),
  };
}

/** Launch, stubbing the recovery dialog before the app can reach it. */
async function launch(s: Seeded, response: 0 | 1): Promise<{ win: Page; calls: () => Promise<number> }> {
  app = await electron.launch({
    args: [root, `--user-data-dir=${s.userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: s.recordings, STC_TEMP_TAKES_DIR: s.tempTakes,
      STC_NO_SHUTTER: "1",
    },
  });
  // The stub itself counts its own calls, in the MAIN process, so a test can
  // tell "the dialog fired once" from "it fired and this raced it" without a
  // second IPC channel.
  await app.evaluate(({ dialog }, resp) => {
    (globalThis as any).__recoveryCalls = 0;
    dialog.showMessageBox = (async (..._args: unknown[]) => {
      (globalThis as any).__recoveryCalls++;
      return { response: resp, checkboxChecked: false };
    }) as any;
  }, response);
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { win, calls: () => app!.evaluate(() => (globalThis as any).__recoveryCalls ?? 0) };
}

describe("crash recovery (STC-393)", () => {
  test("no orphaned temp takes — no prompt at all", async () => {
    const s = seed();
    const { calls } = await launch(s, 1);
    // No durable signal that recovery has finished running (there is nothing
    // to wait FOR when it does nothing), so this waits out the window in
    // which it would have fired and then asserts it did not.
    await new Promise((r) => setTimeout(r, 2000));
    expect(await calls()).toBe(0);
  }, 60_000);

  test("a stale (>7 day) temp take is purged silently, never prompted", async () => {
    const s = seed();
    const stale = join(s.tempTakes, "2020-01-01_00-00-00");
    makeStillFolder("2020-01-01_00-00-00", { into: s.tempTakes });
    const { calls } = await launch(s, 1);
    await expect.poll(() => existsSync(stale), { timeout: 15_000 }).toBe(false);
    // Give the (already-purged) prompt path a moment it would have used.
    await new Promise((r) => setTimeout(r, 1000));
    expect(await calls()).toBe(0);
  }, 60_000);

  test("Discard all deletes every orphaned temp take", async () => {
    const s = seed();
    makeStillFolder(recentStamp(2 * 60 * 60 * 1000), { into: s.tempTakes });
    makeTakeFolder(recentStamp(1 * 60 * 60 * 1000), { into: s.tempTakes });
    const { calls } = await launch(s, 1);   // 1 = "Discard all"
    await expect.poll(() => calls(), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => readdirSync(s.tempTakes).length, { timeout: 15_000 }).toBe(0);
    // Nothing was ever promoted — discarding must not leave a trace in the library.
    expect(readdirSync(s.recordings)).toEqual([]);
  }, 60_000);

  test("Review reopens a recovered still's panel", async () => {
    const s = seed();
    const name = recentStamp(60 * 60 * 1000);
    makeStillFolder(name, { into: s.tempTakes });
    const { calls } = await launch(s, 0);   // 0 = "Review"
    await expect.poll(() => calls(), { timeout: 15_000 }).toBe(1);
    await expect.poll(
      () => windowCount(app!, "thumbnail.html"),
      { timeout: 15_000 },
    ).toBe(1);
    // Still sitting in temp — the panel is open, not yet settled.
    expect(existsSync(join(s.tempTakes, name))).toBe(true);
  }, 60_000);

  test("Review promotes a recovered recording straight to the library", async () => {
    const s = seed();
    const name = recentStamp(60 * 60 * 1000);
    makeTakeFolder(name, { into: s.tempTakes });
    const { win, calls } = await launch(s, 0);   // 0 = "Review"
    await expect.poll(() => calls(), { timeout: 15_000 }).toBe(1);
    // Promoted into `raw/` now (STC-413), not directly under the recordings
    // root — a top-level listing would show `raw` itself, not the take's own
    // stamped name.
    await expect.poll(() => readdirSync(join(s.recordings, RAW_SUBDIR)), { timeout: 15_000 })
      .toEqual([name]);
    expect(existsSync(join(s.tempTakes, name))).toBe(false);
    // The main window came to the front rather than being left showing
    // whatever it opened with — the closest this app has to "reveal it".
    await expect.poll(() => win.textContent("#takes"), { timeout: 15_000 }).toContain(name.slice(0, 10));
  }, 60_000);

  test("most recent first: the newest recovered still ends up frontmost in the stack", async () => {
    const s = seed();
    // Three stills, ordered so their timestamps sort unambiguously — furthest
    // offset (oldest) first, so `newest`'s literal offset (smallest) really is
    // the most recent of the three.
    makeStillFolder(recentStamp(3 * 60 * 60 * 1000), { into: s.tempTakes });
    makeStillFolder(recentStamp(2 * 60 * 60 * 1000), { into: s.tempTakes });
    const newest = recentStamp(1 * 60 * 60 * 1000);
    makeStillFolder(newest, { into: s.tempTakes });
    const { calls } = await launch(s, 0);
    await expect.poll(() => calls(), { timeout: 15_000 }).toBe(1);
    await expect.poll(
      () => app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes("thumbnail.html")).length),
      { timeout: 15_000 },
    ).toBe(3);

    // The frontmost panel (stack index 0) is the one `presentThumbnail` was
    // called with LAST — recovery walks oldest-first so that lands on the
    // newest capture. Read real window bounds from the main process rather
    // than re-deriving `stackPosition`'s arithmetic: DEFAULT_CORNER is
    // bottom-right, where older (higher-index) panels are pushed UP
    // (`stackPosition`'s `inward = -1`), so the newest panel has the
    // LARGEST y of the three.
    const panels = await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().includes("thumbnail.html"))
        .map((w) => ({ url: w.webContents.getURL(), y: w.getBounds().y })));
    const byY = [...panels].sort((a, b) => b.y - a.y);
    expect(new URL(byY[0]!.url).searchParams.get("dir")).toMatch(new RegExp(`${newest}$`));
  }, 60_000);
});
