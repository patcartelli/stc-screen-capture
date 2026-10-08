import { beforeEach } from "vitest";
import {
  CASCADE_LIMIT, E2E_DIAG_DIR_ENV, MAX_SNAPSHOTS, collectDiagnostics, isHang, nextStreak,
  readCascade, writeCascade, type Outcome,
} from "./_e2e-diagnostics.js";

/**
 * Every e2e test's hang watch (STC-496). A `setupFiles` entry of the e2e
 * project only, so it runs before each test in every e2e file and nowhere
 * else. `_e2e-diagnostics.ts` says why it exists.
 *
 * `onTestFinished`, not `afterEach`: measured on vitest 4.1, an `afterEach`
 * that throws stops the `afterEach` hooks after it, and `closeApp` throwing
 * from a file's own `afterEach` is one of the hangs this has to see.
 * `onTestFinished` runs after every hook, sees the hook's error on the
 * result, and is awaited.
 */
/**
 * STC-476: every e2e launch spreads `process.env`, so this reaches them all.
 * CI has no grants, and the permissions panel would otherwise cover the main
 * window in every file that uses the real helper. `permissions.e2e.test.ts`
 * sets it to "" to see the panel.
 */
process.env.STC_ASSUME_PERMISSIONS ??= "granted";

const dir = process.env[E2E_DIAG_DIR_ENV];

beforeEach((ctx) => {
  if (!dir) return;
  const { streak } = readCascade(dir);
  if (streak >= CASCADE_LIMIT) {
    ctx.skip(`STC-496: ${streak} e2e tests in a row hung, so the rest are skipped; see ${dir}`);
  }
  ctx.onTestFinished(async ({ task }) => {
    const errors = (task.result?.errors ?? []).map((e) => String(e?.message ?? e));
    const state = task.result?.state;
    const outcome: Outcome = state === "skip" ? "skip"
      : state === "pass" ? "pass"
      : isHang(errors) ? "hang" : "fail";
    const before = readCascade(dir);
    const next = { streak: nextStreak(before.streak, outcome), snapshots: before.snapshots };
    if (outcome === "hang") {
      const label = `${task.file?.name ?? "?"} > ${task.name}`;
      let line = `[e2e-diag] HANG ${next.streak}/${CASCADE_LIMIT} in ${label}: ${errors[0]?.split("\n")[0]}`;
      if (next.snapshots < MAX_SNAPSHOTS) {
        next.snapshots++;
        line += `; ${await collectDiagnostics(dir, next.snapshots, label)}`;
      }
      process.stderr.write(`${line}\n`);
      if (next.streak === CASCADE_LIMIT) {
        process.stderr.write(`[e2e-diag] ${CASCADE_LIMIT} hangs in a row — skipping every remaining e2e test `
          + `so this run ends with its failure summary instead of at the job's time limit (STC-496)\n`);
      }
    }
    writeCascade(dir, next);
  });
});
