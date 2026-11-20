import { describe, test, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_ENV, isUnderTmp } from "./_launch.js";

/**
 * Every e2e app is isolated from the machine it runs on (STC-403, STC-658).
 *
 * STC-403: `_editor-fixture.ts` launched the app without `--user-data-dir`, so
 * every editor e2e read the developer's real `settings.json` and wrote PNGs to
 * their real Desktop. It passed on CI (a fresh profile has no save folder) and
 * failed only where someone was looking. This file's first version checked
 * that every `electron.launch(` carried the flag.
 *
 * STC-658: that check was right about the flag and blind to everything else.
 * The 2026-11-13 review found 44 launchers leaving the copies folder on its
 * real default (`purgeCopies` deletes from it 60 s after launch), every Delete
 * going to the real Trash, and copies landing on the real clipboard. Each
 * launcher carried its own list of roots, short by a different one each time.
 *
 * So now there is ONE launcher, `_launch.ts`'s `launchIsolated`, and this file
 * holds three rules about it:
 *
 * 1. No file in `app/test/` calls `electron.launch(` except `_launch.ts`.
 * 2. Every `STC_*_DIR` that `app/src/` reads is one of the launcher's roots,
 *    so a new folder the app writes to cannot be added without the launcher
 *    isolating it.
 * 3. A root a test passes must be under the system temp directory
 *    (`isUnderTmp`, which the launcher applies before starting the app).
 * 4. (STC-683) The launcher runs the fake helper unless a test opts into the
 *    real one with `helper: "real"`, and the files that may are listed here.
 *
 * No behavioural test can make these claims: an app pointed at a real folder
 * still starts, and most assertions still pass. So they are checked
 * STRUCTURALLY, the way `library-seam.test.ts` and `spaces-seam.test.ts`
 * check theirs, each with a control proving it can fail.
 */

const repo = join(__dirname, "..", "..");
const TEST_DIR = join(repo, "app", "test");
const SRC_DIR = join(repo, "app", "src");
const LAUNCHER = "_launch.ts";
/** This file's own fixture strings are examples of the pattern, not launches. */
const SELF = "e2e-user-data-isolation.test.ts";

/** Comments blanked before scanning, keeping line numbers — library-seam.test.ts's own move. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** Rule 1: line numbers of every `electron.launch(` in code. */
function directLaunches(src: string): number[] {
  return stripComments(src).split("\n").flatMap((l, i) => (l.includes("electron.launch(") ? [i + 1] : []));
}

/** Rule 2: every `STC_*_DIR` named in code. */
function rootsRead(src: string): string[] {
  return [...new Set(stripComments(src).match(/\bSTC_[A-Z_]+_DIR\b/g) ?? [])];
}

describe("every e2e app goes through the one isolating launcher (STC-658)", () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".ts") && f !== SELF && f !== LAUNCHER);

  for (const f of files) {
    test(`${f} does not call electron.launch( itself`, () => {
      const found = directLaunches(readFileSync(join(TEST_DIR, f), "utf8"));
      expect(found, `app/test/${f} launches the app directly at line(s) ${found.join(", ")}; ` +
        "use launchIsolated from ./_launch.js, which isolates every root").toEqual([]);
    });
  }

  test("the launcher itself is the one call, and adds a user-data dir", () => {
    const src = stripComments(readFileSync(join(TEST_DIR, LAUNCHER), "utf8"));
    expect(directLaunches(src)).toHaveLength(1);
    expect(src).toContain("--user-data-dir=");
    expect(src).toContain("STC_PASTEBOARD");
  });

  test("the pattern catches a direct launch", () => {
    expect(directLaunches(`app = await electron.launch({ args: [root] });`)).toEqual([1]);
  });

  test("the pattern ignores a comment discussing electron.launch(", () => {
    expect(directLaunches(`// electron.launch( is what the launcher wraps\nconst x = 1;`)).toEqual([]);
  });
});

describe("every folder the app writes to is a launcher root (STC-658)", () => {
  test("app/src reads no STC_*_DIR the launcher does not set", () => {
    const read = new Set<string>();
    for (const f of readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"))) {
      for (const r of rootsRead(readFileSync(join(SRC_DIR, f), "utf8"))) read.add(r);
    }
    const missing = [...read].filter((r) => !(ROOT_ENV as readonly string[]).includes(r)).sort();
    expect(missing, "app/src reads these folders from the environment, and _launch.ts's ROOT_ENV " +
      "does not set them, so every e2e app falls back to the real one").toEqual([]);
    // And the scan saw the roots it should: a scan that finds nothing passes the line above.
    expect([...read].sort()).toEqual(expect.arrayContaining(["STC_COPIES_DIR", "STC_RECORDINGS_DIR", "STC_TEMP_TAKES_DIR", "STC_TRASH_DIR"]));
  });

  test("the pattern catches a new root in code, and not one in a comment", () => {
    expect(rootsRead(`return env.STC_EXPORTS_DIR || join(home, "x");`)).toEqual(["STC_EXPORTS_DIR"]);
    expect(rootsRead(`// STC_EXPORTS_DIR is discussed, not read`)).toEqual([]);
  });
});

describe("a root a test passes must be a temp folder (STC-658)", () => {
  test("a fresh temp folder, and one not made yet inside it, are accepted", () => {
    const t = mkdtempSync(join(tmpdir(), "stc-iso-"));
    expect(isUnderTmp(t)).toBe(true);
    expect(isUnderTmp(join(t, "not-yet", "deeper"))).toBe(true);
  });

  test("the real home, the temp directory itself, a relative path and '' are refused", () => {
    expect(isUnderTmp(homedir())).toBe(false);
    expect(isUnderTmp(join(homedir(), "Library", "Application Support", "Capture", "copies"))).toBe(false);
    expect(isUnderTmp(tmpdir())).toBe(false);
    expect(isUnderTmp("recordings")).toBe(false);
    expect(isUnderTmp("")).toBe(false);
  });

  test("a path that only climbs out of the temp directory is refused", () => {
    expect(isUnderTmp(join(tmpdir(), "..", "..", "Users"))).toBe(false);
  });
});

/** Rule 4: how many `helper: "real"` opt-ins are in code. */
function realHelperOptIns(src: string): number {
  return (stripComments(src).match(/\bhelper:\s*"real"/g) ?? []).length;
}

/**
 * The only files that run the real Swift helper (STC-683), each with why. The
 * real binary runs Vision's 45 s `warm-text`, probes permissions, may flash the
 * recording indicator and calls ScreenCaptureKit outside the serial list, and
 * makes CI depend on `helper/build/`. Adding a file here is a decision, not a
 * default; the reason is also in the test's own `why`.
 */
const REAL_HELPER_FILES: Record<string, string> = {
  "frame-png.e2e.test.ts": "the saved PNG is ImageIO's real encode; the fake writes one placeholder byte",
  "shell.e2e.test.ts": "the smoke test that the app spawns the real binary and shows its real grant refusal",
};

describe("an e2e app runs the fake helper unless its test opts into the real one (STC-683)", () => {
  test("the launcher defaults to the stand-in and requires a reason for the real one", () => {
    const src = stripComments(readFileSync(join(TEST_DIR, LAUNCHER), "utf8"));
    expect(src).toContain('helper = "fake"');
    expect(src).toContain("STC_HELPER_BIN = FAKE_HELPER");
    expect(src).toMatch(/helper === "real" && !why/);
  });

  test("exactly the listed files opt into the real helper, each with a why", () => {
    const found = readdirSync(TEST_DIR)
      .filter((f) => f.endsWith(".ts") && f !== SELF && f !== LAUNCHER)
      .filter((f) => realHelperOptIns(readFileSync(join(TEST_DIR, f), "utf8")) > 0)
      .sort();
    expect(found, "a file opts into the real helper that is not in REAL_HELPER_FILES (or a listed one no longer does)")
      .toEqual(Object.keys(REAL_HELPER_FILES).sort());
    for (const f of found) {
      expect(readFileSync(join(TEST_DIR, f), "utf8"), `${f} opts in without a why`).toMatch(/\bwhy:\s*["`]/);
    }
  });

  test("the pattern catches an opt-in in code, and not one in a comment", () => {
    expect(realHelperOptIns(`launchIsolated({ helper: "real", why: "x" })`)).toBe(1);
    expect(realHelperOptIns(`// helper: "real" is discussed`)).toBe(0);
  });
});
