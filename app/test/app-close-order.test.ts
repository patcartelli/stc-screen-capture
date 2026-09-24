import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-449's guard. Every `afterEach` that closes the app clears its `app`
 * variable BEFORE awaiting the close, and passes its own hook bound.
 *
 * The old form, `afterEach(async () => { await app?.close()...; app = undefined; })`,
 * ran under vitest's default 10 s hook timeout. When a close overran it (a
 * test ending mid-recording, on the macOS runner), vitest moved on and the
 * hook body kept going. Its late `app = undefined` then cleared a LATER
 * test's app, and that test failed with `Cannot read properties of undefined
 * (reading 'windows')`, which points at the wrong test entirely. See
 * `_quit-fixture.ts`'s `closeApp` and `APP_CLOSE_MS`.
 *
 * Structural rather than behavioural, for the reason `window-page-lookup`
 * gives: the bad form passes on any machine where closing is fast, which is
 * every machine but the one it fails on.
 */
const TEST_DIR = join(__dirname);
const EXEMPT = new Set(["app-close-order.test.ts", "_quit-fixture.ts"]);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** Each `afterEach(...)` call's full argument text, with its line number. */
function afterEachCalls(src: string): { line: number; args: string }[] {
  const code = stripComments(src);
  const out: { line: number; args: string }[] = [];
  const re = /afterEach\s*\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "(" || code[i] === "{" || code[i] === "[") depth++;
      else if (code[i] === ")" || code[i] === "}" || code[i] === "]") depth--;
    }
    out.push({ line: code.slice(0, m.index).split("\n").length, args: code.slice(start, i - 1) });
  }
  return out;
}

/** Split an argument list at its top-level commas. */
function topLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) { parts.push(args.slice(from, i)); from = i + 1; }
  }
  parts.push(args.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** What is wrong with one afterEach, or null if it does not close an app or does so correctly. */
function problem(args: string): string | null {
  const [body = "", bound] = topLevelArgs(args);
  const close = body.search(/\.close\(|closeApp\(/);
  if (close < 0) return null;
  const cleared = body.search(/\b\w+\s*=\s*undefined/);
  if (cleared < 0 || cleared > close) return "clears its app AFTER awaiting the close";
  if (!bound) return "has no hook bound (vitest's default is 10 s)";
  return null;
}

describe("e2e afterEach clears its app before closing it, under its own bound (STC-449)", () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".ts") && !EXEMPT.has(f));

  for (const f of files) {
    test(`${f}`, () => {
      const bad = afterEachCalls(readFileSync(join(TEST_DIR, f), "utf8"))
        .map(({ line, args }) => ({ line, why: problem(args) }))
        .filter((x) => x.why);
      expect(bad.map((b) => `line ${b.line}: ${b.why}`),
        `app/test/${f}: use \`const a = app; app = undefined; await closeApp(a);\` with APP_CLOSE_MS (_quit-fixture.ts)`)
        .toEqual([]);
    });
  }

  test("the guard catches the form that failed on CI, and a missing bound", () => {
    const [old] = afterEachCalls(`afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });`);
    expect(problem(old!.args)).toBe("clears its app AFTER awaiting the close");
    const [unbounded] = afterEachCalls(`afterEach(async () => { const a = app; app = undefined; await closeApp(a); });`);
    expect(problem(unbounded!.args)).toBe("has no hook bound (vitest's default is 10 s)");
  });

  test("the guard accepts the fixed form, panel-waits' own form, and hooks that close nothing", () => {
    for (const src of [
      `afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);`,
      `afterEach(async () => {\n  const closing = app;\n  app = undefined;\n  if (!closing) return;\n  await closing.close().catch(() => {});\n}, TEARDOWN_MS);`,
      `afterEach(async () => { await rm(dir, { recursive: true, force: true }); });`,
      `afterEach(() => { for (const c of live.splice(0)) c.kill(); });`,
    ]) {
      const [call] = afterEachCalls(src);
      expect(problem(call!.args), src).toBeNull();
    }
  });
});
