import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder, makeStillFolder } from "./_take-fixture.js";
import { THUMBNAIL_FILE } from "../src/library-items.js";
import { RAW_SUBDIR } from "../src/takes.js";
import { hasWindow } from "./_windows.js";
import { keptFileRequests } from "./_still-log.js";
import { toastText } from "./_toast.js";

/**
 * The library grid, end to end (STC-294).
 *
 * What the adapter decides is checked with no window at all in `library.test.ts`,
 * and that no view branches on kind is checked structurally in
 * `library-seam.test.ts`. What is left for this file is the wiring neither can
 * see: that a mixed root really draws both kinds of tile in one grid, that the
 * filter really narrows it, that a still's DECORATED picture really gets
 * rendered and cached beside its document, and that duplicate really produces a
 * second, independent shot.
 *
 * The ticket asks for tests over a mixed library, a stills-only library and an
 * empty one, and those are the three shapes here.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

interface Launched { win: Page; recordings: string; stillLog: string; errors: string[] }

/** `seed` populates the recordings root before Electron ever sees it. */
async function launch(seed: (recordings: string) => void): Promise<Launched> {
  const recordings = mkdtempSync(join(tmpdir(), "stc-libe2e-"));
  seed(recordings);
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // `saveFolder: null` leaves `STC_RECORDINGS_DIR` (`recordings`) as the
  // resolved root, which is where `seed()` just wrote the fixture. STC-412
  // unified `saveFolder` to govern BOTH stills and recordings, including
  // which root the library SCANS (`takesRoot`), so an active one here would
  // point the whole grid somewhere the fixture is not.
  //
  // The "never exports on its own" test below used to prove its own name by
  // reading back an otherwise-unused `destDir`; under one unified
  // `saveFolder` nothing in the app could resolve to that folder by any
  // path, so the read passed unconditionally (STC-412 final review, I3). The
  // helper's own request log is what an export would actually reach.
  const stillLog = join(mkdtempSync(join(tmpdir(), "stc-still-log-")), "requests.jsonl");
  // Seeded on DISK: `recorder:setSettings` deliberately strips `saveFolder`
  // (STC-293 review, #92 — `saveFolder` replaced `still.destination` at
  // STC-412, and the strip moved with it: it is a plain top-level field,
  // stripped the same generic way `share.destination` already was).
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    saveFolder: null,
  }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")), STC_HELPER_BIN: FAKE_HELPER,
      STC_FAKE_STILL_LOG: stillLog, STC_NO_SHUTTER: "1",
    },
  });
  const win = await app.firstWindow();
  // Collected so a failing poll can SAY why rather than just timing out. The
  // thumbnail path deliberately swallows a render failure — a tile that cannot
  // draw must cost its picture and nothing else — which on CI made "the render
  // threw" and "the tile was never painted" look identical for twenty seconds.
  const errors: string[] = [];
  win.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  win.on("pageerror", (e) => errors.push(String(e)));
  await win.waitForSelector("#capturestill");
  return { win, recordings, stillLog, errors };
}

/** The still editor window, once it is up — same idiom as `redaction.e2e.test.ts`. */
async function stillEditorWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) if (p.url().includes("still-editor.html")) return p;
    if (Date.now() - start > ms) {
      throw new Error(`no still editor window appeared within ${ms}ms; windows: `
        + JSON.stringify(app!.windows().map((p) => p.url())));
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Poll for a cached thumbnail, and report the renderer's own errors if it never arrives. */
/** 0 when the file is absent; never throws, so a poller can call it freely. */
function sizeOf(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/**
 * A file that exists, is non-empty, and has STOPPED GROWING.
 *
 * Measured rather than assumed. Polling a 6 MB `writeFile` concurrently, from
 * 120 runs, the first sighting was 0 bytes 22 times and a PARTIAL file 98
 * times — and the complete size 0 times. So "it exists" and even "it is
 * non-empty" are both states the writer passes through, and only a size that
 * has settled means the write is done.
 */
async function settledSize(path: string): Promise<number> {
  const first = sizeOf(path);
  if (first === 0) return 0;
  await new Promise((r) => setTimeout(r, 30));
  return sizeOf(path) === first ? first : 0;
}

async function expectThumbnail(dir: string, errors: string[]): Promise<void> {
  try {
    // Polled on the SIZE, not on existence. `writeFile` CREATES the file and
    // then writes it, so `existsSync` goes true in between — and a caller that
    // then reads `size` can legitimately see 0 on a file that is about to be a
    // perfectly good PNG. That is what reddened CI on #117, on a run whose
    // Test step was 110s longer than master's and so had a wider window; the
    // race predates that PR by a long way and it is the wait that was wrong,
    // not the write.
    await expect.poll(() => settledSize(join(dir, THUMBNAIL_FILE)), { timeout: 20_000 })
      .toBeGreaterThan(0);
  } catch (e) {
    throw new Error(`no ${THUMBNAIL_FILE} in ${dir} after 20s. Renderer errors:\n`
      + (errors.length ? errors.join("\n") : "(none — the tile was never painted at all)")
      + `\n${String(e)}`);
  }
}

/** The badges currently drawn, in grid order. */
const badges = (win: Page) => win.evaluate(() =>
  [...document.querySelectorAll("#libgrid .libbadge")].map((n) => n.textContent));

/** The action buttons on the tile at `i`. */
const actionsOf = (win: Page, i: number) => win.evaluate((n) => {
  const tile = document.querySelectorAll("#libgrid .libtile")[n];
  return [...(tile?.querySelectorAll("button") ?? [])].map((b) => b.dataset.action);
}, i);

async function clickAction(win: Page, i: number, action: string): Promise<void> {
  await win.locator(`#libgrid .libtile >> nth=${i}`)
           .locator(`button[data-action="${action}"]`).click();
}

describe("the library grid", () => {
  test("an empty library says so and draws no grid", async () => {
    const { win } = await launch(() => {});
    await expect.poll(() => win.locator("#empty").count(), { timeout: 15_000 }).toBe(1);
    expect(await win.locator("#libgrid").count()).toBe(0);
    // The filter chips are still there — the library is empty, not absent.
    expect(await win.locator(".libfilters .chip").count()).toBe(3);
  }, 60_000);

  test("a stills-only library lists them as stills, not as broken recordings", async () => {
    // The bug this ticket fixes: before the adapter, a still had no anchors.json
    // and so was reported as a damaged recording in the invalid list.
    const { win } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", { into: dir });
      makeStillFolder("2026-09-08_12-00-01", { into: dir });
    });
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Shot", "Shot"]);
    expect(await win.locator(".broken").count()).toBe(0);
  }, 60_000);

  test("a mixed library interleaves both kinds in one grid, newest first", async () => {
    const { win } = await launch((dir) => {
      makeTakeFolder("2026-09-08_12-00-00", { into: dir });
      makeStillFolder("2026-09-08_12-00-01", { into: dir });
      makeTakeFolder("2026-09-08_12-00-02", { into: dir });
      makeStillFolder("2026-09-08_12-00-03", { into: dir });
    });
    // Interleaved by timestamp, NOT clumped by kind: the directory name is the
    // sort key for both, which is what makes one index over two formats
    // possible at all.
    await expect.poll(() => badges(win), { timeout: 15_000 })
      .toEqual(["Shot", "Recording", "Shot", "Recording"]);
    expect(await win.locator(".broken").count()).toBe(0);
  }, 60_000);

  test("the filter narrows the grid, and All brings both back", async () => {
    const { win } = await launch((dir) => {
      makeTakeFolder("2026-09-08_12-00-00", { into: dir });
      makeStillFolder("2026-09-08_12-00-01", { into: dir });
    });
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Shot", "Recording"]);

    await win.locator('.libfilters .chip[data-filter="still"]').click();
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Shot"]);

    await win.locator('.libfilters .chip[data-filter="recording"]').click();
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Recording"]);

    await win.locator('.libfilters .chip[data-filter="all"]').click();
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Shot", "Recording"]);
  }, 90_000);

  test("each kind offers its own actions, and both offer rename and delete", async () => {
    const { win } = await launch((dir) => {
      makeTakeFolder("2026-09-08_12-00-00", { into: dir });
      makeStillFolder("2026-09-08_12-00-01", { into: dir });
    });
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Shot", "Recording"]);

    // Duplicate is a still's, and it is the ADAPTER that says so — the view
    // rendered whatever list it was handed.
    expect(await actionsOf(win, 0)).toEqual(
      ["open", "rename", "duplicate", "reveal", "delete"]);
    expect(await actionsOf(win, 1)).toEqual(["open", "rename", "reveal", "delete"]);
  }, 60_000);
});

describe("decorated thumbnails", () => {
  test("a still's picture is rendered and cached beside its document", async () => {
    const { recordings, errors } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", { into: dir });
    });
    const takeDir = join(recordings, "2026-09-08_12-00-00");

    // Polled on the FILE, not on the <img>: the picture appearing is what the
    // cache is for, and the write is the last step of the render.
    await expectThumbnail(takeDir, errors);
    // A real PNG, not an empty file. The main-process guard refuses bytes that
    // are not one, so a FINISHED file is proof it had the magic — but "finished"
    // is the load-bearing word, and waiting for existence never established it.
    expect(statSync(join(takeDir, THUMBNAIL_FILE)).size).toBeGreaterThan(0);
  }, 60_000);

  /**
   * The cache being IN the take directory is what makes the ticket's delete
   * criterion — "no orphans" — true by construction rather than by eviction.
   * `take:delete` moves the whole directory to the Trash, so this checks the
   * thing that would otherwise be left behind is somewhere it cannot be.
   */
  test("the cached thumbnail lives inside the take, so deleting takes it too", async () => {
    const { recordings, errors } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", { into: dir });
    });
    const takeDir = join(recordings, "2026-09-08_12-00-00");
    await expectThumbnail(takeDir, errors);
    // Nothing anywhere else: the whole cache for this shot is these bytes.
    expect(readdirSync(recordings)).toEqual(["2026-09-08_12-00-00"]);
    expect(readdirSync(takeDir).sort()).toEqual(["frame.png", "shot.json", THUMBNAIL_FILE].sort());
  }, 60_000);
});

describe("duplicate", () => {
  test("makes a second, independent shot without re-capturing", async () => {
    const { win, recordings } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", {
        into: dir, redactions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }],
      });
    });
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Shot"]);

    await clickAction(win, 0, "duplicate");
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Shot", "Shot"]);

    // The original is a LEGACY top-level bundle (`makeStillFolder` writes it
    // that way, still-supported per Task 8's migration rule) and stays put;
    // `duplicateTake` builds its destination from `newTakeDir`, which lands a
    // fresh bundle in `raw/` now (STC-413) rather than beside the original.
    expect(readdirSync(recordings).sort()).toEqual(["2026-09-08_12-00-00", RAW_SUBDIR]);
    const rawDirs = readdirSync(join(recordings, RAW_SUBDIR));
    expect(rawDirs).toHaveLength(1);
    const copy = join(recordings, RAW_SUBDIR, rawDirs[0]!);
    // The decoration came with it — that is the point of duplicating rather
    // than re-capturing.
    const shot = JSON.parse(readFileSync(join(copy, "shot.json"), "utf8"));
    expect(shot.decoration.redactions).toHaveLength(1);
    expect(existsSync(join(copy, "frame.png"))).toBe(true);
  }, 60_000);

  /**
   * The copy does not inherit the ORIGINAL's cached picture.
   *
   * Driven through the bridge rather than the button, deliberately: clicking
   * Duplicate re-renders the grid, which paints the new tile and caches a
   * thumbnail for it within moments — so a `thumb.png` beside the copy is the
   * EXPECTED end state, and asserting its absence through the UI just races
   * the render. The first version of this test did exactly that and failed
   * correctly.
   *
   * What actually matters is that the bytes are not the original's, since the
   * copy's decoration is about to diverge and a cache showing the old one is
   * worse than a cold one. So the original is given a recognisable thumbnail
   * first and the copy is checked against it — a positive discriminator rather
   * than an absence that a timing change would quietly satisfy.
   */
  test("duplicate does not carry the original's cached thumbnail across", async () => {
    const { win, recordings, errors } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", { into: dir });
    });
    const original = join(recordings, "2026-09-08_12-00-00");
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Shot"]);
    await expectThumbnail(original, errors);
    // A sentinel the real renderer would never produce: a 1x1 PNG.
    const SENTINEL = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64");
    writeFileSync(join(original, THUMBNAIL_FILE), SENTINEL);

    const r = await win.evaluate((d) => (window as any).recorder.duplicateStill(d), original);
    expect(r.ok).toBe(true);
    const copy = r.dir as string;
    expect(readdirSync(copy).sort()).toEqual(["frame.png", "shot.json"]);
    // And if the library later caches one for the copy, it is the copy's own.
    if (existsSync(join(copy, THUMBNAIL_FILE))) {
      expect(readFileSync(join(copy, THUMBNAIL_FILE)).equals(SENTINEL)).toBe(false);
    }
  }, 60_000);

  /**
   * Re-opening a shot from the library now goes straight to the still editor
   * (STC-300 revision) — `still:reopen` used to re-present the post-capture
   * panel with `take: { kind: "shot", origin: "library" }`; once Edit became
   * reachable from the panel too, that extra click was in the way of the
   * thing someone reopening old work most likely wants. See `main.ts`'s
   * `still:reopen` for the full reasoning, including why nothing is lost:
   * Copy/Delete/Reveal for a kept take are already on the grid's own tile
   * menu.
   */
  test("re-opening a shot from the library opens the still editor, and never exports on its own (STC-294/STC-300)", async () => {
    const { win, recordings, stillLog } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", { into: dir });
    });
    const original = join(recordings, "2026-09-08_12-00-00");
    const before = readFileSync(join(original, "shot.json"), "utf8");
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Shot"]);

    await clickAction(win, 0, "open");
    const editor = await stillEditorWindow();
    await editor.waitForSelector("#stagecanvas");

    // And nothing was exported, duplicated or promoted a second time, and
    // the original untouched, just by having been opened.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await hasWindow(app!, "still-editor.html")).toBe(true);
    // "Never exports on its own" — its own title — read off the helper's
    // request log (STC-412 final review, I3). The folder read this replaces
    // named a fixture directory that, once `saveFolder` became the single
    // setting governing every write, nothing in the app could resolve to, so
    // it was empty whether or not the still editor exported anything.
    //
    // `keptFileRequests`, not every export: opening the still editor DOES
    // write a drag-out file to the clipboard cache as it paints, exactly like
    // the old panel did, and the claim here is about a copy being KEPT — a
    // second encoded shot appearing somewhere the user keeps files just from
    // opening one.
    expect(keptFileRequests(stillLog)).toEqual([]);
    expect(readdirSync(recordings)).toEqual(["2026-09-08_12-00-00"]);
    expect(readFileSync(join(original, "shot.json"), "utf8")).toBe(before);
  }, 60_000);
});

/**
 * `trashWithConfirmation` (`main.ts`), reached from the library grid's own
 * Delete action.
 *
 * This used to be two tests reached by re-opening a shot into the
 * post-capture panel and pressing its Trash button (`trashStyle`'s "confirm"
 * style, STC-392 D1/review I2) — that door closed when `still:reopen` started
 * opening the still editor directly (STC-300 revision; a `{ kind: "shot",
 * origin: "library" }` panel is no longer constructed anywhere). The CANCEL
 * half is fully redundant with `manage.e2e.test.ts`'s own "cancelling the
 * confirmation keeps the take", reached the same way and dropped here rather
 * than kept as a second copy. The FAILURE half — review I2's actual finding,
 * that an uncaught `shell.trashItem` rejection used to escape as an unhandled
 * promise rejection with no message and no restore — has no other test
 * anywhere, since `trashWithConfirmation` itself carries the fix and both of
 * its callers (this one and `panel:trash`'s confirm branch) share it. Ported
 * onto the grid's own Delete button rather than left to depend on a door that
 * no longer exists.
 */
describe("a failed delete is reported, not swallowed (STC-392 review, I2)", () => {
  test("the library grid's own Delete reports a failed trash rather than silently doing nothing", async () => {
    const { win, recordings } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", { into: dir });
    });
    const original = join(recordings, "2026-09-08_12-00-00");
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Shot"]);

    await app!.evaluate(({ dialog, shell }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); // Move to Trash
      shell.trashItem = async () => { throw new Error("simulated Trash failure"); };
    });
    await clickAction(win, 0, "delete");

    // The OLD `trashWithConfirmation` left `dialog.showMessageBox` and
    // `shell.trashItem` uncaught there, so a real Trash failure escaped as an
    // unhandled promise rejection rather than reaching whichever caller asked
    // for it. A message actually reaching the toast (`renderer.ts`'s own
    // `alertUser`, called from `act()`'s catch, now routed through
    // `showMessageToast` — STC-412) is the proof the rejection was caught,
    // the same property the panel-based version of this test pinned via the
    // panel's own `#status` line.
    await expect.poll(() => toastText(app!), { timeout: 15_000 })
      .toContain("simulated Trash failure");
    // Nothing was actually moved — the failure is real, not just reported.
    expect(existsSync(original)).toBe(true);
  }, 60_000);
});
