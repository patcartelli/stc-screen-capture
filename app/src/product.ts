/**
 * The product's own identity (STC-399), from the STC Product Naming Spec.
 *
 * `MODEL_CODE` stays fixed for the life of the job; the version moves under
 * it. One constant, reused by the three surfaces the ticket names — the
 * instrument strip (this file's `MODEL_CODE` alone), the About panel and the
 * export manifest stamp (`productStamp`, called with `app.getVersion()` on
 * the main-process side and with the version reported over IPC on the
 * editor's) — rather than any of them typing "SK-016" a second time.
 *
 * No imports on purpose: this file has to be reachable from the Electron
 * main process (Node), the main window's renderer and the editor's renderer
 * (both browser, no DOM types required to just read a constant), which is
 * exactly the three worlds `tsconfig.node.json`/`tsconfig.browser.json`
 * keep apart. A module with nothing to import cannot fail any of them.
 */
export const MODEL_CODE = "SK-016";

/** "STC SK-016 v{version}" — the About panel and the export stamp's own words. */
export function productStamp(version: string): string {
  return `STC ${MODEL_CODE} v${version}`;
}
