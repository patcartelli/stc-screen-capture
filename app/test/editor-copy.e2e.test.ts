import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { openEditorFromLibrary, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The editor's Copy to clipboard (STC-616), through the real handlers:
 * `#copyclip` -> `editor:copy` -> STC-488's hidden render window -> the helper's
 * `copy-file`. Against `_fake-helper.mjs`, which logs `copy-file` instead of
 * touching a pasteboard; what Slack or Finder accept is the runbook's.
 *
 * What these pin is the DECISIONS, each of which has a plausible wrong version
 * that still copies a file: the panel's cache is not reused, the file is the
 * editor's own, and a cancel leaves nothing behind.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const TAKE = "2026-08-24_10-00-00";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

interface Launched { editorWin: Page; copies: string; copyLog: string }

async function launch(env: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder(TAKE);
  const copies = mkdtempSync(join(tmpdir(), "stc-copies-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  const copyLog = join(mkdtempSync(join(tmpdir(), "stc-log-")), "copy.log");
  writeFileSync(join(userData, "settings.json"), JSON.stringify({}));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`], cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings,
      STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_COPIES_DIR: copies, STC_FAKE_COPY_LOG: copyLog,
      STC_HELPER_BIN: FAKE_HELPER, STC_NO_SHUTTER: "1", ...env,
    },
  });
  const mainWin = await app.firstWindow();
  await mainWin.waitForLoadState("domcontentloaded");
  await mainWin.waitForSelector("#takes [data-open=open]", { timeout: 20_000 });
  const editorWin = await openEditorFromLibrary(app, mainWin);
  await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
  return { editorWin, copies, copyLog };
}

const copyLogLines = (log: string): any[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

describe("Copy to clipboard in the editor's Export section", () => {
  test("renders the editor's own file and ignores the panel's cached copy of the take", async () => {
    const { editorWin, copies, copyLog } = await launch();
    // The panel's cache for this leaf: `<leaf>.mp4`, an UNEDITED chat-size render.
    // Reusing it would paste the wrong video for any edited take.
    const panelCopy = join(copies, `${TAKE}.mp4`);
    writeFileSync(panelCopy, "the panel's copy");
    await editorWin.click("#openexport");
    await editorWin.click("#copyclip");
    await expect.poll(() => editorWin.textContent("#copystatus"), { timeout: 90_000 })
      .toBe("Copied. Paste anywhere.");

    const edit = join(copies, `${TAKE}-edit.mp4`);
    expect(existsSync(edit)).toBe(true);
    expect(statSync(edit).size).toBeGreaterThan(1000);
    expect(readFileSync(panelCopy, "utf8")).toBe("the panel's copy");
    expect(readdirSync(copies).filter((n) => n.endsWith(".partial"))).toEqual([]);
    const lines = copyLogLines(copyLog);
    expect(lines).toHaveLength(1);
    expect(lines[0].path).toBe(edit);
    // Export and Copy are enabled again once it is over.
    expect(await editorWin.isDisabled("#copyclip")).toBe(false);
    expect(await editorWin.isDisabled("#export")).toBe(false);
  }, 300_000);

  test("a second Copy renders again, because the project may have changed", async () => {
    const { editorWin, copies, copyLog } = await launch();
    await editorWin.click("#openexport");
    await editorWin.click("#copyclip");
    await expect.poll(() => copyLogLines(copyLog).length, { timeout: 90_000 }).toBe(1);
    const first = statSync(join(copies, `${TAKE}-edit.mp4`)).mtimeMs;
    await expect.poll(() => editorWin.isDisabled("#copyclip"), { timeout: 15_000 }).toBe(false);
    await editorWin.click("#copyclip");
    await expect.poll(() => copyLogLines(copyLog).length, { timeout: 90_000 }).toBe(2);
    expect(statSync(join(copies, `${TAKE}-edit.mp4`)).mtimeMs).toBeGreaterThan(first);
  }, 300_000);

  test("Cancel ends the render and leaves no file and no pasteboard write", async () => {
    // The 5 s fixture renders in a second or two; the delay seam holds it open.
    const { editorWin, copies, copyLog } = await launch({ STC_COPY_RENDER_DELAY_MS: "8000" });
    await editorWin.click("#openexport");
    await editorWin.click("#copyclip");
    await expect.poll(() => editorWin.isDisabled("#export"), { timeout: 15_000 }).toBe(true);
    expect(await editorWin.isVisible("#exportbar")).toBe(true);
    await editorWin.click("#cancelexport");
    await expect.poll(() => editorWin.textContent("#copystatus"), { timeout: 15_000 }).toBe("Cancelled.");
    expect(readdirSync(copies)).toEqual([]);
    expect(copyLogLines(copyLog)).toEqual([]);
    expect(await editorWin.isDisabled("#export")).toBe(false);
  }, 300_000);

  test("a pasteboard refusal is said, and the file stays for the next Copy", async () => {
    const { editorWin, copies } = await launch({ STC_FAKE_COPY_ERROR: "copy-refused" });
    await editorWin.click("#openexport");
    await editorWin.click("#copyclip");
    await expect.poll(() => editorWin.textContent("#copystatus"), { timeout: 90_000 })
      .toBe("Could not copy.");
    expect(existsSync(join(copies, `${TAKE}-edit.mp4`))).toBe(true);
    expect(await editorWin.isDisabled("#copyclip")).toBe(false);
  }, 300_000);
});
