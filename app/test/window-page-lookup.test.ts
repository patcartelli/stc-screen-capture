import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-434's guard: no e2e test takes a `Page` with a bare `.windows().find(`.
 *
 * `windowCount` (main process) sees a window before Playwright attaches its
 * `Page` (`_windows.ts` has the table and the STC-434 measurement), so a test
 * that waits on the count and then does `app.windows().find(...)!` gets
 * `undefined` whenever the gap is open — only under load, so it passes on an
 * idle machine and reddens CI. #205 fixed it in panel-waits; the same line
 * was also in quit (master run 35746783680 failed on it) and thumbnail.
 * `pageWithUrl`/`pageMatching` are the owner; this keeps them the only way.
 *
 * Structural rather than behavioural for the reason `e2e-user-data-isolation`
 * states: the bad form passes on any idle machine.
 *
 * Exempt: `_windows.ts` (the owner) and `_toast.ts`, whose `toastPage` answers
 * "is a toast up NOW" and is only ever read inside a poll or as an absence
 * check — returning undefined is its contract, not a race.
 */
const TEST_DIR = join(__dirname);
const EXEMPT = new Set(["_windows.ts", "_toast.ts", "window-page-lookup.test.ts"]);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** Line numbers of every `.windows().find(` / `.windows()\n  .find(`. */
function bareLookups(src: string): number[] {
  const code = stripComments(src);
  const out: number[] = [];
  for (const m of code.matchAll(/\.windows\(\)\s*\.\s*find\s*\(/g)) {
    out.push(code.slice(0, m.index).split("\n").length);
  }
  return out;
}

describe("e2e tests take a Page through pageWithUrl/pageMatching, never a bare find (STC-434)", () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".ts") && !EXEMPT.has(f));

  for (const f of files) {
    test(`${f} has no bare .windows().find(`, () => {
      const lines = bareLookups(readFileSync(join(TEST_DIR, f), "utf8"));
      expect(lines, `app/test/${f} lines ${lines.join(", ")}: use pageWithUrl/pageMatching (_windows.ts)`).toEqual([]);
    });
  }

  test("the pattern catches the form that failed on CI, on one line and split", () => {
    expect(bareLookups(`const panel = app!.windows().find((p) => p.url().includes("thumbnail.html"))!;`))
      .toEqual([1]);
    expect(bareLookups(`const p = app!.windows()\n  .find((p) => p.url() === u)!;`)).toEqual([1]);
  });

  test("the pattern leaves pageWithUrl, a polled loop and a comment alone", () => {
    expect(bareLookups(`const panel = await pageWithUrl(app!, "thumbnail.html");`)).toEqual([]);
    expect(bareLookups(`for (const p of app!.windows()) if (p.url().includes("x")) return p;`)).toEqual([]);
    expect(bareLookups(`// app.windows().find( is what this guard refuses`)).toEqual([]);
  });
});
