import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "../src/render.js";
import { tickTimeNs } from "../src/time.js";
import type { Project, Session } from "../src/types.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const base = (): Session => ({
  anchors: load("fixtures/basic/anchors.json"),
  events: load("fixtures/basic/events.json").events,
  frames: load("fixtures/basic/frames.json"),
});
const project = (): Project => load("fixtures/basic/project.json");
const withKeys = (): Session => ({ ...base(), keys: [
  { t: tickTimeNs(120), kind: "key", key: "ArrowDown", mods: [] },
  { t: tickTimeNs(130), kind: "key", key: "ArrowDown", mods: [] },
] });

describe("render's keycast (STC-419)", () => {
  test("a take with no keys renders keycast: null", () => {
    expect(render(project(), base(), tickTimeNs(125)).keycast).toBeNull();
  });
  test("a take with keys shows the current one, with its count", () => {
    expect(render(project(), withKeys(), tickTimeNs(135)).keycast).toEqual({ label: "↓", count: 2, opacity: 1 });
  });
  test("show:false hides it — and render() is what BOTH sinks call, so the export hides it too (Review Focus 4)", () => {
    expect(render({ ...project(), keycast: { show: false } }, withKeys(), tickTimeNs(135)).keycast).toBeNull();
  });
  test("keys change nothing else in the frame", () => {
    const a = render(project(), base(), tickTimeNs(135));
    const b = render(project(), withKeys(), tickTimeNs(135));
    expect({ ...b, keycast: null }).toEqual(a);
  });
});
