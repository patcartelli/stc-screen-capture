import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PreviewController, previewLine, previewTransition, previewWanted, thirdsLines,
  PREVIEW_EXTRA_HEIGHT, PREVIEW_TILE_HEIGHT, PREVIEW_TILE_MARGIN_BOTTOM, PREVIEW_TILE_MARGIN_TOP,
  PREVIEW_TILE_WIDTH, type PreviewPort,
} from "../src/camera-preview.js";
import { barLayout, menuAnchor, menuHeight } from "../src/record-options.js";
import type { DisplayInfo } from "../src/selection.js";

/**
 * STC-638's app-side decisions: when the camera menu's live view starts and
 * stops, who may speak after whom, what the empty tile says, and the geometry the
 * menu and the CSS must agree on. No Electron, no helper.
 */

const open = { openMenu: "camera", camera: true, cameraDeviceUid: null as string | null };

describe("when a preview is wanted (rule 1)", () => {
  test("the camera menu open with the camera on", () => {
    expect(previewWanted(open)).toEqual({ uid: null });
    expect(previewWanted({ ...open, cameraDeviceUid: "abc" })).toEqual({ uid: "abc" });
  });
  test("not with another menu open, no menu, or the camera Off", () => {
    expect(previewWanted({ ...open, openMenu: "mic" })).toBeNull();
    expect(previewWanted({ ...open, openMenu: null })).toBeNull();
    expect(previewWanted({ ...open, camera: false })).toBeNull();
  });
});

describe("the transition (rule 2)", () => {
  const A = { uid: "a" }, B = { uid: "b" }, auto = { uid: null };
  test.each([
    [null, null, "none"],
    [null, A, "start"],
    [A, null, "stop"],
    [A, A, "none"],
    [A, B, "start"],       // a pick of another device restarts on it
    [A, auto, "start"],
    [auto, auto, "none"],
  ] as const)("%j -> %j is %s", (asked, want, expected) => {
    expect(previewTransition(asked, want)).toBe(expected);
  });
});

describe("what the empty tile says", () => {
  test("every reason is a sentence, never a raw code", () => {
    expect(previewLine({ kind: "starting" })).toBe("Starting camera…");
    expect(previewLine({ kind: "live" })).toBe("");
    expect(previewLine({ kind: "off" })).toBe("");
    expect(previewLine({ kind: "unavailable", code: "camera-not-authorized" })).toBe("Camera access is off");
    expect(previewLine({ kind: "unavailable", code: "camera-not-found" })).toBe("Camera not found");
    expect(previewLine({ kind: "unavailable", code: "camera-no-device" })).toBe("No camera available");
    expect(previewLine({ kind: "unavailable", code: "bad-state" })).toBe("Camera is in use");
    expect(previewLine({ kind: "unavailable", code: "device-lost" })).toBe("Camera disconnected");
    expect(previewLine({ kind: "unavailable", code: "something-new" })).toBe("Camera unavailable");
  });
});

/** A port whose start/stop the test settles by hand. */
function fakePort() {
  const starts: { uid: string | null; ok: () => void; fail: (code: string) => void }[] = [];
  let stops = 0;
  const port: PreviewPort = {
    start: (uid) => new Promise<void>((ok, rej) => {
      starts.push({ uid, ok, fail: (code) => rej(Object.assign(new Error(code), { code })) });
    }),
    stop: () => { stops++; return Promise.resolve(); },
  };
  return { port, starts, stops: () => stops };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PreviewController (rules 2-5)", () => {
  test("starting until a PICTURE arrives, not until the helper answers (rule 3)", async () => {
    const f = fakePort(); let changes = 0;
    const c = new PreviewController(f.port, () => changes++);
    c.sync({ uid: null });
    expect(c.view).toEqual({ kind: "starting" });
    f.starts[0]!.ok(); await tick();
    expect(c.view).toEqual({ kind: "starting" });   // running, but nothing to show yet
    expect(c.frame()).toBe(true);
    expect(c.view).toEqual({ kind: "live" });
    expect(changes).toBe(2);
  });

  test("sync is idempotent: the same want asks the helper once", () => {
    const f = fakePort();
    const c = new PreviewController(f.port, () => {});
    c.sync({ uid: "a" }); c.sync({ uid: "a" }); c.sync({ uid: "a" });
    expect(f.starts).toHaveLength(1);
  });

  test("a different device restarts on it", () => {
    const f = fakePort();
    const c = new PreviewController(f.port, () => {});
    c.sync({ uid: "a" }); c.sync({ uid: "b" });
    expect(f.starts.map((s) => s.uid)).toEqual(["a", "b"]);
  });

  test("closing the menu stops it, and a frame after the stop is dropped (rule 4)", () => {
    const f = fakePort();
    const c = new PreviewController(f.port, () => {});
    c.sync({ uid: null });
    c.frame();
    c.sync(null);
    expect(f.stops()).toBe(1);
    expect(c.view).toEqual({ kind: "off" });
    expect(c.frame()).toBe(false);
  });

  test("a refusal that lands after the menu closed does not resurrect a view (rule 4)", async () => {
    const f = fakePort();
    const c = new PreviewController(f.port, () => {});
    c.sync({ uid: null });
    c.sync(null);
    f.starts[0]!.fail("camera-not-authorized"); await tick();
    expect(c.view).toEqual({ kind: "off" });
  });

  test("a refusal from the old device does not overwrite the new one's start (rule 4)", async () => {
    const f = fakePort();
    const c = new PreviewController(f.port, () => {});
    c.sync({ uid: "a" }); c.sync({ uid: "b" });
    f.starts[0]!.fail("camera-not-found"); await tick();
    expect(c.view).toEqual({ kind: "starting" });
  });

  test("a refusal is shown and NOT retried until the want changes (rule 5)", async () => {
    const f = fakePort();
    const c = new PreviewController(f.port, () => {});
    c.sync({ uid: null });
    f.starts[0]!.fail("camera-not-authorized"); await tick();
    expect(c.view).toEqual({ kind: "unavailable", code: "camera-not-authorized" });
    c.sync({ uid: null }); c.sync({ uid: null });
    expect(f.starts).toHaveLength(1);
    expect(c.frame()).toBe(false);
    c.sync({ uid: "other" });                       // the want changed: try again
    expect(f.starts).toHaveLength(2);
  });

  test("an error with no code is a generic one", async () => {
    const f = fakePort();
    const c = new PreviewController({ start: () => Promise.reject(new Error("boom")), stop: f.port.stop }, () => {});
    c.sync({ uid: null }); await tick();
    expect(c.view).toEqual({ kind: "unavailable", code: "camera-failed" });
  });

  test("the camera unplugged: unavailable, and not retried", () => {
    const f = fakePort();
    const c = new PreviewController(f.port, () => {});
    c.sync({ uid: null }); c.frame();
    c.stopped("device-lost");
    expect(c.view).toEqual({ kind: "unavailable", code: "device-lost" });
    c.sync({ uid: null });
    expect(f.starts).toHaveLength(1);
  });

  test("the helper's own timeout forgets the preview so the open menu starts it again", () => {
    const f = fakePort();
    const c = new PreviewController(f.port, () => {});
    c.sync({ uid: null }); c.frame();
    c.stopped("timeout");
    expect(c.view).toEqual({ kind: "off" });
    c.sync({ uid: null });
    expect(f.starts).toHaveLength(2);
  });

  test("a stop nobody asked for is ignored when nothing is wanted", () => {
    const f = fakePort(); let changes = 0;
    const c = new PreviewController(f.port, () => changes++);
    c.stopped("take-started");
    expect(changes).toBe(0);
    expect(c.view).toEqual({ kind: "off" });
  });

  test("close stops a running preview and is safe twice", () => {
    const f = fakePort();
    const c = new PreviewController(f.port, () => {});
    c.sync({ uid: null });
    c.close(); c.close();
    expect(f.stops()).toBe(1);
  });

  test("a failing stop does not throw out of sync", () => {
    const c = new PreviewController({ start: () => Promise.resolve(), stop: () => Promise.reject(new Error("x")) }, () => {});
    c.sync({ uid: null });
    expect(() => c.sync(null)).not.toThrow();
  });
});

describe("thirds guides", () => {
  test("two vertical and two horizontal lines at a third and two thirds", () => {
    const l = thirdsLines(300, 150);
    expect(l).toEqual([
      { x1: 100, y1: 0, x2: 100, y2: 150 }, { x1: 200, y1: 0, x2: 200, y2: 150 },
      { x1: 0, y1: 50, x2: 300, y2: 50 }, { x1: 0, y1: 100, x2: 300, y2: 100 },
    ]);
  });
});

describe("the tile's geometry: the menu, the constants and the CSS agree", () => {
  test("the extra height is the tile plus its margins", () => {
    expect(PREVIEW_EXTRA_HEIGHT).toBe(PREVIEW_TILE_HEIGHT + PREVIEW_TILE_MARGIN_TOP + PREVIEW_TILE_MARGIN_BOTTOM);
    expect(menuHeight(3, PREVIEW_EXTRA_HEIGHT)).toBe(menuHeight(3) + PREVIEW_EXTRA_HEIGHT);
  });

  test("the tile is 16:9 inside the menu's fixed 280 px with an 8 px inset", () => {
    expect(PREVIEW_TILE_WIDTH).toBe(280 - 2 * 8);
    expect(Math.abs(PREVIEW_TILE_WIDTH * 9 / 16 - PREVIEW_TILE_HEIGHT)).toBeLessThan(1);
  });

  test("overlay.html draws the tile at exactly these numbers", () => {
    const css = readFileSync(join(__dirname, "..", "renderer", "overlay.html"), "utf8");
    const rule = css.match(/\.campreview\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain(`width: ${PREVIEW_TILE_WIDTH}px`);
    expect(rule).toContain(`height: ${PREVIEW_TILE_HEIGHT}px`);
    expect(rule).toContain(`margin: ${PREVIEW_TILE_MARGIN_TOP}px 8px ${PREVIEW_TILE_MARGIN_BOTTOM}px`);
    // and the menu it sits in is the fixed width this assumes
    const menuCss = readFileSync(join(__dirname, "..", "renderer", "device-menu.css"), "utf8");
    expect(menuCss).toMatch(/\.device-menu\s*\{[^}]*width:\s*280px/);
  });

  test("the taller menu flips above where the plain one still fits below", () => {
    const display: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 2 };
    let flipsOnlyWithTile = 0;
    for (let y = 200; y <= 900; y += 10) {
      const l = barLayout({ x: 400, y, width: 400, height: 50 }, display);
      const plain = menuAnchor(l, "camera", display, 3);
      const tall = menuAnchor(l, "camera", display, 3, PREVIEW_EXTRA_HEIGHT);
      // More height can only move a menu from below to above, never back.
      if (plain.side === "above") expect(tall.side).toBe("above");
      if (plain.side === "below" && tall.side === "above") flipsOnlyWithTile++;
    }
    expect(flipsOnlyWithTile).toBeGreaterThan(0);
  });
});
