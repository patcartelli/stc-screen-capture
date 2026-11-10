import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-641: macOS caches Vision's Neural Engine compile per EXECUTABLE FILE
 * NAME, one entry per name, checked against the code-signing identifier
 * (measured 2026-11-10, `docs/STC-572-RUNBOOK.md` §1). A new cdhash, path or
 * signer stays warm, which is the only reason an app update does not cost the
 * first Capture Text ~45 s. Renaming the helper, or signing it with an explicit
 * identifier other than its file name, would make every user's first read
 * after that update cold again, and nothing else would fail. So both are
 * pinned here, at every place a shipped helper is named or signed.
 */
const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Every codesign invocation in a script, minus comments and echo lines. */
function codesignLines(script: string): string[] {
  return script.split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#") && !l.startsWith("echo") && /\bcodesign\b/.test(l) && /--sign|-s\b/.test(l));
}
const setsIdentifier = (line: string) => /(--identifier\b|\s-i\s)/.test(line);

describe("the helper keeps one name and identifier (STC-641)", () => {
  test("helper/build.sh writes build/stc-helper and signs it without an explicit identifier", () => {
    const sh = read("helper/build.sh");
    expect(sh).toMatch(/-o build\/stc-helper\b/);
    const lines = codesignLines(sh);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(setsIdentifier(l), l).toBe(false);
  });

  test("the packaged app ships it as Resources/stc-helper", () => {
    const yml = read("electron-builder.yml");
    expect(yml).toMatch(/from: helper\/build\/stc-helper\s+to: stc-helper\b/);
    expect(yml).toMatch(/Contents\/Resources\/stc-helper\b/);
  });

  test("control: the identifier check fires on the forms that would break the cache", () => {
    expect(setsIdentifier("codesign --force --identifier com.x --sign X build/stc-helper")).toBe(true);
    expect(setsIdentifier("codesign -f -s - -i com.x build/stc-helper")).toBe(true);
    expect(codesignLines("  codesign -f -s - -i com.x build/stc-helper")).toHaveLength(1);
  });
});
