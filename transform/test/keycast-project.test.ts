import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { PROJECT_VERSIONS } from "../src/project-version.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const validate13 = new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/project-13.schema.json"), "utf8")));
const DUR = 5_000_000_000;

describe("project-13 keycast (STC-419)", () => {
  test("an untouched project does not promote to 13", () => {
    expect(projectForWrite(defaultProject(640, 360), DUR).version).toBeLessThan(13);
  });
  test("hiding the keycast writes a schema-valid v13 carrying show:false", () => {
    const p = { ...defaultProject(640, 360), keycast: { show: false } };
    const out = projectForWrite(p, DUR);
    expect(out.version).toBe(13);
    expect(out.keycast).toEqual({ show: false });
    expect(validate13(out), JSON.stringify(validate13.errors, null, 2)).toBe(true);
  });
  test("show:true is the default and does not promote", () => {
    const p = { ...defaultProject(640, 360), keycast: { show: true } };
    expect(projectForWrite(p, DUR).version).toBeLessThan(13);
  });
  test("parse round-trips show:false and treats anything else as shown", () => {
    const base = defaultProject(640, 360);
    const hidden = parseProject(projectForWrite({ ...base, keycast: { show: false } }, DUR), 640, 360, DUR);
    expect(hidden.keycast).toEqual({ show: false });
    const odd = parseProject({ ...projectForWrite(base, DUR), version: 13, keycast: { show: "no" } }, 640, 360, DUR);
    expect(odd.keycast?.show).not.toBe(false);
  });
  test("13 is a readable version", () => {
    expect(PROJECT_VERSIONS).toContain(13);
  });
});
