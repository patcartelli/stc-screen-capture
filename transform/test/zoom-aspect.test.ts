import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { render } from "../src/render.js";
import { defaultProject } from "../src/trim.js";
import type { Project, Session, SessionEvent, ZoomOverride } from "../src/types.js";

/**
 * STC-629: no zoom block may stretch the picture.
 *
 * The compositor stretches `zoom.crop` (UV over the capture) to fill a
 * frame-shaped output, so the picture keeps its proportions exactly when the
 * crop's UV width equals its UV height. This holds every block kind to that,
 * at every tick across its window, with a deliberately odd-shaped rect on
 * every kind that carries one: a rect saved before STC-629 can be any shape,
 * and render() is what has to widen it.
 *
 * `CASES` is keyed by the override kind, so a new kind in `types.ts` does not
 * typecheck until it has a row here, and the schema check below fails if the
 * latest project schema gains a kind this file has never heard of.
 */

const MS = 1_000_000;
const S = 1000 * MS;
const ODD = { x: 0.1, y: 0.2, width: 0.5, height: 0.25 };

// A click at 2 s opens a derived window [1.7 s, 4.5 s]; the pointer then
// travels, so a following block actually moves.
const events: SessionEvent[] = [
  { t: 2000 * MS, kind: "down", x: 480, y: 540, button: 0 },
  { t: 2050 * MS, kind: "up", x: 700, y: 600, button: 0 },
  { t: 3000 * MS, kind: "move", x: 1700, y: 300 },
];
const WINDOW_ID = String(1700 * MS);

const session = {
  anchors: {
    version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
    display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920,
               pixelHeight: 1080, backingScale: 1, originX: 0, originY: 0 },
    capture: { width: 1920, height: 1080, codec: "h264", firstFrameNs: 0 },
    files: { display: "display.mp4" }, stop: { t: 8 * S, reason: "user" },
  },
  events, frames: [0, 16_000_000, 32_000_000],
} as unknown as Session;

const manual = (follow: boolean): ZoomOverride => ({
  kind: "manual", id: "m1", startNs: 5 * S, endNs: 7 * S, rect: ODD, easing: "standard",
  ...(follow ? { follow: true as const } : {}),
});

const CASES: Record<ZoomOverride["kind"], Record<string, ZoomOverride[]>> = {
  geometry: {
    "a drawn region": [{ kind: "geometry", windowId: WINDOW_ID, rect: ODD }],
    "a drawn region that follows the cursor": [{ kind: "geometry", windowId: WINDOW_ID, rect: ODD, follow: true }],
  },
  manual: {
    "a manual block": [manual(false)],
    "a manual block that follows the cursor": [manual(true)],
  },
  removed: {
    "a removed Auto block": [{ kind: "removed", windowId: WINDOW_ID }],
  },
  retime: {
    "a retimed Auto block": [{ kind: "retime", windowId: WINDOW_ID, endNs: 5 * S }],
  },
};

const rows: [string, ZoomOverride[]][] = [
  ["an Auto block (stage 2's region)", []],
  ...Object.values(CASES).flatMap((byName) => Object.entries(byName)),
];

describe("every zoom block renders at the frame's proportions (STC-629)", () => {
  test.each(rows)("%s", (_name, overrides) => {
    const project: Project = { ...defaultProject(1920, 1080), overrides };
    let zoomed = false;
    for (let t = 0; t <= 8 * S; t += 20 * MS) {
      const { crop, amount } = render(project, session, t).zoom;
      if (amount > 0.5 && crop.width < 0.99) zoomed = true;
      expect(crop.width, `t = ${t / MS} ms`).toBeCloseTo(crop.height, 9);
    }
    // A row that never zooms proves nothing about the shape (the removed
    // block is the one row that must not zoom inside its window, and still
    // zooms nowhere else, so it is exempt).
    if (!overrides.some((o) => o.kind === "removed")) expect(zoomed).toBe(true);
  });

  test("the latest project schema has no override kind this file is missing", () => {
    const dir = join(__dirname, "..", "..", "schema");
    const latest = Math.max(...readdirProjectVersions(dir));
    const text = readFileSync(join(dir, `project-${latest}.schema.json`), "utf8");
    const json = JSON.parse(text);
    const variants: any[] = json.properties.overrides.items.oneOf ?? json.properties.overrides.items.anyOf;
    const kinds = variants.map((v) => v.properties.kind.const).sort();
    expect(kinds).toEqual(Object.keys(CASES).sort());
  });
});

function readdirProjectVersions(dir: string): number[] {
  return readdirSync(dir)
    .map((f) => /^project-(\d+)\.schema\.json$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
}
