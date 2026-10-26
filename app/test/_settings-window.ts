import type { ElectronApplication, Page } from "playwright";
import { pageWithUrl } from "./_windows.js";

/**
 * Open Settings the way a person does, with the library's gear (STC-581), and
 * hand back its page. Settings is its own window now, so a test that used to
 * click #settings and poke the sheet in the library page drives this page.
 */
export async function openSettings(app: ElectronApplication, library: Page, pane?: string): Promise<Page> {
  await library.click("#settings");
  const page = await pageWithUrl(app, "settings.html");
  await page.waitForLoadState("domcontentloaded");
  if (pane) await page.click(`#sidebar button[data-pane="${pane}"]`);
  return page;
}
