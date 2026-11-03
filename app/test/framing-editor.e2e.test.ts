import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { CUSTOM_ANGLE_DEG, CUSTOM_START_COLOR } from "../../transform/src/backgrounds.js";
import { DARK_SHADOW_OPACITY, LOOK_FILLS } from "../../transform/src/looks.js";

/**
 * The Frame section's Background looks (STC-396, STC-604, STC-608): the still
 * editor's swatch grid (`#framelooks`, look-grid.ts) in the inspector pane,
 * None first and Custom last. Asserts: None is checked on an unframed take; a
 * look writes `project.json` with the look's own colours (Aurora's three stops
 * need project-20) and repaints the preview; None removes `framing` again;
 * padding, corners and shadow wait for a frame and survive a look change;
 * Custom shows its colour row, writes one colour as a solid and two as a
 * linear, and marks a bad value `aria-invalid` without writing it; the grid is
 * ONE tab stop that the arrow keys, Home and End move across without picking.
 *
 * Every write is polled on DISK first and the DOM after it (STC-514):
 * setFraming writes before updateFramingUI redraws, so a one-shot DOM read
 * right after a disk poll races the redraw.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readProject = (takeDir: string): any => {
  try { return JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8")); } catch { return undefined; }
};

const look = (id: string) => `#framelooks [data-look="${id}"]`;
const checkedLook = (page: Page) => page.getAttribute(`#framelooks [aria-checked="true"]`, "data-look");
const focusedLook = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.look);
const tabStops = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>("#framelooks [role=radio]")]
    .filter((el) => el.getAttribute("tabindex") === "0").map((el) => el.dataset.look));

/** The stage's bottom-right pixel: inside the frame's padding once there is one. */
const cornerPixel = (page: Page) => page.evaluate(() => {
  const c = document.getElementById("stage") as HTMLCanvasElement;
  return [...c.getContext("2d")!.getImageData(c.width - 2, c.height - 2, 1, 1).data.slice(0, 3)];
});
const hexRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const distance = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

describe("the Frame section's Background looks (STC-608)", () => {
  test("defaults to None, frames on a look, and clears again", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    await editorWin.waitForSelector(look("none"));
    expect(await checkedLook(editorWin)).toBe("none");
    expect(await editorWin.isHidden("#framecustomrow")).toBe(true);
    expect(await editorWin.textContent("#legibility")).not.toMatch(/inside the frame/);

    // Aurora: three stops, so the document is project-20; it rides on `clean`.
    const aurora = LOOK_FILLS.aurora;
    if (aurora.kind !== "linear") throw new Error("Aurora is a linear fill");
    await editorWin.click(look("aurora"));
    await expect.poll(() => readProject(takeDir)?.framing, { timeout: 10_000 })
      .toEqual({ preset: "clean", background: aurora });
    expect(readProject(takeDir).version).toBe(20);
    await expect.poll(() => checkedLook(editorWin), { timeout: 10_000 }).toBe("aurora");
    await expect.poll(() => editorWin.textContent("#legibility"), { timeout: 10_000 }).toMatch(/inside the frame/);
    // The preview repaints with it: the gradient's last stop sits in the far corner.
    await expect.poll(async () => distance(await cornerPixel(editorWin), hexRgb(aurora.colors[2]!)),
                      { timeout: 10_000 }).toBeLessThan(60);

    await editorWin.click(look("none"));
    await expect.poll(() => readProject(takeDir)?.framing, { timeout: 10_000 }).toBeUndefined();
    await expect.poll(() => checkedLook(editorWin), { timeout: 10_000 }).toBe("none");
  }, 120_000);

  test("padding, corners and shadow wait for a frame and survive a look change", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    for (const id of ["#framepadding", "#frameradius", "#frameshadow"]) expect(await editorWin.isDisabled(id)).toBe(true);

    await editorWin.click(look("clean"));
    await expect.poll(() => editorWin.isEnabled("#framepadding"), { timeout: 10_000 }).toBe(true);
    const setRange = (id: string, v: number) => editorWin.evaluate(([i, val]) => {
      const el = document.getElementById(i as string) as HTMLInputElement;
      el.value = String(val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, [id, v]);
    await setRange("framepadding", 10);
    await expect.poll(() => readProject(takeDir)?.framing?.paddingPct, { timeout: 10_000 }).toBeCloseTo(0.1, 5);
    expect(await editorWin.textContent("#framepadding-out")).toBe("10%");
    await setRange("frameradius", 3);
    await expect.poll(() => readProject(takeDir)?.framing?.radiusPct, { timeout: 10_000 }).toBeCloseTo(0.03, 5);

    await editorWin.uncheck("#frameshadow");
    await expect.poll(() => readProject(takeDir)?.framing?.shadow?.opacity, { timeout: 10_000 }).toBe(0);
    await editorWin.check("#frameshadow");
    await expect.poll(() => readProject(takeDir)?.framing?.shadow, { timeout: 10_000 }).toBeUndefined();

    // The numbers are the user's: a look change keeps them, and Dark brings its deeper shadow.
    await editorWin.click(look("dark"));
    await expect.poll(() => readProject(takeDir)?.framing?.preset, { timeout: 10_000 }).toBe("dark");
    const f = readProject(takeDir).framing;
    expect(f.paddingPct).toBeCloseTo(0.1, 5);
    expect(f.radiusPct).toBeCloseTo(0.03, 5);
    expect(f.background).toEqual(LOOK_FILLS.dark);
    expect(f.shadow.opacity).toBe(DARK_SHADOW_OPACITY);
    await expect.poll(() => checkedLook(editorWin), { timeout: 10_000 }).toBe("dark");
  }, 120_000);

  test("Custom shows its colour row, writes valid colours, and marks a bad one", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    await editorWin.waitForSelector(look("custom"));
    expect(await editorWin.isHidden("#framecustomrow")).toBe(true);

    // A Custom pick starts on the still editor's starting colour, as a solid.
    await editorWin.click(look("custom"));
    await expect.poll(() => readProject(takeDir)?.framing?.background, { timeout: 10_000 })
      .toEqual({ kind: "solid", color: CUSTOM_START_COLOR });
    await expect.poll(() => editorWin.isVisible("#framecustomrow"), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => checkedLook(editorWin), { timeout: 10_000 }).toBe("custom");

    // One colour is a solid; the write is on the field's commit (Tab blurs it).
    await editorWin.fill("#framecustoma", "#112233");
    await editorWin.press("#framecustoma", "Tab");
    await expect.poll(() => readProject(takeDir)?.framing?.background, { timeout: 10_000 })
      .toEqual({ kind: "solid", color: "#112233" });

    // A second colour makes it a linear fill at the Custom angle.
    await expect.poll(() => editorWin.inputValue("#framecustoma"), { timeout: 10_000 }).toBe("#112233");
    await editorWin.fill("#framecustomb", "#445566");
    await editorWin.press("#framecustomb", "Tab");
    await expect.poll(() => readProject(takeDir)?.framing?.background, { timeout: 10_000 })
      .toEqual({ kind: "linear", colors: ["#112233", "#445566"], angleDeg: CUSTOM_ANGLE_DEG });
    await expect.poll(() => checkedLook(editorWin), { timeout: 10_000 }).toBe("custom");

    // A bad value is marked and never reaches the document.
    await expect.poll(() => editorWin.inputValue("#framecustomb"), { timeout: 10_000 }).toBe("#445566");
    const before = readFileSync(join(takeDir, "project.json"), "utf8");
    await editorWin.fill("#framecustoma", "zz");
    await editorWin.press("#framecustoma", "Tab");
    await expect.poll(() => editorWin.getAttribute("#framecustoma", "aria-invalid"), { timeout: 10_000 }).toBe("true");
    await sleep(750);   // longer than a write takes to land; there must be none
    expect(readFileSync(join(takeDir, "project.json"), "utf8")).toBe(before);
    expect(await checkedLook(editorWin)).toBe("custom");
  }, 180_000);

  test("the look grid is one tab stop and arrows move", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    await editorWin.waitForSelector(look("none"));
    expect(await tabStops(editorWin)).toEqual(["none"]);

    // The Frame tab comes straight before its panel: one Tab lands on the checked swatch.
    await editorWin.focus("#tab-frame");
    await editorWin.keyboard.press("Tab");
    expect(await focusedLook(editorWin)).toBe("none");

    // Arrows, End and Home move the focus and the one tab stop; they never pick.
    for (const [key, to] of [["ArrowRight", "clean"], ["End", "custom"], ["Home", "none"], ["ArrowLeft", "custom"]] as const) {
      await editorWin.keyboard.press(key);
      expect(await focusedLook(editorWin)).toBe(to);
      expect(await tabStops(editorWin)).toEqual([to]);
    }
    expect(await checkedLook(editorWin)).toBe("none");
    expect(readProject(takeDir)?.framing).toBeUndefined();
  }, 120_000);
});
