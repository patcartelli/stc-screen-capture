import { describe, test, expect } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { pageMatching, pageWithUrl } from "./_windows.js";

/**
 * Acquiring a `Page` has to WAIT (STC-434).
 *
 * The defect this pins is not hypothetical and not a timeout: `panel-waits`
 * polled `windowCount(app, "thumbnail.html")` — the MAIN process's clock,
 * ~78-110 ms to commit — and then dereferenced `app.windows()`, Playwright's
 * attached-page list, which is a different clock at 78-147 ms. On CI that
 * produced `Cannot read properties of undefined (reading 'click')` on four
 * runs across two PRs.
 *
 * The race needs the attach lag to outrun the commit, which no real launch
 * can be asked to do on demand — so it is reproduced at the SEAM instead,
 * with a stub whose window list is empty for the first few reads. That is the
 * same reasoning `thumbnail-discard-race.test.ts` records for pinning a race
 * at its source rather than chasing it live.
 *
 * The load-bearing case is `attaches late`: a single `.find()` returns
 * `undefined` there, which is exactly what CI saw.
 */

/** A page stub — only `url()` is ever consulted by the helpers under test. */
const pageAt = (url: string) => ({ url: () => url }) as unknown as Page;

/**
 * An `ElectronApplication` stub whose window list is empty for the first
 * `emptyReads` calls, then holds `pages`. `reads` counts how often the helper
 * actually looked, so a test can prove it polled rather than got lucky.
 */
function appWhereWindowsAppearAfter(emptyReads: number, pages: Page[]) {
  const state = { reads: 0 };
  const app = {
    windows: () => { state.reads++; return state.reads > emptyReads ? pages : []; },
    // Only reached on the failure path, for the message.
    evaluate: async () => ["file:///main.html"],
  } as unknown as ElectronApplication;
  return { app, state };
}

describe("acquiring a Page waits for Playwright to attach one (STC-434)", () => {
  test("a window already attached is returned without delay", async () => {
    const panel = pageAt("file:///app/renderer/thumbnail.html");
    const { app, state } = appWhereWindowsAppearAfter(0, [panel]);
    expect(await pageWithUrl(app, "thumbnail.html")).toBe(panel);
    expect(state.reads, "no polling needed when it is already there").toBe(1);
  });

  test("a window that attaches LATE is waited for, not read as undefined", async () => {
    // THE regression. A single `app.windows().find(...)` here returns
    // undefined and the caller dies on `.click`.
    const panel = pageAt("file:///app/renderer/thumbnail.html");
    const { app, state } = appWhereWindowsAppearAfter(4, [panel]);
    expect(await pageWithUrl(app, "thumbnail.html")).toBe(panel);
    expect(state.reads, "it kept looking").toBeGreaterThan(4);
  });

  test("the right window is picked out of several", async () => {
    const main = pageAt("file:///app/renderer/index.html");
    const panel = pageAt("file:///app/renderer/thumbnail.html");
    const toast = pageAt("file:///app/renderer/toast.html?mode=message");
    const { app } = appWhereWindowsAppearAfter(2, [main, panel, toast]);
    expect(await pageWithUrl(app, "toast.html")).toBe(toast);
  });

  test("a predicate can exclude the pages that were already up", async () => {
    // Undo's case: a SECOND panel, told apart from the first only by not
    // having been in the list before.
    const old = pageAt("file:///app/renderer/thumbnail.html");
    const fresh = pageAt("file:///app/renderer/thumbnail.html");
    const before = new Set([old]);
    const { app } = appWhereWindowsAppearAfter(3, [old, fresh]);
    const got = await pageMatching(app,
      (p) => p.url().includes("thumbnail.html") && !before.has(p), "the new panel");
    expect(got).toBe(fresh);
  });

  test("a window that never attaches fails with the urls it DID see", async () => {
    // A bound that says only "timed out" cannot tell "never appeared" from
    // "appeared under a url nobody expected", and those want different fixes.
    const main = pageAt("file:///app/renderer/index.html");
    const { app } = appWhereWindowsAppearAfter(0, [main]);
    await expect(pageWithUrl(app, "thumbnail.html", 120)).rejects.toThrow(/index\.html/);
    await expect(pageWithUrl(app, "thumbnail.html", 120)).rejects.toThrow(/thumbnail\.html/);
  });

  test("the bound is honoured rather than looping forever", async () => {
    const { app } = appWhereWindowsAppearAfter(0, []);
    const t0 = Date.now();
    await expect(pageWithUrl(app, "nothing.html", 150)).rejects.toThrow(/within 150 ms/);
    // Generous upper bound — this asserts it RETURNS, not how promptly.
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
