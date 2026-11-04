/**
 * Which Chrome CI runs, in ONE place (STC-640).
 *
 * `npx playwright install chrome` installs whatever stable Google serves that
 * hour, and on 2026-11-03 that turned master red with no commit (STC-639). So
 * the required job runs Chrome for Testing at this exact version, and
 * .github/workflows/chrome-canary.yml runs the same gates on current stable.
 *
 * To bump: change PINNED_CHROME to a version listed in
 * https://googlechromelabs.github.io/chrome-for-testing/known-good-versions.json
 * Bump on purpose. A red canary is the usual reason, or an Electron upgrade.
 *
 * STC_GATE_CHROME is the binary scripts/install-pinned-chrome.mjs installed.
 * Unset, which is every local run, this is the machine's own Chrome.
 */
export const PINNED_CHROME = "157.0.8103.38";

export function gateBrowser(env = process.env) {
  const executablePath = env.STC_GATE_CHROME;
  return executablePath
    ? { label: "chrome-for-testing", launch: { executablePath } }
    : { label: "chrome", launch: { channel: "chrome" } };
}
