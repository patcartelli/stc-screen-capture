import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as MP4BoxNS from "mp4box";
import { makeTakeFolder } from "./_take-fixture.js";
import { openEditorFromLibrary, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { exportManifestName, exportMediaName } from "../src/share.js";

/**
 * The editor's MP4 Frame rate (STC-614), through the real handlers: `#exportrate`
 * -> `exportSession({ rate })` in the editor window, and Copy's render job.
 * Real WebCodecs; the fake helper logs `copy-file` instead of touching a
 * pasteboard.
 *
 * What these pin is what has a plausible wrong version that still writes an
 * MP4: a 30 fps file with 60 fps's frame count (the step never reached the
 * loop), a Copy that ignores the rate the Export used, and a rate saved on the
 * take.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const TAKE = "2026-08-24_10-00-00";
const MP4Box = ((MP4BoxNS as any).default ?? MP4BoxNS) as any;

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

interface Launched { editorWin: Page; recordings: string; takeDir: string; copies: string; copyLog: string }

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
  return { editorWin, recordings, takeDir, copies, copyLog };
}

/** The video track's sample count and the rate its timing says, read from the file itself. */
function videoTrack(path: string): { samples: number; fps: number } {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer & { fileStart: number };
  ab.fileStart = 0;
  const file = MP4Box.createFile();
  let info: any;
  file.onReady = (i: any) => { info = i; };
  file.appendBuffer(ab);
  file.flush();
  const v = info?.videoTracks?.[0];
  if (!v) throw new Error(`${path}: no video track`);
  // nb_samples - 1 intervals span the track (the last sample adds none).
  return { samples: v.nb_samples, fps: ((v.nb_samples - 1) * v.timescale) / v.duration };
}

async function exportMp4(editorWin: Page): Promise<void> {
  await expect.poll(() => editorWin.isDisabled("#export"), { timeout: 15_000 }).toBe(false);
  await editorWin.click("#export");
  await expect.poll(() => editorWin.textContent("#exportstatus"), { timeout: 120_000 }).toMatch(/^Done — /);
}

describe("the editor's MP4 Frame rate", () => {
  test("MP4 shows Frame rate at 60; GIF swaps it for its own", async () => {
    const { editorWin } = await launch();
    expect(await editorWin.isVisible("#exportrate")).toBe(true);
    expect(await editorWin.inputValue("#exportrate")).toBe("60");
    await editorWin.selectOption("#exporttype", "gif");
    expect(await editorWin.isVisible("#exportrate")).toBe(false);
    expect(await editorWin.isVisible("#gifrate")).toBe(true);
    await editorWin.selectOption("#exporttype", "mp4");
    expect(await editorWin.isVisible("#exportrate")).toBe(true);
  }, 120_000);

  test("30 fps exports every other frame, and is not saved on the take", async () => {
    const { editorWin, recordings, takeDir } = await launch();
    await exportMp4(editorWin);
    const at60 = JSON.parse(readFileSync(join(recordings, exportManifestName(TAKE)), "utf8"));
    expect(at60.rate).toBe(60);
    expect(videoTrack(join(recordings, exportMediaName(TAKE))).samples).toBe(at60.frames);

    await editorWin.selectOption("#exportrate", "30");
    await exportMp4(editorWin);
    const at30 = JSON.parse(readFileSync(join(recordings, exportManifestName(TAKE)), "utf8"));
    expect(at30.rate).toBe(30);
    expect(at30.frames).toBe(Math.ceil(at60.frames / 2));
    const track = videoTrack(join(recordings, exportMediaName(TAKE)));
    expect(track.samples).toBe(at30.frames);
    expect(track.fps).toBeCloseTo(30, 0);

    const project = existsSync(join(takeDir, "project.json"))
      ? readFileSync(join(takeDir, "project.json"), "utf8") : "{}";
    expect(project).not.toMatch(/"rate"|exportRate/);
  }, 300_000);

  test("Copy follows the Frame rate", async () => {
    const { editorWin, recordings, copies, copyLog } = await launch();
    await editorWin.selectOption("#exportrate", "30");
    await exportMp4(editorWin);
    const exported = JSON.parse(readFileSync(join(recordings, exportManifestName(TAKE)), "utf8"));

    await editorWin.click("#copyclip");
    await expect.poll(() => editorWin.textContent("#copystatus"), { timeout: 120_000 })
      .toBe("Copied. Paste anywhere.");
    expect(readdirSync(copies)).toEqual([`${TAKE}-edit.mp4`]);
    const line = JSON.parse(readFileSync(copyLog, "utf8").trim().split("\n")[0]!);
    expect(videoTrack(line.path).samples).toBe(exported.frames);
  }, 300_000);
});
