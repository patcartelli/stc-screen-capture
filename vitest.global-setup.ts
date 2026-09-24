import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
 *
 * Then it is LAUNCHED once, because the download was not the whole of it. With
 * the binary already fetched (run 36014986162), the first E2E test still took
 * ~5 s from its start to Electron's first output against <1 s for every launch
 * after it. What that cost is — plausibly macOS checking a freshly extracted
 * app bundle on first exec — is not established; this pays it here by the same
 * route a test would: a hidden window, so the renderer and GPU helper bundles
 * are exec'd too, not only the main binary. A bare script rather than the app,
 * so it starts no helper, no tray and no overlay, with a user-data dir of its
 * own. Timed and printed, since the claim is that the cost moved, not vanished.
 *
 * NOT fatal, unlike everything above: it builds nothing a test runs against,
 * so a failure here leaves no stale artefact behind — only a slower first
 * test, which is what happened before it existed.
 */
function warmElectron(electronPath: string) {
  const dir = mkdtempSync(join(tmpdir(), "stc-electron-warm-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "stc-electron-warm", main: "main.js" }));
  writeFileSync(join(dir, "main.js"), `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL("data:text/html,<p>warm</p>");
  app.quit();
});
`);
  const t0 = Date.now();
  try {
    execFileSync(electronPath, [dir, `--user-data-dir=${join(dir, "ud")}`], {
      stdio: "pipe", timeout: 60_000, killSignal: "SIGKILL",
    });
    process.stderr.write(`[global-setup] Electron warm-up launch took ${Date.now() - t0}ms\n`);
  } catch (e) {
    process.stderr.write(
      `[global-setup] Electron warm-up launch FAILED after ${Date.now() - t0}ms ` +
      `(not fatal; the first E2E launch pays it instead): ${(e as Error).message.slice(0, 500)}\n`);
  }
}

export default function setup() {
  execFileSync(fileURLToPath(new URL("./helper/build.sh", import.meta.url)), { stdio: "pipe" });
  execFileSync("node", [fileURLToPath(new URL("./app/build.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: "pipe",
  });
  warmElectron(createRequire(import.meta.url)("electron") as string);
}
