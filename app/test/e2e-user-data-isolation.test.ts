import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-403's guard: every E2E fixture that launches the real app must be
 * isolated from the developer's real `~/Library/Application Support/Capture`.
 *
 * `_editor-fixture.ts`'s `launchApp` used to omit `--user-data-dir`, so the
 * app under test loaded the DEVELOPER's real `settings.json` — on a machine
 * with a save folder set, every editor E2E wrote real PNGs to the real
 * Desktop and then failed asserting on a file that had landed somewhere else
 * entirely. It passed precisely where nobody was looking (a fresh CI profile
 * has no `saveFolder`, STC-412's field — `still.destination` at the time this
 * was written) and failed only on a real developer machine.
 *
 * Building this guard found the SAME defect in four more files nothing had
 * flagged yet (`manage.e2e.test.ts`, `missing-helper.e2e.test.ts`,
 * `take-library.e2e.test.ts`, `shell.e2e.test.ts`, `export-identity.slow.
 * test.ts`) — the ticket's diagnosis was scoped to the one file whose litter
 * was actually noticed, but the defect is "an app-launching fixture forgot
 * the flag", which is a property of the CALL SITE, not of any one file. All
 * five are fixed alongside this guard.
 *
 * No behavioural test can make this claim: a fixture that forgets the flag
 * still starts the app, the app still comes up, and most assertions still
 * pass — right up until the one that reads a directory the real settings
 * silently redirected. So it is checked STRUCTURALLY, in the idiom this repo
 * already uses for rules about shape rather than output: `library-seam.
 * test.ts` on the library's adapter, `spaces-seam.test.ts` on the event
 * space, `gate-bounds.test.ts` refusing a bare `browser.close()`.
 */

const repo = join(__dirname, "..", "..");
const TEST_DIR = join(repo, "app", "test");

/**
 * How far past `electron.launch(` the flag is allowed to live.
 *
 * Every real call site in this repo puts it in the same `args` array as
 * `electron.launch(` itself, one line below at most (measured directly, not
 * assumed: every existing correct call site clears this by a wide margin).
 * A generous window rather than a tight one, because the guard's job is to
 * catch an OMITTED flag, not to police formatting.
 */
const WINDOW_LINES = 8;

/** Comments blanked before scanning, keeping line numbers — library-seam.test.ts's own move. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** Line-by-line so a failure names the line, not just the file. */
function unisolatedLaunches(src: string): string[] {
  const lines = stripComments(src).split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes("electron.launch(")) continue;
    const window = lines.slice(i, i + WINDOW_LINES).join("\n");
    if (!window.includes("--user-data-dir")) {
      out.push(`${i + 1}: electron.launch() with no --user-data-dir within ${WINDOW_LINES} lines`);
    }
  }
  return out;
}

/**
 * This guard's own fixture strings below are examples of the pattern, not
 * real launches, and are not comments — `stripComments` cannot tell them
 * apart from code. Excluded by name rather than relying on that.
 */
const SELF = "e2e-user-data-isolation.test.ts";

describe("every E2E fixture that launches the app is isolated from real user data (STC-403)", () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".ts") && f !== SELF);

  for (const f of files) {
    test(`${f} does not launch electron without --user-data-dir`, () => {
      const src = readFileSync(join(TEST_DIR, f), "utf8");
      const found = unisolatedLaunches(src);
      expect(found, `app/test/${f} launches the app without isolating it from the ` +
        `developer's real settings:\n${found.join("\n")}`).toEqual([]);
    });
  }

  /**
   * The guard must be able to FAIL, which is a separate claim from it
   * passing — this repo has paid for the difference more than once (a bound
   * nobody watched fire, a floor with enough slack to hide a missing term).
   */
  test("the pattern catches a launch call with no --user-data-dir at all", () => {
    const missing = `
      app = await electron.launch({
        args: [root], cwd: root,
        env: { ...process.env, STC_RECORDINGS_DIR: dir },
      });
    `;
    expect(unisolatedLaunches(missing)).not.toEqual([]);
  });

  test("the pattern catches a launch call whose flag is too far away to be the same site", () => {
    const farAway = [
      "app = await electron.launch({",
      "  args: [root], cwd: root,",
      ...Array.from({ length: WINDOW_LINES }, () => "  // padding so the flag below is out of the window"),
      "  // --user-data-dir lives somewhere else entirely and is not this call's",
      "});",
    ].join("\n");
    expect(unisolatedLaunches(farAway)).not.toEqual([]);
  });

  /** And it must not fire on a properly isolated call. A guard that cries wolf gets turned off. */
  test("the pattern leaves an isolated launch call alone", () => {
    const isolated = `
      app = await electron.launch({
        args: [root, \`--user-data-dir=\${mkdtempSync(join(tmpdir(), "stc-ud-"))}\`], cwd: root,
        env: { ...process.env, STC_RECORDINGS_DIR: dir },
      });
    `;
    expect(unisolatedLaunches(isolated)).toEqual([]);
  });

  /** A file may discuss the rule it keeps — this file's own header does. */
  test("the pattern ignores a comment discussing electron.launch(", () => {
    const discussing = `
      // electron.launch( with no --user-data-dir is the bug this guard exists to catch
      const x = 1;
    `;
    expect(unisolatedLaunches(discussing)).toEqual([]);
  });
});
