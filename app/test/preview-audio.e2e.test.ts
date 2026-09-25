import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, openEditorFromLibrary } from "./_editor-fixture.js";
import { makeTakeFolder, makeMicTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The editor preview's sound (STC-454), wired. What a person HEARS — sync,
 * clicks at chunk joins, whether 1x-only feels right — needs a Mac and real
 * audio: docs/STC-454-RUNBOOK.md. What is checked here is what the pure
 * tests cannot see:
 *
 * - the speaker button appears only for a take that has audio;
 * - a track that will not decode costs the preview its SOUND, never its
 *   picture (the fixture's mic.m4a is a valid AAC container over
 *   placeholder bytes — Linux has no AAC encoder to make a real one);
 * - mute is an app setting: it survives a restart and is never a take edit;
 * - the cleanup worker loads under the editor's CSP and cleans a track sent
 *   to it — bundling, `worker-src`, and the message shape, end to end.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openEditor(dir: string, userData?: string): Promise<Page> {
  const launched = await launchApp(dir, {}, { userData });
  app = launched.app;
  const editorWin = await openEditorFromLibrary(app, launched.win);
  await editorWin.waitForSelector("#stage", { timeout: 20_000 });
  await expect.poll(() => editorWin.textContent("#clock"), { timeout: 20_000 }).toMatch(/\d/);
  return editorWin;
}

const audioState = (win: Page) => win.getAttribute("#previewaudio", "data-state");

describe("preview sound", () => {
  test("a take with no audio shows no speaker", async () => {
    const { dir } = makeTakeFolder();
    const win = await openEditor(dir);
    expect(await audioState(win)).toBe("none");
    expect(await win.getAttribute("#previewaudio", "hidden")).not.toBeNull();
  }, 120_000);

  test("with sound ready, 1x plays on the AUDIO clock and 2x falls back to the wall clock", async () => {
    // The fixture's placeholder AAC frames decode (to near-silence) in
    // Chromium, so the whole path runs here: decode, PreviewAudio, the
    // AudioContext, and the player following its clock.
    const { dir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => audioState(win), { timeout: 30_000 }).toBe("ready");
    const before = await win.textContent("#clock-cur");
    await win.click("#playpause");
    await expect.poll(() => win.getAttribute("#stage", "data-clock"), { timeout: 10_000 }).toBe("audio");
    // ...and the picture moves on it.
    await expect.poll(() => win.textContent("#clock-cur"), { timeout: 10_000 }).not.toBe(before);
    // L steps the shuttle to 2x: no sound there (Patrick: 1x only), so the
    // wall clock. Read WHILE 2x is still playing: the fixture is ~5 s, and a
    // take that has run off its end is paused and back on the wall clock
    // whatever the rule says — the first draft of this test passed that way
    // with the rule broken. Home first, so 2x has the whole take to run in,
    // and a wait past SEEK_SETTLE_MS so the seek's own silence is over.
    // Home is a seek, and a seek pauses the shuttle; from stopped, L twice is 2x.
    await win.keyboard.press("Home");
    await win.keyboard.press("l");
    await win.keyboard.press("l");
    await expect.poll(() => win.textContent("#shuttle")).toBe("2x");
    await win.waitForTimeout(300);
    const during = await win.evaluate(() => ({
      clock: document.getElementById("stage")!.dataset.clock,
      shuttle: document.getElementById("shuttle")!.textContent,
      playing: document.getElementById("playpause")!.getAttribute("aria-label"),
    }));
    expect(during.shuttle).toBe("2x");
    expect(during.playing).toBe("Pause");
    expect(during.clock).toBe("wall");
    await win.keyboard.press("k");
  }, 120_000);

  test("a mic track that will not decode costs the sound, not the picture", async () => {
    const { dir } = makeMicTakeFolder(undefined, { undecodable: true });
    const win = await openEditor(dir);
    await expect.poll(() => audioState(win), { timeout: 30_000 }).toBe("unavailable");
    expect(await win.getAttribute("#previewaudio", "title")).toMatch(/unavailable/i);
    const before = await win.textContent("#clock-cur");
    await win.click("#playpause");
    await expect.poll(() => win.textContent("#clock-cur"), { timeout: 10_000 }).not.toBe(before);
    expect(await win.getAttribute("#stage", "data-clock")).toBe("wall");
    await win.click("#playpause");
  }, 120_000);

  test("mute is an app setting: it toggles, and a restart keeps it", async () => {
    const { dir } = makeMicTakeFolder();
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null }));
    let win = await openEditor(dir, userData);
    await expect.poll(() => audioState(win), { timeout: 30_000 }).not.toBe("loading");
    expect(await win.getAttribute("#previewaudio", "aria-pressed")).toBe("false");
    // Unavailable disables the button; drive the setting through the page
    // the way a click on a working one would, so persistence is what is tested.
    await win.evaluate(() => (window as any).editor.setPreviewMuted(true));
    const a = app; app = undefined; await closeApp(a);

    win = await openEditor(dir, userData);
    await expect.poll(() => win.getAttribute("#previewaudio", "aria-pressed"), { timeout: 10_000 }).toBe("true");
    expect(await win.getAttribute("#previewaudio", "aria-label")).toBe("Unmute preview sound");
  }, 180_000);

  test("the speaker button's click flips aria-pressed and the label", async () => {
    const { dir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => audioState(win), { timeout: 30_000 }).not.toBe("loading");
    // Enable it for the click itself (it is disabled only because this
    // fixture's audio cannot decode); the handler is the one a real take uses.
    await win.evaluate(() => { (document.getElementById("previewaudio") as HTMLButtonElement).disabled = false; });
    const start = await win.getAttribute("#previewaudio", "aria-pressed");
    await win.click("#previewaudio");
    await expect.poll(() => win.getAttribute("#previewaudio", "aria-pressed")).toBe(start === "true" ? "false" : "true");
    await win.click("#previewaudio");
    await expect.poll(() => win.getAttribute("#previewaudio", "aria-pressed")).toBe(start);
  }, 120_000);

  test("the cleanup worker loads under the editor's CSP and cleans what it is sent", async () => {
    const { dir } = makeTakeFolder();
    const win = await openEditor(dir);
    const result = await win.evaluate(async () => {
      const rate = 48_000, n = rate;
      let seed = 7;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
      // Half a second of tone, half a second of pause, all over hiss.
      const x = Float32Array.from({ length: n }, (_, i) =>
        (i < n / 2 ? 0.1 * Math.sin((2 * Math.PI * 200 * i) / rate) : 0) + rnd() * 0.005);
      const sentLength = x.length;
      const pause = (a: Float32Array) => {
        let e = 0;
        for (let i = Math.floor(n * 0.7); i < Math.floor(n * 0.95); i++) e += a[i]! * a[i]!;
        return e;
      };
      // Measured BEFORE the post: transferring the buffer empties `x`.
      const pauseBefore = pause(x);
      const w = new Worker("../dist/narration-worker.js");
      const reply = await new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("worker did not answer in 20 s")), 20_000);
        w.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
        w.onerror = (e) => { clearTimeout(t); reject(new Error(`worker error: ${e.message}`)); };
        w.postMessage({ id: 1, strength: 0.5, track: { startNs: 5, sampleRate: rate, channels: [x] } }, [x.buffer]);
      });
      w.terminate();
      const out: Float32Array = reply.track.channels[0];
      return {
        id: reply.id, error: reply.error, startNs: reply.track.startNs,
        length: out.length, sentLength, finite: out.every(Number.isFinite),
        // Cleaned: the hiss in the pause drops (by the floor, ~11 dB at 0.5).
        pauseQuieter: pause(out) < pauseBefore / 4,
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.id).toBe(1);
    expect(result.startNs).toBe(5);
    expect(result.length).toBe(result.sentLength);
    expect(result.finite).toBe(true);
    expect(result.pauseQuieter).toBe(true);
  }, 120_000);
});

