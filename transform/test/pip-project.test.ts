import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { PROJECT_VERSIONS } from "../src/project-version.js";
import {
  DEFAULT_PIP_STYLE, PIP_WIDTH_MIN, PIP_WIDTH_MAX, PIP_RADIUS_MAX, PIP_FRAMING_ZOOM_MAX,
  PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX, PIP_COLOR_PATTERN, type PipStyle,
} from "../src/pip-style.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const schema15 = JSON.parse(readFileSync(join(root, "schema/project-15.schema.json"), "utf8"));
const validate15 = new Ajv({ allErrors: true, strict: true }).compile(schema15);
const DUR = 5_000_000_000;
const STYLE: PipStyle = { ...DEFAULT_PIP_STYLE, shape: "circle", shadow: true, mirror: true,
  border: { widthPt: 2, color: "#ffffff" }, framing: { x: 0.4, y: 0.5, zoom: 1.5 } };
const withStyle = (s: unknown) => {
  const p = defaultProject(640, 360, undefined, true);
  return { ...p, pip: { ...p.pip!, style: s as PipStyle } };
};

describe("project-15 pip.style (STC-461)", () => {
  test("15 is a readable version", () => expect(PROJECT_VERSIONS).toContain(15));
  test("an untouched camera project does not promote to 15", () => {
    expect(projectForWrite(defaultProject(640, 360, undefined, true), DUR).version).toBeLessThan(15);
  });
  test("a style writes a schema-valid v15 carrying it", () => {
    const out = projectForWrite(withStyle(STYLE), DUR);
    expect(out.version).toBe(15);
    expect(out.pip!.style).toEqual(STYLE);
    expect(validate15(out), JSON.stringify(validate15.errors, null, 2)).toBe(true);
  });
  test("v15 still carries every v14 field (>=, not ===)", () => {
    const p = { ...withStyle(STYLE), keycast: { show: false }, showClicks: false };
    const out = projectForWrite(p, DUR);
    expect(out.keycast).toEqual({ show: false });
    expect(out.showClicks).toBe(false);
  });
  test("parse round-trips a style", () => {
    const back = parseProject(projectForWrite(withStyle(STYLE), DUR), 640, 360, DUR, true);
    expect(back.pip!.style).toEqual(STYLE);
  });
  test("a bad style is DROPPED, not the project (Review Focus 5)", () => {
    const raw = { ...projectForWrite(withStyle(STYLE), DUR) } as any;
    raw.pip = { ...raw.pip, style: { ...STYLE, border: { widthPt: 2, color: "white" } } };
    const back = parseProject(raw, 640, 360, DUR, true);
    expect(back.pip).toBeDefined();
    expect(back.pip!.enabled).toBe(true);
    expect(back.pip!.style).toBeUndefined();
  });
  test("the schema's bounds are pip-style.ts's bounds", () => {
    const s = schema15.properties.pip.properties.style.properties;
    expect([s.width.minimum, s.width.maximum]).toEqual([PIP_WIDTH_MIN, PIP_WIDTH_MAX]);
    expect(s.cornerRadius.maximum).toBe(PIP_RADIUS_MAX);
    expect(s.framing.properties.zoom.maximum).toBe(PIP_FRAMING_ZOOM_MAX);
    const b = s.border.oneOf[1].properties;
    expect([b.widthPt.minimum, b.widthPt.maximum]).toEqual([PIP_BORDER_PT_MIN, PIP_BORDER_PT_MAX]);
    expect(b.color.pattern).toBe(PIP_COLOR_PATTERN.source);
  });
  test("the schema refuses what cleanPipStyle refuses", () => {
    const bad = projectForWrite(withStyle(STYLE), DUR) as any;
    bad.pip.style = { ...STYLE, width: 0.9 };
    expect(validate15(bad)).toBe(false);
  });
});
