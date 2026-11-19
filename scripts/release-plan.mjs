/**
 * The release command's decisions (STC-651), kept apart from `release.mjs` so
 * each can be tested without git, GitHub, Apple or Drive. This module runs
 * nothing.
 *
 * Every function here REFUSES rather than guesses, in the same way
 * `release-sign.mjs` does: a release that went out on a wrong branch, over a
 * red CI run or on a version that already exists cannot be taken back (testers
 * have the file), so an answer we cannot read is never a pass.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** `v1.2.3` or `1.2.3-beta.2` to `{ version, tag }`. Build metadata is refused: it has no precedence. */
export function parseVersion(input) {
  const version = String(input ?? "").replace(/^v/, "");
  if (!SEMVER.test(version)) {
    throw new Error(`"${input}" is not a version. Use MAJOR.MINOR.PATCH, optionally with a prerelease: 1.1.0-beta.2`);
  }
  return { version, tag: `v${version}` };
}

/** semver precedence: negative when a < b. A prerelease sorts below its release. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`cannot compare "${a}" and "${b}"`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (!pa[4] && !pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  const xa = pa[4].split(".");
  const xb = pb[4].split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb) {
      const d = Number(xa[i]) - Number(xb[i]);
      if (d) return Math.sign(d);
    } else if (na !== nb) {
      return na ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    } else if (xa[i] !== xb[i]) {
      return xa[i] < xb[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Every reason the release must not start, as sentences. Empty means go.
 * `tags` is every tag known locally or on origin.
 */
export function preflightProblems({ branch, dirty, headSha, originSha, tags, tag, currentVersion, version }) {
  const problems = [];
  if (branch !== "master") problems.push(`On "${branch}", not master. A release is cut from master.`);
  if (dirty) problems.push("The working tree has uncommitted changes. A build named for a version must be reproducible from the commit it names.");
  if (!originSha) {
    problems.push("Could not read origin/master, so there is no telling whether this checkout is current.");
  } else if (headSha !== originSha) {
    problems.push(`HEAD (${headSha.slice(0, 8)}) is not origin/master (${originSha.slice(0, 8)}). Pull, or push, first.`);
  }
  if (tags.includes(tag)) problems.push(`${tag} already exists. A tag is never moved; pick the next version.`);
  if (compareVersions(version, currentVersion) < 0) {
    problems.push(`${version} is lower than the current ${currentVersion}.`);
  }
  return problems;
}

/**
 * Whether CI passed on `sha`, from `gh run list --json headSha,workflowName,status,conclusion`.
 * Only the required workflow decides (`workflowName`): another workflow's green
 * run on the same commit is not CI, which is the mistake merge-when-green's
 * header records. Returns "green", "red", "pending" or "missing".
 */
export function ciVerdict(runs, sha, workflowName) {
  const run = runs.find((r) => r.headSha === sha && r.workflowName === workflowName);
  if (!run) return { state: "missing" };
  if (run.status !== "completed") return { state: "pending", run };
  return { state: run.conclusion === "success" ? "green" : "red", run };
}

/**
 * Did the publish leave every file on the release at the size we sent?
 * `assets` is `gh release view --json assets`. Size, not name alone: an
 * interrupted upload leaves the name behind.
 */
export function uploadProblems(assets, expected) {
  const problems = [];
  for (const { name, size } of expected) {
    const hit = assets.find((f) => f.name === name);
    if (!hit) problems.push(`${name} is not on the release.`);
    else if (hit.size !== size) problems.push(`${name} is ${hit.size} bytes on the release, ${size} here.`);
  }
  return problems;
}

/** The files a release produces for a version, in `release/`. */
export function artifactNames(version) {
  const dmg = `Capture-${version}-arm64.dmg`;
  return { dmg, sha: `${dmg}.sha256` };
}
