import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import {
  parseChanges, changesForWrite, computeChangeDocument, ChangesLoadError,
} from "../src/changes.js";
import type { Frame } from "../src/frame-diff-rule.js";

// CJS/ESM interop: ajv v8 ships CJS; vitest may or may not unwrap the default.
const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

const schema = load("schema/changes-1.schema.json");
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
const fixture = load("fixtures/changes/changes.json");

/**
 * STC-322: the schema and the loader are checked against EACH OTHER, same
 * pattern STC-307 set for recording.json — a document the schema accepts
 * must parse, and one it rejects must be refused.
 */
describe("changes-1 schema and loader agree", () => {
  test("the fixture validates and round-trips through the loader", () => {
    expect(validate(fixture), JSON.stringify(validate.errors, null, 2)).toBe(true);
    const changes = parseChanges(fixture);
    expect(changes.version).toBe(1);
    expect(changes.gridWidth).toBe(4);
    expect(changes.gridHeight).toBe(3);
    expect(changes.frames).toHaveLength(3);
    expect(changes.frames[0]).toEqual({ t: 0, cells: new Array(12).fill(0), changedFraction: 0 });
    expect(JSON.stringify(changesForWrite(changes))).toBe(JSON.stringify(parseChanges(fixture)));
    expect(changesForWrite(changes)).toEqual(changes);
  });

  test("the loader returns a copy, never the raw object", () => {
    const raw = clone(fixture);
    const changes = parseChanges(raw);
    raw.frames[0].t = 999;
    expect(changes.frames[0]!.t).toBe(0);
  });
});

describe("documents that must be refused — by both the schema and the loader", () => {
  const refused: [string, (d: any) => void][] = [
    ["a future version", (d) => { d.version = 2; }],
    ["no version", (d) => { delete d.version; }],
    ["a field nobody declared, at the top level", (d) => { d.gridResolution = "coarse"; }],
    ["a field nobody declared, on a frame", (d) => { d.frames[0].label = "start"; }],
    ["a non-integer t", (d) => { d.frames[0].t = 1.5; }],
    ["a negative t", (d) => { d.frames[0].t = -1; }],
    ["a cell above 1", (d) => { d.frames[0].cells[0] = 1.5; }],
    ["a cell below 0", (d) => { d.frames[0].cells[0] = -0.1; }],
    ["threshold above 1", (d) => { d.threshold = 1.5; }],
    ["a non-integer gridWidth", (d) => { d.gridWidth = 4.5; }],
  ];
  test.each(refused)("%s", (_name, mutate) => {
    const doc = clone(fixture);
    mutate(doc);
    expect(validate(doc), "the schema accepted it").toBe(false);
    expect(() => parseChanges(doc)).toThrow(ChangesLoadError);
  });

  // Cross-field constraints (cells.length === gridWidth * gridHeight, PTS
  // strictly increasing across frames) are not expressible in JSON Schema —
  // same class as recording.ts's endNs > startNs — so the schema alone
  // accepts these and the loader's refusal is asserted on its own.
  const loaderOnly: [string, (d: any) => void, RegExp][] = [
    ["a frame's cells array shorter than gridWidth * gridHeight", (d) => { d.frames[0].cells.pop(); }, /cells has 11 entries, expected .* 12/],
    ["frames out of PTS order", (d) => { d.frames.reverse(); }, /frames\[1\]\.t/],
    ["a repeated PTS", (d) => { d.frames[1].t = d.frames[0].t; }, /frames\[1\]\.t/],
  ];
  test.each(loaderOnly)("the schema alone accepts %s; the loader names the field", (_name, mutate, msg) => {
    const doc = clone(fixture);
    mutate(doc);
    expect(validate(doc), "the schema unexpectedly rejected it too").toBe(true);
    expect(() => parseChanges(doc)).toThrow(msg);
  });
});

/**
 * `computeChangeDocument` is the pure half of the post-recording pass — no
 * canvas, no WebCodecs, so it is the one part of STC-322 this sandbox can
 * actually run against something resembling real data. `extractFrames` /
 * `computeChangesForVideo` (change-track.ts) glue this to a real decode and
 * cannot be exercised here (no WebCodecs in this environment at all — see
 * the STC-322 finding doc).
 */
describe("computeChangeDocument", () => {
  const W = 8, H = 8, GW = 2, GH = 2; // 4 cells, 16 px each — small and exact.

  function solid(r: number, g: number, b: number): Frame {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
    }
    return { data, width: W, height: H };
  }

  test("frame 0 gets an all-zero grid — there is no predecessor to diff against", () => {
    const doc = computeChangeDocument([solid(10, 10, 10), solid(10, 10, 10)], [0, 1000], { gridWidth: GW, gridHeight: GH });
    expect(doc.frames[0]).toEqual({ t: 0, cells: [0, 0, 0, 0], changedFraction: 0 });
  });

  test("a uniform change registers in every cell, and the document round-trips through the schema", () => {
    const a = solid(10, 10, 10);
    const b = solid(250, 250, 250); // far past any reasonable threshold
    const doc = computeChangeDocument([a, b], [0, 1000], { gridWidth: GW, gridHeight: GH, threshold: 0.5 });
    expect(doc.frames[1]!.cells).toEqual([1, 1, 1, 1]);
    expect(doc.frames[1]!.changedFraction).toBe(1);
    expect(validate(changesForWrite(doc)), JSON.stringify(validate.errors)).toBe(true);
  });

  test("a change confined to one quadrant registers in exactly that cell — three regions survive as three regions, not one bounding rect", () => {
    const a = solid(10, 10, 10);
    const bData = new Uint8ClampedArray(a.data);
    // top-left quadrant only (x<4, y<4)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const p = (y * W + x) * 4;
        bData[p] = 250; bData[p + 1] = 250; bData[p + 2] = 250;
      }
    }
    const b: Frame = { data: bData, width: W, height: H };
    const doc = computeChangeDocument([a, b], [0, 1000], { gridWidth: GW, gridHeight: GH, threshold: 0.5 });
    // cell layout is row-major: [top-left, top-right, bottom-left, bottom-right]
    expect(doc.frames[1]!.cells).toEqual([1, 0, 0, 0]);
  });

  test("threshold governs what counts as changed", () => {
    const a = solid(100, 100, 100);
    const b = solid(108, 108, 108); // luma delta ~0.0314
    const below = computeChangeDocument([a, b], [0, 1000], { gridWidth: GW, gridHeight: GH, threshold: 0.01 });
    const above = computeChangeDocument([a, b], [0, 1000], { gridWidth: GW, gridHeight: GH, threshold: 0.5 });
    expect(below.frames[1]!.changedFraction).toBe(1);
    expect(above.frames[1]!.changedFraction).toBe(0);
  });

  test("refuses mismatched frames/framesNs lengths", () => {
    expect(() => computeChangeDocument([solid(0, 0, 0)], [0, 1000])).toThrow(/same length/);
  });

  test("defaults to the reference grid (64x36) and study one's default threshold (0.08)", () => {
    const doc = computeChangeDocument([solid(0, 0, 0), solid(0, 0, 0)], [0, 1000]);
    expect(doc.gridWidth).toBe(64);
    expect(doc.gridHeight).toBe(36);
    expect(doc.threshold).toBe(0.08);
  });
});
