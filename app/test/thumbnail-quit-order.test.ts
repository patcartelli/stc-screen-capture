import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * At quit, the panels are hidden, the window server is given `HIDE_SETTLE_MS`,
 * and only then destroyed (STC-624).
 *
 * `closeThumbnail` used to call `dismissNow` (hide AND destroy in one tick) on
 * each panel. At quit the newest panel is usually key, so AppKit moved key
 * status onto or off a window already being torn down: electron/electron#54860,
 * STC-534's crash. Over 2026-11-02..12 that was ~187 of 196 e2e crashes at
 * quit, every one with a `thumbnail.html` panel open (docs/STC-624-TRIAGE.md).
 *
 * Pinned at the SOURCE: the crash needs a real window server and is a timing
 * coincidence, so no test here can reproduce it on demand — the same position
 * `thumbnail-discard-race.test.ts` is in. Evidence the fix works is the crash
 * count on CI, not this file.
 */

const SRC = readFileSync(join(__dirname, "../src/thumbnail-window.ts"), "utf8");

/** The body of `closeThumbnail`, from its signature to the next top-level `}`. */
function bodyOf(src: string): string {
  const start = src.search(/export (async )?function closeThumbnail\(/);
  if (start < 0) throw new Error("closeThumbnail not found in thumbnail-window.ts");
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end);
}

/** Hide every panel, then wait out the settle, then destroy — in that order. */
function hidesThenSettlesThenDestroys(body: string): boolean {
  const hide = body.search(/\.hide\(\)/);
  const settle = body.search(/await sleep\(HIDE_SETTLE_MS\)/);
  const destroy = body.search(/\.dismissNow\(\)/);
  return hide >= 0 && settle > hide && destroy > settle;
}

describe("closeThumbnail at quit (STC-624)", () => {
  test("hides every panel, waits HIDE_SETTLE_MS, then destroys", () => {
    expect(hidesThenSettlesThenDestroys(bodyOf(SRC))).toBe(true);
  });

  test("reads the panel list again after the settle, so a panel presented during it closes too", () => {
    const body = bodyOf(SRC);
    const settle = body.search(/await sleep\(HIDE_SETTLE_MS\)/);
    expect(body.slice(settle)).toMatch(/\[\.\.\.panels\]/);
  });

  test("CONTROL: the pre-STC-624 body (dismiss at once) fails the check", () => {
    const old = `export function closeThumbnail(): Promise<void> {
  const all = [...panels];
  if (all.length === 0) return Promise.resolve();
  for (const p of all) p.dismissNow();
  return Promise.all(all.map((p) => p.waitUntilClosed())).then(() => undefined);
}
`;
    expect(hidesThenSettlesThenDestroys(bodyOf(old))).toBe(false);
  });
});
