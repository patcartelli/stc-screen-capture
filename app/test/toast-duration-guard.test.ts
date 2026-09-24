import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The drift guard for ruling 2 (STC-392 Task 6, review I6): the undo toast's
 * progress bar reads its duration from a query param — `toast-window.ts`'s
 * own `UNDO_WINDOW_MS`, carried across in `toast-renderer.ts` — never a
 * literal written into `toast.html`'s stylesheet. A second, independently
 * spelled `8s` beside it is exactly the "one value, two copies" defect
 * CLAUDE.md names most often in this repo, and this feature already wrote
 * one variant of it once: the review that added this guard (I1) found an
 * inert `@media (prefers-reduced-motion: reduce) { animation: none; ... }`
 * rule in this same file, which is the identical shape — a decision
 * restated in the stylesheet where an inline style (`toast-renderer.ts`) had
 * already claimed the property.
 *
 * `share.test.ts`'s "the export filename lives in exactly one place" is the
 * template this follows: greps the real file rather than trusting the
 * decision stays where it was put, and proves the pattern can fire before
 * trusting that it does not.
 */
describe("the undo toast's animation duration lives in exactly one place", () => {
  const root = join(__dirname, "..", "..");
  const html = readFileSync(join(root, "app", "renderer", "toast.html"), "utf8");

  /** A duration written directly into the stylesheet, shorthand or longhand
   * — legitimate CSS never puts a bare number where `toast-renderer.ts` is
   * supposed to be the only writer. */
  const LITERAL_DURATION = /animation(-duration)?\s*:\s*[^;]*\d/;

  test("the pattern can fire", () => {
    expect("animation-duration: 8000ms;").toMatch(LITERAL_DURATION);
    expect("animation: drain 8s linear forwards;").toMatch(LITERAL_DURATION);
  });

  test("and does not fire on toast.html as it stands", () => {
    // Comments blanked first — this file's own explanation of the rule
    // (this test's own header, and the file's inline comments) mentions a
    // literal duration in prose, and a guard that flags a file for
    // DISCUSSING the rule it keeps is a guard someone turns off (STC-294).
    const code = html
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    expect(code).not.toMatch(LITERAL_DURATION);
  });
});
