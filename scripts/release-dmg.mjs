#!/usr/bin/env node
/**
 * Build the release .dmg (STC-508a) and say what to do with it.
 *
 * Builds, never publishes. Tagging and creating a GitHub release are
 * outward-facing (STC-508), so this ends by PRINTING the `gh release create`
 * command for a person to run once they have decided to.
 *
 * Refuses a dirty tree: a .dmg named for a version must be reproducible from
 * the commit it names. `--allow-dirty` is for trying the script.
 *
 * Usage: npm run release:dmg [-- --allow-dirty]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const allowDirty = process.argv.includes("--allow-dirty");
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const dirty = out("git", ["status", "--porcelain", "--untracked-files=no"]);
if (dirty && !allowDirty) {
  console.error("Working tree has uncommitted changes. Commit them, or pass --allow-dirty to try the script.");
  process.exit(1);
}

// Same steps as `app:package`, with the dmg target in place of `dir`.
run("npm", ["run", "app:build"]);
run("bash", ["scripts/build-app-icon.sh"]);
run("bash", ["helper/build.sh"]);
run("npx", ["electron-builder", "--mac", "dmg", "--publish", "never"]);

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

const sha = createHash("sha256").update(readFileSync(dmg)).digest("hex");
writeFileSync(`${dmg}.sha256`, `${sha}  ${dmgs[0]}\n`);

console.log(`\n${dmg}\nsha256 ${sha}${dirty ? "\n(built from a DIRTY tree)" : ""}`);
console.log(`\nNot published. When STC-508's blockers are clear and Patrick says yes:`);
console.log(`  git tag v${version} && git push origin v${version}`);
console.log(`  gh release create v${version} "${dmg}" "${dmg}.sha256" --title "v${version}" --notes-file <notes>`);
