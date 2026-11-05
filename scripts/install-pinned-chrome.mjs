/**
 * Installs Chrome for Testing at PINNED_CHROME and tells later CI steps where
 * it is, through STC_GATE_CHROME (STC-640).
 *
 *   node scripts/install-pinned-chrome.mjs [dir]
 *
 * It refuses unless the binary reports exactly the pinned version: a gate that
 * quietly ran something else is the fault the pin exists to end.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PINNED_CHROME } from "./gate-browser.mjs";

const platform = { arm64: "mac-arm64", x64: "mac-x64" }[process.arch];
if (process.platform !== "darwin" || !platform) {
  console.error(`FAIL: no Chrome for Testing build chosen for ${process.platform}/${process.arch}`);
  process.exit(2);
}

const dir = process.argv[2] ?? mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "chrome-for-testing-"));
const zip = join(dir, "chrome.zip");
const url = `https://storage.googleapis.com/chrome-for-testing-public/${PINNED_CHROME}/${platform}/chrome-${platform}.zip`;

execFileSync("curl", ["-fsSL", "--retry", "3", "--max-time", "150", "-o", zip, url], { stdio: "inherit" });
// ditto, not unzip: the app bundle's frameworks are full of symlinks.
execFileSync("ditto", ["-x", "-k", zip, dir], { stdio: "inherit" });

const app = "Google Chrome for Testing";
const binary = join(dir, `chrome-${platform}`, `${app}.app`, "Contents", "MacOS", app);
const reported = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
if (reported !== `${app} ${PINNED_CHROME}`) {
  console.error(`FAIL: asked for ${PINNED_CHROME}, the binary says "${reported}"`);
  process.exit(1);
}

console.log(`installed: ${reported}`);
console.log(`STC_GATE_CHROME=${binary}`);
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `STC_GATE_CHROME=${binary}\n`);
