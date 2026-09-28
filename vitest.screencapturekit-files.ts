/**
 * The unit test files that make the REAL helper call ScreenCaptureKit, which
 * must never run at the same time as each other (STC-470).
 *
 * Measured on macOS 27, ungranted, with bare Swift probes and no helper code:
 * when two processes make their first `SCShareableContent` call within about
 * a millisecond of each other, one is refused in ~30 ms and the other is never
 * answered at all — the helper's 15 s backstop replies `start-timeout`. Worse,
 * while any process holding such a lost call is alive, other callers are lost
 * too (7 of 18 fresh probes), so one collision cascades: 16 helpers started at
 * once lost 14. Once every stuck process has exited, 18 of 18 answered.
 * Retrying in the test was tried twice and held in neither form; not
 * overlapping is the fix. `docs/TICKET-LOG.md`'s STC-470 row has the numbers.
 *
 * Only three helper commands reach ScreenCaptureKit — `start`,
 * `capture-still` and `windows`; `devices` and app launch do not. The files
 * below are every unit test that sends one to the real binary.
 * `vitest.config.ts` runs them in their own `fileParallelism: false` project,
 * which vitest schedules into the same sequential group as the e2e project:
 * after the parallel unit files, one file at a time. (`shell.e2e.test.ts`
 * reaches ScreenCaptureKit too and is already in that group.)
 *
 * `app/test/screencapturekit-serial.test.ts` fails if a unit file starts doing
 * this without being listed here.
 */
export const SCREENCAPTUREKIT_FILES = [
  "helper/test/capture.test.ts",
  "helper/test/ipc.test.ts",
  "app/test/supervisor.test.ts",
  "app/test/helper-client.test.ts",
];
