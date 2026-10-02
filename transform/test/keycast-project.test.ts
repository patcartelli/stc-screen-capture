import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { PROJECT_VERSIONS } from "../src/project-version.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const validate14 = new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/project-14.schema.json"), "utf8")));
const DUR = 5_000_000_000;

describe("project-14 keycast (STC-419)", () => {
  test("an untouched project does not promote to 14", () => {
    expect(projectForWrite(defaultProject(640, 360), DUR).version).toBeLessThan(14);
  });
  test("hiding the keycast writes a schema-valid v14 carrying show:false", () => {
    const p = { ...defaultProject(640, 360), keycast: { show: false } };
    const out = projectForWrite(p, DUR);
    expect(out.version).toBe(14);
    expect(out.keycast).toEqual({ show: false });
    expect(validate14(out), JSON.stringify(validate14.errors, null, 2)).toBe(true);
  });
  test("show:true is the default and does not promote", () => {
    const p = { ...defaultProject(640, 360), keycast: { show: true } };
    expect(projectForWrite(p, DUR).version).toBeLessThan(14);
  });
  test("parse round-trips show:false and treats anything else as shown", () => {
    const base = defaultProject(640, 360);
    const hidden = parseProject(projectForWrite({ ...base, keycast: { show: false } }, DUR), 640, 360, DUR);
    expect(hidden.keycast).toEqual({ show: false });
    const odd = parseProject({ ...projectForWrite(base, DUR), version: 14, keycast: { show: "no" } }, 640, 360, DUR);
    expect(odd.keycast?.show).not.toBe(false);
  });
  test("14 is a readable version", () => {
    expect(PROJECT_VERSIONS).toContain(14);
  });
});
