import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { canvasColorSpace, checkCaptureColour, CAPTURE_COLOR_SPACES } from "../src/capture-colour.js";
import { checkWindowTrack } from "../src/window-track.js";
import type { Anchors } from "../src/types.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

// STC-510. A recording on a wide-gamut display is captured as Display P3 and says so
// in anchors-9's `capture.colorSpace`; every sink that draws it asks ONE function
// which canvas to use. Measured on a real take before this existed: the export
// drew a P3 take into the default sRGB canvas and came out with the P3-green and
// sRGB-green swatches the SAME green.

const DISPLAY = { id: 1, pointWidth: 1800, pointHeight: 1169, pixelWidth: 3600, pixelHeight: 2338, backingScale: 2, originX: 0, originY: 0 };
const anchors = (over: Partial<Anchors["capture"]> = {}, version: Anchors["version"] = 9): Anchors => ({
  version, timebase: { numer: 125, denom: 3 }, t0Ns: "0", display: DISPLAY,
  capture: { width: 3326, height: 2160, codec: "h264", firstFrameNs: 0, ...over },
  files: { display: "display.mp4" }, stop: { t: 5_000_000_000, reason: "user" },
});

describe("canvasColorSpace", () => {
  test("a Display P3 take draws into a display-p3 canvas", () => {
    expect(canvasColorSpace(anchors({ colorSpace: "displayP3" }))).toBe("display-p3");
  });
  test("a take with no colour space is sRGB, which is what every earlier take is", () => {
    expect(canvasColorSpace(anchors())).toBe("srgb");
    expect(canvasColorSpace(anchors({}, 2))).toBe("srgb");
  });
});

describe("checkCaptureColour", () => {
  test("accepts a P3 take at v9 and a take that names nothing", () => {
    expect(() => checkCaptureColour(anchors({ colorSpace: "displayP3" }))).not.toThrow();
    expect(() => checkCaptureColour(anchors())).not.toThrow();
    expect(() => checkCaptureColour(anchors({}, 2))).not.toThrow();
  });
  test("refuses a space this build cannot draw rather than reading it as sRGB", () => {
    expect(() => checkCaptureColour(anchors({ colorSpace: "adobeRGB" as never }))).toThrow(/not a space this build can draw/);
  });
  test("refuses a colour space on a version that predates it", () => {
    expect(() => checkCaptureColour(anchors({ colorSpace: "displayP3" }, 8))).toThrow(/new at anchors v9/);
    expect(() => checkCaptureColour(anchors({ colorSpace: "displayP3" }, 2))).toThrow(/new at anchors v9/);
  });
  test("the schema's enum and the loader's list are the same list", () => {
    const schema = load("schema/anchors-9.schema.json");
    expect(schema.properties.capture.properties.colorSpace.enum).toEqual([...CAPTURE_COLOR_SPACES]);
  });
});

describe("window.track on v9", () => {
  // v9 is anchors-8 plus a colour space, so a P3 window take that also MOVED carries
  // both; v8 itself still exists only for a track.
  const win = (version: Anchors["version"], track?: { t: number; x: number; y: number }[]): Anchors => ({
    ...anchors({}, version),
    scope: { kind: "window", window: { id: 1, bounds: { x: 10, y: 20, width: 100, height: 100 }, ...(track ? { track } : {}) } },
  });
  const T = [{ t: 0, x: 10, y: 20 }, { t: 1_000_000_000, x: 50, y: 20 }];
  test("a moved window on v9 loads", () => expect(() => checkWindowTrack(win(9, T))).not.toThrow());
  test("a window that never moved on v9 loads (v9 does not imply a track)", () => {
    expect(() => checkWindowTrack(win(9))).not.toThrow();
  });
  test("v8 without a track is still refused", () => expect(() => checkWindowTrack(win(8))).toThrow(/no window track/));
  test("a track on v7 is still refused", () => expect(() => checkWindowTrack(win(7, T))).toThrow(/new at anchors v8/));
});

describe("anchors-9 schema", () => {
  const validate = new Ajv({ allErrors: true, strict: true }).compile(load("schema/anchors-9.schema.json"));
  const doc = (over: object = {}) => ({ ...structuredClone(anchors({ colorSpace: "displayP3" })), ...over }) as any;

  test("a P3 take validates", () => expect(validate(doc()), JSON.stringify(validate.errors)).toBe(true));
  test("a take that names no colour space validates (absence is sRGB)", () => {
    expect(validate({ ...structuredClone(anchors()) }), JSON.stringify(validate.errors)).toBe(true);
  });
  test("an unknown colour space is refused, and so is an explicit srgb (absence is the answer)", () => {
    for (const colorSpace of ["adobeRGB", "srgb", "sRGB", ""]) {
      const d = doc(); d.capture.colorSpace = colorSpace;
      expect(validate(d), colorSpace).toBe(false);
    }
  });
  test("anchors-8 refuses a colour space (new at 9)", () => {
    const v8 = new Ajv({ allErrors: true, strict: true }).compile(load("schema/anchors-8.schema.json"));
    const d = doc(); d.version = 8;
    expect(v8(d)).toBe(false);
  });
});
