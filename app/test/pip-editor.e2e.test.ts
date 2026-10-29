import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { pipRect, PIP_SNAP_MARGIN_PX } from "../../transform/src/pip-style.js";

/**
 * The editor's Camera popover (STC-461): the shared inspector's first host and
 * the on-stage drag. `fixtures/pip` is a 640x360 capture whose project.json
 * asks for a 3840x2160 output, with a 1280x720 camera — so the sizes below are
 * READ from the take rather than written as literals.
 */

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const readJson = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const savedProject = (dir: string) => {
  try { return readJson(dir, "project.json"); } catch { return undefined; }
};
const savedPip = (dir: string) => savedProject(dir)?.pip;

describe("the editor's Camera section (STC-461, STC-604)", () => {
  test("hidden for a take with no camera", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await editorWin.isHidden("#pipbtn")).toBe(true);
  }, 120_000);

  test("the Circle preset saves a v16 circle", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    await editorWin.click("#pipbtn");
    await editorWin.click('[data-pip-preset="circle"]');
    await expect.poll(() => savedPip(takeDir)?.style?.shape, { timeout: 10_000 }).toBe("circle");
    expect(savedProject(takeDir).version).toBe(16);
  }, 120_000);

  test("dragging the PiP near the top-left corner snaps it onto the margin", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    const output = readJson(takeDir, "project.json").output as { width: number; height: number };
    const cam = readJson(takeDir, "anchors.json").camera as { width: number; height: number };
    await editorWin.click("#pipbtn");
    // The overlay shows once the Camera section is active.
    await editorWin.locator("#pipoverlay .pipbox").waitFor({ state: "visible", timeout: 10_000 });
    const box = (await editorWin.locator("#pipoverlay .pipbox").boundingBox())!;
    const stage = (await editorWin.locator("#stage").boundingBox())!;
    await editorWin.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await editorWin.mouse.down();
    // Aim a few OUTPUT pixels short of the snapped spot; the snap must finish the job.
    const scale = stage.width / output.width;
    await editorWin.mouse.move(stage.x + (PIP_SNAP_MARGIN_PX + 4) * scale + box.width / 2,
                               stage.y + (PIP_SNAP_MARGIN_PX + 3) * scale + box.height / 2, { steps: 8 });
    await editorWin.mouse.up();
    await expect.poll(() => savedPip(takeDir)?.style, { timeout: 10_000 }).toBeDefined();
    const style = savedPip(takeDir).style;
    const r = pipRect(style, { width: output.width, height: output.height }, { width: cam.width, height: cam.height });
    expect([r.x, r.y]).toEqual([PIP_SNAP_MARGIN_PX, PIP_SNAP_MARGIN_PX]);
    // STC-604: the Camera section is a pane section, not a popover. The drag
    // leaves it open and the Anchor row names the place the snap landed on.
    expect(await editorWin.evaluate(() => !document.getElementById("pippanel")!.hidden)).toBe(true);
    await expect.poll(() => editorWin.inputValue("#pipanchor"), { timeout: 5_000 }).toBe("top-left");
  }, 120_000);

  test("the Anchor row pins the PiP to a place; Snap to edges off lets a drag land between places", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    const output = readJson(takeDir, "project.json").output as { width: number; height: number };
    const cam = readJson(takeDir, "anchors.json").camera as { width: number; height: number };
    await editorWin.click("#pipbtn");
    await editorWin.selectOption("#pipanchor", "top-left");
    await expect.poll(() => savedPip(takeDir)?.style, { timeout: 10_000 }).toBeDefined();
    const at = () => pipRect(savedPip(takeDir).style, { width: output.width, height: output.height },
      { width: cam.width, height: cam.height });
    await expect.poll(() => [at().x, at().y], { timeout: 10_000 }).toEqual([PIP_SNAP_MARGIN_PX, PIP_SNAP_MARGIN_PX]);

    // Snap off: a drag a few SCREEN pixels off an anchor stays where it was
    // dropped. Done from the CENTRE anchor, away from the stage's top-left
    // corner (the first attempt, from top-left, never moved the PiP). 6 x 5
    // screen px is inside the snap threshold (12), so with snap on it would be
    // pulled back onto the anchor; `dragCenter`'s unit test holds that rule.
    await editorWin.selectOption("#pipanchor", "center");
    await expect.poll(() => editorWin.inputValue("#pipanchor"), { timeout: 10_000 }).toBe("center");
    await expect.poll(() => at().x, { timeout: 10_000 }).toBeGreaterThan(PIP_SNAP_MARGIN_PX);
    const x0 = at().x;
    const y0 = at().y;
    await editorWin.uncheck("#pipsnap");
    expect(await editorWin.isChecked("#pipsnap")).toBe(false);
    const box = (await editorWin.locator("#pipoverlay .pipbox").boundingBox())!;
    await editorWin.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await editorWin.mouse.down();
    await editorWin.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 5, { steps: 6 });
    await editorWin.mouse.up();
    await expect.poll(() => at().x, { timeout: 10_000 }).not.toBe(x0);
    expect(at().y).not.toBe(y0);
    expect(await editorWin.inputValue("#pipanchor")).toBe("");
  }, 120_000);

  test("reframe: dragging the window right moves framing.x right, and Done saves it", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    await editorWin.click("#pipbtn");
    await editorWin.click('[data-pip-preset="circle"]');
    await editorWin.click("#pipreframe");
    await editorWin.fill("#pipzoom", "2");
    await editorWin.dispatchEvent("#pipzoom", "change");
    const w = (await editorWin.locator("#pipframewindow").boundingBox())!;
    await editorWin.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
    await editorWin.mouse.down();
    await editorWin.mouse.move(w.x + w.width / 2 + 20, w.y + w.height / 2, { steps: 5 });
    await editorWin.mouse.up();
    await editorWin.click("#pipframedone");
    await expect.poll(() => savedPip(takeDir)?.style?.framing?.zoom, { timeout: 10_000 }).toBe(2);
    expect(savedPip(takeDir).style.framing.x).toBeGreaterThan(0.5);
    expect(savedPip(takeDir).style.shape).toBe("circle");
    expect(savedPip(takeDir).style.width).not.toBe(0.5);   // the temporary display style never leaked
  }, 120_000);

  test("reframe: leaving the page mid-reframe commits it rather than dropping it", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    await editorWin.click("#pipbtn");
    await editorWin.click('[data-pip-preset="circle"]');
    await expect.poll(() => savedPip(takeDir)?.style?.shape, { timeout: 10_000 }).toBe("circle");
    await editorWin.click("#pipreframe");
    await editorWin.fill("#pipzoom", "2");
    await editorWin.dispatchEvent("#pipzoom", "change");
    // No Done, no Escape: the page goes away with the reframe still open.
    await editorWin.reload();
    await expect.poll(() => savedPip(takeDir)?.style?.framing?.zoom, { timeout: 10_000 }).toBe(2);
    expect(savedPip(takeDir).style.shape).toBe("circle");
    expect(savedPip(takeDir).style.width).not.toBe(0.5);   // the temporary display style never leaked
  }, 120_000);
});
