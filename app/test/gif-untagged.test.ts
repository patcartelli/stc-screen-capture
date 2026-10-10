import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-395 spec §3: a saved GIF is a plain output file, NOT a take's finished
 * file. If someone adds `.gif` to the library's media types, the editor's
 * Export (which overwrites a bundle's ONE finished file) could write MP4 bytes
 * into a `.gif`, and Reclaim would start reading GIFs as export proof. Making
 * the GIF a finished file is a design change (spec §3's alternative), not a
 * one-line edit — this test is what says so.
 */
describe("a saved GIF stays outside the library model", () => {
  const src = readFileSync(join(__dirname, "..", "src", "library.ts"), "utf8");
  test("MEDIA_EXTENSIONS does not list .gif", () => {
    const line = src.split("\n").find((l) => l.includes("const MEDIA_EXTENSIONS"))!;
    expect(line).toBeTruthy();                       // control: the pattern still finds the declaration
    expect(line).toContain(".mp4");                  // control: it is the list we think it is
    expect(line).not.toContain(".gif");
  });
});
