import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, cpSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { windowCount, pageWithUrl, clickThatCloses } from "./_windows.js";

/**
 * A recording's Copy (STC-488): rendered with cursor and zoom, written to the
 * copies folder, put on the pasteboard through the helper, panel left open.
 * Real WebCodecs H.264, which the macos-15 runner already exercises in
 * export.e2e.test.ts. Against `_fake-helper.mjs`, which logs `copy-file`
 * instead of touching a pasteboard; what Slack or Mail accept is
 * docs/STC-488-RUNBOOK.md. The camera test only proves a take with a camera.mp4
 * copies at all; whether the PiP is composited correctly is the runbook's.
 */
// Timeout arithmetic (_timeout-budget.ts: the outer literal must exceed the sum
// of the inner `{ timeout }` bounds). Every test declares 300_000 as a LITERAL.
//   Shared pieces: recordAndStop = 15 s poll; readyPanel = 2 x 15 s; each
//   clickThatCloses = 15 s default; each windowCount poll = 15 s; copy-file = 120 s.
//   test 1: 15 + 30 + #copyprogress 15 + 120 + Copied 15 = 195 s
//   test 2: 15 + 30 + 15 + 120 + 15 (enabled) = 195 s
//   test 3 (camera): 15 + 30 + 120 = 165 s
//   test 4 (busy): 15 + 30 + Saving 15 + Could-not-save 15 = 75 s (+ 1.5 s waits)
//   test 5 (refused): 15 + 30 + 120 = 165 s
//   test 6 (trash after copy): 15 + 30 + 120 + clickThatCloses 15 + window poll 15 = 195 s
//   test 7 (trash mid-render): 15 + 30 + 15 + 15 + 15 = 90 s (+ 1 s wait)
//   test 8 (dismiss mid-render): 15 + 30 + 15 + 15 + 15 = 90 s
//   test 9 (reuse): 15 + 30 + 120 + 15 (enabled) + 15 (copy-file 2) = 195 s
//   test 10 (clipboard moved mid-render, F1): 15 + 30 + 15 (Ready status) + 15 (enabled)
//     + 15 (copy-file 2) = 90 s
//   test 11 (quit mid-render, F8): 15 + 30 + 15 (render window) = 60 s; the close
//     is closeApp's own APP_CLOSE_MS bound, which throws rather than hangs
//   test 12 (a failing render, F8): 15 + 30 + 120 (status) + 15 (enabled) = 180 s
// Inner bounds (195 s worst) clear 300 s strictly; the ~105 s left is launch,
// teardown and startRecordFlow's hidden bounds (judgement headroom).
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const POLL_MS = 15_000;
// What a take holds when the app records it: no project.json (nothing writes
// one at record time), mirroring `_take-fixture.ts`'s makePipTakeFolder.
const RECORDED = ["anchors.json", "events.json", "display.mp4", "camera.mp4"];

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

interface Launched { win: Page; temp: string; copies: string; copyLog: string }

async function launch(env: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const copies = mkdtempSync(join(tmpdir(), "stc-copies-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  const copyLog = join(mkdtempSync(join(tmpdir(), "stc-log-")), "copy.log");
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`], cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
      STC_COPIES_DIR: copies, STC_FAKE_COPY_LOG: copyLog,
      // Long enough to see a render in progress (copy-render.ts's seam).
      STC_COPY_RENDER_DELAY_MS: "3000",
      STC_HELPER_BIN: FAKE_HELPER, STC_OVERLAY_SYNTHETIC_INPUT: "1", STC_NO_SHUTTER: "1", ...env,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#record");
  await withoutCountdown(win);
  return { win, temp, copies, copyLog };
}

/** Record and stop through the real flow, with a REAL renderable take in the temp dir. */
async function recordAndStop(l: Launched, fixture = "basic"): Promise<string> {
  await startRecordFlow(app!, l.win);
  await expect.poll(() => readdirSync(l.temp).length, { timeout: POLL_MS }).toBe(1);
  const dir = join(l.temp, readdirSync(l.temp)[0]!);
  for (const f of readdirSync(join(root, "fixtures", fixture))) {
    if (RECORDED.includes(f)) cpSync(join(root, "fixtures", fixture, f), join(dir, f));
  }
  await l.win.evaluate(() => (window as any).recorder.stop());
  return dir;
}

async function readyPanel(): Promise<Page> {
  await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: POLL_MS }).toBe(1);
  const panel = await pageWithUrl(app!, "thumbnail.html");
  await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className),
                     { timeout: POLL_MS }).toContain("in");
  return panel;
}

/** A synthetic ⌘-key on the document, as panel-waits.e2e does: a real key press needs the panel focused, which a headless window may not be. */
const metaKey = (panel: Page, key: string) =>
  panel.evaluate((k) => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true })); }, key);

const copyRequests = (log: string): Array<{ path: string }> =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

describe("copying a recording (STC-488)", () => {
  test("Copy renders an MP4 into the copies folder, hands it to the pasteboard, and leaves the panel open", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    expect(await panel.isVisible("#copy")).toBe(true);

    await panel.click("#copy");
    await expect.poll(() => panel.isVisible("#copyprogress"), { timeout: POLL_MS }).toBe(true);
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);

    const { path } = copyRequests(l.copyLog)[0]!;
    expect(path).toBe(join(l.copies, `${dir.split("/").pop()}.mp4`));
    const mp4 = readFileSync(path);
    expect(mp4.includes("avc1"), "an H.264 video track").toBe(true);
    expect(readdirSync(l.copies).filter((n) => n.endsWith(".partial"))).toEqual([]);
    await expect.poll(() => panel.textContent("#status"), { timeout: POLL_MS }).toContain("Copied");
    expect(await windowCount(app!, "thumbnail.html")).toBe(1);
    expect(await panel.isVisible("#copyprogress")).toBe(false);
    expect(existsSync(dir), "Copy does not promote").toBe(true);
  }, 300_000);

  test("Save and Edit are locked while a copy renders, by key as well as by click (Review Focus 1)", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => panel.isVisible("#copyprogress"), { timeout: POLL_MS }).toBe(true);
    expect(await panel.isDisabled("#save")).toBe(true);
    expect(await panel.isDisabled("#edit")).toBe(true);
    expect(await panel.isDisabled("#copy")).toBe(true);
    expect(await panel.isEnabled("#trash")).toBe(true);
    await metaKey(panel, "s");
    // Sampled right after the key: a Save that started would have said so.
    expect(await panel.textContent("#status")).not.toContain("Saving");
    await metaKey(panel, "e");
    await panel.waitForTimeout(500);
    expect(await windowCount(app!, "editor.html"), "a ⌘E during the render must not open the editor").toBe(0);

    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);
    // AFTER the render: if either key had slipped through, the take has moved by now.
    expect(existsSync(dir), "neither ⌘S nor ⌘E may have moved the take").toBe(true);
    expect(await windowCount(app!, "editor.html")).toBe(0);
    await expect.poll(() => panel.isEnabled("#save"), { timeout: POLL_MS }).toBe(true);
  }, 300_000);

  test("a camera take copies (Review Focus 3)", async () => {
    const l = await launch();
    await recordAndStop(l, "pip");
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);
    expect(existsSync(copyRequests(l.copyLog)[0]!.path)).toBe(true);
  }, 300_000);

  test("⌘C during an in-flight Save starts no render (busy holds the key path)", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    // Hold Save open from the main side (a test-only stand-in for a slow promote;
    // no product seam), then let it fail so the panel stays and recovers.
    await app!.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("panel:save");
      ipcMain.handle("panel:save", () => new Promise((r) => setTimeout(() => r({ ok: false, detail: "held" }), 4000)));
    });
    await panel.click("#save");
    await expect.poll(() => panel.textContent("#status"), { timeout: POLL_MS }).toContain("Saving");
    await metaKey(panel, "c");
    await panel.waitForTimeout(1500);
    expect(await windowCount(app!, "copy-render.html"), "no render for a take mid-Save").toBe(0);
    expect(await panel.isVisible("#copyprogress")).toBe(false);
    expect(await panel.textContent("#status")).toContain("Saving");
    await expect.poll(() => panel.textContent("#status"), { timeout: POLL_MS }).toContain("Could not save");
    expect(copyRequests(l.copyLog)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(await panel.isEnabled("#copy")).toBe(true);
  }, 300_000);

  test("a refused pasteboard write is reported, and the panel recovers (Review Focus 4)", async () => {
    const l = await launch({ STC_FAKE_COPY_ERROR: "pasteboard-failed" });
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => panel.textContent("#status"), { timeout: 120_000 }).toContain("Could not copy");
    expect(await panel.isEnabled("#save")).toBe(true);
    expect(await panel.isEnabled("#copy")).toBe(true);
    expect(existsSync(dir)).toBe(true);
  }, 300_000);

  test("Copy, then Trash: the copy outlives the take", async () => {
    const l = await launch();
    await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);
    const { path } = copyRequests(l.copyLog)[0]!;
    await clickThatCloses(panel, "#trash");
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: POLL_MS }).toBe(0);
    expect(existsSync(path), "the paste still works").toBe(true);
  }, 300_000);

  test("Trash during a render cancels it: no render window, no partial, no pasteboard write", async () => {
    const l = await launch();
    await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: POLL_MS }).toBe(1);
    await clickThatCloses(panel, "#trash");
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: POLL_MS }).toBe(0);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(readdirSync(l.copies)).toEqual([]);
    expect(copyRequests(l.copyLog)).toEqual([]);
  }, 300_000);

  test("dismissing mid-render cancels it (Review Focus 2)", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: POLL_MS }).toBe(1);
    await clickThatCloses(panel, "#dismiss");
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: POLL_MS }).toBe(0);
    expect(readdirSync(l.copies)).toEqual([]);
    expect(copyRequests(l.copyLog)).toEqual([]);
    expect(existsSync(dir), "dismiss leaves the take where it was").toBe(true);
  }, 300_000);

  test("a second Copy reuses the finished file without rendering again", async () => {
    const l = await launch();
    await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);
    await expect.poll(() => panel.isEnabled("#copy"), { timeout: POLL_MS }).toBe(true);
    const first = statSync(copyRequests(l.copyLog)[0]!.path);
    await panel.click("#copy");
    // A re-render would show progress and a render window right after the click.
    expect(await panel.isVisible("#copyprogress"), "no progress right after the click").toBe(false);
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: POLL_MS }).toBe(2);
    expect(await panel.isVisible("#copyprogress"), "no progress before the second write").toBe(false);
    expect(await windowCount(app!, "copy-render.html"), "no second render").toBe(0);
    const path = copyRequests(l.copyLog)[1]!.path;
    expect(path).toBe(copyRequests(l.copyLog)[0]!.path);
    const second = statSync(path);
    expect(second.mtimeMs, "the file was not rewritten").toBe(first.mtimeMs);
    expect(second.ino, "the file was not replaced").toBe(first.ino);
  }, 300_000);

  test("a copy made elsewhere mid-render keeps the file and asks for a second press (F1)", async () => {
    // The fake pasteboard's changeCount moves 1 s after its first read; the render takes 3 s+.
    const l = await launch({ STC_FAKE_PASTEBOARD: "[]", STC_FAKE_PASTEBOARD_CHANGE_AFTER_MS: "1000" });
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => panel.textContent("#status"), { timeout: 15_000 })
      .toBe("Ready, press Copy to put it on the clipboard");
    expect(copyRequests(l.copyLog), "the newer clipboard must not be overwritten").toEqual([]);
    const out = join(l.copies, `${dir.split("/").pop()}.mp4`);
    expect(existsSync(out), "the finished file is kept").toBe(true);
    await expect.poll(() => panel.isEnabled("#copy"), { timeout: 15_000 }).toBe(true);
    expect(await panel.isEnabled("#save")).toBe(true);
    expect(await panel.isVisible("#copyprogress")).toBe(false);

    await panel.click("#copy");
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 15_000 }).toBe(1);
    expect(copyRequests(l.copyLog)[0]!.path).toBe(out);
    expect(await windowCount(app!, "copy-render.html"), "the second press renders nothing").toBe(0);
  }, 300_000);

  test("quitting during a render leaves no partial", async () => {
    const l = await launch();
    await recordAndStop(l);
    const panel = await readyPanel();
    await panel.click("#copy");
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: 15_000 }).toBe(1);
    const a = app; app = undefined;
    // closeApp throws if the app does not close inside APP_CLOSE_MS.
    await closeApp(a);
    expect(readdirSync(l.copies)).toEqual([]);
    expect(copyRequests(l.copyLog)).toEqual([]);
  }, 300_000);

  test("a render that fails reports it and cleans up", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    // An index-less display.mp4: the demuxer cannot read it, so the render fails.
    truncateSync(join(dir, "display.mp4"), 1_000);
    await panel.click("#copy");
    await expect.poll(() => panel.textContent("#status"), { timeout: 120_000 }).toMatch(/^Could not copy/);
    await expect.poll(() => panel.isEnabled("#copy"), { timeout: 15_000 }).toBe(true);
    expect(await panel.isEnabled("#save")).toBe(true);
    expect(await panel.isEnabled("#edit")).toBe(true);
    expect(readdirSync(l.copies)).toEqual([]);
    expect(copyRequests(l.copyLog)).toEqual([]);
  }, 300_000);
});
