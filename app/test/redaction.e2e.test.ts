import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { parseShot } from "../../transform/src/shot.js";
import { THUMBNAIL_FILE } from "../src/library-items.js";
import { stubQuitDialog } from "./_quit-fixture.js";

/**
 * Redaction, end to end (STC-297).
 *
 * The arithmetic — what a drag means, which colour a fill takes — is
 * `transform/test/still-redact.test.ts`, with no pointer and no canvas. That
 * an exported PNG genuinely contains no trace of what was covered is
 * `helper/test/still-encode.test.ts`, which decodes the encoded file. What is
 * left for this file is the WIRING those two cannot see: that a real drag on a
 * real panel becomes a region, that Undo takes one back, and that the regions
 * reach `shot.json` on disk — which is the whole of "redaction survives an app
 * restart", since that document IS the still.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(extraEnv: Record<string, string> = {}):
  Promise<{ win: Page; destDir: string; recordings: string }> {
  const { dir: recordings } = makeTakeFolder();
  const destDir = mkdtempSync(join(tmpdir(), "stc-redact-dest-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on disk, never through `recorder:setSettings` — that channel
  // deliberately strips `still.destination` (STC-293 review, #92).
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    still: { destination: destDir },
  }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")), STC_HELPER_BIN: FAKE_HELPER,
      STC_NO_SHUTTER: "1", ...extraEnv,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  return { win, destDir, recordings };
}

/** The overlay window, once it is up — `still-overlay.e2e.test.ts`'s own helper. */
async function overlayWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) if (p.url().includes("overlay.html")) return p;
    if (Date.now() - start > ms) {
      throw new Error(`no overlay window appeared within ${ms}ms; windows: `
        + JSON.stringify(app!.windows().map((p) => p.url())));
    }
    await sleep(50);
  }
}

/** Push one event through the overlay's own bridge, as the DOM handlers would. */
async function sendOverlay(overlay: Page, event: unknown): Promise<void> {
  await overlay.evaluate((e) => (window as any).overlay.send(e), event);
}

/**
 * A WINDOW shot, its panel, in redact mode — the mode-persistence test (I2)
 * needs alpha (`availableModes()` offers only `selected-area` for a crop),
 * so it cannot reuse `redactingPanel`'s plain display capture.
 *
 * Drives the overlay's own bridge the way `still-overlay.e2e.test.ts` does
 * (real input would be testing the window server's hit-testing, which
 * belongs on the Mac) to pick the stand-in's Finder window.
 */
async function windowShotPanel(win: Page): Promise<{ panel: Page; dir: string }> {
  await win.click("#capturestill");
  const overlay = await overlayWindow();
  await sendOverlay(overlay, { t: "key", key: " " });
  await sendOverlay(overlay, { t: "pointermove", at: { x: 200, y: 200 } });
  await sendOverlay(overlay, { t: "pointerdown", at: { x: 200, y: 200 } });

  const panel = await thumbnailWindow();
  await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
    .toContain("in");
  const dir = await panel.evaluate(() => new URLSearchParams(location.search).get("dir")!);
  return { panel, dir };
}

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

/** The regions the stored document actually carries, through the real loader. */
const storedRegions = (dir: string) =>
  parseShot(JSON.parse(readFileSync(join(dir, "shot.json"), "utf8"))).decoration.redactions;

/**
 * The preview canvas's box, once it has stopped moving.
 *
 * Entering redact mode resizes the WINDOW (main) and the canvas (renderer),
 * and those are two processes arriving at the same answer independently.
 * Dragging against a box read mid-resize is the "success by finding nothing to
 * do" race in its other direction — the coordinates would be real, just no
 * longer where the canvas is. Two consecutive identical reads, then drag.
 */
async function settledCanvasBox(panel: Page, ms = 10_000):
  Promise<{ x: number; y: number; width: number; height: number }> {
  const read = async () => panel.locator("#thumbcanvas").boundingBox();
  const start = Date.now();
  let last = await read();
  for (;;) {
    await sleep(120);
    const now = await read();
    if (last && now && now.x === last.x && now.y === last.y
        && now.width === last.width && now.height === last.height && now.width > 0) {
      return now;
    }
    if (Date.now() - start > ms) {
      throw new Error(`the preview canvas never settled: ${JSON.stringify({ last, now })}`);
    }
    last = now;
  }
}

/** A capture, its panel, and that panel already in redact mode. */
async function redactingPanel(win: Page): Promise<{ panel: Page; dir: string }> {
  const r = await win.evaluate(() => (window as any).recorder.captureStill("display"));
  expect(r.ok).toBe(true);
  const panel = await thumbnailWindow();
  // Every control this take has is on the card from the moment it paints
  // (STC-392) — no click-to-expand step left before Redact is reachable.
  await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
    .toContain("in");
  await panel.click("#redact");
  await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
    .toContain("redacting");
  return { panel, dir: r.dir as string };
}

/**
 * Drag a box across the middle of the preview, as a person would.
 *
 * Fractions of the canvas rather than pixels: the panel sizes its canvas to
 * the shot, so a fixed pixel box would fall outside it for a differently
 * shaped capture and the drag would land on nothing.
 */
async function dragBox(panel: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await settledCanvasBox(panel);
  const at = ([fx, fy]: [number, number]) =>
    ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const a = at(from), b = at(to);
  await panel.mouse.move(a.x, a.y);
  await panel.mouse.down();
  // Two moves, not one: a single move can be coalesced with the press, and
  // this is testing that a DRAG is followed rather than that a click lands.
  await panel.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await panel.mouse.move(b.x, b.y);
  await panel.mouse.up();
}

describe("redaction", () => {
  test("Redact grows the panel, and a drag becomes a stored region", async () => {
    const { win } = await launch();
    const { panel, dir } = await redactingPanel(win);
    expect(storedRegions(dir)).toHaveLength(0);

    await dragBox(panel, [0.3, 0.35], [0.7, 0.6]);

    // Polled, not read once: the write is a round trip to main and back, and
    // asserting immediately would be asserting on the moment before it.
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    const [region] = storedRegions(dir);
    // Normalised and inside the capture — the schema's own rule, and what
    // makes a region survive a change of crop, padding or output scale.
    expect(region!.x).toBeGreaterThanOrEqual(0);
    expect(region!.y).toBeGreaterThanOrEqual(0);
    expect(region!.width).toBeGreaterThan(0);
    expect(region!.height).toBeGreaterThan(0);
    expect(region!.x + region!.width).toBeLessThanOrEqual(1);
    expect(region!.y + region!.height).toBeLessThanOrEqual(1);
  }, 60_000);

  test("a second box adds rather than replaces, and Undo takes back the last one", async () => {
    const { win } = await launch();
    const { panel, dir } = await redactingPanel(win);

    await dragBox(panel, [0.1, 0.1], [0.4, 0.3]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    const first = storedRegions(dir)[0]!;

    await dragBox(panel, [0.55, 0.55], [0.9, 0.8]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(2);

    await panel.click("#undo");
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    // The one that survived is the FIRST — undo is last-in-first-out, not
    // "clear everything and hope".
    expect(storedRegions(dir)[0]).toEqual(first);
  }, 60_000);

  test("editing the regions drops the library's cached thumbnail (STC-294)", async () => {
    const { win } = await launch();
    const { panel, dir } = await redactingPanel(win);
    // A cached picture, as the library grid would have left behind. It was
    // rendered from the decoration that is about to change, so leaving it would
    // show the grid a shot that no longer exists.
    writeFileSync(join(dir, THUMBNAIL_FILE), Buffer.alloc(64));
    expect(existsSync(join(dir, THUMBNAIL_FILE))).toBe(true);

    await dragBox(panel, [0.3, 0.35], [0.7, 0.6]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    // Dropped by the same handler that wrote the regions, so the two cannot
    // disagree about what this shot looks like.
    await expect.poll(() => existsSync(join(dir, THUMBNAIL_FILE)),
                      { timeout: 15_000 }).toBe(false);
  }, 60_000);

  test("a swipe starting on the panel's chrome does not discard while redacting (STC-392 review, I4)", async () => {
    // The old collapsed/expanded panel could not hit this: redact mode implied
    // expanded, and only the bare (collapsed) thumbnail could start a swipe at
    // all. STC-392's one-card panel removed that door, and a drag beginning
    // on the card's own chrome — the status line, the controls' padding, not
    // the canvas a redaction drag claims — could still read as a swipe and
    // discard the take out from under an in-progress redaction. This drives
    // exactly that gesture: a press-drag-release on `#status`, well clear of
    // the canvas and of every button/select, dragged far enough (150px,
    // > SWIPE_DISCARD_PX) toward the discard edge that an unguarded card
    // would throw the take away.
    const { win, recordings } = await launch();
    const { panel, dir } = await redactingPanel(win);

    const status = await panel.locator("#status").boundingBox();
    expect(status).toBeTruthy();
    const y = status!.y + status!.height / 2;
    const x0 = status!.x + 20;
    await panel.mouse.move(x0, y);
    await panel.mouse.down();
    // Two moves, matching `dragBox`'s own reasoning: a single move can be
    // coalesced with the press, and dominantly horizontal so the gesture
    // would classify as `discard` rather than `drag-out` if it were ever
    // read as a swipe at all — bottom-right is the default corner, whose
    // discard direction is rightward (`discardDirection`).
    await panel.mouse.move(x0 + 75, y);
    await panel.mouse.move(x0 + 150, y);
    await panel.mouse.up();

    // Nothing to poll FOR — a discard would close the panel and delete the
    // take, so this waits out the round trip either would have taken and
    // then asserts neither happened.
    await sleep(1500);
    expect(app!.windows().some((p) => p.url().includes("thumbnail.html"))).toBe(true);
    expect(existsSync(join(dir, "shot.json"))).toBe(true);
    expect(storedRegions(dir)).toHaveLength(0);
    // And the take was never promoted or trashed out of the library either.
    const ownRecordings = readdirSync(recordings).filter((n) => n !== "2026-08-24_10-00-00");
    expect(ownRecordings).toHaveLength(0);
  }, 60_000);

  test("a click is not a region", async () => {
    const { win } = await launch();
    const { panel, dir } = await redactingPanel(win);
    const box = await settledCanvasBox(panel);
    await panel.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await panel.mouse.down();
    await panel.mouse.up();
    // Nothing to poll FOR here, so this waits out the round trip a real region
    // would have taken and then asserts nothing arrived.
    await sleep(1500);
    expect(storedRegions(dir)).toHaveLength(0);
  }, 60_000);

  test("the stored regions reach the promoted take, not just the preview", async () => {
    const { win, recordings } = await launch();
    const { panel, dir } = await redactingPanel(win);
    await dragBox(panel, [0.25, 0.3], [0.75, 0.65]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);

    // Save PROMOTES the take (STC-393's `promoteTake`) rather than writing a
    // destination-folder file (STC-392, D5 — `panel:save` never calls
    // `still:export`) — the library renders a shot from its own stored
    // document, so a redaction visible in the panel and missing from that
    // document is the failure this pins now.
    await panel.click("#save");
    await expect.poll(
      () => app!.windows().filter((p) => p.url().includes("thumbnail.html")).length,
      { timeout: 15_000 },
    ).toBe(0);
    // `dir` is stale once the panel has closed, so the promoted take is
    // looked up by name instead. `launch()` seeds the library with its own
    // fixture take (`makeTakeFolder`) for the app to have something to show
    // at boot — filtered out here so this only names the take THIS test just
    // captured and saved.
    const savedShots = readdirSync(recordings).filter((n) => n !== "2026-08-24_10-00-00");
    expect(savedShots).toHaveLength(1);
    expect(storedRegions(join(recordings, savedShots[0]!))).toHaveLength(1);
  }, 60_000);

  test("Save persists the chosen Style, not just redactions (STC-392 review, I2)", async () => {
    // `still:writeShot` used to accept redactions only, so picking a Style
    // other than the one the capture was taken with and pressing Save left
    // the stored document — and therefore the library tile — showing the
    // OLD mode. Needs a WINDOW shot: a display crop's `availableModes()` is
    // `["selected-area"]` alone (no alpha), so there is nothing to switch to.
    const { win, recordings } = await launch({ STC_OVERLAY_SYNTHETIC_INPUT: "1" });
    const { panel, dir } = await windowShotPanel(win);

    // The stand-in writes a fresh window shot as "window-only" (see
    // `_fake-helper.mjs`) — pick a DIFFERENT mode so a no-op write could not
    // pass this test by accident.
    expect(parseShot(JSON.parse(readFileSync(join(dir, "shot.json"), "utf8"))).decoration.mode)
      .toBe("window-only");
    await panel.selectOption("#mode", "window-shadow");
    // The write is a round trip to main and back, same as a redaction's.
    await expect.poll(
      () => parseShot(JSON.parse(readFileSync(join(dir, "shot.json"), "utf8"))).decoration.mode,
      { timeout: 15_000 },
    ).toBe("window-shadow");

    await panel.click("#save");
    await expect.poll(
      () => app!.windows().filter((p) => p.url().includes("thumbnail.html")).length,
      { timeout: 15_000 },
    ).toBe(0);
    const savedShots = readdirSync(recordings).filter((n) => n !== "2026-08-24_10-00-00");
    expect(savedShots).toHaveLength(1);
    const saved = parseShot(
      JSON.parse(readFileSync(join(recordings, savedShots[0]!, "shot.json"), "utf8")));
    expect(saved.decoration.mode).toBe("window-shadow");
  }, 60_000);
});
