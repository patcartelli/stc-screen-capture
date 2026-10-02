import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { PROJECT_VERSIONS } from "../src/project-version.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const validate15 = new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/project-15.schema.json"), "utf8")));
const DUR = 5_000_000_000;

describe("project-15 framing (STC-396)", () => {
  test("15 is a readable version", () => {
    expect(PROJECT_VERSIONS).toContain(15);
  });

  test("an untouched project does not promote to 15", () => {
    expect(projectForWrite(defaultProject(640, 360), DUR).version).toBeLessThan(15);
  });

  test("a framed project writes a schema-valid v15 carrying framing", () => {
    const p = { ...defaultProject(640, 360), framing: { preset: "clean" as const } };
    const out = projectForWrite(p, DUR);
    expect(out.version).toBe(15);
    expect(out.framing).toEqual({ preset: "clean" });
    expect(validate15(out), JSON.stringify(validate15.errors, null, 2)).toBe(true);
  });

  test("framing coexists with the lower-version fields it promotes past", () => {
    const p = {
      ...defaultProject(640, 360), framing: { preset: "solid" as const, color: "#112233" },
      keycast: { show: false }, showClicks: false, micMuted: true, bookmarks: [1_000_000_000],
    };
    const out = projectForWrite(p, DUR);
    expect(out.version).toBe(15);
    expect(out.keycast).toEqual({ show: false });
    expect(out.showClicks).toBe(false);
    expect(out.micMuted).toBe(true);
    expect(out.bookmarks).toEqual([1_000_000_000]);
    expect(validate15(out), JSON.stringify(validate15.errors, null, 2)).toBe(true);
  });

  test("a framed document round-trips through parseProject", () => {
    const framing = {
      preset: "dark" as const, paddingPct: 0.1,
      shadow: { offsetYPct: 0.01, blurPct: 0.02, opacity: 0.4 },
    };
    const written = projectForWrite({ ...defaultProject(640, 360), framing }, DUR);
    expect(parseProject(written, 640, 360, DUR).framing).toEqual(framing);
  });

  test("a malformed framing is dropped, not fatal: the take opens unframed", () => {
    const written = projectForWrite({ ...defaultProject(640, 360), framing: { preset: "clean" as const } }, DUR);
    for (const bad of [{ preset: "bogus" }, "clean", 7, { preset: "clean", paddingPct: 9 }]) {
      const p = parseProject({ ...written, framing: bad }, 640, 360, DUR);
      expect(p.framing).toBeUndefined();
      expect(p.output).toEqual({ fps: 60, width: 640, height: 360 });
    }
  });

  test("a document with no framing parses with none", () => {
    const old = projectForWrite(defaultProject(640, 360), DUR);
    expect(parseProject(old, 640, 360, DUR).framing).toBeUndefined();
  });

  test("a frozen v14 document still loads unchanged", () => {
    const v14 = {
      version: 14, output: { fps: 60, width: 640, height: 360 },
      cursor: { style: "default", scale: 1 }, transform: { version: 13 },
      keycast: { show: false }, showClicks: false,
    };
    const p = parseProject(v14, 640, 360, DUR);
    expect(p.keycast).toEqual({ show: false });
    expect(p.showClicks).toBe(false);
    expect(p.framing).toBeUndefined();
  });
});
