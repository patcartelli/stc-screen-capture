import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PRIMARY_DISPLAY_ENV } from "./app/test/_fake-displays.mjs";

/**
 * Build the helper AND the app bundle ONCE for the whole run. Previously each
 * suite rebuilt the helper in its own beforeAll; run concurrently they raced on
 * build/stc-helper — one signing it while the other overwrote it — and
 * whichever lost had its entire file reported as failed-to-collect, silently
 * skipping every test in it.
 *
 * The app bundle had the SAME bug one directory over, and it outlived the
 * helper's fix because it fails as a timeout in a UI assertion rather than as a
 * build error, so it read as flakiness. Six test files each ran app/build.mjs
 * per launch: measured at 17 builds in one `vitest run app/test`, 5 of them in
 * flight at once, all writing app/dist/{main.mjs,preload.cjs,renderer.js}.
 * esbuild truncates an output file before rewriting it, so a sampler watching
 * those paths caught all three at ZERO bytes mid-run — renderer.js 282 times,
 * it being the largest. An Electron launch landing in that window loads an
 * empty renderer: the page renders, no script runs, #takes stays empty, and
 * take-library.e2e.test.ts's 20 s poll fails. Load only widens the window,
 * which is why it looked like contention between two sessions on one machine.
 *
 * app/test/build-once.test.ts keeps the per-test builds from coming back.
 *
 * A non-zero exit must throw: swiftc leaves the previous binary in place on
 * failure, so an unchecked build silently tests stale code.
 *
 * The Electron BINARY is fetched here too. Electron 43 has no postinstall: its
 * `index.js` downloads the binary on the first `require("electron")`, which is
 * Playwright's `_electron.launch()` — so `npm ci` finished in 2 s on CI and the
 * download landed inside whichever E2E test launched first. That was
 * panel-waits.e2e's "left alone, the panel is still there…", the slowest test
 * in the suite at 17.6-20.0 s on runs 35934526803 and 36007134242, of which
 * ~9 s was the download, charged against the 30 s launch default
 * `PLAYWRIGHT_LAUNCH_OVERHEAD_MS` budgets for. Requiring it here pays the same
 * cost once, outside every test's clock; it is a no-op once `dist/` is there,
 * and it throws on a failed download, which is what should stop the run.
 */
export default function setup() {
  execFileSync(fileURLToPath(new URL("./helper/build.sh", import.meta.url)), { stdio: "pipe" });
  execFileSync("node", [fileURLToPath(new URL("./app/build.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: "pipe",
  });
  const electron: string = createRequire(import.meta.url)("electron");
  // STC-464: the helper stand-in must list the display the overlay really
  // picks, or STC-433's pre-countdown check opens a dialog no test answers
  // (app/test/_fake-displays.mjs). Measured once here and inherited through
  // the environment by every worker, every app launch and every stand-in. A
  // failure must throw: the fallback id is the one that hid this on CI.
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  const id = execFileSync(electron, [fileURLToPath(new URL("./scripts/primary-display-id.cjs", import.meta.url))], {
    env, encoding: "utf8", timeout: 30_000,
  }).trim();
  if (!/^\d+$/.test(id)) throw new Error(`primary-display-id.cjs printed ${JSON.stringify(id)}, not a display id`);
  process.env[PRIMARY_DISPLAY_ENV] = id;
}
