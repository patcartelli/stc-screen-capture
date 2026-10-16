import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS, stubQuitDialog } from "./_quit-fixture.js";

/**
 * STC-479 through the real app: the camera popover tags a virtual camera and
 * lists it after the physical ones. The pure rule is `device-picker.test.ts`'s;
 * this is the part that test cannot see — that the helper's `devices` answer
 * reaches the popover with `virtual` intact and the tag is drawn.
 *
 * The cameras come from the fake helper's `STC_FAKE_CAMERAS`, deliberately
 * listed virtual-first so the sort is what puts it last.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

describe("the camera menu's virtual label (STC-479)", () => {
  test("a virtual camera is tagged and listed after the physical ones", async () => {
    const { dir: recordings } = makeTakeFolder();
    app = await electron.launch({
      args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
      cwd: root,
      env: {
        ...process.env,
        STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
        STC_HELPER_BIN: FAKE_HELPER,
        STC_FAKE_CAMERAS: JSON.stringify([
          { name: "Fixture Virtual Camera", uid: "fixture-virt", virtual: true },
          { name: "Fixture Webcam", uid: "fixture-cam", virtual: false },
        ]),
      },
    });
    await stubQuitDialog(app);
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await expect.poll(() => win.isEnabled("#camera-picker"), { timeout: 30_000 }).toBe(true);

    const rows = win.locator("#devicepopover .row");
    // The popover draws what the renderer knew when it opened, and the device
    // list arrives after first paint, so reopen until both cameras are in.
    await expect.poll(async () => {
      await win.click("#camera-picker");
      const n = await rows.count();
      if (n < 4) await win.keyboard.press("Escape");
      return n;
    }, { timeout: 20_000 }).toBe(4);

    const labels = await rows.locator(".label").allTextContents();
    expect(labels).toEqual(["No Camera", "Automatic", "Fixture Webcam", "Fixture Virtual Camera"]);
    // Only the virtual row carries the tag, and it is not part of the name.
    expect(await rows.locator(".secondary").allTextContents()).toEqual(["virtual"]);
    expect(await rows.nth(3).locator(".secondary").count()).toBe(1);
    expect(await rows.nth(2).locator(".secondary").count()).toBe(0);
  }, 180_000);
});
