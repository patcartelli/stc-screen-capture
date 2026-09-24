import type { ElectronApplication } from "playwright";
import { TRASH_COMMIT_AT_QUIT_MS } from "../src/pending-trash.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../src/helper-client.js";
import { QUIT_GRACE_MS } from "../src/supervisor.js";

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

/**
 * The worst case of closing the app, derived from the bounds the quit chain
 * actually runs under (STC-449). Every e2e `afterEach` that closes the app
 * uses this as its hook bound, rather than vitest's 10 s default.
 *
 * `app.close()` resolves once `runQuitTeardown()` (main.ts) has finished:
 *   - each promised deletion commits under `TRASH_COMMIT_AT_QUIT_MS`;
 *   - `sup.shutdown()` stops a live recording (one request, under the
 *     client's `DEFAULT_REQUEST_TIMEOUT_MS`), sends `quit` (another request
 *     under the same bound), then gives the helper `QUIT_GRACE_MS` to exit;
 *   - plus a margin for the window teardown and process exit around them.
 *
 * A test that ends mid-recording goes through all of it, and on the macOS
 * runner that has overrun 10 s. The typical close is ~100 ms, so this bound
 * only costs time when something is really stuck, and then it gives the
 * chain room to finish and name its slow stage (see `closeApp`).
 */
export const APP_CLOSE_MS =
  TRASH_COMMIT_AT_QUIT_MS + 2 * DEFAULT_REQUEST_TIMEOUT_MS + QUIT_GRACE_MS + 10_000;

/** A close slower than this prints its duration and the app's `[quit]` lines. */
export const SLOW_CLOSE_MS = 3_000;

/**
 * How long before its hook's bound `closeApp` stops waiting. It uses that
 * time to kill the process and say why, so the report is printed before
 * vitest abandons the hook.
 */
export const CLOSE_GIVE_UP_MARGIN_MS = 5_000;

/**
 * Close an app the way every e2e `afterEach` should (STC-449).
 *
 * The caller clears its own `app` variable BEFORE calling this, and passes
 * the hook's own bound as the hook timeout:
 *
 *     afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);
 *
 * The old form, `await app?.close()...; app = undefined;`, cleared it AFTER
 * the await. When the hook hit its bound, vitest moved on but the hook body
 * kept running, so its late `app = undefined` landed in a LATER test that had
 * already set `app`. That test then failed with `Cannot read properties of
 * undefined (reading 'windows')`, a misleading consequence of the first
 * failure. `app-close-order.test.ts` refuses that form in any test file.
 *
 * Three outcomes:
 *   - a close under `SLOW_CLOSE_MS`: silent;
 *   - a slow close that finishes: one stderr line with its duration and the
 *     app's own `[quit] teardown …` stage timings (main.ts prints them as the
 *     chain finishes; the listener is attached here because that line only
 *     ever appears during the close);
 *   - a close still running `CLOSE_GIVE_UP_MARGIN_MS` before `hookBoundMs`:
 *     the process is SIGKILLed so it cannot leak into the next test, and this
 *     THROWS with whatever `[quit]` lines it saw. The test fails, as it did
 *     when the hook timed out, but it says what it was waiting on.
 */
export async function closeApp(app: ElectronApplication | undefined, hookBoundMs = APP_CLOSE_MS): Promise<void> {
  if (!app) return;
  const proc = app.process();
  const quitLines: string[] = [];
  const onData = (chunk: Buffer | string) => {
    for (const line of String(chunk).split("\n")) {
      if (line.includes("[quit]")) quitLines.push(line.trim());
    }
  };
  proc.stderr?.on("data", onData);
  const seen = () => (quitLines.length ? quitLines.join("; ") : "no [quit] line was printed");
  const giveUpMs = hookBoundMs - CLOSE_GIVE_UP_MARGIN_MS;
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    app.close().then(() => true, () => true),
    new Promise<false>((r) => { timer = setTimeout(() => r(false), giveUpMs); }),
  ]);
  clearTimeout(timer);
  proc.stderr?.off("data", onData);
  const ms = Date.now() - t0;
  if (!closed) {
    proc.kill("SIGKILL");
    throw new Error(`app.close() did not finish within ${giveUpMs}ms, so pid ${proc.pid} was killed; ${seen()}`);
  }
  if (ms > SLOW_CLOSE_MS) {
    process.stderr.write(`[closeApp] app.close() took ${ms}ms (pid ${proc.pid}); ${seen()}\n`);
  }
}
