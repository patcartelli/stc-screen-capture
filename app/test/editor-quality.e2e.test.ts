import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { openEditorFromLibrary, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { exportManifestName } from "../src/share.js";
import { videoBitrate } from "@transform/export-quality";

/**
 * The editor's MP4 Quality and File size (STC-613), through the real handlers:
 * `#exportquality` -> `exportSession({ quality })` in the editor window, and
 * Copy's render job. Real WebCodecs; the fake helper logs `copy-file` instead
 * of touching a pasteboard.
 *
 * What these pin is what has a plausible wrong version that still writes an
 * MP4: an estimate that ignores the Quality or the Frame rate, an encoder that
 * still asks for the flat 12 Mbps, a Copy that ignores the Quality the Export
 * used, and a Quality saved on the take.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const TAKE = "2026-08-24_10-00-00";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

interface Launched { editorWin: Page; takeDir: string; copies: string; copyLog: string }

async function launch(): Promise<Launched> {
  const { dir: recordings, takeDir } = makeTakeFolder(TAKE);
  const copies = mkdtempSync(join(tmpdir(), "stc-copies-"));
  const copyLog = join(mkdtempSync(join(tmpdir(), "stc-log-")), "copy.log");
  app = await electron.launch({
    args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`], cwd: root,
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
  return { editorWin, takeDir, copies, copyLog };
}

/** Moves the slider the way a drag does: sets the value and fires `input`. */
async function setQuality(editorWin: Page, stop: number): Promise<void> {
  await editorWin.$eval("#exportquality", (el, v) => {
    (el as HTMLInputElement).value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, stop);
}

/** The File size readout in bytes ("≈ 18.4 MB" -> 18_400_000). */
async function estimate(editorWin: Page): Promise<number> {
  const text = (await editorWin.textContent("#exportsize")) ?? "";
  const m = /^≈ ([\d.]+) (MB|GB)$/.exec(text);
  if (!m) throw new Error(`File size reads ${JSON.stringify(text)}`);
  return Number(m[1]) * (m[2] === "GB" ? 1e9 : 1e6);
}

async function exportMp4(editorWin: Page): Promise<void> {
  await expect.poll(() => editorWin.isDisabled("#export"), { timeout: 15_000 }).toBe(false);
  await editorWin.click("#export");
  await expect.poll(() => editorWin.textContent("#exportstatus"), { timeout: 120_000 }).toMatch(/^Done — /);
}

describe("the editor's MP4 Quality and File size", () => {
  test("High by default; the estimate follows Quality and Frame rate; GIF hides both", async () => {
    const { editorWin } = await launch();
    expect(await editorWin.inputValue("#exportquality")).toBe("2");
    expect(await editorWin.textContent("#exportquality-out")).toBe("High");
    await expect.poll(() => estimate(editorWin).catch(() => 0), { timeout: 10_000 }).toBeGreaterThan(0);
    const high = await estimate(editorWin);

    await setQuality(editorWin, 0);
    expect(await editorWin.textContent("#exportquality-out")).toBe("Low");
    expect(await estimate(editorWin)).toBeLessThan(high);

    await setQuality(editorWin, 2);
    await editorWin.selectOption("#exportrate", "30");
    expect(await estimate(editorWin)).toBeLessThan(high);

    await editorWin.selectOption("#exporttype", "gif");
    expect(await editorWin.isVisible("#exportquality")).toBe(false);
    expect(await editorWin.isVisible("#exportsize")).toBe(false);
    await editorWin.selectOption("#exporttype", "mp4");
    expect(await editorWin.isVisible("#exportquality")).toBe(true);
    expect(await editorWin.isVisible("#exportsize")).toBe(true);
  }, 120_000);

  test("the export asks for the Quality's bitrate, and Quality is not saved on the take", async () => {
    const { editorWin, takeDir } = await launch();
    await setQuality(editorWin, 0);
    await exportMp4(editorWin);
    const m = JSON.parse(readFileSync(join(takeDir, exportManifestName(TAKE)), "utf8"));
    expect(m.quality).toBe("low");
    expect(m.videoBitrate).toBe(videoBitrate(m.output.width, m.output.height, m.rate, "low"));
    expect(m.videoBitrate).not.toBe(12_000_000);

    const project = existsSync(join(takeDir, "project.json"))
      ? readFileSync(join(takeDir, "project.json"), "utf8") : "{}";
    expect(project).not.toMatch(/quality|videoBitrate/i);
  }, 300_000);

  test("Copy follows the Quality", async () => {
    const { editorWin, copies, copyLog } = await launch();
    await editorWin.click("#copyclip");
    await expect.poll(() => editorWin.textContent("#copystatus"), { timeout: 120_000 })
      .toBe("Copied. Paste anywhere.");
    const high = statSync(JSON.parse(readFileSync(copyLog, "utf8").trim().split("\n")[0]!).path).size;

    await setQuality(editorWin, 0);
    await editorWin.click("#copyclip");
    await expect.poll(() => readFileSync(copyLog, "utf8").trim().split("\n").length, { timeout: 120_000 }).toBe(2);
    // The log line is the pasteboard call, so the render is done; only the reply is left.
    await expect.poll(() => editorWin.textContent("#copystatus"), { timeout: 30_000 })
      .toBe("Copied. Paste anywhere.");
    expect(readdirSync(copies)).toEqual([`${TAKE}-edit.mp4`]);
    const low = statSync(JSON.parse(readFileSync(copyLog, "utf8").trim().split("\n")[1]!).path).size;
    // The fixture is synthetic motion, so the encoder spends its budget: Low's file is the smaller.
    expect(low).toBeLessThan(high);
  }, 300_000);
});
