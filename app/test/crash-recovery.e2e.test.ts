import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder, makeStillFolder } from "./_take-fixture.js";
import { windowCount } from "./_windows.js";
import { stamp, RAW_SUBDIR } from "../src/takes.js";
import { RECOVERY_OFFERED_FILE } from "../src/temp-takes.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * A temp-take folder name that is recent, not a hardcoded calendar date.
 *
 * (Since the STC-465 review the purge no longer reads the NAME at all — it
 * measures from when crash recovery first OFFERED a take, and never touches
 * one that was not offered — so an old name can no longer get a fixture
 * purged. Kept anyway: a recent name is what these takes would really carry,
 * and it keeps the ordering below honest. The history, for the record:)
 *
 * `purgeStaleTempTakes` computed age from the directory NAME's own timestamp
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
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

interface Seeded { recordings: string; tempTakes: string; userData: string }

function seed(): Seeded {
  return {
    recordings: mkdtempSync(join(tmpdir(), "stc-recovery-lib-")),
    tempTakes: mkdtempSync(join(tmpdir(), "stc-recovery-temp-")),
    userData: mkdtempSync(join(tmpdir(), "stc-ud-")),
  };
}

interface Launched {
  win: Page;
  calls: () => Promise<number>;
  /** Every recovery dialog's `message` and `detail`, in order. */
  dialogs: () => Promise<{ message: string; detail: string }[]>;
  /** Every path `shell.showItemInFolder` was asked to reveal. */
  revealed: () => Promise<string[]>;
}

/** Launch, stubbing the recovery dialog before the app can reach it. */
async function launch(s: Seeded, response: 0 | 1): Promise<Launched> {
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
  // second IPC channel. It also keeps what the dialog SAID, since "N unsaved
  // takes recovered" has to match what Review then delivers.
  //
  // `shell.showItemInFolder` is stubbed in the same breath: Review reveals an
  // unfinished take in Finder, and a test must neither pop a real Finder
  // window on a Mac nor be unable to see that it asked for one.
  await app.evaluate(({ dialog, shell }, resp) => {
    const g = globalThis as any;
    g.__recoveryCalls = 0;
    g.__recoveryDialogs = [];
    g.__revealed = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.__recoveryCalls++;
      const opts = args[args.length - 1] as { message?: string; detail?: string };
      g.__recoveryDialogs.push({ message: opts?.message ?? "", detail: opts?.detail ?? "" });
      return { response: resp, checkboxChecked: false };
    }) as any;
    shell.showItemInFolder = ((p: string) => { g.__revealed.push(p); }) as any;
  }, response);
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return {
    win,
    calls: () => app!.evaluate(() => (globalThis as any).__recoveryCalls ?? 0),
    dialogs: () => app!.evaluate(() => (globalThis as any).__recoveryDialogs ?? []),
    revealed: () => app!.evaluate(() => (globalThis as any).__revealed ?? []),
  };
}

/** What a crash-recovery marker file holds: the epoch ms of the first offer. */
function markOffered(dir: string, at: number): void {
  writeFileSync(join(dir, RECOVERY_OFFERED_FILE), String(at));
}

/**
 * A take the helper died in the middle of: a video with bytes in it and no
 * `anchors.json` (written only at a clean STOP) — what `kill -9` mid-take, or
 * `recording-lost`, leaves behind. `listTempTakes` classifies it `unknown`.
 */
function makeUnfinishedTake(name: string, into: string): string {
  const dir = join(into, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "display.mp4"), Buffer.alloc(4096, 7));
  return dir;
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

  test("a take OFFERED more than 7 days ago is purged silently, never prompted again", async () => {
    const s = seed();
    const stale = join(s.tempTakes, "2020-01-01_00-00-00");
    makeStillFolder("2020-01-01_00-00-00", { into: s.tempTakes });
    markOffered(stale, Date.now() - 8 * 24 * 60 * 60 * 1000);
    const { calls } = await launch(s, 1);
    await expect.poll(() => existsSync(stale), { timeout: 15_000 }).toBe(false);
    // Give the (already-purged) prompt path a moment it would have used.
    await new Promise((r) => setTimeout(r, 1000));
    expect(await calls()).toBe(0);
  }, 60_000);

  test("a take older than 7 days that was NEVER offered is offered, not purged (STC-465 review)", async () => {
    // A still left in temp by an ignored panel, or a recording whose
    // promotion failed, in a menu-bar session that ran for over a week: the
    // app promised to offer it back on this launch, and the purge used to run
    // FIRST and delete it by the age in its name. Watched failing: the dialog
    // never fired and the directory was gone.
    const s = seed();
    const name = "2020-01-01_00-00-00";
    const stranded = join(s.tempTakes, name);
    makeStillFolder(name, { into: s.tempTakes });
    const { calls, dialogs } = await launch(s, 0);   // 0 = "Review"
    await expect.poll(() => calls(), { timeout: 15_000 }).toBe(1);
    expect((await dialogs())[0]!.message).toBe("1 unsaved take recovered");
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 15_000 }).toBe(1);
    expect(existsSync(stranded)).toBe(true);
    // ...and the offer is recorded, so the purge's week starts from NOW —
    // the one moment the user was actually shown it.
    await expect.poll(() => existsSync(join(stranded, RECOVERY_OFFERED_FILE)), { timeout: 15_000 })
      .toBe(true);
    const at = Number(readFileSync(join(stranded, RECOVERY_OFFERED_FILE), "utf8"));
    expect(Math.abs(Date.now() - at)).toBeLessThan(60_000);
  }, 60_000);

  test("Review surfaces an unfinished take in Finder, and the count says what Review delivers (STC-465 review)", async () => {
    // A still, plus the take the helper died in the middle of. Both are
    // counted — and both are then SHOWN: the still as its panel, the
    // unfinished one moved out of temp storage into `raw/` and revealed.
    // Watched failing before the fix: counted as 2, the unfinished one only
    // `console.error`ed and left in temp for the purge.
    const s = seed();
    makeStillFolder(recentStamp(2 * 60 * 60 * 1000), { into: s.tempTakes });
    const unfinished = recentStamp(1 * 60 * 60 * 1000);
    makeUnfinishedTake(unfinished, s.tempTakes);
    const { calls, dialogs, revealed } = await launch(s, 0);   // 0 = "Review"
    await expect.poll(() => calls(), { timeout: 15_000 }).toBe(1);
    const [d] = await dialogs();
    expect(d!.message).toBe("2 unsaved takes recovered");
    // Said up front, before Review, so Finder opening is not a surprise.
    expect(d!.detail).toMatch(/1 of them stopped before it finished writing/);
    expect(d!.detail).toMatch(/Finder/);

    const dest = join(s.recordings, RAW_SUBDIR, unfinished);
    await expect.poll(() => revealed(), { timeout: 15_000 }).toEqual([dest]);
    // Moved, not copied — and the bytes that survived are the bytes that arrived.
    expect(readFileSync(join(dest, "display.mp4")).length).toBe(4096);
    expect(existsSync(join(s.tempTakes, unfinished))).toBe(false);
    // The still is offered the ordinary way, alongside it.
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 15_000 }).toBe(1);
  }, 60_000);

  test("a temp directory with nothing in it is removed and never counted", async () => {
    // The helper made the directory and died before writing a byte. There is
    // nothing to offer, so it must not inflate "N unsaved takes recovered" —
    // and with nothing else there, no prompt fires at all.
    const s = seed();
    const empty = join(s.tempTakes, recentStamp(60 * 60 * 1000));
    mkdirSync(empty, { recursive: true });
    const { calls } = await launch(s, 0);
    await expect.poll(() => existsSync(empty), { timeout: 15_000 }).toBe(false);
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
