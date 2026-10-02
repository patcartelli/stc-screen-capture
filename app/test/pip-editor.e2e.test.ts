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

describe("the editor's Camera popover (STC-461)", () => {
  test("hidden for a take with no camera", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await editorWin.isHidden("#pipbtn")).toBe(true);
  }, 120_000);

  test("the Circle preset saves a v15 circle", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    await editorWin.click("#pipbtn");
    await editorWin.click('[data-pip-preset="circle"]');
    await expect.poll(() => savedPip(takeDir)?.style?.shape, { timeout: 10_000 }).toBe("circle");
    expect(savedProject(takeDir).version).toBe(15);
  }, 120_000);

  test("dragging the PiP near the top-left corner snaps it onto the margin", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    const output = readJson(takeDir, "project.json").output as { width: number; height: number };
    const cam = readJson(takeDir, "anchors.json").camera as { width: number; height: number };
    await editorWin.click("#pipbtn");
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
    // The drag must not cost the person the inspector (light dismiss is re-opened).
    await expect.poll(() => editorWin.evaluate(() => document.getElementById("pippanel")!.matches(":popover-open")),
      { timeout: 5_000 }).toBe(true);
  }, 120_000);
});
