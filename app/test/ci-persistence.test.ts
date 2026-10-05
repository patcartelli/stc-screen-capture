import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * Why one Electron crash used to wedge every later e2e launch (STC-496).
 *
 * After an app crashes, macOS offers, on that app's NEXT launch, to reopen its
 * windows — a modal `NSAlert` raised from
 * `-[NSPersistentUIRestorer promptToIgnorePersistentStateWithCrashHistory:]`
 * inside `_handleAEOpenEvent:`, before the app is ready. On CI nobody clicks
 * it, so every later launch of the same bundle blocked there: `firstWindow`
 * never fired, `app.close()` never returned, and the run died at its time
 * limit. `sample` of a wedged launch (run 37353659082) showed exactly that
 * stack. Every e2e launch is node_modules' Electron, one bundle id, so one
 * crash poisoned all of them.
 *
 * `ApplePersistenceIgnoreState` for that bundle turns the prompt off, so a
 * crash costs one failed test rather than the rest of the run. These pin that
 * the CI step exists, runs before the tests, and names the bundle the suite
 * actually launches — an Electron upgrade that changed the id would otherwise
 * make the setting a silent no-op.
 */
const root = join(__dirname, "..", "..");
const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const lines = ci.split("\n");
const SETTING = /defaults write (\S+) ApplePersistenceIgnoreState -bool (?:YES|true)/;

function stepIndex(name: string): number {
  return lines.findIndex((l) => l.trim() === `- name: ${name}`);
}

describe("CI turns off macOS's reopen-windows prompt for the e2e Electron", () => {
  const at = lines.findIndex((l) => SETTING.test(l) && !/^\s*#/.test(l));

  test("ci.yml writes ApplePersistenceIgnoreState", () => {
    expect(at, "no `defaults write <bundle> ApplePersistenceIgnoreState -bool YES` step in ci.yml").toBeGreaterThan(-1);
  });

  test("before the Test step, so it is in force for every e2e launch", () => {
    const testStep = stepIndex("Test");
    expect(testStep).toBeGreaterThan(-1);
    expect(at, "the setting is missing, so it cannot be before anything").toBeGreaterThan(-1);
    expect(at).toBeLessThan(testStep);
  });

  test("for the bundle id of the Electron the e2e suite launches", () => {
    // Playwright's `_electron.launch()` with no executablePath runs
    // `require("electron")`, i.e. this binary.
    const exe = createRequire(import.meta.url)("electron") as unknown as string;
    const plist = readFileSync(join(exe, "..", "..", "Info.plist"), "utf8");
    const id = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    expect(id, "could not read CFBundleIdentifier from Electron's Info.plist").toBeTruthy();
    expect(lines[at]!.match(SETTING)?.[1]).toBe(id);
  });

  test("control: the pattern matches the step and not a comment about it", () => {
    expect(SETTING.test("          defaults write com.github.Electron ApplePersistenceIgnoreState -bool YES")).toBe(true);
    expect(SETTING.test("defaults read com.github.Electron ApplePersistenceIgnoreState")).toBe(false);
  });
});
