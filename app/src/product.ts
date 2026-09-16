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

/**
 * What the app is CALLED (STC-397), from the same Naming Spec: the product
 * is "Capture", STC is the label, and `MODEL_CODE` above is the model.
 *
 * This is the display name — window titles, the tray tooltip, the About
 * panel. It is deliberately the same string `package.json`'s `productName`
 * carries, because Electron derives `app.getName()` (and therefore
 * `app.getPath("userData")`) from that field, and a launcher matches it
 * exactly. Typing it twice is how the folder settings live in and the name
 * on screen drift apart.
 */
export const PRODUCT_NAME = "Capture";

/**
 * The Application Support folder this app used before it was renamed.
 *
 * `productName` sets `userData`, so renaming the product MOVES it — from
 * `…/stc-screen-recorder` to `…/Capture` — and everything stored there
 * would be orphaned rather than lost: still on disk, just somewhere the app
 * no longer looks. `migrateLegacyAppData` (main.ts) and
 * `migrateLegacyTempTakes` (temp-takes.ts) carry the two things this app
 * actually owns there across, once, on first launch after the rename.
 *
 * Kept as a constant rather than inlined at those two call sites for the
 * usual reason: they have to agree about which folder they are rescuing,
 * and a second spelling of it is how one of them silently stops finding
 * anything.
 */
export const LEGACY_APP_DIR_NAME = "stc-screen-recorder";

/** "STC SK-016 v{version}" — the About panel and the export stamp's own words. */
export function productStamp(version: string): string {
  return `STC ${MODEL_CODE} v${version}`;
}
