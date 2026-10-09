import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fmtDuration } from "../src/library-items.js";

/**
 * STC-487 / Task 8: the panel's renderer serves a recording as well as a shot.
 *
 * The renderer runs in a window, so what a unit test can pin is the SOURCE: a
 * recording has no `shot.json`, `parseShot` refuses rather than defaults, and
 * every path that reads the shot has to leave early for a recording rather than
 * throw. A guard at each entry can be grepped; a listener that was never
 * attached cannot. The real behaviour is `recording-panel.e2e.test.ts` (Task 10).
 */
const src = readFileSync(join(__dirname, "../src/thumbnail-renderer.ts"), "utf8");

/** The body of `name` up to the next top-level declaration. */
function bodyOf(name: string): string {
  const at = src.indexOf(name);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(at + name.length);
  const next = rest.search(/\n(?:async function|function|card\.addEventListener|document\.addEventListener|void \()/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("a recording never reaches a shot-only path", () => {
  test("parseShot runs only for a shot", () => {
    const calls = src.match(/parseShot\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(src).toMatch(/take\.kind === "shot"\s*\?\s*parseShot\(/);
  });

  for (const entry of [
    "async function draw()",
    "async function runExport(",
    "async function refreshDragFile()",
  ]) {
    test(`${entry} returns early without a shot`, () => {
      expect(bodyOf(entry)).toMatch(/const shot = stillShot;\s*if \(!shot/);
    });
  }

  test("Copy and drag-out are refused for a recording at their entries", () => {
    expect(bodyOf("async function run(")).toMatch(/if \(take\.kind !== "shot"\) return false;/);
    expect(src).toMatch(/card\.addEventListener\("pointerdown", \(e\) => \{[^}]*?if \(take\.kind !== "shot"\) return;/s);
  });

  test("a recording paints without a frame, through the same settle-window function", () => {
    expect(src).toMatch(/if \(!stillShot\) \{\s*markReady\(\);\s*paintCard\(\);\s*return;/);
    // ONE arming site for the 300 ms input guard, so a recording cannot lose it.
    expect((src.match(/keysLiveAt = performance\.now\(\)/g) ?? [])).toHaveLength(1);
  });

  test("control: the patterns fire on shot-only code that lacks the guard", () => {
    const unguarded = "async function draw(): Promise<void> {\n  if (!frame) return;\n}\n";
    expect(unguarded).not.toMatch(/const shot = stillShot;\s*if \(!shot/);
  });
});

describe("STC-395: a failed GIF refuses Copy and Save by key as well as by button", () => {
  test("perform() returns false for copy/save in GIF mode when copySaveEnabled is false", () => {
    expect(bodyOf("async function perform(")).toMatch(
      /\(action === "copy" \|\| action === "save"\) && formatOf\(gif\) === "gif" && !copySaveEnabled\(gif\)\) return false;/);
  });
  test("the switch is disabled while an action is in flight", () => {
    expect(src).toMatch(/b\.disabled = copying \|\| busy;/);
  });
});

describe("the recording card's duration", () => {
  test("is the library's own formatter", () => {
    expect(fmtDuration(42_000)).toBe("0:42");
    expect(fmtDuration(67_000)).toBe("1:07");
  });
});
