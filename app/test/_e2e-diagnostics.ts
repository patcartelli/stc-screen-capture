import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the machine looked like when an e2e test HUNG, and when to stop
 * running the rest (STC-496).
 *
 * The fault this exists for: on the macOS runner, partway through the e2e
 * files, one test stops responding and from then on every test in every later
 * file runs into its own bound — never recovering — until the job reaches its
 * 70 minute cap and GitHub cancels it. Seen on 2026-09-28, 09-30 and 10-01 at
 * least, a different test each time. A cancelled vitest prints no failure
 * summary, so those runs told us WHICH tests hung and nothing about what they
 * were waiting on: no error, no stack, no process state. Two things were
 * missing, and this module is both:
 *
 *  1. Evidence. On a hang, `collectDiagnostics` writes the process table, a
 *     `sample` (a few hundred stack traces of every thread) of the youngest
 *     live Electron main processes, and a screenshot, into `E2E_DIAG_DIR_ENV`
 *     — which CI uploads — and prints one line naming them, LIVE, so even a
 *     run that is cancelled anyway carries the first hang's summary in its
 *     log. `closeApp` samples the app it is about to kill the same way.
 *
 *  2. An end. After `CASCADE_LIMIT` consecutive hangs the rest of the e2e
 *     tests are skipped, so the job finishes red in minutes with vitest's
 *     full failure summary, instead of being cancelled at 70 minutes with
 *     none. A run that is already red loses nothing by stopping: no stalled
 *     run on record has ever recovered.
 *
 * The decisions (`isHang`, `nextStreak`, `electronMains`) are pure and tested
 * in `e2e-diagnostics.test.ts`; `collectDiagnostics` and `sampleProcess` only
 * run commands, each under its own bound.
 */

/**
 * Where diagnostics go. Set for the e2e project only (vitest.config.ts), so a
 * unit test that drives `closeApp` against a stub pid never samples a real
 * process that happens to own that pid.
 */
export const E2E_DIAG_DIR_ENV = "STC_E2E_DIAG_DIR";

/** Consecutive hangs before the remaining e2e tests are skipped. */
export const CASCADE_LIMIT = 3;

/**
 * At most this many diagnostic snapshots per run. A cascade that somehow did
 * not trip the limit (hangs separated by passes) must not fill the disk.
 */
export const MAX_SNAPSHOTS = 6;

/** How many live Electron main processes one snapshot samples, youngest first. */
export const SAMPLE_PROCESSES = 3;

/**
 * Bounds on the commands, chosen so a whole snapshot finishes inside vitest's
 * 10 s hook bound: `ps`/`uptime` run first, then every `sample` and the
 * screenshot run AT ONCE, so the worst case is `QUICK + PARALLEL`, not a sum.
 * `sample <pid> 1` takes about 1.2 s on a responsive machine.
 */
export const QUICK_COMMAND_MS = 1_500;
export const PARALLEL_COMMAND_MS = 5_000;

/**
 * `closeApp`'s own snapshot of the app it is about to kill, which must fit in
 * `CLOSE_GIVE_UP_MARGIN_MS`. 3 s was too short: on the first stalled CI run
 * with this in place (37043431975, load average 14 on a 3-CPU VM) not one of
 * three samples finished inside it.
 */
export const CLOSE_SAMPLE_MS = 7_000;

/**
 * Whether a finished test's errors mean it HUNG rather than failed an
 * assertion. Three shapes: vitest's own test bound, its hook bound, and
 * `closeApp` giving up on a close (which throws from an `afterEach`).
 */
export function isHang(messages: readonly string[]): boolean {
  return messages.some((m) =>
    /Test timed out in \d+ms|Hook timed out in \d+ms|app\.close\(\) did not finish within/.test(m));
}

export type Outcome = "pass" | "fail" | "hang" | "skip";

/**
 * The run of consecutive hangs. A pass or an ordinary failure breaks it (an
 * app that answered an assertion, however wrongly, was not wedged); a skip
 * leaves it alone, since a skipped test says nothing about the machine.
 */
export function nextStreak(streak: number, outcome: Outcome): number {
  if (outcome === "hang") return streak + 1;
  if (outcome === "skip") return streak;
  return 0;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  stat: string;
  /** Seconds since the process started. */
  ageS: number;
  command: string;
}

/** `ps -o etime`'s `[[dd-]hh:]mm:ss` in seconds; NaN for anything else. */
export function etimeSeconds(etime: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return NaN;
  const [, d = "0", h = "0", min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

/** The `ps` invocation `parseProcesses` reads. */
export const PS_ARGS = ["-axww", "-o", "pid=,ppid=,stat=,etime=,command="];

export function parseProcesses(ps: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3]!, ageS: etimeSeconds(m[4]!), command: m[5]! });
  }
  return rows;
}

/**
 * Electron MAIN processes, youngest first. A main process runs
 * `Electron.app/Contents/MacOS/Electron`; its helpers (GPU, renderer,
 * network) run `Electron Helper*.app`, which this deliberately excludes — the
 * main process is the one whose event loop decides whether a window opens or
 * a close finishes.
 */
export function electronMains(rows: readonly ProcessRow[]): ProcessRow[] {
  return rows
    .filter((r) => /Electron\.app\/Contents\/MacOS\/Electron(\s|$)/.test(r.command))
    .sort((a, b) => a.ageS - b.ageS);
}

/** Processes worth naming in a summary line: the app, the helper, the fake helper. */
export function interesting(rows: readonly ProcessRow[]): ProcessRow[] {
  return rows.filter((r) => /Electron|stc-helper|_fake-helper/.test(r.command));
}

/** A test name as a directory name. */
export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

interface CommandResult { ok: boolean; stdout: string; error?: string }

/** Run a command under a bound. Never rejects: a diagnostic must not become the failure. */
export function run(cmd: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err
        ? { ok: false, stdout: String(stdout ?? ""), error: err.message.split("\n")[0] }
        : { ok: true, stdout: String(stdout) }));
  });
}

/**
 * `sample` one process into `file`, under `boundMs`. macOS only; not ok
 * anywhere else, or when the process is gone, or when the bound fires — and
 * then `error` says which, since a missing sample is itself evidence.
 */
export async function sampleProcess(pid: number, file: string, boundMs: number): Promise<CommandResult> {
  if (process.platform !== "darwin") return { ok: false, stdout: "", error: "not macOS" };
  return run("/usr/bin/sample", [String(pid), "1", "-mayDie", "-file", file], boundMs);
}

/**
 * What a hung app looks like the moment `closeApp` gives up on it, BEFORE
 * the kill: its `ps` state, a `sample`, and (CI only) the screen, all at
 * once, under `CLOSE_SAMPLE_MS`. The per-test snapshot runs after every
 * hook, by which time `closeApp` has killed the app — on run 37043431975 it
 * found no Electron process at all — so this is the only look at the app
 * itself. Returns a clause for closeApp's error.
 */
export async function snapshotHungApp(pid: number, dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const stem = join(dir, `close-gave-up-${pid}-${Date.now()}`);
  const [stat, sampled] = await Promise.all([
    run("ps", ["-o", "stat=,etime=,pcpu=", "-p", String(pid)], QUICK_COMMAND_MS),
    sampleProcess(pid, `${stem}.sample.txt`, CLOSE_SAMPLE_MS),
    process.platform === "darwin" && process.env.CI
      ? run("screencapture", ["-x", `${stem}.png`], CLOSE_SAMPLE_MS)
      : Promise.resolve(),
  ]);
  return `ps stat/etime/cpu: ${stat.stdout.trim() || "gone"}; `
    + (sampled.ok ? `its stacks are in ${stem}.sample.txt` : `no sample (${sampled.error})`);
}

/**
 * The cascade state lives in a FILE, not a module variable: vitest isolates
 * every test file in its own module graph, and the cascade is precisely the
 * thing that crosses files. The e2e project runs one file at a time
 * (`fileParallelism: false`), so there is never a second writer.
 */
export function readCascade(dir: string): { streak: number; snapshots: number } {
  try {
    const v = JSON.parse(readFileSync(join(dir, "cascade.json"), "utf8"));
    return { streak: Number(v.streak) || 0, snapshots: Number(v.snapshots) || 0 };
  } catch {
    return { streak: 0, snapshots: 0 };
  }
}

export function writeCascade(dir: string, state: { streak: number; snapshots: number }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cascade.json"), JSON.stringify(state));
}

/**
 * Take one snapshot into `<dir>/<n>-<label>/` and return a one-line summary
 * for the live log. Bounded end to end by `QUICK_COMMAND_MS * 2 +
 * PARALLEL_COMMAND_MS`.
 */
export async function collectDiagnostics(dir: string, n: number, label: string): Promise<string> {
  const out = join(dir, `${String(n).padStart(2, "0")}-${slug(label)}`);
  mkdirSync(out, { recursive: true });
  const ps = await run("ps", PS_ARGS, QUICK_COMMAND_MS);
  writeFileSync(join(out, "ps.txt"), ps.ok ? ps.stdout : `ps failed: ${ps.error}\n${ps.stdout}`);
  const load = await run("uptime", [], QUICK_COMMAND_MS);
  const rows = parseProcesses(ps.stdout);
  const mains = electronMains(rows).slice(0, SAMPLE_PROCESSES);
  const [sampled] = await Promise.all([
    Promise.all(mains.map((m) => sampleProcess(m.pid, join(out, `sample-${m.pid}.txt`), PARALLEL_COMMAND_MS))),
    // CI only: a screenshot is for a machine nobody can look at, and on a
    // developer's Mac it can raise a Screen Recording prompt for the terminal.
    process.platform === "darwin" && process.env.CI
      ? run("screencapture", ["-x", join(out, "screen.png")], PARALLEL_COMMAND_MS)
      : Promise.resolve(),
  ]);
  const alive = electronMains(rows).map((m) => `${m.pid}(${m.ageS}s,${m.stat})`).join(" ") || "none";
  const sampledPids = mains.filter((_, i) => sampled[i]!.ok).map((m) => m.pid).join(",") || "none";
  return `electron mains alive: ${alive}; sampled: ${sampledPids}; `
    + `${interesting(rows).length} app/helper processes; load: ${load.stdout.trim() || load.error}; wrote ${out}`;
}
