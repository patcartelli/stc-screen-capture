import { describe, expect, test } from "vitest";
import { recordTimeProject, defaultStyleForTake } from "../src/take-project.js";
import { DEFAULT_PIP_STYLE, type PipStyle } from "@transform/pip-style.js";
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
  test("a non-default style with the camera on seeds a v15 pip, never a framing", () => {
    const style = defaultStyleForTake({ ...CIRCLE, framing: { x: 0.3, y: 0.5, zoom: 2 } }, true)!;
    expect(style.framing).toBeUndefined();
    const doc = JSON.parse(recordTimeProject({ showClicks: true, pipStyle: style })!);
    expect(doc.version).toBe(15);
    expect(doc.pip).toEqual({ enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32, style });
    expect(doc.showClicks).toBeUndefined();
  });
  test("both choices together keep both, at v15", () => {
    const doc = JSON.parse(recordTimeProject({ showClicks: false, pipStyle: CIRCLE })!);
    expect(doc).toMatchObject({ version: 15, showClicks: false });
    expect(doc.pip.style.shape).toBe("circle");
  });
  test("show-clicks alone is byte-for-byte what it was", () => {
    expect(recordTimeProject({ showClicks: false, pipStyle: null }))
      .toBe(JSON.stringify({ version: 13, showClicks: false }, null, 2) + "\n");
  });
});
