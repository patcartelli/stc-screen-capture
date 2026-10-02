import { describe, test, expect, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { ElectronApplication } from "playwright";
import {
  CASCADE_LIMIT, CLOSE_SAMPLE_MS, E2E_DIAG_DIR_ENV, PARALLEL_COMMAND_MS, QUICK_COMMAND_MS,
  electronMains, etimeSeconds, isHang, nextStreak, parseProcesses, readCascade,
} from "./_e2e-diagnostics.js";
import { closeApp, CLOSE_GIVE_UP_MARGIN_MS } from "./_quit-fixture.js";

/**
 * STC-496's hang watch: the decisions, `closeApp` sampling a process that
 * really is stuck, and the cascade cut-off driven through a real vitest run.
 */
const root = join(__dirname, "..", "..");

describe("what counts as a hang", () => {
  test("vitest's test and hook bounds, and closeApp giving up", () => {
    expect(isHang(["Test timed out in 15000ms.\nIf this is a long-running test…"])).toBe(true);
    expect(isHang(["Hook timed out in 10000ms."])).toBe(true);
    expect(isHang(["app.close() did not finish within 72000ms, so pid 1 was killed; no [quit] line was printed"]))
      .toBe(true);
  });

  test("an assertion failure is not one — that app answered", () => {
    expect(isHang(["AssertionError: expected '' to contain 'some-new-fault'"])).toBe(false);
    expect(isHang([])).toBe(false);
  });

  test("the streak grows on a hang, breaks on a pass or a failure, and ignores a skip", () => {
    expect(nextStreak(0, "hang")).toBe(1);
    expect(nextStreak(2, "hang")).toBe(3);
    expect(nextStreak(2, "pass")).toBe(0);
    expect(nextStreak(2, "fail")).toBe(0);
    expect(nextStreak(2, "skip")).toBe(2);
  });
});

describe("reading ps", () => {
  test("etime in every shape ps prints", () => {
    expect(etimeSeconds("05:03")).toBe(303);
    expect(etimeSeconds("1:02:03")).toBe(3723);
    expect(etimeSeconds("2-01:00:00")).toBe(2 * 86400 + 3600);
    expect(etimeSeconds("garbage")).toBeNaN();
  });

  test("Electron main processes only, youngest first — never their helpers", () => {
    const rows = parseProcesses([
      "  101     1 S      12:00 /opt/node/bin/node vitest",
      "  202   101 S      01:10 /w/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /w --user-data-dir=/t/a",
      "  203   202 S      01:09 /w/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU) --type=gpu-process",
      "  303   101 UE     00:12 /w/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /w --user-data-dir=/t/b",
      "",
    ].join("\n"));
    expect(rows).toHaveLength(4);
    expect(electronMains(rows).map((r) => [r.pid, r.ageS, r.stat])).toEqual([[303, 12, "UE"], [202, 70, "S"]]);
  });
});

describe("the bounds fit inside what holds them", () => {
  test("a whole snapshot fits in vitest's 10 s hook bound", () => {
    expect(2 * QUICK_COMMAND_MS + PARALLEL_COMMAND_MS).toBeLessThan(10_000);
  });

  test("closeApp's sample fits in its give-up margin, so the kill still lands before the hook bound", () => {
    expect(CLOSE_SAMPLE_MS).toBeLessThan(CLOSE_GIVE_UP_MARGIN_MS);
  });
});

describe("closeApp samples a stuck app before killing it", () => {
  let child: ChildProcess | undefined;
  const saved = process.env[E2E_DIAG_DIR_ENV];
  afterEach(() => {
    child?.kill("SIGKILL");
    child = undefined;
    if (saved === undefined) delete process.env[E2E_DIAG_DIR_ENV];
    else process.env[E2E_DIAG_DIR_ENV] = saved;
  });

  // A real process, because `sample` needs one; the stub app's close never
  // settles, the case the give-up exists for.
  function stuckApp(pid: number): ElectronApplication {
    const proc = Object.assign(new EventEmitter(), { pid, stderr: new EventEmitter(), kill: () => true });
    return { process: () => proc, close: () => new Promise<void>(() => {}) } as unknown as ElectronApplication;
  }

  test.runIf(process.platform === "darwin")("the stacks land in the diagnostics dir and the error names them", async () => {
    child = spawn("/bin/sleep", ["60"]);
    const dir = mkdtempSync(join(tmpdir(), "stc-diag-test-"));
    process.env[E2E_DIAG_DIR_ENV] = dir;
    const err = await closeApp(stuckApp(child.pid!), CLOSE_GIVE_UP_MARGIN_MS + 200).catch((e: Error) => e);
    expect(String(err)).toMatch(/did not finish within 200ms.*its stacks are in /);
    // `.sample.txt` exactly: on CI the same snapshot also writes a screenshot
    // beside it, which a bare prefix match picked up instead (run 37048218242).
    const file = readdirSync(dir).find((f) =>
      f.startsWith(`close-gave-up-${child!.pid}-`) && f.endsWith(".sample.txt"));
    expect(file, `no sample in ${dir}`).toBeDefined();
    expect(readFileSync(join(dir, file!), "utf8")).toContain("Call graph");
  }, CLOSE_GIVE_UP_MARGIN_MS + 5_000);

  test("with no diagnostics dir it samples nothing, as on the unit project", async () => {
    child = spawn("/bin/sleep", ["60"]);
    process.env[E2E_DIAG_DIR_ENV] = "";
    const err = await closeApp(stuckApp(child.pid!), CLOSE_GIVE_UP_MARGIN_MS + 200).catch((e: Error) => e);
    expect(String(err)).toMatch(/did not finish within 200ms/);
    expect(String(err)).not.toMatch(/its stacks are in/);
  }, CLOSE_GIVE_UP_MARGIN_MS + 5_000);
});

describe("the cascade cut-off, through a real vitest run", () => {
  test(`${CASCADE_LIMIT} hangs in a row skip the rest; an ordinary failure does not count`, () => {
    const dir = mkdtempSync(join(tmpdir(), "stc-diag-cascade-"));
    const { CI: _ci, ...env } = process.env;   // no screenshot from a developer's terminal
    const r = spawnSync(process.execPath, [
      join(dirname(createRequire(__filename).resolve("vitest/package.json")), "vitest.mjs"), "run",
      "--config", join(root, "app", "test", "fixtures", "e2e-cascade", "vitest.config.ts"),
      "--reporter", "json",
    ], { cwd: root, env: { ...env, [E2E_DIAG_DIR_ENV]: dir }, encoding: "utf8", timeout: 60_000 });
    const json = r.stdout.slice(r.stdout.indexOf("{"));
    const report = JSON.parse(json) as { testResults: { assertionResults: { title: string; status: string }[] }[] };
    const status = Object.fromEntries(report.testResults[0]!.assertionResults.map((a) => [a.title, a.status]));
    expect(status).toEqual({
      "an ordinary failure": "failed",
      "hang 1": "failed",
      "hang 2": "failed",
      "hang 3": "failed",
      "would hang 4": "skipped",
      "would pass": "skipped",
    });
    expect(r.stderr).toMatch(/\[e2e-diag\] HANG 1\/3 in .*hang 1: Test timed out in 100ms/);
    expect(r.stderr).toMatch(/3 hangs in a row — skipping every remaining e2e test/);
    expect(readCascade(dir).streak).toBe(CASCADE_LIMIT);
    expect(readdirSync(dir).filter((f) => /^\d\d-/.test(f))).toHaveLength(CASCADE_LIMIT);
    expect(existsSync(join(dir, "01-hangs.fixture.ts-hang-1", "ps.txt"))).toBe(true);
  }, 60_000);
});
