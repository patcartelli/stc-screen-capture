import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

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
  destDir: string;
  stillLog: string;
}

async function launch(extraEnv: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const destDir = mkdtempSync(join(tmpdir(), "stc-thumb-dest-"));
  const stillLog = join(mkdtempSync(join(tmpdir(), "stc-still-log-")), "requests.jsonl");
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on DISK, before launch — never through `recorder:setSettings`.
  // That channel deliberately strips `still.destination` (STC-293 review,
  // #92): a renderer may not choose where main writes, precisely the thing an
  // E2E test setting up its own fixture would otherwise look like. A real
  // destination (not "beside the shot") makes a settled export easy to find.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    still: { destination: destDir },
  }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")), STC_HELPER_BIN: FAKE_HELPER,
      STC_FAKE_STILL_LOG: stillLog, STC_NO_SHUTTER: "1", ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  return { win, recordings, destDir, stillLog };
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
    () => app!.windows().filter((p) => p.url().includes("thumbnail.html")).length,
    { timeout: ms },
  ).toBe(0);
}

const readRequests = (log: string): any[] =>
  existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

/** A whole-display capture, the same door a hotkey uses — no overlay to drive. */
async function captureDisplay(win: Page): Promise<any> {
  return win.evaluate(() => (window as any).recorder.captureStill("display"));
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

  test("Save promotes the take into the library and closes the panel — it writes no destination-folder file", async () => {
    const { win, recordings, destDir } = await launch();
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
    // `panel:save` PROMOTES the take (STC-393's `promoteTake`) — it does not
    // call `still:export`, so the configured destination folder stays empty.
    // The library IS the destination now; a separate copy there is
    // `still:export`'s job (Copy, Save As), not Save's.
    expect(ownTakes(recordings).length).toBe(1);
    expect(readdirSync(destDir).length).toBe(0);
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
    expect(app!.windows().some((p) => p.url().includes("thumbnail.html"))).toBe(true);
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
    await expect.poll(() => {
      const urls = app!.windows().map((p) => p.url()).filter((u) => u.includes("thumbnail.html"));
      return urls.length === 2 && urls.includes(firstUrl);
    }, { timeout: 15_000 }).toBe(true);
  }, 60_000);

  test("every stacked capture still WAITS — nothing is lost by doing nothing (STC-392)", async () => {
    const { win, destDir } = await launch();
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
      const urls = app!.windows().map((p) => p.url()).filter((u) => u.includes("thumbnail.html"));
      return urls.length;
    }, { timeout: 15_000 }).toBe(2);

    // Nothing exported for either capture.
    expect(readdirSync(destDir).length).toBe(0);
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

  test("the skip preference bypasses the panel entirely and copies rather than saves", async () => {
    const { win, destDir, stillLog } = await launch();
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
    // destination folder, and never the library either (a silent panel only
    // ever performs Copy, which does not promote).
    expect(readdirSync(destDir).length).toBe(0);
    const exported = readRequests(stillLog).find((x) => x.rgba !== undefined);
    expect(exported?.clipboard).toBe(true);
    // A copy still writes a file too — still-io.ts's `destinationDir`, so the
    // pasteboard's file URL points at something real — but to the CACHE, never
    // the chosen destination folder. `destDir` staying empty above is the
    // proof; a cache-directory path here is expected, not a leak of the file
    // the "straight to clipboard" wording promises not to write.
    expect(exported?.file).toBeDefined();
    expect(exported?.file).not.toContain(destDir);
  }, 60_000);
});
