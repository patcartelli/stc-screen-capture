import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * STC-675: one place fills a still's presets and plans its size, `planStill`
 * (`transform/src/still-plan.ts`). The app's renderers reach it through
 * `composeStill` or call it directly; none lays out or fills a shot itself.
 * Three copies of that did, and the panel's drifted (no margin, no shadow).
 *
 * As a grep over `app/src`, with a control proving the pattern fires on the
 * pre-STC-675 panel code.
 */
const APP_SRC = join(__dirname, "..", "src");
const FORBIDDEN = /\b(layoutStill|decorationForMode|planRender)\s*\(/;

/** Code lines only: a comment may name the functions. */
function offendingLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
    return FORBIDDEN.test(line);
  });
}

describe("planStill is the only still layout in app/src (STC-675)", () => {
  it("control: the pattern fires on the panel's pre-STC-675 export plan", () => {
    const before = [
      "  const layout = layoutStill(shot);",
      "  let plan = planRender(options, { layout, pxPerPoint });",
      "    const decorated = { ...shot, decoration: decorationForMode(shot.decoration.mode, shot.decoration) };",
      "  // `layoutStill(shot)` in a comment is fine",
    ].join("\n");
    expect(offendingLines(before)).toHaveLength(3);
  });

  it("no file in app/src lays out, fills or plans a shot itself", () => {
    const files = readdirSync(APP_SRC).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(20);
    const found = files.flatMap((f) =>
      offendingLines(readFileSync(join(APP_SRC, f), "utf8")).map((l) => `${f}: ${l.trim()}`));
    expect(found).toEqual([]);
  });
});
