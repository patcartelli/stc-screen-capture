import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-488: the editor and the copy render load a take through ONE module.
 * A second hand-built loader is how a sink starts to fork the transform
 * (CLAUDE.md, the non-negotiable), so this greps for it, with a control
 * proving the pattern fires.
 */
const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
const BUILDS_A_SESSION = /\bloadSession\s*\(/;

describe("one session loader (STC-488)", () => {
  test("control: session-io.ts itself calls loadSession", () => {
    expect(src("session-io.ts")).toMatch(BUILDS_A_SESSION);
  });
  test("the editor imports it instead of calling loadSession", () => {
    expect(src("editor.ts")).not.toMatch(BUILDS_A_SESSION);
    expect(src("editor.ts")).toMatch(/from "\.\/session-io\.js"/);
  });
  // Task 5 creates copy-render.ts and switches this on, with the same two
  // assertions the editor's test above makes.
  test.todo("the copy render imports it instead of calling loadSession");
});
