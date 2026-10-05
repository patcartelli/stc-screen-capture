import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "../src/render.js";
import { tickTimeNs } from "../src/time.js";
import type { Project, Session } from "../src/types.js";

/**
 * STC-492: the editor's Clicks switch writes project.showClicks, and
 * render() — which both sinks call — hands it to the compositor.
 */
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const session = (): Session => ({
  anchors: load("fixtures/basic/anchors.json"),
  events: load("fixtures/basic/events.json").events,
  frames: load("fixtures/basic/frames.json"),
});
const project = (): Project => load("fixtures/basic/project.json");

describe("render's showClicks (STC-492)", () => {
  const t = tickTimeNs(125);
  test("absent means on", () => {
    expect(render(project(), session(), t).cursor.showClicks).toBe(true);
  });
  test("the editor's switch flips what the compositor is handed, both ways", () => {
    const off = render({ ...project(), showClicks: false }, session(), t);
    const on = render({ ...project(), showClicks: true }, session(), t);
    expect(off.cursor.showClicks).toBe(false);
    expect(on.cursor.showClicks).toBe(true);
  });
  test("it changes nothing else in the frame", () => {
    const a = render(project(), session(), t);
    const b = render({ ...project(), showClicks: false }, session(), t);
    expect({ ...b, cursor: { ...b.cursor, showClicks: true } }).toEqual(a);
  });
});
