/**
 * STC-405: audit auto-zoom stage 2 against one real take — which windows the
 * change track misled, and how noisy the take was outside them.
 *
 * Needs the take's changes.json. Without one every window takes the cursor
 * fallback, which pixels cannot mislead, so there is nothing to audit; write
 * it first with `node scripts/change-track-one.mjs <sessionDir>` (real Chrome).
 * This script itself needs no browser and no Mac: it reads three JSON files.
 *
 * Usage: node scripts/zoom-audit-one.mjs <sessionDir> [--out report.md]
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
const sessionDir = args.find((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1));
if (!sessionDir) {
  console.error("usage: node scripts/zoom-audit-one.mjs <sessionDir> [--out report.md]");
  process.exit(2);
}
for (const f of ["anchors.json", "events.json"]) {
  if (!existsSync(join(sessionDir, f))) { console.error(`${sessionDir} has no ${f}`); process.exit(2); }
}
if (!existsSync(join(sessionDir, "changes.json"))) {
  console.error(`${sessionDir} has no changes.json — run: node scripts/change-track-one.mjs ${sessionDir}`);
  process.exit(2);
}

// The transform is TypeScript with .js import specifiers; bundle it rather than transpile per file.
const tmp = mkdtempSync(join(tmpdir(), "zoom-audit-"));
const bundle = join(tmp, "audit.mjs");
await build({
  entryPoints: [new URL("../transform/src/zoom-audit.ts", import.meta.url).pathname],
  outfile: bundle, bundle: true, format: "esm", platform: "node", logLevel: "error",
});
const { auditTake, renderReport } = await import(pathToFileURL(bundle).href);
const changesMod = join(tmp, "changes.mjs");
await build({
  entryPoints: [new URL("../transform/src/changes.ts", import.meta.url).pathname],
  outfile: changesMod, bundle: true, format: "esm", platform: "node", logLevel: "error",
});
const { parseChanges } = await import(pathToFileURL(changesMod).href);

const read = (f) => JSON.parse(readFileSync(join(sessionDir, f), "utf8"));
const audit = auditTake({
  anchors: read("anchors.json"),
  events: read("events.json").events,
  changes: parseChanges(read("changes.json")),
});
const md = renderReport(audit, basename(resolve(sessionDir)));
if (outPath) { writeFileSync(outPath, md); console.log(`wrote ${outPath}`); }
console.log(md);
