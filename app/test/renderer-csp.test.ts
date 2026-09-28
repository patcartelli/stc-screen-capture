import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-467: `overlay.html` was the one renderer page with no Content-Security-
 * Policy meta tag at all — every other page under `app/renderer/` already
 * carries one. This asserts the property directly, over every `.html` file in
 * that directory, so a NEW page that forgets one fails here rather than
 * shipping silently — the same reason `gate-bounds.test.ts` and
 * `library-seam.test.ts` check a structural property rather than trusting
 * that whoever adds the next file remembers the convention by hand.
 */

const rendererDir = join(__dirname, "..", "renderer");

function htmlFiles(): string[] {
  return readdirSync(rendererDir).filter((f) => f.endsWith(".html"));
}

describe("every renderer page declares a Content-Security-Policy (STC-467)", () => {
  const files = htmlFiles();

  test("at least the pages this repo is known to ship are present", () => {
    // A sanity floor, not the whole claim: if `readdirSync` ever came back
    // empty (a wrong path, a renamed directory), every test below would
    // vacuously pass having checked nothing.
    expect(files).toEqual(expect.arrayContaining([
      "index.html", "overlay.html", "countdown.html", "toast.html",
      "thumbnail.html", "editor.html", "still-editor.html",
    ]));
  });

  for (const file of htmlFiles()) {
    test(`${file} has a Content-Security-Policy meta tag`, () => {
      const html = readFileSync(join(rendererDir, file), "utf8");
      expect(html).toMatch(/<meta\s+http-equiv=["']Content-Security-Policy["']/i);
    });
  }
});
