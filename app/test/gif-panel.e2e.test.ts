import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { windowCount, pageWithUrl, clickThatCloses } from "./_windows.js";
import { RAW_SUBDIR } from "../src/takes.js";

/**
 * A fresh recording's GIF / Video switch, wired (STC-395). The pure states are
 * `gif-panel.test.ts`'s; this file proves the panel, main and the render window
 * do what those states say: a flip to GIF converts with progress and shows the
 * size, Copy and Save use the GIF (joining a conversion still running), a flip
 * back to Video or a Trash cancels it, and a still's panel has no switch.
 *
 * Real WebCodecs decode and a real GIF encode in the hidden render window, the
 * same path `recording-copy.e2e.test.ts` exercises for the mp4. Against
 * `_fake-helper.mjs`, which logs `copy-file` instead of touching a pasteboard;
 * what a GIF looks like when pasted is the runbook's, not this file's.
 *
 * Helpers are copied from `recording-copy.e2e.test.ts` (file-local there).
 * Windows are counted through `_windows.ts`, never `app.windows()` (STC-416).
 */
// Timeout arithmetic (_timeout-budget.ts: the outer literal must exceed the sum
// of the inner `{ timeout }` bounds). Every test declares 300_000 as a LITERAL.
//   Shared pieces: recordAndStop = 15 s poll; readyPanel = 15 s window poll +
//   pageWithUrl's 15 s + 15 s card poll = 45 s; each clickThatCloses = 15 s;
//   a conversion (or a copy that waits on one) = 120 s.
//   test 1 (flip, size, Copy): 15 + 45 + #copyprogress 15 + label 120 + copy-file 15
//     + status 15 = 225 s
//   test 2 (Copy mid-conversion): 15 + 45 + status 15 + copy-file 120 + status 15 = 210 s
//   test 3 (Save): 15 + 45 + label 120 + clickThatCloses 15 + promoted 15 + saved gif 15
//     + panel gone 15 = 240 s
//   test 4 (back to Video): 15 + 45 + #copyprogress 15 + render window 15 + window gone 15
//     + label hidden 15 = 120 s (+ 1 s settle)
//   test 5 (GIF → Video → GIF): 15 + 45 + label 120 + window gone 15 = 195 s
//   test 6 (Trash mid-conversion): 15 + 45 + render window 15 + clickThatCloses 15
//     + window gone 15 = 105 s (+ 1 s settle)
//   test 7 (a still's panel): thumbnail 15 + pageWithUrl 15 + card 15 = 45 s
// Inner bounds (240 s worst) clear 300 s strictly; the rest is launch,
// teardown and startRecordFlow's hidden bounds (judgement headroom).
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const POLL_MS = 15_000;
// What a take holds when the app records it: no project.json (nothing writes
// one at record time), mirroring `_take-fixture.ts`'s makePipTakeFolder.
const RECORDED = ["anchors.json", "events.json", "display.mp4", "camera.mp4"];

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

interface Launched { win: Page; recordings: string; temp: string; copies: string; copyLog: string }

async function launch(env: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const copies = mkdtempSync(join(tmpdir(), "stc-copies-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  const copyLog = join(mkdtempSync(join(tmpdir(), "stc-log-")), "copy.log");
  // `saveFolder: null` leaves STC_RECORDINGS_DIR as the resolved root, so a
  // promote and a saved GIF land where this file looks. No `gif` key: the
  // default frame rate and width, which is what a first GIF is made with.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`], cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
      STC_COPIES_DIR: copies, STC_FAKE_COPY_LOG: copyLog,
      // Long enough to see a conversion in progress, and to cancel one (copy-render.ts's seam).
      STC_COPY_RENDER_DELAY_MS: "3000",
      STC_HELPER_BIN: FAKE_HELPER, STC_OVERLAY_SYNTHETIC_INPUT: "1", STC_NO_SHUTTER: "1", ...env,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#record");
  await withoutCountdown(win);
  return { win, recordings, temp, copies, copyLog };
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

const copyRequests = (log: string): Array<{ path: string }> =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const named = (dir: string, ext: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(ext)) : [];

/** Bundles actually promoted — `raw/`, not the top level (recording-panel.e2e's `promoted`). */
const promoted = (recordings: string): string[] => {
  const raw = join(recordings, RAW_SUBDIR);
  return existsSync(raw) ? readdirSync(raw) : [];
};

const isGif = (path: string): boolean => readFileSync(path).subarray(0, 6).toString("latin1") === "GIF89a";

const checked = (panel: Page): Promise<string | null> =>
  panel.evaluate(() => document.querySelector("#format button[aria-checked=true]")?.getAttribute("data-format") ?? null);

const GIF = "#format button[data-format=gif]";
const VIDEO = "#format button[data-format=video]";
/** `gif-panel.ts`'s ready label: "GIF · 820 KB" (and maybe a large-file warning after it). */
const READY = /^GIF · \d/;

describe("a recording's GIF (STC-395)", () => {
  test("flip to GIF converts with progress, shows the size, and Copy hands the GIF to the pasteboard", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();
    expect(await panel.isVisible("#format"), "a fresh recording offers the switch").toBe(true);
    expect(await checked(panel)).toBe("video");
    expect(await panel.isVisible("#giflabel")).toBe(false);

    await panel.click(GIF);
    expect(await checked(panel)).toBe("gif");
    await expect.poll(() => panel.isVisible("#copyprogress"), { timeout: 15_000 }).toBe(true);
    expect(await panel.textContent("#giflabel")).toMatch(/^GIF \d+%$/);
    await expect.poll(() => panel.textContent("#giflabel"), { timeout: 120_000 }).toMatch(READY);
    expect(await panel.isVisible("#copyprogress"), "no bar once the GIF is ready").toBe(false);

    const gifs = named(l.copies, ".gif");
    expect(gifs).toEqual([`${dir.split("/").pop()}.gif`]);
    expect(isGif(join(l.copies, gifs[0]!)), "a GIF89a file").toBe(true);
    expect(named(l.copies, ".partial")).toEqual([]);
    expect(named(l.copies, ".mp4"), "a GIF is not an mp4 copy").toEqual([]);
    expect(copyRequests(l.copyLog), "converting puts nothing on the pasteboard").toEqual([]);

    await panel.click("[data-action=copy]");
    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 15_000 }).toBe(1);
    expect(copyRequests(l.copyLog)[0]!.path).toBe(join(l.copies, gifs[0]!));
    await expect.poll(() => panel.textContent("#status"), { timeout: 15_000 }).toContain("Copied GIF");
    expect(await windowCount(app!, "thumbnail.html"), "Copy leaves the panel open").toBe(1);
    expect(await windowCount(app!, "copy-render.html"), "a ready GIF is not rendered again").toBe(0);
    expect(existsSync(dir), "Copy does not promote").toBe(true);
  }, 300_000);

  test("Copy pressed mid-conversion waits for it, then copies the GIF", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();

    await panel.click(GIF);
    // Straight after the flip: the 3 s render delay means the conversion is still running.
    await panel.click("[data-action=copy]");
    await expect.poll(() => panel.textContent("#status"), { timeout: 15_000 }).toMatch(/^Waiting for the GIF… \d+%$/);
    expect(copyRequests(l.copyLog), "nothing on the pasteboard before the GIF exists").toEqual([]);

    await expect.poll(() => copyRequests(l.copyLog).length, { timeout: 120_000 }).toBe(1);
    const out = join(l.copies, `${dir.split("/").pop()}.gif`);
    expect(copyRequests(l.copyLog)[0]!.path).toBe(out);
    expect(isGif(out)).toBe(true);
    await expect.poll(() => panel.textContent("#status"), { timeout: 15_000 }).toContain("Copied GIF");
    expect(await panel.textContent("#giflabel")).toMatch(READY);
    // The Copy joined the running job rather than starting a second one.
    expect(named(l.copies, ".gif")).toHaveLength(1);
    expect(named(l.copies, ".partial")).toEqual([]);
    expect(await windowCount(app!, "copy-render.html")).toBe(0);
  }, 300_000);

  test("Save in GIF mode keeps the take and writes <take>.gif to the save folder", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();

    await panel.click(GIF);
    await expect.poll(() => panel.textContent("#giflabel"), { timeout: 120_000 }).toMatch(READY);
    await clickThatCloses(panel, "[data-action=save]");

    // The take is kept: promoted into raw/, out of temp storage.
    await expect.poll(() => promoted(l.recordings).length, { timeout: 15_000 }).toBe(1);
    expect(existsSync(dir)).toBe(false);
    const take = promoted(l.recordings)[0]!;
    // And its GIF sits at the TOP level of the save folder, beside the library, not in raw/.
    await expect.poll(() => named(l.recordings, ".gif"), { timeout: 15_000 }).toEqual([`${take}.gif`]);
    expect(isGif(join(l.recordings, `${take}.gif`))).toBe(true);
    expect(named(l.recordings, ".partial")).toEqual([]);
    expect(named(join(l.recordings, RAW_SUBDIR), ".gif"), "no GIF inside raw/").toEqual([]);
    expect(copyRequests(l.copyLog), "Save is not Copy").toEqual([]);
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 15_000 }).toBe(0);
  }, 300_000);

  test("flipping back to Video mid-conversion cancels: no render window, no partial", async () => {
    const l = await launch();
    await recordAndStop(l);
    const panel = await readyPanel();

    await panel.click(GIF);
    await expect.poll(() => panel.isVisible("#copyprogress"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: 15_000 }).toBe(1);
    await panel.click(VIDEO);

    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: 15_000 }).toBe(0);
    await expect.poll(() => panel.isVisible("#giflabel"), { timeout: 15_000 }).toBe(false);
    // Past the 3 s delay: a render that survived the cancel would have written by now.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(named(l.copies, ".partial")).toEqual([]);
    expect(named(l.copies, ".gif")).toEqual([]);
    expect(await windowCount(app!, "copy-render.html")).toBe(0);
    expect(await checked(panel)).toBe("video");
    expect(await panel.isVisible("#copyprogress")).toBe(false);
    expect(await panel.isEnabled("[data-action=copy]")).toBe(true);
    expect(await panel.isEnabled("[data-action=save]")).toBe(true);
    expect(copyRequests(l.copyLog)).toEqual([]);
    expect(await windowCount(app!, "thumbnail.html"), "the switch never closes the panel").toBe(1);
  }, 300_000);

  test("GIF → Video → GIF quickly ends ready, with one GIF (Review Focus 4)", async () => {
    const l = await launch();
    const dir = await recordAndStop(l);
    const panel = await readyPanel();

    await panel.click(GIF);
    await panel.click(VIDEO);
    await panel.click(GIF);
    expect(await checked(panel)).toBe("gif");

    // The first job's late "cancelled" must not knock the second conversion back to Video.
    await expect.poll(() => panel.textContent("#giflabel"), { timeout: 120_000 }).toMatch(READY);
    expect(await checked(panel)).toBe("gif");
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: 15_000 }).toBe(0);
    expect(named(l.copies, ".gif")).toEqual([`${dir.split("/").pop()}.gif`]);
    expect(isGif(join(l.copies, named(l.copies, ".gif")[0]!))).toBe(true);
    expect(named(l.copies, ".partial")).toEqual([]);
    expect(copyRequests(l.copyLog)).toEqual([]);
  }, 300_000);

  test("Trash mid-conversion cancels it", async () => {
    const l = await launch();
    await recordAndStop(l);
    const panel = await readyPanel();

    await panel.click(GIF);
    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: 15_000 }).toBe(1);
    expect(await panel.isEnabled("[data-action=trash]"), "Trash stays live during a conversion").toBe(true);
    await clickThatCloses(panel, "[data-action=trash]");

    await expect.poll(() => windowCount(app!, "copy-render.html"), { timeout: 15_000 }).toBe(0);
    // Past the 3 s delay: a render that survived the Trash would have written by now.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(named(l.copies, ".gif")).toEqual([]);
    expect(named(l.copies, ".partial")).toEqual([]);
    expect(copyRequests(l.copyLog)).toEqual([]);
    expect(named(l.recordings, ".gif"), "nothing saved either").toEqual([]);
  }, 300_000);

  test("the switch is absent on a still's panel", async () => {
    const l = await launch();
    // The same still flow recording-panel.e2e uses.
    const shot = await l.win.evaluate(() => (window as any).recorder.captureStill("display"));
    expect(shot.ok).toBe(true);
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 15_000 }).toBe(1);
    const panel = await pageWithUrl(app!, "thumbnail.html", 15_000);
    await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className),
                       { timeout: 15_000 }).toContain("in");
    // A shot's panel: the picture, not the recording card (so the switch is not
    // merely hidden by its parent). The switch itself is hidden by `offersFormat`.
    expect(await panel.isVisible("#thumbwrap")).toBe(true);
    expect(await panel.evaluate(() => (document.getElementById("format") as HTMLElement).hidden)).toBe(true);
    expect(await panel.isVisible("#format")).toBe(false);
    expect(await panel.isVisible("#giflabel")).toBe(false);
  }, 300_000);
});
