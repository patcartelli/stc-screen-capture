import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { launchApp, openEditorFromLibrary } from "./_editor-fixture.js";
import { productStamp } from "../src/product.js";

/**
 * The model code, end to end (STC-399): the instrument strip shows the bare
 * code, the editor's export dialog shows the full stamp built from the SAME
 * `app.getVersion()` the About panel uses — nothing here is asserted against
 * a second, independently-typed copy of "SK-016" or the version.
 */
const root = join(__dirname, "..", "..");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

describe("the model code (STC-399)", () => {
  test("shows on the instrument strip, and disappears with everything else when the pill collapses", async () => {
    const { dir } = makeTakeFolder();
    const r = await launchApp(dir);
    app = r.app;
    const win: Page = r.win;

    expect(await win.textContent("#modelcode")).toBe("SK-016");
    expect(await win.isVisible("#modelcode")).toBe(true);

    // The same CSS rule that hides the title hides this — no separate
    // conditional was written for it, so exercising the class directly
    // proves the placement rather than a real recording proving nothing new.
    await win.evaluate(() => document.body.classList.add("pill-collapsed"));
    expect(await win.isVisible("#modelcode")).toBe(false);
  }, 60_000);

  test("the editor's export dialog carries the full stamp, built from app.getVersion()", async () => {
    const { dir } = makeTakeFolder();
    const r = await launchApp(dir);
    app = r.app;
    const editorWin = await openEditorFromLibrary(app, r.win);

    const version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    await editorWin.click("#openexport");
    await editorWin.waitForSelector("#exportdialog[open]", { timeout: 10_000 });
    await expect.poll(() => editorWin.textContent("#modelstamp"), { timeout: 10_000 })
      .toBe(productStamp(version));
  }, 60_000);
});
