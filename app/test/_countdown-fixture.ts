import type { Page } from "playwright";

/**
 * Turn the countdown off for a test that is not ABOUT the countdown (STC-391).
 *
 * Record always counts down now, so every E2E file that presses Record would
 * otherwise wait out a real three seconds — nine files, several of them
 * starting more than one take. That is a lot of wall clock added to a suite
 * whose flakiness was traced to timing only days ago (STC-386), for a delay
 * none of those tests is checking.
 *
 * It goes through the SHIPPED preference rather than a test-only backdoor:
 * `countdownMs: 0` is a legitimate stored value that `countdown.ts` rule 6
 * defines as "off", so a file calling this is exercising a path a user can
 * reach, not one built for tests. `countdown.e2e.test.ts` is the file that
 * deliberately does NOT call it.
 */
export async function withoutCountdown(win: Page): Promise<void> {
  await win.waitForFunction(() => Boolean((window as any).recorder));
  await win.evaluate(() => (window as any).recorder.setSettings({ countdownMs: 0 }));
}

/** The opposite, for a test that wants a countdown of a known length. */
export async function withCountdown(win: Page, ms: number): Promise<void> {
  await win.waitForFunction(() => Boolean((window as any).recorder));
  await win.evaluate((v) => (window as any).recorder.setSettings({ countdownMs: v }), ms);
}
