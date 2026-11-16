import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseShot, type Shot } from "@transform/shot";
import { applyLook } from "@transform/backgrounds";
import { decorationForMode, PRESET_PADDING_PCT } from "@transform/still-decorate";
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from "@transform/still-export";
import { planStill } from "@transform/still-plan";
import { captureLook, WINDOW_SHOT_LOOKS, type WindowShotLook } from "../src/window-look";

/**
 * STC-675: the panel's export of a FRESH window shot is the size the still
 * editor's is, with the look's margin and shadow.
 *
 * A fresh shot is built by the same code a capture writes it with
 * (`captureLook` → `applyLook`, as `main.ts`'s `captureStill` does), on the
 * window fixture. Such a document carries no `paddingPct` and no `shadow`.
 *
 * The panel passes the STORED shot to `planStill` (`thumbnail-renderer.ts`'s
 * `draw` through `composeStill`, and `runExport` directly). The still editor
 * draws the document its preset fill describes, which is also what the
 * Library thumbnail has always shown. Those two must come out the same size.
 * On the code before STC-675 the panel came out at the window's own size.
 */
const ROOT = join(__dirname, "..", "..");
const fixture = parseShot(JSON.parse(readFileSync(join(ROOT, "fixtures", "shot-window", "shot.json"), "utf8")));

function freshShot(look: WindowShotLook): Shot {
  const { write } = captureLook(look, null, { file: "wallpaper.jpg" });
  return parseShot({ ...fixture, decoration: applyLook(fixture.decoration, write) });
}

/** What the still editor and the Library draw: the mode's presets filled in. */
function editorShot(shot: Shot): Shot {
  return parseShot({ ...shot, decoration: decorationForMode(shot.decoration.mode, shot.decoration) });
}

const SCALES: ExportOptions[] = [
  { ...DEFAULT_EXPORT_OPTIONS, scale: "native" },
  { ...DEFAULT_EXPORT_OPTIONS, scale: "1x" },
];

describe("planStill: the panel's export of a fresh window shot (STC-675)", () => {
  for (const { value: look, label } of WINDOW_SHOT_LOOKS) {
    for (const options of SCALES) {
      it(`${label}, ${options.scale}: the panel's size is the still editor's`, () => {
        const shot = freshShot(look);
        const panel = planStill(shot, options).plan;
        const editor = planStill(editorShot(shot), options).plan;
        expect(panel.layout.canvas).toEqual(editor.layout.canvas);
        expect(panel.layout.content).toEqual(editor.layout.content);
        expect(Boolean(panel.layout.shadow)).toBe(Boolean(editor.layout.shadow));
        expect(panel.layout.background).toEqual(editor.layout.background);
        expect(panel.alpha).toBe(editor.alpha);
      });
    }

    it(`${label}: the look's margin and shadow are there`, () => {
      const shot = freshShot(look);
      const { layout } = planStill(shot, { ...DEFAULT_EXPORT_OPTIONS, scale: "native" }).plan;
      const mode = shot.decoration.mode;
      if (mode === "window-only") {
        // Just the window: no margin preset, no shadow. Control for the rest.
        expect(PRESET_PADDING_PCT[mode]).toBe(0);
        expect(layout.canvas).toEqual({ width: fixture.frame.width, height: fixture.frame.height });
        expect(layout.shadow).toBeUndefined();
      } else {
        expect(layout.canvas.width).toBeGreaterThan(fixture.frame.width);
        expect(layout.canvas.height).toBeGreaterThan(fixture.frame.height);
        expect(layout.shadow).toBeDefined();
      }
    });
  }

  it("an older Capture-background shot with no stored background gets Clean, as in the editor", () => {
    // Real shots from 2026-11-03 carry `window-shadow-background` and no
    // `background` key; before STC-675 the panel drew them on transparency.
    const shot = parseShot({ ...fixture, decoration: { ...fixture.decoration, mode: "window-shadow-background" } });
    const opts = { ...DEFAULT_EXPORT_OPTIONS, scale: "native" as const };
    const panel = planStill(shot, opts).plan;
    expect(panel.layout.background).toBeDefined();
    expect(panel.alpha).toBe(false);
    expect(panel.layout.canvas).toEqual(planStill(editorShot(shot), opts).plan.layout.canvas);
  });

  it("explicit values in the document still win over the presets", () => {
    const shot = freshShot("window-shadow");
    const tight = parseShot({ ...shot, decoration: { ...shot.decoration, paddingPct: 0,
      shadow: { offsetX: 0, offsetY: 0, blur: 0, spread: 0, opacity: 0.5 } } });
    const { layout } = planStill(tight, { ...DEFAULT_EXPORT_OPTIONS, scale: "native" }).plan;
    expect(layout.canvas).toEqual({ width: fixture.frame.width, height: fixture.frame.height });
  });
});
