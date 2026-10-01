import { describe, expect, test } from "vitest";
import { recordTimeProject } from "../src/take-project.js";
import { parseProject, projectForWrite } from "../../transform/src/trim.js";
import { TRANSFORM_VERSION } from "../../transform/src/transform-version.js";

describe("recordTimeProject (STC-420)", () => {
  test("show clicks ON is the default and writes nothing", () => {
    expect(recordTimeProject({ showClicks: true })).toBeNull();
  });

  test("OFF writes a seed that parseProject turns into a full project", () => {
    const doc = JSON.parse(recordTimeProject({ showClicks: false })!);
    const p = parseProject(doc, 1920, 1080, 5e9);
    expect(p.showClicks).toBe(false);
    // everything the seed does not say is the parser's answer, not ours
    expect(p.output).toEqual({ fps: 60, width: 1920, height: 1080 });
    expect(p.cursor).toEqual({ style: "default", scale: 1 });
    expect(p.transform).toEqual({ version: TRANSFORM_VERSION });
  });

  test("the editor's first save turns the seed into a v13 document that keeps the choice", () => {
    const doc = JSON.parse(recordTimeProject({ showClicks: false })!);
    const out = projectForWrite(parseProject(doc, 1920, 1080, 5e9), 5e9);
    expect(out.version).toBe(13);
    expect(out.showClicks).toBe(false);
  });
});
