import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every `afterEach` that closes an app CLEARS ITS HANDLE FIRST, and says how
 * long it may take.
 *
 * 36 E2E files closed the app with
 * `await app?.close().catch(() => {}); app = undefined;` under vitest's default
 * 10 s hook timeout. When a close outran that, vitest abandoned the hook and
 * started the next test while the hook's body kept running — and its late
 * `app = undefined` then wiped out the handle the NEXT test had just set, which
 * failed on `undefined` for a reason that had nothing to do with it (#202,
 * `mic-picker`). `_app-teardown.ts` is the one owner of the fix; this is the
 * guard that keeps a new file from reintroducing the old line.
 *
 * Checked STRUCTURALLY, like `e2e-user-data-isolation.test.ts`: no behavioural
 * test can make this claim, because the old line is correct whenever the close
 * is fast — which is every run anyone looks at.
 */

const TEST_DIR = join(__dirname);
const SELF = "e2e-teardown-order.test.ts";

/** Comments blanked before scanning, keeping offsets — `library-seam.test.ts`'s own move. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** Each `afterEach(...)` call's full text, found by balancing parentheses. */
function afterEachCalls(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const re = /\bafterEach\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 0;
    for (let i = m.index + "afterEach".length; i < code.length; i++) {
      const c = code[i];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) { out.push(code.slice(m.index, i + 1)); break; }
    }
  }
  return out;
}

type TeardownProblem = "clears-after-close" | "no-bound" | "close-before-clear";

/** What is wrong with one `afterEach(...)` call, if it closes an app at all. */
function teardownProblems(call: string): TeardownProblem[] {
  const problems: TeardownProblem[] = [];
  // The old line, and any variant of it: awaiting the handle's own close
  // inside the hook means the handle is still set while the close runs.
  if (/await\s+app\s*\??\.\s*close\(/.test(call)) problems.push("clears-after-close");
  const close = call.indexOf("closeApp(");
  if (close >= 0) {
    const clear = call.search(/\bapp\s*=\s*undefined\b/);
    if (clear < 0 || clear > close) problems.push("close-before-clear");
  }
  if (problems.length === 0 && close < 0) return problems; // not a teardown hook
  // An explicit bound: the arrow's closing brace, then `, <expr>)`.
  if (!/\}\s*,\s*[^,)]+\)\s*$/.test(call)) problems.push("no-bound");
  return problems;
}

describe("every E2E teardown clears its handle before closing, and is bounded", () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".ts") && f !== SELF);
  const closing = files.flatMap((f) =>
    afterEachCalls(readFileSync(join(TEST_DIR, f), "utf8"))
      .filter((c) => c.includes("closeApp(") || /app\s*\??\.\s*close\(/.test(c))
      .map((c) => ({ f, c })));

  test("the reader finds the teardown hooks at all", () => {
    // 38 files close an app in an afterEach today. A guard that reads nothing
    // passes on everything, so it must find most of them.
    expect(closing.length).toBeGreaterThanOrEqual(30);
  });

  test("no teardown hook has a problem", () => {
    const bad = closing
      .map(({ f, c }) => ({ f, problems: teardownProblems(c) }))
      .filter((x) => x.problems.length > 0)
      .map((x) => `app/test/${x.f}: ${x.problems.join(", ")}`);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  /** The guard must be able to FAIL — a separate claim from it passing. */
  test("it catches the old line", () => {
    const old = "afterEach(async () => { await app?.close().catch(() => {}); app = undefined; })";
    expect(teardownProblems(old)).toEqual(["clears-after-close", "no-bound"]);
  });

  test("it catches the old line even with a bound", () => {
    const old = "afterEach(async () => { await app?.close().catch(() => {}); app = undefined; }, TEARDOWN_MS)";
    expect(teardownProblems(old)).toEqual(["clears-after-close"]);
  });

  test("it catches closeApp called before the handle is cleared", () => {
    const wrong = "afterEach(async () => { await closeApp(app); app = undefined; }, APP_TEARDOWN_MS)";
    expect(teardownProblems(wrong)).toEqual(["close-before-clear"]);
  });

  test("it catches a correct order with no bound", () => {
    const unbounded = "afterEach(async () => { const a = app; app = undefined; await closeApp(a); })";
    expect(teardownProblems(unbounded)).toEqual(["no-bound"]);
  });

  /** And it must not fire on the right shape. A guard that cries wolf gets turned off. */
  test("it leaves the right shape alone", () => {
    const right = "afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_TEARDOWN_MS)";
    expect(teardownProblems(right)).toEqual([]);
  });

  test("it ignores an afterEach that closes nothing", () => {
    expect(teardownProblems("afterEach(() => { vi.restoreAllMocks(); })")).toEqual([]);
  });

  test("it ignores a comment quoting the old line", () => {
    const src = "// afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });\nconst x = 1;";
    expect(afterEachCalls(src)).toEqual([]);
  });
});
