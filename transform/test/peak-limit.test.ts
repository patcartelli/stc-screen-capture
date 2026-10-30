import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import {
  cleanPeakLimit, isDefaultPeakLimit, ceilingLevel, mixLimit, peaksOver, formatCeilingDb,
  DEFAULT_PEAK_LIMIT, CEILING_DB_MIN, CEILING_DB_MAX,
} from "../src/peak-limit.js";
import { mixBlock, exportAudioPlan, MIX_SAMPLE_RATE, type PcmTrack } from "../src/audio-mix.js";
import { isClipped } from "../src/waveform.js";
import { defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { PROJECT_VERSIONS } from "../src/project-version.js";
import type { Project } from "../src/types.js";

// STC-606: the audio ceiling. Limit peaks on is a hard limit at the ceiling
// (STC-418's rule, moved down); off, the mix limits at full scale as before.

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const validate18 = new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/project-18.schema.json"), "utf8")));
const DUR = 60_000_000_000;

describe("the setting", () => {
  test("a block is read on its own terms; anything malformed is null", () => {
    expect(cleanPeakLimit({ enabled: true, ceilingDb: -3 })).toEqual({ enabled: true, ceilingDb: -3 });
    for (const bad of [null, [], "on", { enabled: "yes", ceilingDb: -1 }, { enabled: true },
      { enabled: true, ceilingDb: CEILING_DB_MIN - 0.1 }, { enabled: true, ceilingDb: CEILING_DB_MAX + 0.1 },
      { enabled: true, ceilingDb: NaN }]) {
      expect(cleanPeakLimit(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("the default is off at -1 dB, and absent counts as the default", () => {
    expect(DEFAULT_PEAK_LIMIT).toEqual({ enabled: false, ceilingDb: -1 });
    expect(isDefaultPeakLimit(undefined)).toBe(true);
    expect(isDefaultPeakLimit({ enabled: false, ceilingDb: -1 })).toBe(true);
    expect(isDefaultPeakLimit({ enabled: false, ceilingDb: -2 })).toBe(false);
    expect(isDefaultPeakLimit({ enabled: true, ceilingDb: -1 })).toBe(false);
  });

  test("the ceiling in linear terms; the mix limits there only when on", () => {
    expect(ceilingLevel({ enabled: false, ceilingDb: -6 })).toBeCloseTo(0.5012, 4);
    expect(ceilingLevel(undefined)).toBeCloseTo(0.8913, 4);
    expect(mixLimit({ enabled: false, ceilingDb: -6 })).toBe(1);
    expect(mixLimit({ enabled: true, ceilingDb: -6 })).toBeCloseTo(0.5012, 4);
    expect(mixLimit(undefined)).toBe(1);
  });

  test("the readout's dB, with a true minus sign", () => {
    expect(formatCeilingDb(-1)).toBe("−1 dB");
    expect(formatCeilingDb(0)).toBe("0 dB");
    expect(formatCeilingDb(-2.54)).toBe("−2.5 dB");
  });
});

describe("peaksOver: a peak is a burst", () => {
  test("consecutive buckets at or over the level are one peak", () => {
    const peaks = [0.1, 0.95, 0.97, 0.2, 0.96, 0.1, 0.99];
    expect(peaksOver(peaks, 0.9)).toEqual([{ start: 1, end: 3 }, { start: 4, end: 5 }, { start: 6, end: 7 }]);
  });
  test("a bucket limited at the ceiling counts as reaching it (float32 margin)", () => {
    const level = ceilingLevel({ enabled: true, ceilingDb: -1 });
    expect(peaksOver(Float32Array.of(0, level, 0), level)).toEqual([{ start: 1, end: 2 }]);
  });
  test("nothing over is no peaks", () => {
    expect(peaksOver([0.1, 0.2], 0.9)).toEqual([]);
  });
});

describe("the mix", () => {
  const loud = (): PcmTrack => ({ startNs: 0, sampleRate: MIX_SAMPLE_RATE,
    channels: [Float32Array.of(0.95, -0.95, 0.5), Float32Array.of(0.95, -0.95, 0.5)] });
  const mix = (ceiling?: number) =>
    Array.from(mixBlock({ mic: loud(), system: null, systemLevel: 1, micLevel: 1, ceiling, originNs: 0, from: 0, frames: 3 })[0]!);

  test("no ceiling is the old full-scale limit, sample for sample", () => {
    expect(mix(undefined)).toEqual(mix(1));
    expect(mix(undefined)[0]).toBeCloseTo(0.95, 6);
  });

  test("a ceiling hard-limits both signs there and leaves quieter samples alone", () => {
    const [a, b, c] = mix(0.5);
    expect(a).toBeCloseTo(0.5, 6);
    expect(b).toBeCloseTo(-0.5, 6);
    expect(c).toBeCloseTo(0.5, 6);
    const [, , q] = mix(0.8);
    expect(q).toBeCloseTo(0.5, 6);
  });

  test("a nonsense ceiling falls back to full scale", () => {
    expect(mix(0)).toEqual(mix(1));
    expect(mix(NaN)).toEqual(mix(1));
    expect(mix(3)).toEqual(mix(1));
  });

  test("Limit peaks sends a mic-only take through the mixer, where the limit lives", () => {
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: false }).path).toBe("mic");
    expect(exportAudioPlan({ encode: true, hasMic: true, hasSystem: false, limit: true }).path).toBe("mix");
  });

  test("the waveform reads clipped where the mix is limited", () => {
    const lim = mixLimit({ enabled: true, ceilingDb: -6 });
    expect(isClipped(lim, lim)).toBe(true);
    expect(isClipped(lim * 0.9, lim)).toBe(false);
    expect(isClipped(1)).toBe(true);
  });
});

describe("project-18", () => {
  const withLimit = (peakLimit: Project["peakLimit"]): Project => ({ ...defaultProject(640, 360), peakLimit });
  const reload = (p: Project) => parseProject(projectForWrite(p, DUR), 640, 360, DUR);

  test("18 is a readable version", () => expect(PROJECT_VERSIONS).toContain(18));

  test("an untouched take is not promoted, and writes no peakLimit", () => {
    const out = projectForWrite(withLimit(undefined), DUR);
    expect(out.version).toBeLessThan(18);
    expect("peakLimit" in out).toBe(false);
    expect(projectForWrite(withLimit({ enabled: false, ceilingDb: -1 }), DUR).version).toBeLessThan(18);
  });

  test("a changed ceiling or Limit peaks on promotes to v18, schema-valid, and reads back", () => {
    for (const pl of [{ enabled: true, ceilingDb: -1 }, { enabled: false, ceilingDb: -4.5 }]) {
      const out = projectForWrite(withLimit(pl), DUR);
      expect(out.version).toBe(18);
      expect(out.peakLimit).toEqual(pl);
      expect(validate18(out), JSON.stringify(validate18.errors, null, 2)).toBe(true);
      expect(reload(withLimit(pl)).peakLimit).toEqual(pl);
    }
  });

  test("v18 still carries every older field (>=, not ===)", () => {
    const p = { ...withLimit({ enabled: true, ceilingDb: -2 }), showClicks: false, slug: "my-take",
      framing: { preset: "solid" as const, color: "#112233" } };
    const out = projectForWrite(p, DUR);
    expect(out.version).toBe(18);
    expect(out.showClicks).toBe(false);
    expect(out.slug).toBe("my-take");
    expect(out.framing).toEqual({ preset: "solid", color: "#112233" });
    expect(validate18(out), JSON.stringify(validate18.errors, null, 2)).toBe(true);
  });

  test("a malformed block is dropped on load (the take keeps the default), and the schema refuses it", () => {
    const doc = { ...projectForWrite(withLimit({ enabled: true, ceilingDb: -2 }), DUR), peakLimit: { enabled: true, ceilingDb: 5 } };
    expect(parseProject(doc as any, 640, 360, DUR).peakLimit).toBeUndefined();
    expect(validate18(doc)).toBe(false);
  });
});
