/**
 * STC-525. The optional-vs-required split for reading a take's files: a take
 * with no project.json (never edited) answers null instead of throwing, so the
 * main process does not log a handler error on every load; a file that MUST
 * exist still fails loudly.
 */
import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPTIONAL_TAKE_FILES, readOptionalTakeFile } from "../src/take-read.js";

const takeDir = () => mkdtempSync(join(tmpdir(), "stc-take-read-"));

describe("readOptionalTakeFile (STC-525)", () => {
  test("a missing project.json is null, not a throw", async () => {
    expect(await readOptionalTakeFile(takeDir(), "project.json")).toBeNull();
  });

  test("a missing events.json is null too", async () => {
    expect(await readOptionalTakeFile(takeDir(), "events.json")).toBeNull();
  });

  test("a present file returns exactly its bytes", async () => {
    const dir = takeDir();
    writeFileSync(join(dir, "project.json"), '{"version":1}');
    const got = await readOptionalTakeFile(dir, "project.json");
    expect(new TextDecoder().decode(got!)).toBe('{"version":1}');
  });

  test("only ENOENT is swallowed: any other read error still throws", async () => {
    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
    await expect(readOptionalTakeFile(takeDir(), "project.json", (async () => { throw eacces; }) as unknown as typeof readFile))
      .rejects.toThrow("EACCES");
  });

  test("a required file is refused on this channel, so a missing anchors.json cannot go quiet", async () => {
    for (const name of ["anchors.json", "display.mp4", "camera.mp4", "mic.m4a", "system.m4a"]) {
      expect(OPTIONAL_TAKE_FILES.has(name)).toBe(false);
      await expect(readOptionalTakeFile(takeDir(), name)).rejects.toThrow("not an optional take file");
    }
  });
});
