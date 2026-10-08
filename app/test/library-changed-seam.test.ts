import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-519: a recording saved from its panel did not appear under the selected
 * chip until the user changed chips. Promotion happens in main; the library
 * window only rescans when told. This pins the telling as a grep — the same
 * shape as `library-seam.test.ts` — because the failure needs a real panel
 * Save to reproduce and a new promote site is easy to add without it.
 */
const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

describe("library:changed (STC-519)", () => {
  const main = src("main.ts");

  test("main.ts promotes through promoteIntoLibrary, except Save All at quit", () => {
    const bare = main.split("\n").filter((l) => /\bpromoteTake\(/.test(l) && !l.trim().startsWith("*") && !l.trim().startsWith("//"));
    // The wrapper's own call, and the quit loop (the window is going away).
    expect(bare.length).toBe(2);
    expect(bare.some((l) => l.includes("onPromoted") || l.includes("() => send(\"library:changed\""))).toBe(true);
  });

  test("the wrapper sends library:changed", () => {
    expect(main).toMatch(/promoteTake\([^)]*\(\) => send\("library:changed"/);
  });

  test("preload forwards the channel and the renderer rescans on it", () => {
    expect(src("preload.ts")).toContain('"library:changed"');
    expect(src("renderer.ts")).toMatch(/recorder\.on\("library:changed", \(\) => \{ void refreshTakes\(\)/);
  });

  test("control: the patterns do not match a file that lacks the wiring", () => {
    expect('recorder.on("still:captured", () => {})').not.toMatch(/recorder\.on\("library:changed"/);
  });
});
