import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";

/**
 * The Settings sheet, end to end (STC-412): the sheet-opening button renamed
 * from "Profile" to "Settings", and Scope/Camera/Mic relocated out of the
 * main window's record row into a new "Profile" section inside the sheet,
 * ahead of the pre-existing "Preferences" section. Nothing about the sheet's
 * open/close mechanics changed — only what it contains and how it is opened.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

async function launch(opts: { userData: string; recordings: string }) {
  app = await electron.launch({
    args: [root, `--user-data-dir=${opts.userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: opts.recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await withoutCountdown(win);
  return win;
}

describe("the settings sheet", () => {
  test("the sheet holds Profile and Preferences as two sections, and Scope/Camera/Mic live there now", async () => {
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: makeTakeFolder().dir });
    // Not directly clickable before the sheet opens — this is the ticket's own
    // acceptance property, and the negative check matters as much as the
    // positive one below. The sheet is a slide-over (`transform: translateX`)
    // rather than `display: none`, so Playwright's own `isVisible()` reports
    // true even while it sits off-screen — the real signal is the bounding
    // box, which lands past the window's right edge until `.open` slides it
    // in.
    const viewportWidth = await win.evaluate(() => window.innerWidth);
    const boxBeforeOpen = await win.locator("#scope").boundingBox();
    expect(boxBeforeOpen).not.toBeNull();
    expect(boxBeforeOpen!.x).toBeGreaterThanOrEqual(viewportWidth);
    await win.click("#settings");
    await expect.poll(() => win.getAttribute("#profilesheet", "class")).toMatch(/open/);
    const headings = await win.locator("#profilesheet h2").allTextContents();
    expect(headings).toContain("Profile");
    expect(headings).toContain("Preferences");
    expect(headings.indexOf("Profile")).toBeLessThan(headings.indexOf("Preferences"));
    expect(await win.isVisible("#scope")).toBe(true);
    expect(await win.isVisible("#camera")).toBe(true);
    expect(await win.isVisible("#mic")).toBe(true);
    expect(await win.locator("#stillcleardest").count()).toBe(0);
  });
});
