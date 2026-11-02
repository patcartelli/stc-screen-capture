import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { openEditorFromLibrary, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { exportMediaName } from "../src/share.js";

/**
 * The editor's GIF Type (STC-615), through the real handlers: `#exporttype` ->
 * `exportGif` in the editor window -> `export:writeGif`, and Copy in its GIF
 * form (`editor:copy` with the GIF render job). Real WebCodecs; the fake helper
 * logs `copy-file` instead of touching a pasteboard.
 *
 * What these pin is what has a plausible wrong version that still writes a
 * GIF: it lands in the save folder UNTAGGED beside no MP4, a second export
 * never overwrites the first, and Type is not saved on the take.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const TAKE = "2026-08-24_10-00-00";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

interface Launched { editorWin: Page; recordings: string; takeDir: string; copies: string; copyLog: string }

async function launch(): Promise<Launched> {
  const { dir: recordings, takeDir } = makeTakeFolder(TAKE);
  const copies = mkdtempSync(join(tmpdir(), "stc-copies-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  const copyLog = join(mkdtempSync(join(tmpdir(), "stc-log-")), "copy.log");
  // Small and slow-rate, so the conversion is quick on a CI runner.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ gif: { fps: 10, maxWidth: 480 } }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`], cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings,
      STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_COPIES_DIR: copies, STC_FAKE_COPY_LOG: copyLog,
      STC_HELPER_BIN: FAKE_HELPER, STC_NO_SHUTTER: "1",
    },
  });
  const mainWin = await app.firstWindow();
  await mainWin.waitForLoadState("domcontentloaded");
  await mainWin.waitForSelector("#takes [data-open=open]", { timeout: 20_000 });
  const editorWin = await openEditorFromLibrary(app, mainWin);
  await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
  await editorWin.click("#openexport");
  return { editorWin, recordings, takeDir, copies, copyLog };
}

const gifs = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".gif")).sort();

describe("GIF as the editor's export Type", () => {
  test("the Export section scrolls inside the pane and never pushes the timeline off screen", async () => {
    const { editorWin } = await launch();
    // Many rows, so the section is taller than any window this suite opens.
    await editorWin.selectOption("#exporttype", "gif");
    await editorWin.evaluate(() => {
      const p = document.getElementById("pane")!;
      for (let i = 0; i < 40; i++) { const d = document.createElement("div"); d.style.height = "46px"; d.textContent = "x"; p.append(d); }
    });
    const m = await editorWin.evaluate(() => ({
      vh: innerHeight, docH: document.documentElement.scrollHeight,
      timelineBottom: document.getElementById("timeline")!.getBoundingClientRect().bottom,
      paneScrolls: document.getElementById("pane")!.scrollHeight > document.getElementById("pane")!.clientHeight,
    }));
    expect(m.docH).toBeLessThanOrEqual(m.vh);
    expect(m.timelineBottom).toBeLessThanOrEqual(m.vh);
    expect(m.paneScrolls).toBe(true);
  }, 120_000);

  test("GIF swaps Size for the GIF options, and the button says what it makes", async () => {
    const { editorWin } = await launch();
    expect(await editorWin.isVisible("#outsize")).toBe(true);
    expect(await editorWin.isVisible("#gifrate")).toBe(false);
    await editorWin.selectOption("#exporttype", "gif");
    expect(await editorWin.isVisible("#outsize")).toBe(false);
    expect(await editorWin.isVisible("#gifrate")).toBe(true);
    expect(await editorWin.inputValue("#gifrate")).toBe("10");
    expect(await editorWin.inputValue("#gifwidth")).toBe("480");
    expect((await editorWin.textContent("#export"))?.trim()).toBe("Export GIF");
    await editorWin.selectOption("#exporttype", "mp4");
    expect((await editorWin.textContent("#export"))?.trim()).toBe("Export");
  }, 120_000);

  test("exports an untagged GIF to the save folder, and never overwrites one", async () => {
    const { editorWin, recordings, takeDir } = await launch();
    await editorWin.selectOption("#exporttype", "gif");
    await editorWin.click("#export");
    await expect.poll(() => editorWin.textContent("#exportstatus"), { timeout: 90_000 }).toMatch(/^Saved .*\.gif/);
    expect(gifs(recordings)).toEqual([`${TAKE}.gif`]);
    const first = readFileSync(join(recordings, `${TAKE}.gif`));
    expect(first.subarray(0, 6).toString("latin1")).toBe("GIF89a");
    // Untagged and manifest-less: not an MP4 export at all, and the take gains no capture identity.
    expect(existsSync(join(recordings, exportMediaName(TAKE)))).toBe(false);
    expect(existsSync(join(takeDir, "capture.json"))).toBe(false);
    expect(readdirSync(recordings).filter((n) => n.endsWith(".partial"))).toEqual([]);

    await expect.poll(() => editorWin.isDisabled("#export"), { timeout: 15_000 }).toBe(false);
    await editorWin.click("#export");
    await expect.poll(() => gifs(recordings).length, { timeout: 90_000 }).toBe(2);
    expect(gifs(recordings)).toEqual([`${TAKE}-2.gif`, `${TAKE}.gif`]);
    expect(readFileSync(join(recordings, `${TAKE}.gif`))).toEqual(first);
  }, 300_000);

  test("Type is not saved on the take", async () => {
    const { editorWin, takeDir } = await launch();
    await editorWin.selectOption("#exporttype", "gif");
    await editorWin.click("#export");
    await expect.poll(() => editorWin.textContent("#exportstatus"), { timeout: 90_000 }).toMatch(/^Saved /);
    const project = existsSync(join(takeDir, "project.json"))
      ? readFileSync(join(takeDir, "project.json"), "utf8") : "{}";
    expect(project).not.toMatch(/gif|exportType/i);
  }, 300_000);

  test("Copy follows the Type: a GIF render to its own -edit.gif", async () => {
    const { editorWin, copies, copyLog } = await launch();
    await editorWin.selectOption("#exporttype", "gif");
    await editorWin.click("#copyclip");
    await expect.poll(() => editorWin.textContent("#copystatus"), { timeout: 90_000 })
      .toBe("Copied. Paste anywhere.");
    expect(readdirSync(copies)).toEqual([`${TAKE}-edit.gif`]);
    const line = JSON.parse(readFileSync(copyLog, "utf8").trim().split("\n")[0]!);
    expect(line.path).toBe(join(copies, `${TAKE}-edit.gif`));
    expect(readFileSync(line.path).subarray(0, 6).toString("latin1")).toBe("GIF89a");
  }, 300_000);
});
