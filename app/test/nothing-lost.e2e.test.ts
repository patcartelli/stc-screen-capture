import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseShot } from "../../transform/src/shot.js";
import { SETTLE_READY_MS } from "../src/thumbnail.js";
import { stubQuitDialog } from "./_quit-fixture.js";
import { windowCount } from "./_windows.js";
import { closeApp } from "./_app-teardown.js";

/**
 * STC-301 gate 4 — nothing lost.
 *
 * > "A harness that fires N captures in quick succession, lets every thumbnail
 * > time out untouched, and asserts N files on disk with valid `shot.json`
 * > beside each. Covers the failure mode that would actually make the tool
 * > untrustworthy."
 *
 * That last sentence is why this gate exists and why it is worth more than its
 * size suggests. Every other still test asks whether one capture is CORRECT;
 * this one asks whether a burst of them is COMPLETE — and a screenshot tool
 * that occasionally loses one is worse than one that is merely wrong, because
 * you cannot tell by looking.
 *
 * ## Why it is an E2E and not a `scripts/*-gate.mjs`
 *
 * It needs Electron and the stand-in helper; it needs no browser and inspects
 * no pixels. A sixth gate PROCESS would have to be added to `worstCaseJobMs`,
 * given its own declared bound and counted against the job's cap — machinery
 * CLAUDE.md records getting wrong twice — to buy nothing this does not already
 * get by running on every push.
 *
 * ## What makes it deterministic on a CI runner
 *
 * The ticket's Constraints section demands an answer to that, having paid for
 * flaky gates three times. Two things (STC-392 removed a third — there is no
 * panel timeout to set to a floor any more):
 *
 *  - Nothing here polls for a panel to appear or races an animation. It waits
 *    on the only durable artefact — directories on disk — with a generous
 *    bound, and the directories are written by `capture-still` itself, before
 *    any panel exists.
 *  - The captures are fired through `still:capture`'s `display` action, which
 *    opens no overlay and needs no pointer, so there is no window-server
 *    interaction to lose a race with.
 *
 * ## What "nothing lost" means, post-STC-392
 *
 * The gate's own wording ("lets every thumbnail time out untouched") is the
 * OLD mechanism; the property it was checking survives it. A burst that is
 * never touched used to reach N exports; now it reaches N panels still open
 * and N takes still in temp storage — untouched either way, and "recoverable"
 * a word STC-393's crash recovery now makes literally true rather than a
 * synonym for "already saved".
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

/**
 * How many captures count as "quick succession".
 *
 * The ticket's own acceptance wording elsewhere is "five captures in five
 * seconds produce five recoverable shots" (STC-296), so five is the number the
 * product was specified against rather than one picked to be comfortable.
 */
const N = 5;

/**
 * Teardown gets a bound of its own, and the number is derived rather than felt.
 *
 * This gate deliberately leaves the app mid-burst, with several panels still
 * open. Before STC-392, closing them meant settling each — waiting up to
 * `SETTLE_READY_MS` for a first composite (STC-296, #102) before exporting —
 * and vitest's default hook timeout (10 s) was the SAME NUMBER `SETTLE_READY_MS`
 * happened to be, making teardown a coin flip; observed failing 1 run in 5.
 * `dismissNow` no longer waits on the renderer at all, so this bound is more
 * generous than teardown needs today — kept derived from `SETTLE_READY_MS`
 * rather than cut to the bone, since a future renderer round trip (Task 4's
 * export-then-close) would need slack here again and a restated number would
 * not move with it.
 */
const TEARDOWN_MS = SETTLE_READY_MS + 20_000;

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, TEARDOWN_MS);

interface Launched { win: Page; recordings: string; tempTakes: string; destDir: string }

async function launch(): Promise<Launched> {
  const recordings = mkdtempSync(join(tmpdir(), "stc-nothinglost-"));
  const tempTakes = mkdtempSync(join(tmpdir(), "stc-nothinglost-temp-"));
  const destDir = mkdtempSync(join(tmpdir(), "stc-nothinglost-dest-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on DISK: `recorder:setSettings` strips `saveFolder` by design
  // (STC-293 review, #92 — `saveFolder` replaced `still.destination` at
  // STC-412).
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    saveFolder: destDir,
  }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: tempTakes,
      STC_HELPER_BIN: FAKE_HELPER,
      STC_NO_SHUTTER: "1",
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  return { win, recordings, tempTakes, destDir };
}

/**
 * Every take directory that holds a shot, with the document it carries.
 *
 * Tolerates a missing `root` (STC-413's `raw/` need not exist at all until
 * something is promoted into it) rather than throwing ENOENT — a promotion
 * check that can crash on "nothing promoted yet" is not a check that
 * discriminates anything.
 */
function shotsIn(root: string): { name: string; dir: string }[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => ({ name, dir: join(root, name) }))
    .filter((t) => existsSync(join(t.dir, "shot.json")));
}

describe("gate 4: nothing is lost in a burst of captures", () => {
  test(`${N} captures in quick succession leave ${N} recoverable shots`, async () => {
    const { win, tempTakes } = await launch();

    // Fired one after another with no waiting between them beyond the await —
    // which is what a person mashing a hotkey produces, and what the panel's
    // replace-the-showing-one path has to survive.
    const results = [];
    for (let i = 0; i < N; i++) {
      results.push(await win.evaluate(() => (window as any).recorder.captureStill("display")));
    }
    expect(results.every((r) => r.ok), JSON.stringify(results)).toBe(true);

    // N distinct directories: the one-second collision guard in `newTakeDir`
    // is what makes this true, and a burst is exactly when it matters.
    const dirs = results.map((r) => r.dir as string);
    expect(new Set(dirs).size, `captures shared a directory: ${JSON.stringify(dirs)}`).toBe(N);

    // TEMP storage (STC-393), not the library — this half of the claim is
    // about what `capture-still` itself wrote, before any panel exists to
    // decide whether a shot is kept. The library only gets these once a panel
    // settles, which is the second test's claim, not this one's.
    const shots = shotsIn(tempTakes);
    expect(shots.length, `only ${shots.length} of ${N} captures left a shot.json`).toBe(N);

    // Every one of them loads. Not "the file exists" — `parseShot` refuses
    // rather than defaults, so a document it accepts is one that can actually
    // be rendered, which is what "recoverable" has to mean.
    for (const s of shots) {
      const doc = parseShot(JSON.parse(readFileSync(join(s.dir, "shot.json"), "utf8")));
      expect(existsSync(join(s.dir, doc.frame.file)), `${s.name} has no ${doc.frame.file}`).toBe(true);
    }
  }, 120_000);

  /**
   * And every one of them WAITS, untouched (STC-392, restating a test that
   * asserted the OLD contract rather than loosening it).
   *
   * The shots being on disk is the helper's doing and happens before any panel
   * exists. What this half proves is the ticket's actual sentence — "lets every
   * thumbnail time out untouched" was true when there was a timeout to let
   * fire; the property it stood for — a burst nobody touches loses nothing —
   * is kept a different way now: N panels stay OPEN rather than each reaching
   * an export, and their N takes stay in temp storage rather than moving to
   * the destination folder.
   *
   * What that exercises has CHANGED under the gate, and the assertion is worth
   * more for it. It used to be the replace path — a capture arriving while a
   * panel showed replaced it, and the outgoing shot had to be settled rather
   * than discarded. Captures stack now (#104), so what a burst reaches is N
   * panels alive at once — still true post-STC-392, only none of them ever
   * settle on their own any more.
   *
   * `N` is 5 because the ticket says five. It USED to also equal
   * `MAX_STACKED`, so this burst filled the stack exactly and evicted
   * nothing — worth recording as history rather than deleting outright,
   * because it explains why this assertion once needed no further comment.
   * Task 5b (STC-392 D7) lowered `MAX_STACKED` to 3, so this same burst now
   * DOES push two panels over the cap. That no longer threatens this
   * assertion the way it once would have: overflow used to DISMISS (destroy)
   * the evicted panel, which really would have meant fewer than N windows
   * and fewer than N recoverable shots. It no longer destroys anything —
   * a panel past the cap is HIDDEN, not torn down — so `N` windows and `N`
   * shots in temp storage both still hold; only the VISIBLE count is now
   * `MAX_STACKED` rather than `N`, which this gate does not assert on either
   * side and so is silent about here on purpose.
   */
  test(`ignoring all ${N} panels still exports none of them`, async () => {
    const { win, tempTakes, destDir } = await launch();
    for (let i = 0; i < N; i++) {
      await win.evaluate(() => (window as any).recorder.captureStill("display"));
    }

    // Waits on the durable artefact rather than on any panel's animation: N
    // real BrowserWindows on screen.
    await expect.poll(() => windowCount(app!, "thumbnail.html"),
                       { timeout: 60_000 }).toBe(N);

    // Nothing exported, nothing promoted to the library, and nothing lost
    // either: every shot is still exactly where `capture-still` wrote it —
    // temp storage, never decided.
    //
    // `destDir` — the seeded `saveFolder` — is the app's real `takesRoot`,
    // wins over `STC_RECORDINGS_DIR` (`takesRoot`'s own precedence), and is
    // checked at its TOP LEVEL rather than at `destDir/raw`: a promoted
    // bundle would create `raw/` itself, which a top-level `readdirSync`
    // already sees, so this one check catches both an exported file AND a
    // promoted bundle appearing anywhere under the real root. A prior version
    // of this test also checked the `STC_RECORDINGS_DIR`-named directory
    // directly, which `saveFolder` shadows here (STC-412) — that check was
    // vacuous even before STC-413 (nothing is ever written there), and adding
    // `raw/` to its path would not have fixed that, so it is removed rather
    // than repointed at the wrong root.
    expect(readdirSync(destDir).length).toBe(0);
    expect(shotsIn(tempTakes).length).toBe(N);
  }, 180_000);
});
