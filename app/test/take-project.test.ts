import { describe, expect, test } from "vitest";
import { recordTimeProject, defaultStyleForTake } from "../src/take-project.js";
import { DEFAULT_PIP_STYLE, type PipStyle } from "@transform/pip-style.js";
import { wallpaperFraming } from "@transform/framing.js";
import { parseProject, projectForWrite } from "../../transform/src/trim.js";
import { TRANSFORM_VERSION } from "../../transform/src/transform-version.js";

describe("recordTimeProject (STC-420)", () => {
  test("show clicks ON is the default and writes nothing", () => {
    expect(recordTimeProject({ showClicks: true, pipStyle: null })).toBeNull();
  });

  test("OFF writes a seed that parseProject turns into a full project", () => {
    const doc = JSON.parse(recordTimeProject({ showClicks: false, pipStyle: null })!);
    const p = parseProject(doc, 1920, 1080, 5e9);
    expect(p.showClicks).toBe(false);
    // everything the seed does not say is the parser's answer, not ours
    expect(p.output).toEqual({ fps: 60, width: 1920, height: 1080 });
    expect(p.cursor).toEqual({ style: "default", scale: 1 });
    expect(p.transform).toEqual({ version: TRANSFORM_VERSION });
  });

  test("the editor's first save turns the seed into a v13 document that keeps the choice", () => {
    const doc = JSON.parse(recordTimeProject({ showClicks: false, pipStyle: null })!);
    const out = projectForWrite(parseProject(doc, 1920, 1080, 5e9), 5e9);
    expect(out.version).toBe(13);
    expect(out.showClicks).toBe(false);
  });
});

const CIRCLE: PipStyle = { ...DEFAULT_PIP_STYLE, shape: "circle", shadow: true };

describe("the PiP default seeds a take (STC-461)", () => {
  test("default style or camera off: nothing (Review Focus 4)", () => {
    expect(defaultStyleForTake(DEFAULT_PIP_STYLE, true)).toBeNull();
    expect(defaultStyleForTake(CIRCLE, false)).toBeNull();
    expect(recordTimeProject({ showClicks: true, pipStyle: null })).toBeNull();
  });
  test("a non-default style with the camera on seeds a v16 pip, never a framing", () => {
    const style = defaultStyleForTake({ ...CIRCLE, framing: { x: 0.3, y: 0.5, zoom: 2 } }, true)!;
    expect(style.framing).toBeUndefined();
    const doc = JSON.parse(recordTimeProject({ showClicks: true, pipStyle: style })!);
    expect(doc.version).toBe(16);
    expect(doc.pip).toEqual({ enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32, style });
    expect(doc.showClicks).toBeUndefined();
  });
  test("both choices together keep both, at v16", () => {
    const doc = JSON.parse(recordTimeProject({ showClicks: false, pipStyle: CIRCLE })!);
    expect(doc).toMatchObject({ version: 16, showClicks: false });
    expect(doc.pip.style.shape).toBe("circle");
  });
  test("show-clicks alone is byte-for-byte what it was", () => {
    expect(recordTimeProject({ showClicks: false, pipStyle: null }))
      .toBe(JSON.stringify({ version: 13, showClicks: false }, null, 2) + "\n");
  });
});

describe("recordTimeProject's framing (STC-626)", () => {
  const base = { showClicks: true, pipStyle: null };
  const seed = (over: object) => JSON.parse(recordTimeProject({ ...base, ...over } as any)!);

  test("no look and clicks on still writes nothing", () => {
    expect(recordTimeProject({ ...base, framing: null })).toBeNull();
  });
  test("a fill is a v15 seed", () => {
    const framing = { preset: "clean", background: { kind: "solid", color: "#ffffff" } };
    expect(seed({ framing })).toEqual({ version: 15, framing });
  });
  test("a look of more than two stops is v21", () => {
    const framing = { preset: "clean", background: { kind: "linear", colors: ["#111111", "#222222", "#333333"], angleDeg: 135 } };
    expect(seed({ framing }).version).toBe(21);
  });
  test("wallpaper is v22", () => {
    expect(seed({ framing: { preset: "clean", background: wallpaperFraming() } }).version).toBe(22);
  });
  test("the highest choice sets the version and every choice is kept", () => {
    const framing = { preset: "clean", background: wallpaperFraming() };
    const doc = seed({ framing, pipStyle: DEFAULT_PIP_STYLE, showClicks: false });
    expect(doc.version).toBe(22);
    expect(doc.showClicks).toBe(false);
    expect(doc.pip.style).toEqual(DEFAULT_PIP_STYLE);
    expect(doc.framing).toEqual(framing);
  });
  test("a fill with clicks off stays v15, carrying both", () => {
    const framing = { preset: "clean", background: { kind: "solid", color: "#ffffff" } };
    expect(seed({ framing, showClicks: false })).toEqual({ version: 15, showClicks: false, framing });
  });
  test("parseProject takes the seed's framing", () => {
    const framing = { preset: "clean", background: wallpaperFraming() };
    expect(parseProject(seed({ framing }), 1920, 1080, 5e9).framing).toEqual(framing);
  });
});
