import type { ElectronApplication } from "playwright";
import { TRASH_COMMIT_AT_QUIT_MS } from "../src/pending-trash.js";

/**
 * How long an `afterEach` gets to close the app.
 *
 * The same derivation `panel-waits.e2e.test.ts` introduced for STC-427: the
 * quit chain's worst case (a promised deletion's commit is bounded by
 * `TRASH_COMMIT_AT_QUIT_MS` in `main.ts`) plus room to observe it. Derived
 * rather than restated, so it moves if that bound does.
 *
 * Before this, 36 E2E files closed the app under vitest's DEFAULT hook
 * timeout — the e2e project sets none, so 10 s — which is less than the
 * quit chain is allowed to take.
 */
export const APP_TEARDOWN_MS = TRASH_COMMIT_AT_QUIT_MS + 20_000;

/** Over this, a close is worth a line in the log: nobody knows how long the chain usually takes on CI. */
const SLOW_CLOSE_MS = 3_000;

/**
 * Close an app a test launched. The CALLER must already have cleared its own
 * handle — that ordering is the whole point, and it cannot live in here,
 * because each file keeps its handle in its own module-level `let app`:
 *
 * ```ts
 * afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_TEARDOWN_MS);
 * ```
 *
 * The line it replaces was `await app?.close().catch(() => {}); app = undefined;`,
 * which clears the handle AFTER the close. When that close outran the hook's
 * bound, vitest abandoned the hook and started the next test — but the hook's
 * body kept running, and its late `app = undefined` landed after the NEXT test
 * had set `app`. That test then failed on `undefined` for a reason that had
 * nothing to do with it — seen on #202 (`mic-picker`: the hook timed out, and
 * the next test died reading `.windows` off `undefined`). The hook timeout by
 * itself has also been seen on master (run 35918105565, `camera-toggle`) and
 * on #209 (`scope-indicator`). Clearing first means a slow close can only ever
 * close its own app, and the longer bound gives the chain room to finish.
 *
 * `slow-close` is logged rather than asserted: why the runner's quit takes
 * this long is still unknown (#202's thread), and a line per slow close is how
 * it gets attributed — `panel-waits` already had this and nothing else did.
 * No file tag: vitest already heads stderr with the file and test that wrote it.
 */
export async function closeApp(closing: ElectronApplication | undefined): Promise<void> {
  if (!closing) return;
  const t0 = Date.now();
  await closing.close().catch(() => {});
  const ms = Date.now() - t0;
  if (ms > SLOW_CLOSE_MS) process.stderr.write(`[teardown] app.close() took ${ms}ms\n`);
}

