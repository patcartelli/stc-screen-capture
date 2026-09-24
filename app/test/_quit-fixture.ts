import type { ElectronApplication } from "playwright";

/**
 * Answer the before-quit "unsaved takes" dialog (STC-392), so `app.close()`
 * does not hang.
 *
 * `app.on("before-quit")` in `main.ts` now `preventDefault()`s and raises a
 * modal `dialog.showMessageBox` (Save All / Quit Anyway / Cancel) whenever
 * `unsavedTakeDirs()` is non-empty — which any e2e test that ends with a
 * panel still open triggers, silent (`skip`) panels included. Nobody was
 * answering it: Playwright's `app.close()` blocked until the suite's 10s
 * `afterEach` timeout, the test failed, and the still-alive Electron process
 * leaked into whatever ran next (cascading failures in files that never
 * touched a panel themselves).
 *
 * Ruling 1 (STC-392 regression fix) is that the warning is correct behaviour
 * and the tests must answer it, not bypass it — so this is a real stub
 * matching `manage.e2e.test.ts`'s established `app.evaluate(({ dialog }) =>
 * ...)` pattern, not a production-code escape hatch.
 *
 * It must be installed the INSTANT `electron.launch()` resolves — before
 * `app.firstWindow()` is even awaited — because unlike a user-triggered
 * dialog (`manage.e2e.test.ts`) or the startup-race one
 * (`crash-recovery.e2e.test.ts`), this one can fire at ANY later point: the
 * moment `app.close()` runs, at the end of a test, with no window of "before
 * the click" to install it in. Installing at launch is the only point that is
 * guaranteed to be before every possible quit.
 *
 * The response is always index 1, "Quit Anyway" — never index 0, "Save All".
 * Save All promotes every open take into the library, which would silently
 * change what these tests observe on disk (several assert exactly the
 * temp-vs-library split). Quit Anyway deletes nothing and leaves takes in
 * temp, which is what these tests already expect.
 */
export async function stubQuitDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (..._args: unknown[]) =>
      ({ response: 1, checkboxChecked: false })) as any;
  });
}
