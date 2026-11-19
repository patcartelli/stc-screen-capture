#!/usr/bin/env node
/**
 * One command cuts a Capture build (STC-651): checks, version bump, signed and
 * notarized dmg, tag, upload to the private beta folder.
 *
 *   npm run release -- 1.1.0-beta.2             # the whole thing
 *   npm run release -- 1.1.0-beta.2 --dry-run   # the checks only, changes nothing
 *   npm run release -- --upload 1.1.0-beta.2    # re-run just the publish for a tagged build
 *
 * Order matters, and each step is chosen so a failure leaves nothing to undo:
 *   1. Preflight on master: clean tree, HEAD == origin/master, CI green on that
 *      commit, tag not taken, version not lower. Nothing has changed yet.
 *   2. Bump. master is protected, so the bump goes through a PR and
 *      `npm run merge` (which itself refuses a red CI); then master is pulled
 *      and step 1's CI check runs again on the merge commit.
 *   3. `release:dmg` builds, signs, notarizes, staples, checksums.
 *   4. Tag and push the tag, only now: a tag on a build that never finished
 *      is the one thing that cannot be taken back.
 *   5. Publish a GitHub release (a pre-release when the version has a
 *      prerelease part) with the dmg and its .sha256, then check the release
 *      lists both at the right size. That is where testers download from
 *      (docs/TESTER-README.md; STC-648 superseded the ticket's Drive folder).
 *
 * Env: release-dmg.mjs's RELEASE_SIGN_ID and NOTARY_PROFILE
 * Setup and recovery: docs/STC-651-RUNBOOK.md
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { artifactNames, ciVerdict, compareVersions, parseVersion, preflightProblems, uploadProblems } from "./release-plan.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const uploadOnly = args.includes("--upload");
const positional = args.filter((a) => !a.startsWith("--"));

const out = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8" }).trim();
const run = (cmd, a) => execFileSync(cmd, a, { stdio: "inherit" });
const die = (msg) => {
  console.error(`\n${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pkgVersion = () => JSON.parse(readFileSync("package.json", "utf8")).version;

let parsed;
try {
  parsed = parseVersion(positional[0]);
} catch (e) {
  die(`${e.message}\nUsage: npm run release -- <version> [--dry-run] | --upload <version>`);
}
const { version, tag } = parsed;
const { dmg, sha } = artifactNames(version);

function upload() {
  const files = [dmg, sha].map((name) => ({ name, path: join("release", name), size: statSync(join("release", name)).size }));
  const exists = (() => {
    try {
      out("gh", ["release", "view", tag]);
      return true;
    } catch {
      return false;
    }
  })();
  if (!exists) {
    run("gh", ["release", "create", tag, ...files.map((f) => f.path), "--title", `Capture ${version}`, "--generate-notes", ...(version.includes("-") ? ["--prerelease"] : [])]);
  } else {
    run("gh", ["release", "upload", tag, ...files.map((f) => f.path), "--clobber"]);
  }
  const view = JSON.parse(out("gh", ["release", "view", tag, "--json", "assets,url"]));
  const problems = uploadProblems(view.assets, files);
  if (problems.length) die(`Publish did not land cleanly:\n  ${problems.join("\n  ")}`);
  console.log(`\nPublished ${dmg} and its checksum.\nRelease: ${view.url}`);
}

if (uploadOnly) {
  if (!out("git", ["tag", "--list", tag])) die(`${tag} is not tagged here. --upload is for a build that was cut and tagged but not published.`);
  upload();
  process.exit(0);
}

const ciName = () => {
  const m = readFileSync(".github/workflows/ci.yml", "utf8").match(/^name:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m);
  if (!m) die("could not read the workflow name from .github/workflows/ci.yml; the run to trust is chosen by it");
  return m[1];
};

/** Waits for CI on the current HEAD; anything but green ends the release. */
async function requireGreenCi(waitMs) {
  const sha1 = out("git", ["rev-parse", "HEAD"]);
  const name = ciName();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const runs = JSON.parse(out("gh", ["run", "list", "--commit", sha1, "--workflow", "ci.yml", "--limit", "20", "--json", "databaseId,headSha,workflowName,status,conclusion"]));
    const v = ciVerdict(runs, sha1, name);
    if (v.state === "green") return console.log(`CI green on ${sha1.slice(0, 8)} (run ${v.run.databaseId})`);
    if (v.state === "red") die(`CI ${v.run.conclusion} on ${sha1.slice(0, 8)} (gh run view ${v.run.databaseId} --log-failed). Not releasing.`);
    if (Date.now() > deadline) die(`CI on ${sha1.slice(0, 8)} is ${v.state} and the wait is up. Re-run when it finishes.`);
    await sleep(30_000);
  }
}

function preflight() {
  run("git", ["fetch", "origin", "master", "--tags", "--quiet"]);
  let originSha = "";
  try {
    originSha = out("git", ["rev-parse", "origin/master"]);
  } catch {}
  const remoteTags = out("git", ["ls-remote", "--tags", "origin", tag]);
  const problems = preflightProblems({
    branch: out("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: Boolean(out("git", ["status", "--porcelain"])),
    headSha: out("git", ["rev-parse", "HEAD"]),
    originSha,
    tags: [...out("git", ["tag", "--list"]).split("\n"), ...(remoteTags ? [tag] : [])],
    tag,
    currentVersion: pkgVersion(),
    version,
  });
  if (problems.length) die(`Not releasing ${tag}:\n  - ${problems.join("\n  - ")}`);
}

preflight();
await requireGreenCi(0);
if (dryRun) {
  console.log(`\nDry run: every check passed. A real run would bump ${pkgVersion()} -> ${version}, build, tag ${tag} and upload ${dmg}.`);
  process.exit(0);
}

if (compareVersions(version, pkgVersion()) !== 0) {
  const branch = `release/${tag}`;
  run("git", ["switch", "-c", branch]);
  run("npm", ["version", version, "--no-git-tag-version"]);
  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `Release ${tag}: bump version`]);
  run("git", ["push", "-u", "origin", "HEAD"]);
  const url = out("gh", ["pr", "create", "--base", "master", "--title", `Release ${tag}: bump version`, "--body", `Version bump for ${tag}, from \`npm run release\` (STC-651).`]);
  console.log(`Opened ${url}`);
  run("npm", ["run", "merge", "--", url.split("/").pop()]);
  run("git", ["switch", "master"]);
  run("git", ["pull", "--ff-only", "origin", "master"]);
  run("git", ["branch", "-D", branch]);
  preflight();
  await requireGreenCi(45 * 60_000); // the merge commit's own CI run
}

const build = spawnSync("npm", ["run", "release:dmg"], { stdio: "inherit" });
if (build.status !== 0) die("release:dmg failed; nothing was tagged or uploaded.");

run("git", ["tag", "-a", tag, "-m", `Capture ${version}`]);
run("git", ["push", "origin", tag]);
console.log(`Tagged and pushed ${tag}.`);

upload();
