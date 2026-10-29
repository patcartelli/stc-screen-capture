import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { PROJECT_VERSIONS } from "../src/project-version.js";
import type { Project, ZoomOverride } from "../src/types.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const schema17 = JSON.parse(readFileSync(join(root, "schema/project-17.schema.json"), "utf8"));
const validate17 = new Ajv({ allErrors: true, strict: true }).compile(schema17);
const DUR = 60_000_000_000;
const RECT = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };

const withOverrides = (overrides: ZoomOverride[]): Project => ({ ...defaultProject(640, 360), overrides });
const geometry = (easing?: unknown): ZoomOverride =>
  ({ kind: "geometry", windowId: "1000", rect: RECT, ...(easing !== undefined ? { easing } : {}) }) as ZoomOverride;
const manual = (easing: unknown): ZoomOverride =>
  ({ kind: "manual", id: "m1", startNs: 1, endNs: 2, rect: RECT, easing }) as ZoomOverride;
const reload = (p: Project) => parseProject(projectForWrite(p, DUR), 640, 360, DUR);

describe("project-17: a zoom block's separate in/out speeds (STC-619)", () => {
  test("17 is a readable version", () => expect(PROJECT_VERSIONS).toContain(17));

  test("a plain preset name stays at v6, as it always was", () => {
    expect(projectForWrite(withOverrides([geometry("snappy")]), DUR).version).toBe(6);
    expect(projectForWrite(withOverrides([manual("calm")]), DUR).version).toBe(6);
  });

  test("an in/out pair promotes to v17, and the written document is schema-valid", () => {
    const out = projectForWrite(withOverrides([geometry({ in: "calm", out: "snappy" })]), DUR);
    expect(out.version).toBe(17);
    expect(out.overrides![0]).toMatchObject({ easing: { in: "calm", out: "snappy" } });
    expect(validate17(out), JSON.stringify(validate17.errors, null, 2)).toBe(true);
  });

  test("one side only is a pair too, and a complete manual pair is valid", () => {
    for (const o of [geometry({ out: "calm" }), manual({ in: "calm", out: "snappy" })]) {
      const out = projectForWrite(withOverrides([o]), DUR);
      expect(out.version).toBe(17);
      expect(validate17(out), JSON.stringify(validate17.errors, null, 2)).toBe(true);
    }
  });

  test("v17 still carries every older field (>=, not ===)", () => {
    const p = { ...withOverrides([geometry({ in: "calm" })]), keycast: { show: false }, showClicks: false,
      framing: { preset: "solid" as const, color: "#112233" }, slug: "my-take" };
    const out = projectForWrite(p, DUR);
    expect(out.version).toBe(17);
    expect(out.keycast).toEqual({ show: false });
    expect(out.showClicks).toBe(false);
    expect(out.framing).toEqual({ preset: "solid", color: "#112233" });
    expect(out.slug).toBe("my-take");
    expect(validate17(out), JSON.stringify(validate17.errors, null, 2)).toBe(true);
  });

  test("the schema refuses what the loader would drop: an empty pair, an unknown side, a half manual pair", () => {
    const base = projectForWrite(withOverrides([geometry({ in: "calm", out: "snappy" })]), DUR) as any;
    for (const bad of [{}, { middle: "calm" }, { in: "wobbly" }]) {
      expect(validate17({ ...base, overrides: [geometry(bad)] }), JSON.stringify(bad)).toBe(false);
    }
    expect(validate17({ ...base, overrides: [manual({ in: "calm" })] })).toBe(false);
  });

  test("a pair survives a round trip, and equal sides come back as the preset's name", () => {
    expect(reload(withOverrides([geometry({ in: "calm", out: "snappy" })])).overrides![0])
      .toMatchObject({ easing: { in: "calm", out: "snappy" } });
    const raw = projectForWrite(withOverrides([geometry({ in: "calm", out: "snappy" })]), DUR) as any;
    raw.overrides = [geometry({ in: "snappy", out: "snappy" })];
    expect(parseProject(raw, 640, 360, DUR).overrides![0]).toMatchObject({ easing: "snappy" });
  });

  test("a bad easing drops the easing alone from a geometry override, never the entry", () => {
    const raw = projectForWrite(withOverrides([geometry({ in: "calm", out: "snappy" })]), DUR) as any;
    for (const bad of [{ in: "wobbly" }, {}, "extreme", 3]) {
      raw.overrides = [geometry(bad)];
      const back = parseProject(raw, 640, 360, DUR).overrides!;
      expect(back).toHaveLength(1);
      expect("easing" in back[0]!).toBe(false);
    }
  });

  test("a manual window with a half pair, or none, is dropped whole: it has nothing to fall back to", () => {
    const raw = projectForWrite(withOverrides([manual({ in: "calm", out: "snappy" })]), DUR) as any;
    for (const bad of [{ in: "calm" }, {}, "extreme", undefined]) {
      raw.overrides = [manual(bad)];
      expect(parseProject(raw, 640, 360, DUR).overrides).toEqual([]);
    }
  });
});
