import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { stubQuitDialog } from "./_quit-fixture.js";
import { windowCount, hasWindow, windowUrls } from "./_windows.js";
import { CLIPBOARD_SUBDIR } from "../src/still-io.js";
import { readRequests, exportRequests, keptFileRequests } from "./_still-log.js";

/**
 * The post-capture floating thumbnail, end to end (STC-296, reworked by
 * STC-392).
 *
 * The panel's own STATE — `idle` or `open` — is decided by a pure function
 * and checked with no window at all in `thumbnail.test.ts`. What this file
 * exists for is the wiring that cannot see: that a capture really puts a
 * separate `BrowserWindow` on screen with the right buttons for its take,
 * that clicking Save/Copy/Trash really calls through to the right handler
 * and really destroys the window when the action is one that closes it, and
 * that a showing panel really gets excluded from the NEXT capture's request.
 * What ignoring the panel does is `panel-waits.e2e.test.ts`'s claim now —
 * "there is no path where a capture is silently lost" is still the promise,
 * kept by the panel staying put rather than by a timeout writing a file
 * nobody asked for.
 *
 * NOT covered here since STC-392: there is no collapsed/expanded window size
 * any more (`thumbnail-window.ts`'s window is fixed at `PANEL_SIZE`) and no
 * `#card` click to get from one to the other — every control this take has
 * is on the card from the moment it paints, so there is nothing left to
 * "expand" into.
 *
 * `export-still` is faked here the same way `capture-still` already is: the
 * bytes are never inspected, only that the file the app asked for exists and
 * the reply's shape is honoured — the real encoder is `helper/test/
 * still-encode.test.ts`'s job, and needs no grant to run on every push.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Launched {
  win: Page;
  recordings: string;
  temp: string;
  stillLog: string;
}

async function launch(extraEnv: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  // `saveFolder: null` leaves `STC_RECORDINGS_DIR` (`recordings`) as the
  // resolved root. STC-412 unified `saveFolder` to govern BOTH stills and
  // recordings — `panel:save`'s promote included — so an ACTIVE one here
  // would divert a promoted take away from `recordings`, which is what
  // "Save promotes" below asserts against.
  //
  // A `destDir` — a folder nothing is ever configured to write to — used to
  // live here too, and every "and it wrote nothing THERE" assertion was
  // deleted with it (STC-412 final review, I3). Those assertions were real
  // when `still.destination` and the recordings root were independent
  // settings: pointing the first somewhere and checking the second's traffic
  // never arrived discriminated a genuine misdirection bug. Under one
  // unified `saveFolder` that is null here, NOTHING in the app can resolve
  // to such a folder by any path, so the reads passed unconditionally — a
  // dead assertion reading as coverage. What each of them was reaching for
  // is checked against `stillLog` instead, which a real export DOES reach.
  const stillLog = join(mkdtempSync(join(tmpdir(), "stc-still-log-")), "requests.jsonl");
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on DISK, before launch — never through `recorder:setSettings`.
  // That channel deliberately strips `saveFolder` (STC-293 review, #92 —
  // `saveFolder` replaced `still.destination` at STC-412): a renderer may not
  // choose where main writes, precisely the thing an E2E test setting up its
  // own fixture would otherwise look like.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    saveFolder: null,
  }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp, STC_HELPER_BIN: FAKE_HELPER,
      STC_FAKE_STILL_LOG: stillLog, STC_NO_SHUTTER: "1", ...extraEnv,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  return { win, recordings, temp, stillLog };
}

/** The floating panel, once it is up. Identified by its URL, like the overlay's own helper. */
async function thumbnailWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) if (p.url().includes("thumbnail.html")) return p;
    if (Date.now() - start > ms) {
      throw new Error(`no thumbnail window appeared within ${ms}ms; windows: `
        + JSON.stringify(app!.windows().map((p) => p.url())));
    }
    await sleep(50);
  }
}

async function noThumbnailWindow(ms = 15_000): Promise<void> {
  await expect.poll(
    () => windowCount(app!, "thumbnail.html"),
    { timeout: ms },
  ).toBe(0);
}

/** A whole-display capture, the same door a hotkey uses — no overlay to drive. */
async function captureDisplay(win: Page): Promise<any> {
  return win.evaluate(() => (window as any).recorder.captureStill("display"));
}

/**
 * Drive an action that CLOSES the panel synchronously — dismiss's X click or
 * its Escape key (STC-412) — and tolerate the "Target page, context or
 * browser has been closed" rejection Playwright reports when the action's
 * own target vanishes mid-dispatch.
 *
 * The same trap `_editor-fixture.ts`'s `closeEditorWindow` already exists for
 * (STC-386, CLAUDE.md): `perform("dismiss")` closes the window over a
 * synchronous IPC round trip, so the action LANDED and the window closing IS
 * the confirmation — a bare `.catch(() => {})` would just as happily swallow
 * a real failure, so "close" is awaited FIRST and a rejection not followed by
 * an actual close is rethrown rather than eaten.
 */
async function dismissAndTolerateClose(panel: Page, act: () => Promise<void>): Promise<void> {
  const closed = panel.waitForEvent("close", { timeout: 15_000 });
  const err = await act().then(() => undefined, (e: unknown) => e);
  if (err !== undefined) {
    await closed.catch(() => { throw err; });
    return;
  }
  await closed;
}

/** Live take directories under `recordings`, excluding the fixture `makeTakeFolder` seeds. */
function ownTakes(recordings: string): string[] {
  return readdirSync(recordings).filter((n) => !n.startsWith(".") && n !== "2026-08-24_10-00-00");
}

describe("the post-capture floating thumbnail", () => {
  test("a capture puts a separate, painted panel on screen showing its own actions", async () => {
    const { win } = await launch();
    const r = await captureDisplay(win);
    expect(r.ok).toBe(true);

    const panel = await thumbnailWindow();
    await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
      .toContain("in");
    // A fresh SHOT: copy, save and trash, and no edit — `panel-actions.ts`'s
    // own table, drawn onto the DOM (`actionsFor`).
    expect(await panel.isVisible("#copy")).toBe(true);
    expect(await panel.isVisible("#save")).toBe(true);
    expect(await panel.isVisible("#trash")).toBe(true);
    expect(await panel.isHidden("#edit")).toBe(true);
  }, 60_000);

  test("Save promotes the take into the library and closes the panel — it keeps no second copy", async () => {
    const { win, recordings, stillLog } = await launch();
    await captureDisplay(win);
    const panel = await thumbnailWindow();
    await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
      .toContain("in");

    // Not a status-text poll: a successful Save sends "done" moments after
    // setting its own confirmation text, and main destroys the window on
    // "done" — polling the page for text it may already have closed under is
    // exactly the race that made `still-overlay.e2e.test.ts` flaky once. The
    // window closing IS the confirmation this path is being tested for.
    await panel.click("#save");
    await noThumbnailWindow(15_000);
    // `panel:save` PROMOTES the take (STC-393's `promoteTake`) — it MOVES a
    // directory. The library IS the destination now, and a separate encoded
    // copy anywhere the user keeps files is `still:export`'s job (Copy, Save
    // As), not Save's.
    //
    // Read off the helper's own request log rather than off a folder
    // (STC-412 final review, I3), and `keptFileRequests` rather than every
    // export: writing this as "no export at all" was tried first and FAILED
    // against the real app, which is how it was learned that a panel writes
    // its drag-out file into the clipboard cache the moment it paints. That
    // one is not a copy anybody kept — see `_still-log.ts`. Wire a real save
    // into this path and its file lands outside the cache, here.
    expect(ownTakes(recordings).length).toBe(1);
    expect(keptFileRequests(stillLog)).toEqual([]);
  }, 60_000);

  // "Ignoring it still saves" (the old contract) is now
  // `panel-waits.e2e.test.ts`'s "left alone, the panel is still there and the
  // take is still in temp" — a different claim about the same pixels, so it
  // lives in its own file rather than being loosened here (STC-392).

  test("Copy does not close the panel — Save and Trash both do", async () => {
    const { win, recordings } = await launch();
    await captureDisplay(win);
    const panel = await thumbnailWindow();
    await panel.click("#copy");
    await expect.poll(() => panel.textContent("#status"), { timeout: 15_000 }).toMatch(/^Copied/);
    // Still here — a quick share should not cost the chance to also Save.
    expect(await hasWindow(app!, "thumbnail.html")).toBe(true);
    // And Copy never promoted it (STC-392's D5) — the take the Trash below
    // removes is still the one in temp, not a copy already in the library.
    expect(ownTakes(recordings).length).toBe(0);

    await panel.click("#trash");
    await noThumbnailWindow();
  }, 60_000);

  test("a second capture STACKS rather than replacing — both panels stay", async () => {
    const { win } = await launch();
    await captureDisplay(win);
    const firstUrl = (await thumbnailWindow()).url();

    const r2 = await captureDisplay(win);
    expect(r2.ok).toBe(true);
    // TWO panels, and the first is still one of them. This assertion is the
    // inverse of the one it replaces: until stacking landed, a second capture
    // REPLACED the first and this test required exactly one window. The
    // change is the feature, so the test states the new contract rather than
    // being relaxed to tolerate it.
    await expect.poll(async () => {
      const urls = (await windowUrls(app!)).filter((u) => u.includes("thumbnail.html"));
      return urls.length === 2 && urls.includes(firstUrl);
    }, { timeout: 15_000 }).toBe(true);
  }, 60_000);

  test("every stacked capture still WAITS — nothing is lost by doing nothing (STC-392)", async () => {
    const { win, stillLog } = await launch();
    // Re-anchored for STC-392: with the clock gone, "nothing is lost" is no
    // longer a property of every panel settling on its own timer — it is a
    // property of every panel still being there, undecided, with its shot
    // still in temp storage. Two panels rather than `panel-waits.e2e.test.ts`'s
    // one, because that is what stacking adds: nothing here settles the FIRST
    // panel on the second's behalf, the same as before, just for a different
    // reason (there is no settling at all).
    await captureDisplay(win);
    const r2 = await captureDisplay(win);
    expect(r2.ok).toBe(true);

    await expect.poll(() => {
      return windowCount(app!, "thumbnail.html");
    }, { timeout: 15_000 }).toBe(2);

    // Neither capture produced a file anybody kept — asserted against the
    // helper's own request log (STC-412 final review, I3). The folder read
    // this replaces named a directory the app could no longer resolve to
    // under a unified `saveFolder`, so it was empty whatever the panels did.
    // Note this is deliberately NOT "no export at all": both panels DO write
    // their drag-out file into the clipboard cache on paint, which is the
    // fact writing that stronger assertion first turned up.
    expect(keptFileRequests(stillLog)).toEqual([]);
  }, 60_000);

  test("a showing panel is excluded from the next capture's request, when an id resolves", async () => {
    const { win, stillLog } = await launch();
    await captureDisplay(win);
    await thumbnailWindow();
    await captureDisplay(win);

    const captures = readRequests(stillLog).filter((r) => r.kind !== undefined && r.rgba === undefined);
    expect(captures.length).toBe(2);
    // `excludeWindowIds` is OMITTED (not sent as `[]`) when nothing needs
    // excluding — `hotkeys.e2e.test.ts` pins exactly that for a first, no-panel
    // capture. So the strongest claim this harness can make is conditional: IF
    // the field is present, it names real ids. Whether `getMediaSourceId()`
    // reliably resolves one for a hidden, just-created window is the same
    // environment question `docs/STC-290-RUNBOOK.md` already declines to
    // settle for the overlay's own windows — a real screen and a real
    // subsequent capture are what actually prove exclusion; see
    // `docs/STC-296-RUNBOOK.md`.
    if (captures[1].excludeWindowIds !== undefined) {
      expect(Array.isArray(captures[1].excludeWindowIds)).toBe(true);
      expect(captures[1].excludeWindowIds.every((n: unknown) => Number.isInteger(n))).toBe(true);
    }
  }, 60_000);

  test("the skip preference bypasses the panel entirely, copies, AND promotes", async () => {
    const { win, recordings, temp, stillLog } = await launch();
    await win.evaluate(async () => {
      await (window as any).recorder.setSettings({ thumbnail: { skip: true } });
    });
    const r = await captureDisplay(win);
    expect(r.ok).toBe(true);
    // No UI ever appears for a skipped capture, so there is no window to poll
    // for first — `noThumbnailWindow` alone would succeed on its very first
    // check, before the silent panel has even been created, and prove
    // nothing (the exact "success by finding nothing to do" trap CLAUDE.md
    // warns about). Wait on the actual effect instead: the export reaching
    // the helper.
    await expect.poll(() => readRequests(stillLog).some((x) => x.rgba !== undefined),
                       { timeout: 15_000 }).toBe(true);
    // A skipped panel is still, briefly, a real (hidden) window compositing in
    // the background — see thumbnail-window.ts's `silent` mode — so what is
    // checkable now is that it does not OUTLAST its own export.
    await noThumbnailWindow(15_000);
    // The ticket's own words are "go straight to clipboard" — never the
    // destination folder. `skip` has no panel, so it can never reach a Save
    // button; the ONLY way a skip capture avoids the 7-day temp purge is if
    // the silent path promotes it itself, through `panel:save`, after a
    // successful copy (see `thumbnail-renderer.ts`'s silent branch). So it
    // DOES land in the library, unlike a plain Copy from a shown panel, which
    // deliberately still does not promote (`panel-waits.e2e.test.ts`).
    await expect.poll(() => readdirSync(temp).length, { timeout: 15_000 }).toBe(0);
    expect(ownTakes(recordings).length).toBe(1);
    const exported = exportRequests(stillLog)[0];
    expect(exported?.clipboard).toBe(true);
    // A copy still writes a file too — still-io.ts's `destinationDir`, so the
    // pasteboard's file URL points at something real — but to the CACHE, and
    // that is asserted POSITIVELY now (STC-412 final review, I3). It used to
    // be `not.toContain(destDir)` against a fixture folder nothing could
    // resolve to any more, which passed for a file written literally
    // anywhere, the recordings root and the user's own save folder included.
    // `CLIPBOARD_SUBDIR` is still-io.ts's own constant, so this names the
    // branch it is claiming was taken (`destinationDir`'s `!target.file`
    // fallback) rather than a place it was not.
    expect(exported?.file).toBeDefined();
    expect(exported!.file).toContain(CLIPBOARD_SUBDIR);
    // And NOT in the library: "straight to clipboard" promises the shot is
    // not also encoded into the folder the user keeps their takes in.
    expect(exported!.file).not.toContain(recordings);
  }, 60_000);

  // ---- dismiss (STC-412) ----------------------------------------------------

  test("dismiss (the X) closes the panel and leaves the take exactly where it was", async () => {
    const { win, temp } = await launch();
    const r = await captureDisplay(win);
    expect(r.ok).toBe(true);
    const panel = await thumbnailWindow();
    const before = readdirSync(temp, { recursive: true }).sort();

    await dismissAndTolerateClose(panel, () => panel.click("#dismiss"));

    await noThumbnailWindow();
    expect(readdirSync(temp, { recursive: true }).sort()).toEqual(before);
  }, 60_000);

  test("Escape dismisses the panel outside redact mode", async () => {
    const { win, temp } = await launch();
    const r = await captureDisplay(win);
    expect(r.ok).toBe(true);
    const panel = await thumbnailWindow();
    const before = readdirSync(temp, { recursive: true }).sort();

    // Escape respects `SETTLE_KEYS_MS` like every other keyboard path
    // (thumbnail-renderer.ts's own comment above its keydown listener) — a
    // press dispatched before the panel's own `keysLiveAt` clock is reached
    // is silently ignored, which would otherwise make this test time out in
    // `noThumbnailWindow` for a reason that has nothing to do with dismiss.
    // Same hazard `panel-waits.e2e.test.ts`'s ⌘⌫ test already found (STC-427)
    // and reads the renderer's own published clock for, not a fixed sleep.
    await expect.poll(() => panel.evaluate(() => {
      const card = document.getElementById("card")!;
      const liveAt = Number((card as HTMLElement).dataset.keysLiveAt);
      return card.className.includes("in")
        && Number.isFinite(liveAt) && performance.now() >= liveAt;
    }), { timeout: 15_000 }).toBe(true);

    await dismissAndTolerateClose(panel, () => panel.keyboard.press("Escape"));

    await noThumbnailWindow();
    expect(readdirSync(temp, { recursive: true }).sort()).toEqual(before);
  }, 60_000);
});
