#!/usr/bin/env node
/**
 * Build the release .dmg (STC-508a), sign it with Developer ID, notarize and
 * staple it (STC-508b), and say what to do with it.
 *
 * Builds, never publishes. Tagging and creating a GitHub release are
 * outward-facing (STC-508), so this ends by PRINTING the `gh release create`
 * command for a person to run once they have decided to.
 *
 * Refuses a dirty tree: a .dmg named for a version must be reproducible from
 * the commit it names. `--allow-dirty` is for trying the script.
 *
 * Signing: the app (and the helper inside it) with the Developer ID
 * Application identity, never the self-signed STC Dev Signing; the dmg itself
 * too. Notarization goes through the notarytool keychain profile
 * (NOTARY_PROFILE, default "capture"; STC-515), so there is no password on a
 * command line or in the environment. The checksum is taken AFTER stapling,
 * because stapling rewrites the file.
 *
 * `--skip-notarize` builds a Developer-ID-signed dmg without sending it to
 * Apple, for trying the script. It is not a release and says so.
 *
 * Usage: npm run release:dmg [-- --allow-dirty] [-- --skip-notarize]
 * Env:   RELEASE_SIGN_ID (name or SHA-1, only if several identities), NOTARY_PROFILE
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  builderIdentityName,
  notaryFailureMessage,
  parseDeveloperIds,
  parseNotarySubmission,
  pickReleaseIdentity,
} from "./release-sign.mjs";

const allowDirty = process.argv.includes("--allow-dirty");
const skipNotarize = process.argv.includes("--skip-notarize");
const profile = process.env.NOTARY_PROFILE || "capture";
const run = (cmd, args, env) => execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const dirty = out("git", ["status", "--porcelain", "--untracked-files=no"]);
if (dirty && !allowDirty) {
  console.error("Working tree has uncommitted changes. Commit them, or pass --allow-dirty to try the script.");
  process.exit(1);
}

// Resolve the identity and prove the notary credentials BEFORE the long build,
// so a missing cert or a dead profile fails in seconds rather than minutes in.
let identity;
try {
  identity = pickReleaseIdentity(
    parseDeveloperIds(out("security", ["find-identity", "-v", "-p", "codesigning"])),
    process.env.RELEASE_SIGN_ID,
  );
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
console.log(`Signing with ${identity.name}`);
if (!skipNotarize) {
  try {
    execFileSync("xcrun", ["notarytool", "history", "--keychain-profile", profile], { stdio: "ignore" });
  } catch {
    console.error(
      `notarytool cannot authenticate with keychain profile "${profile}". ` +
        `Store it with: xcrun notarytool store-credentials "${profile}" --apple-id <id> --team-id <team>`,
    );
    process.exit(1);
  }
}

// Same steps as `app:package`, with the dmg target in place of `dir` and the
// release identity in place of the dev one (helper/build.sh takes SIGN_ID;
// electron-builder takes the identity on its command line).
run("npm", ["run", "app:build"]);
run("bash", ["scripts/build-app-icon.sh"]);
run("bash", ["helper/build.sh"], { SIGN_ID: identity.name });
run("npx", [
  "electron-builder", "--mac", "dmg", "--publish", "never",
  `-c.mac.identity=${builderIdentityName(identity.name)}`,
]);

const dmgs = existsSync("release")
  ? readdirSync("release").filter((f) => f.endsWith(".dmg") && f.includes(version))
  : [];
if (dmgs.length !== 1) {
  console.error(`Expected exactly one .dmg for ${version} in release/, found ${dmgs.length}: ${dmgs.join(", ") || "none"}`);
  process.exit(1);
}
const dmg = join("release", dmgs[0]);
if (statSync(dmg).size === 0) {
  console.error(`${dmg} is empty`);
  process.exit(1);
}

// The dmg is a container Apple checks separately from the app inside it.
run("codesign", ["--force", "--timestamp", "--sign", identity.hash, dmg]);

if (!skipNotarize) {
  const submitted = execFileSync(
    "xcrun",
    ["notarytool", "submit", dmg, "--keychain-profile", profile, "--wait", "--output-format", "json"],
    { encoding: "utf8" },
  );
  const sub = parseNotarySubmission(submitted);
  if (!sub.accepted) {
    console.error(notaryFailureMessage(sub, profile));
    process.exit(1);
  }
  run("xcrun", ["stapler", "staple", dmg]);
  run("xcrun", ["stapler", "validate", dmg]);
  // What a downloaded copy will meet: Gatekeeper's verdict on the dmg itself.
  run("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-v", dmg]);
}

const sha = createHash("sha256").update(readFileSync(dmg)).digest("hex");
writeFileSync(`${dmg}.sha256`, `${sha}  ${dmgs[0]}\n`);

console.log(`\n${dmg}\nsha256 ${sha}${dirty ? "\n(built from a DIRTY tree)" : ""}`);
if (skipNotarize) {
  console.log("\nNOT NOTARIZED (--skip-notarize). Gatekeeper will refuse this on a clean Mac. Do not release it.");
  process.exit(0);
}
console.log(`\nNot published. When STC-508's blockers are clear and Patrick says yes:`);
console.log(`  git tag v${version} && git push origin v${version}`);
console.log(`  gh release create v${version} "${dmg}" "${dmg}.sha256" --title "v${version}" --notes-file <notes>`);
