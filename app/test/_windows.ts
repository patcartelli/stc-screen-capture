import type { ElectronApplication } from "playwright";

/**
 * Counting windows from the MAIN process, for every e2e test that counts
 * windows or claims one is absent (STC-416).
 *
 * `app.windows()` is Playwright's list of ATTACHED PAGES, not the app's list
 * of windows, and the two disagree in ways an assertion cannot see. Measured
 * here on 2026-09-19 (three runs each, spread given), against a real launch of
 * this app:
 *
 *   | the window                              | `getAllWindows()` | `app.windows()`      |
 *   |-----------------------------------------|-------------------|----------------------|
 *   | created, no URL ever loaded             | immediately       | NEVER                |
 *   | created + `loadURL`/`loadFile`          | immediately       | 78-147 ms later      |
 *   | (same, counted by URL substring)        | ~78-110 ms later  | 78-147 ms later      |
 *   | a tracked window, destroyed             | immediately       | listed ~22-26 ms more|
 *
 * So `app.windows()` is right — and the only choice — when a test needs a
 * `Page` to click on or evaluate in. It is wrong for a count taken right
 * after an action, wrong for "nothing appeared", and wrong for "still here"
 * for ~25 ms after something went away. STC-392's review found the first
 * case by planting a bare `BrowserWindow` that the assertion never saw.
 *
 * The third row is the one to read twice: a count SCOPED BY URL sees a fresh
 * window only once its navigation has committed, from either process. A
 * "no window of url X appeared" check is therefore only as strong as the
 * commit, however it is read; the strong form of "nothing appeared" is a
 * before/after `windowCount(app)` with no url, which is what the worked
 * example in panel-waits.e2e.test.ts does. Scoped counts are still the
 * right instrument for "went away" and "still here" (no lag at all) and for
 * "exactly N are up" (a decoy that has loaded but not attached is counted).
 *
 * Two things a POLL over these can and cannot claim, both watched under
 * product-side decoys (STC-416's PR has the ledger):
 *
 *  - `expect.poll(() => windowCount(app, "x.html")).toBe(0)` is satisfied by
 *    its FIRST sample. It proves the window it was tracking is gone; it says
 *    nothing about a replacement created in the same tick, whose url has not
 *    committed yet (a decoy spawned inside `destroy()` failed none of the
 *    "went away" polls in the suite; the same decoy spawned at presentation
 *    failed every one). That is the claim, not a weakness to poll harder at.
 *  - `expect.poll(() => windowCount(app, "x.html")).toBe(N)` proves AT LEAST
 *    N. A `file:` load commits ~30 ms before an `about:blank#…` one, and a
 *    poll sampled inside that gap saw exactly N with N+1 on the way. Only an
 *    exact read taken later — after the next action, or a settle — proves
 *    exactly N. Most tests here already take one; a new test should.
 */

/** How many BrowserWindows the main process has right now; optionally only those whose URL contains `urlPart`. */
export function windowCount(app: ElectronApplication, urlPart?: string): Promise<number> {
  return app.evaluate(({ BrowserWindow }, part) =>
    BrowserWindow.getAllWindows().filter((w) => part === undefined || w.webContents.getURL().includes(part)).length,
  urlPart);
}

/** Every window's URL, from the main process — for a failure message, never for an assertion's subject. */
export function windowUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));
}

/** `windowCount(app, urlPart) > 0`, for a "still here" / "never appeared" read that is exact rather than 25 ms stale. */
export async function hasWindow(app: ElectronApplication, urlPart: string): Promise<boolean> {
  return (await windowCount(app, urlPart)) > 0;
}
