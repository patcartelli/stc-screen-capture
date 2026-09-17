import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * The contract STC-392 reverses, end to end.
 *
 * `thumbnail.e2e.test.ts` used to assert that ignoring the panel WROTE the
 * shot — "there is no path where a capture is silently lost" was STC-296's
 * acceptance criterion and a timeout was how it was kept. STC-392 keeps the
 * same promise a different way: ignoring the panel writes nothing, because
 * the panel is still there and the take is still in temp storage where
 * STC-393's crash recovery will find it.
 *
 * This is a NEW file rather than an edit, because it is a different claim
 * about the same pixels and the two should be readable side by side.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Long enough that a timeout would certainly have fired.
 *
 * The old floor was 3 s and the old default 6 s; waiting 8 s means a
 * re-introduced clock at either value is caught rather than raced. The test's
 * own vitest timeout must exceed this — see the rule this repo learned in
 * `bc9faaf`.
 */
const LONGER_THAN_ANY_OLD_TIMEOUT_MS = 8_000;

describe("the panel waits (STC-392)", () => {
  test("left alone, the panel is still there and the take is still in temp", async () => {
    const { dir: recordings } = makeTakeFolder();
    const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
    const destDir = mkdtempSync(join(tmpdir(), "stc-thumb-dest-"));
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    writeFileSync(join(userData, "settings.json"),
                  JSON.stringify({ still: { destination: destDir } }));

    app = await electron.launch({
      args: [root, `--user-data-dir=${userData}`],
      cwd: root,
      env: {
        ...process.env,
        STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
        STC_HELPER_BIN: FAKE_HELPER, STC_NO_SHUTTER: "1",
      },
    });
    const win = await app.firstWindow();
    await win.waitForSelector("#capturestill");
    // NOT a click on the button: `#capturestill` opens the SELECTION overlay
    // (region mode) and needs a driven drag to ever produce a capture — see
    // `still-overlay.e2e.test.ts`'s `STC_OVERLAY_SYNTHETIC_INPUT` dance. This
    // test is about the panel, not the overlay, so it reaches the same
    // `display` capture every other thumbnail/nothing-lost e2e test uses.
    const r = await win.evaluate(() => (window as any).recorder.captureStill("display"));
    expect(r.ok).toBe(true);

    // The panel is up.
    await sleep(1_000);
    let panels = await app.windows();
    expect(panels.some((p) => p.url().includes("thumbnail.html"))).toBe(true);

    await sleep(LONGER_THAN_ANY_OLD_TIMEOUT_MS);

    // Still up — this is the assertion the whole ticket is about.
    panels = await app.windows();
    expect(panels.some((p) => p.url().includes("thumbnail.html"))).toBe(true);
    // And nothing was written anywhere, because nothing was decided.
    expect(readdirSync(destDir)).toEqual([]);
    // The take is exactly where STC-393 put it.
    expect(readdirSync(temp).length).toBe(1);
    // `makeTakeFolder()` seeds `recordings` with its own fixture take so the
    // app has something to show at boot (the same reasoning every other file
    // using it states); filtered out here so this only names what THIS
    // capture would have promoted, which is nothing.
    expect(readdirSync(recordings).filter((n) => !n.startsWith(".") && n !== "2026-08-24_10-00-00"))
      .toEqual([]);
  }, 40_000);   // must exceed the 8 s wait inside it plus launch — bc9faaf's rule
});
