import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCREENCAPTUREKIT_FILES } from "./vitest.screencapturekit-files.js";

/**
 * Two projects, because the E2E files need a different concurrency rule than
 * everything else.
 *
 * Measured on master (2026-08-28): a run put SIX Electron apps on the machine
 * at once — five E2E files launching in parallel, each driving a full browser
 * plus the helper. That is enough to starve the box, and the tell is that a
 * loaded run also takes down transform/test/schema.test.ts (pure JSON-schema
 * validation, no Electron, no subprocess) and `spawnSync xcrun ETIMEDOUT`. The
 * E2E tests are not broken; they are simply the most timing-sensitive things
 * running, so they fail first and look like the culprits.
 *
 * vitest.grant.config.ts already reached the same conclusion for the same
 * reason — see its comment about concurrent `open -W` on one app bundle.
 *
 * `fileParallelism` is a per-project option here, NOT the root default: the
 * unit and helper suites are fast and independent, and serialising them would
 * cost minutes for nothing.
 */
const EXCLUDE = ["**/node_modules/**", "**/*.grant.test.ts", "**/*.slow.test.ts"];

/**
 * Where an e2e hang's diagnostics go (STC-496, app/test/_e2e-diagnostics.ts).
 * CI names it with STC_E2E_DIAG_OUT so it can upload the folder; anywhere else
 * it is a fresh temp dir per run. It also holds the run's hang-streak counter,
 * so a folder handed in by STC_E2E_DIAG_OUT must start empty — a fresh CI
 * workspace always does.
 *
 * It reaches the workers as STC_E2E_DIAG_DIR through each project's `env`,
 * set for the e2e project and explicitly EMPTY for the unit project: the unit
 * tests drive `closeApp` against stub apps with made-up pids, and a set dir
 * would have it `sample` whatever real process owns that pid.
 */
const E2E_DIAG_DIR = process.env.STC_E2E_DIAG_OUT || mkdtempSync(join(tmpdir(), "stc-e2e-diag-"));

/**
 * The same "@transform" alias harness/vite.config.ts serves the browser and
 * tsconfig.json's `paths` serves tsc. A test that imports a harness file —
 * transform/test/decoder-preference-mark.test.ts does, to exercise the gate
 * wiring for real rather than by grepping it — resolves the import through
 * this. The copies cannot be one: the others are a vite config, a JSON file
 * and (app/build.mjs) an esbuild call, in three config languages.
 *
 * It sits on each PROJECT, not on the root: with `projects`, every project is
 * its own vite config and inherits no `resolve` from the parent.
 */
const resolve = {
  alias: { "@transform": fileURLToPath(new URL("./transform/src", import.meta.url)) },
};

export default defineConfig({
  test: {
    // Needs a Screen Recording grant, which a plain test runner does not have.
    // Green must mean green: a suite that is permanently red trains people to
    // ignore it, and then it protects nothing. Run it with `npm run test:capture`.
    exclude: EXCLUDE,
    globalSetup: ["./vitest.global-setup.ts"],
    projects: [
      {
        resolve,
        test: {
          name: "unit",
          include: ["transform/test/**/*.test.ts", "helper/test/**/*.test.ts", "app/test/**/*.test.ts"],
          exclude: [...EXCLUDE, "**/*.e2e.test.ts", ...SCREENCAPTUREKIT_FILES],
          testTimeout: 15_000,
          env: { STC_E2E_DIAG_DIR: "" },
        },
      },
      {
        // The real helper's ScreenCaptureKit calls, never two at once
        // (STC-470, vitest.screencapturekit-files.ts says why). With
        // `fileParallelism: false` and no `sequence.groupOrder`, vitest puts
        // these files in the SAME sequential group as the e2e project below,
        // run after the parallel group — so they overlap neither each other,
        // the unit files, nor shell.e2e's real-helper take.
        resolve,
        test: {
          name: "screencapturekit",
          include: SCREENCAPTUREKIT_FILES,
          exclude: EXCLUDE,
          fileParallelism: false,
          testTimeout: 15_000,
        },
      },
      {
        // One Electron app on the machine at a time.
        resolve,
        test: {
          name: "e2e",
          include: ["app/test/**/*.e2e.test.ts"],
          exclude: EXCLUDE,
          fileParallelism: false,
          testTimeout: 15_000,
          // A hang's diagnostics, and skipping the rest once hangs cascade
          // (STC-496).
          setupFiles: ["./app/test/_e2e-setup.ts"],
          env: { STC_E2E_DIAG_DIR: E2E_DIAG_DIR },
        },
      },
    ],
  },
});
