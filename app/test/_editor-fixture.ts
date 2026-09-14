import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { join } from "node:path";
import { makeTakeFolder, makePipTakeFolder } from "./_take-fixture.js";

const root = join(__dirname, "..", "..");

/** Launch the app against a recordings root, and wait for the library to list something. */
export async function launchApp(dir: string, env: Record<string, string> = {}):
    Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [root], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: dir, ...env },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForSelector("#takes >> text=Preview", { timeout: 20_000 });
  return { app, win };
}

/**
 * Click a take's "Preview" action in the library and hand back the EDITOR
 * window it opens (STC-373) — a new `BrowserWindow`, not an in-page player.
 */
export async function openEditorFromLibrary(app: ElectronApplication, win: Page): Promise<Page> {
  const [editorWin] = await Promise.all([
    app.waitForEvent("window"),
    win.click("#takes >> text=Preview"),
  ]);
  await editorWin.waitForLoadState("domcontentloaded");
  return editorWin;
}

/**
 * Launch the app, open a take from the library, and hand back the EDITOR
 * window's own page — the player moved there, out of the main window's old
 * in-page `#player`.
 */
export async function launchWithTakeInEditor(opts: { pip?: boolean; env?: Record<string, string> } = {}):
    Promise<{
      app: ElectronApplication; win: Page; editorWin: Page; takeDir: string; dir: string;
    }> {
  const { dir, takeDir } = opts.pip ? makePipTakeFolder() : makeTakeFolder();
  const { app, win } = await launchApp(dir, opts.env ?? {});
  const editorWin = await openEditorFromLibrary(app, win);
  return { app, win, editorWin, takeDir, dir };
}

/** Fraction of sampled pixels on the editor's stage that are not pure black. */
export async function inkiness(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.getElementById("stage") as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const w = c.width, h = c.height;
    let lit = 0, n = 0;
    for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 40))) {
      for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 40))) {
        const p = ctx.getImageData(x, y, 1, 1).data;
        if (p[0]! + p[1]! + p[2]! > 24) lit++;
        n++;
      }
    }
    return lit / n;
  });
}

/** Open the export dialog (STC-373) — legibility, output size and share all live in it now. */
export async function openExportDialog(page: Page): Promise<void> {
  await page.click("#openexport");
  await page.waitForSelector("#exportdialog[open]", { timeout: 10_000 });
}
