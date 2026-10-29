import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { launchApp, openEditorFromLibrary } from "./_editor-fixture.js";
import { productStamp } from "../src/product.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The model code, end to end (STC-399): the editor's export dialog shows the full stamp built from the SAME
 * `app.getVersion()` the About panel uses — nothing here is asserted against
 * a second, independently-typed copy of "SK-016" or the version.
 */
const root = join(__dirname, "..", "..");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

describe("the model code (STC-399)", () => {
  // "shows on the instrument strip" went with the strip: the library's title
  // bar is "Library" and its count (STC-584, Capture SK 016's frames). The
  // About panel and the export stamp still carry the code.

  test("the editor's export dialog carries the full stamp, built from app.getVersion()", async () => {
    const { dir } = makeTakeFolder();
    const r = await launchApp(dir);
    app = r.app;
    const editorWin = await openEditorFromLibrary(app, r.win);

    const version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    await editorWin.click("#openexport");
    await editorWin.waitForSelector("#exportpanel:not([hidden])", { timeout: 10_000 });
    await expect.poll(() => editorWin.textContent("#modelstamp"), { timeout: 10_000 })
      .toBe(productStamp(version));
  }, 60_000);
});
