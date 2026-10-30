import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * main.ts's write gate refuses any project.json field it does not list
 * (KNOWN_PROJECT_FIELDS). STC-606 minted project-18's `peakLimit` and the list
 * was not updated: every save of a changed ceiling was refused, and no unit
 * test crossed that process line to see it. The list and the newest schema's
 * fields must be the same set.
 */
const root = join(__dirname, "..", "..");

function knownFields(source: string): string[] {
  const m = /const KNOWN_PROJECT_FIELDS = new Set\(\[([\s\S]*?)\]\);/.exec(source);
  if (!m) throw new Error("KNOWN_PROJECT_FIELDS not found in main.ts");
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
}

describe("the write gate's field list", () => {
  test("is exactly the newest project schema's fields", () => {
    const newest = readdirSync(join(root, "schema"))
      .map((f) => /^project-(\d+)\.schema\.json$/.exec(f)?.[1])
      .filter((n): n is string => !!n)
      .map(Number)
      .sort((a, b) => b - a)[0]!;
    const schema = JSON.parse(readFileSync(join(root, `schema/project-${newest}.schema.json`), "utf8"));
    const fields = Object.keys(schema.properties).sort();
    expect(knownFields(readFileSync(join(root, "app/src/main.ts"), "utf8"))).toEqual(fields);
  });

  test("the check can fail: a list missing a field is caught", () => {
    const planted = 'const KNOWN_PROJECT_FIELDS = new Set([\n  "version", "output",\n]);';
    expect(knownFields(planted)).toEqual(["output", "version"]);
  });
});
