import type { ElectronApplication } from "playwright";

/**
 * Install something in the main process right after `electron.launch()`,
 * and KNOW it is installed (STC-513).
 *
 * An `app.evaluate` issued that early usually arrives while main is still
 * inside `app.whenReady()`'s callback (blocked in `createWindow()` for
 * ~150 ms when `STC_OPEN_LIBRARY_ON_LAUNCH` is set). The inspector then runs
 * it as a V8 interrupt: the function body runs at once, and V8 wraps the
 * result in a promise for `awaitPromise`, holding it only by a WEAK handle.
 * Node drains microtasks only at its own checkpoints, so the reply waits
 * until that callback returns. If a minor GC lands in the gap, the wrapper is
 * collected and Playwright throws "Resulting promise was garbage collected",
 * even though the install RAN. Forcing one `gc()` right after `createWindow()`
 * makes it fail every time; `docs/CORRECTNESS-TRAPS.md` has the measurements.
 *
 * So `install` must set `globalThis[marker] = true` as its last step, and
 * this reads the marker back every time, not only after a lost reply, so a
 * forgotten marker fails on the first run rather than on the rare one. A
 * lost reply is never re-installed blind: the read-back says whether it ran,
 * and is asked again (a few times at most) when its own reply is lost the same
 * way while startup is still busy. A marker that is missing after a lost reply
 * throws, because that would mean the cause above is wrong.
 */
export async function installAtLaunch<Arg>(
  app: ElectronApplication,
  install: (electron: typeof import("electron"), arg: Arg) => void,
  arg: Arg,
  marker: string,
): Promise<void> {
  let lost = false;
  try {
    await app.evaluate(install as never, arg);
  } catch (e) {
    if (!isLostReply(e)) throw e;
    lost = true;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const installed = await app.evaluate((_e, m: string) => (globalThis as Record<string, unknown>)[m] === true, marker);
      if (installed) return;
      throw new Error(lost
        ? `STC-513: the install's reply was lost and ${marker} is not set, so it did not run`
        : `installAtLaunch: the install ran but did not set globalThis.${marker}`);
    } catch (e) {
      if (!isLostReply(e) || attempt >= LOST_REPLY_READS) throw e;
    }
  }
}

/** How many times a lost read-back is asked again before giving up (STC-513). */
export const LOST_REPLY_READS = 5;

export function isLostReply(e: unknown): boolean {
  return e instanceof Error && e.message.includes("Resulting promise was garbage collected");
}
