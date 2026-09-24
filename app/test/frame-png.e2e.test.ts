import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * STC-298: the frame the playhead is on, as a PNG, copied or saved.
 *
 * The identity claim is checked from the outside: the saved PNG, decoded back
 * in the page, must be pixel-identical to the stage canvas, and the stage is
 * what render() + composite() painted for the export-grid frame the still was
 * snapped to. The grid arithmetic itself is unit-tested in transform/test.
 *
 * ## Migrated onto the one export path (STC-293)
 *
 * These buttons used to encode a PNG in the canvas and hand it to Electron's
 * `clipboard.writeImage` — a second encoder and a second clipboard, which
 * STC-293's Note forbids. They now send composited RGBA through
 * `still:export`, so the file is written by ImageIO in the helper and the copy
 * carries PNG + TIFF + a file URL.
 *
 * That makes the identity assertion STRONGER rather than weaker: it now proves
 * the pixels survive the whole trip out of the canvas, across IPC, through a
 * temp file and back out of ImageIO, which is the path every still in the app
 * takes.
 *
 * The frame-grab moved to the editor's own window with the rest of the player
 * (STC-373) — `openTake()` hands back both, since the last test still renames
 * the take from the main window's library.
 *
 * ## The PNG lands at the TOP LEVEL now, not beside the take (STC-413)
 *
 * These assertions used to read `takeDir`, and that was right while a bundle
 * sat at the top level: "beside the shot.json it came from" was also "where
 * the library looks". STC-413 made the folder a VIEW of finished files with
 * source bundles one level down in `raw/`, so `destinationDir`'s old
 * fall-back-to-the-bundle would now write a saved frame into `raw/<stamp>/`,
 * where the scan structurally cannot see it — saved, and invisible. A saved
 * frame IS a finished capture; it belongs beside the other finished files.
 *
 * So these are RESTATED rather than loosened: the PNG is asserted at the
 * root, AND asserted absent from the bundle, which is the half that would
 * still pass if the destination quietly went back to being the bundle's.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openTake():
    Promise<{ win: Page; mainWin: Page; takeDir: string; root: string }> {
  const { app: a, win: mainWin, editorWin, takeDir, dir } = await launchWithTakeInEditor();
  app = a;
  await expect.poll(() => editorWin.textContent("#clock"), { timeout: 20_000 }).toMatch(/^\d:\d\d:\d\d /);
  // `dir` is the capture folder's top level (STC_RECORDINGS_DIR); `takeDir`
  // is the take's own bundle inside it.
  return { win: editorWin, mainWin, takeDir, root: dir };
}

/** Saved frames at the top level of the capture folder. */
const framesAtRoot = (root: string) =>
  readdirSync(root).filter((f) => f.startsWith("frame-") && f.endsWith(".png"));

/** Saved frames that wrongly landed inside the bundle. */
const framesInBundle = (takeDir: string) =>
  readdirSync(takeDir).filter((f) => f.startsWith("frame-"));

/** Decodes a PNG in the page and compares it to the stage, pixel by pixel. */
async function pngMatchesStage(win: Page, pngBase64: string): Promise<{ same: boolean; width: number; height: number; differing: number }> {
  return win.evaluate(async (b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const stage = document.getElementById("stage") as HTMLCanvasElement;
    const a = stage.getContext("2d")!.getImageData(0, 0, stage.width, stage.height).data;
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const b = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let differing = 0;
    if (a.length === b.length) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++; }
    else differing = -1;
    return { same: differing === 0, width: bitmap.width, height: bitmap.height, differing };
  }, pngBase64);
}

describe("the current preview frame as a PNG, from the editor window (STC-373)", () => {
  test("Save frame writes a PNG at the top level that is pixel-identical to the stage", async () => {
    const { win, takeDir, root } = await openTake();
    await win.fill("#scrub", "131");
    await win.dispatchEvent("#scrub", "input");
    await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 }).not.toMatch(/^0:00:00 /);

    await win.click("#saveframe");
    await expect.poll(() => win.textContent("#framestatus"), { timeout: 20_000 }).toMatch(/^Saved frame at/);
    const pngs = readdirSync(root).filter((f) => /^frame-2026-08-24_10-00-00-\d+ms\.png$/.test(f));
    expect(pngs).toHaveLength(1);
    // ...and NOT inside the bundle, where the library's scan would never
    // find it. This is the discriminator: the assertion above alone would
    // pass again if the destination went back to being the bundle's, on a
    // fixture whose bundle happened to sit at the top level.
    expect(framesInBundle(takeDir)).toHaveLength(0);
    // Saved on the 60 fps export grid: the millisecond stamp is a multiple of a frame (16.67 ms, rounded).
    const ms = Number(pngs[0]!.match(/-(\d+)ms\.png$/)![1]);
    const frame = Math.round((ms * 60) / 1000);
    expect(Math.abs(ms - (frame * 1000) / 60)).toBeLessThan(1);

    const png = readFileSync(join(root, pngs[0]!));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const r = await pngMatchesStage(win, png.toString("base64"));
    expect(r.width).toBe(640);
    expect(r.height).toBe(360);
    expect(r.differing, "PNG differs from the stage").toBe(0);
    // The take's own files are untouched.
    expect(existsSync(join(takeDir, "display.mp4"))).toBe(true);
  }, 120_000);

  test("Copy frame puts the image on the clipboard and reports what it took", async () => {
    const { win } = await openTake();
    await win.click("#copyframe");
    // The size, and the representations the pasteboard ACTUALLY accepted —
    // reported back from the helper rather than assumed. "png + tiff +
    // fileURL" is what makes Slack, Keynote and Finder each get something they
    // can use (STC-293); a copy that silently offered only one of them would
    // still say "Copied" here without this.
    await expect.poll(() => win.textContent("#framestatus"), { timeout: 20_000 })
      .toMatch(/^Copied frame at .*\(640×360, png \+ tiff \+ fileURL\)/);
  }, 120_000);

  test("works while playing: the still is taken and playback resumes", async () => {
    const { win, takeDir, root } = await openTake();
    await win.click("#playpause");
    await expect.poll(() => win.textContent("#playpause"), { timeout: 10_000 }).toBe("Pause");
    await win.click("#saveframe");
    await expect.poll(() => win.textContent("#framestatus"), { timeout: 20_000 }).toMatch(/^Saved frame at/);
    expect(framesAtRoot(root)).toHaveLength(1);
    expect(framesInBundle(takeDir)).toHaveLength(0);
    // Resumed, not left paused. Polled, like the play above: captureFrame()
    // pauses (which relabels the button "Play" through onTime) and then calls
    // play(), which flips the state at once but relabels only on its first
    // animation frame — so read immediately after the save, the label can
    // still say "Play" while the player is already playing. CI run
    // 33910489117 caught exactly that gap on a loaded runner.
    await expect.poll(() => win.textContent("#playpause"), { timeout: 10_000 }).toBe("Pause");
    const a = await win.textContent("#clock");
    await expect.poll(() => win.textContent("#clock"), { timeout: 10_000 }).not.toBe(a);
  }, 120_000);

  test("the keyboard shortcut saves too, and does not fire inside the label input", async () => {
    const { win, mainWin, takeDir, root } = await openTake();
    await win.keyboard.press("Control+Shift+S");
    await expect.poll(() => win.textContent("#framestatus"), { timeout: 20_000 }).toMatch(/^Saved frame at/);
    expect(framesAtRoot(root)).toHaveLength(1);
    expect(framesInBundle(takeDir)).toHaveLength(0);
    // Inside a text field the shortcut belongs to the field. The label input
    // is the main window's library, not the editor's.
    await mainWin.click("#takes >> text=Rename");
    await mainWin.focus(".labelinput");
    await mainWin.keyboard.press("Control+Shift+S");
    await new Promise((r) => setTimeout(r, 500));
    expect(framesAtRoot(root)).toHaveLength(1);
  }, 120_000);
});
