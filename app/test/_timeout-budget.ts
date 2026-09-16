/**
 * Every E2E test's own timeout must EXCEED the bounds waiting inside it.
 *
 * The defect this exists to stop, seen for real: a test declared `}, 30_000)`
 * and its body was three sequential `expect.poll(..., { timeout: 10_000 })`
 * calls. Thirty seconds of inner waiting against a thirty-second outer bound,
 * so whenever any poll ran long the OUTER bound fired first and the whole
 * failure read:
 *
 *     Error: Test timed out in 30000ms.
 *      ❯ app/test/zoom-override-manual.e2e.test.ts:180:3
 *
 * — a line number and nothing else. The poll that actually gave up never got
 * to say what it was waiting for, so the failure is indistinguishable from a
 * hang, from a slow runner, and from a real product bug. It reddened master
 * (run 35121605329) and an unrelated PR on separate commits.
 *
 * CLAUDE.md already records this exact shape from the writer-gate work — "an
 * inner bound was set exactly equal to the outer one, so the informative
 * message always lost the race" — and the repo's answer there was to assert
 * the clearance rather than keep the two numbers in step by hand. This is that
 * assertion, for the E2E suite.
 *
 * THE RULE IS DELIBERATELY THE WEAK ONE: the outer bound must be strictly
 * greater than the sum of the inner ones. It says nothing about how much
 * headroom a test needs for its own launches, clicks and drags, because that
 * is a judgement per test and a guard that makes judgements is a guard someone
 * turns off (this file's own lesson, from `library-seam.test.ts`). What it
 * does catch is the case where an inner bound CANNOT fire at all, which is not
 * a judgement — it is arithmetic.
 *
 * The sum is a worst case and most runs never approach it. That is the point:
 * the rule is about which bound speaks when a test does run long, not about
 * how often it does.
 */

/** Vitest's own default for the `e2e` project, applied when a test declares none. */
export const E2E_DEFAULT_TEST_MS = 15_000;

export interface TestBudget {
  file: string;
  name: string;
  /** The `}, N)` the test declares, or the project default when it declares none. */
  outerMs: number;
  /** Whether that outer bound was written down or inherited. */
  declared: boolean;
  /** Every `{ timeout: N }` waiting inside the test body. */
  innerMs: number[];
}

/** `outerMs` must beat everything that can wait inside it. */
export function innerSum(b: TestBudget): number {
  return b.innerMs.reduce((a, n) => a + n, 0);
}

export function hasClearance(b: TestBudget): boolean {
  return b.outerMs > innerSum(b);
}

/** One line a person can act on, naming both numbers rather than only the verdict. */
export function describeViolation(b: TestBudget): string {
  const sum = innerSum(b);
  const how = b.declared ? `declares ${b.outerMs}ms` : `inherits the ${b.outerMs}ms default`;
  return `${b.file} › ${b.name}\n    ${how} but waits up to ${sum}ms inside `
    + `(${b.innerMs.length} bound${b.innerMs.length === 1 ? "" : "s"}: ${b.innerMs.join(" + ")})`;
}

const NUM = (s: string) => Number(s.replace(/_/g, ""));

/**
 * Read one E2E file's tests and what each of them waits on.
 *
 * Deliberately a text scan rather than a parser: it only has to be right about
 * this repo's own uniform shape (checked — all 192 outer bounds in the suite
 * are written `  }, N);` at one indent), and a dependency-free reader is one
 * nobody has to maintain. A shape it cannot read is reported rather than
 * skipped, so the guard can never pass by failing to look.
 */
export function readBudgets(file: string, src: string): TestBudget[] {
  const out: TestBudget[] = [];
  // Both name forms this suite uses: a double-quoted string, and a template
  // literal (`nothing-lost.e2e.test.ts` builds its names from a constant).
  // A reader that knew only the first silently found NOTHING in that file —
  // caught by this guard's own self-check rather than by reading the code.
  const opener = /\n {2}(?:test|it)\(\s*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;
  for (let m = opener.exec(src); m; m = opener.exec(src)) {
    const from = m.index + m[0].length;
    const close = /\n {2}\}(?:, ([0-9_]+))?\);/.exec(src.slice(from));
    if (!close) continue;
    const body = src.slice(from, from + close.index);
    // One of the two name alternatives always matched, or `opener` would not
    // have; `?? ""` is for the typechecker rather than a case that can happen.
    const name = (m[1] ?? m[2] ?? "").replace(/\\"/g, '"');
    const declaredMs = close[1];
    out.push({
      file,
      name,
      outerMs: declaredMs === undefined ? E2E_DEFAULT_TEST_MS : NUM(declaredMs),
      declared: declaredMs !== undefined,
      innerMs: [...body.matchAll(/timeout:\s*([0-9_]+)/g)].map((t) => NUM(t[1] ?? "0")),
    });
  }
  return out;
}
