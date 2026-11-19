import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { makeTakeFolder } from "./_take-fixture.js";
import { launchApp } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { windowCount } from "./_windows.js";

/**
 * STC-466: nothing in this app guarded `will-navigate`, `window.open`, or a
 * permission request, on ANY window — checked here through the main window,
 * which is the one every e2e fixture already launches. The fix is a single
 * `app.on("web-contents-created", ...)` covering every window from one
 * place, so proving it here is proving it everywhere it is wired: there is
 * no per-window branch that could have been missed for the main window and
 * caught for another.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

describe("web-contents-created guard (STC-466)", () => {
  test("denies window.open from the renderer — no new window is created", async () => {
    const { dir } = makeTakeFolder();
    const { app: a, win } = await launchApp(dir);
    app = a;
    const before = await windowCount(a);

    const openedNull = await win.evaluate(() => window.open("https://example.com/", "_blank") === null);
    expect(openedNull).toBe(true);

    // Settle, then count exactly — `windowCount` with no url scope is the
    // strong "nothing appeared" read `_windows.ts`'s own header recommends.
    await new Promise((r) => setTimeout(r, 300));
    expect(await windowCount(a)).toBe(before);
  }, 60_000);

  test("denies a page-initiated navigation away from the app's own page", async () => {
    const { dir } = makeTakeFolder();
    const { app: a, win } = await launchApp(dir);
    app = a;
    const before = win.url();

    // A page-initiated `location` change goes through `will-navigate`; this
    // process's own `loadFile`/`loadURL` calls do not (main.ts's own comment
    // at the guard), which is exactly why this has to be exercised from the
    // PAGE side to mean anything.
    await win.evaluate(() => { location.href = "https://example.com/"; }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    expect(win.url()).toBe(before);
    expect(win.isClosed()).toBe(false);
  }, 60_000);

  // STC-466 review follow-up: the guard's first cut denied every permission
  // request unconditionally, which would have silently broken the editor's
  // Publish flow (`editor.ts`'s `navigator.clipboard.writeText`) — the one
  // Electron permission this app's renderers actually use. This drives the
  // real web API through the real permission-request handler rather than
  // asserting on the handler's source, since the whole point is to catch a
  // regression a static read of the code could miss.
  test("allows a clipboard write from the renderer — the guard is not a bare deny-all", async () => {
    const { dir } = makeTakeFolder();
    const { app: a, win } = await launchApp(dir);
    app = a;

    // STC-658: the one write no seam can redirect. `STC_PASTEBOARD` points the
    // helper and main at a private pasteboard, but Chromium's
    // `navigator.clipboard` always writes the system one, and the point here
    // is the real web API through the real permission handler. So the test
    // puts back what the person had: text, HTML, RTF and an image, the formats
    // Electron can read and write back together. Anything else (a file copied
    // in the Finder, say) is not restored, which is why this stays the only
    // renderer clipboard write in the suite.
    const saved = await a.evaluate(({ clipboard }) => {
      const image = clipboard.readImage();
      return {
        text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(),
        png: image.isEmpty() ? "" : image.toPNG().toString("base64"),
      };
    });
    let wrote = false;
    try {
      wrote = await win.evaluate(async () => {
        try { await navigator.clipboard.writeText("stc-466 clipboard probe"); return true; }
        catch { return false; }
      });
    } finally {
      await a.evaluate(({ clipboard, nativeImage }, s) => {
        clipboard.clear();
        clipboard.write({
          ...(s.text ? { text: s.text } : {}), ...(s.html ? { html: s.html } : {}),
          ...(s.rtf ? { rtf: s.rtf } : {}),
          ...(s.png ? { image: nativeImage.createFromBuffer(Buffer.from(s.png, "base64")) } : {}),
        });
      }, saved);
    }
    expect(wrote).toBe(true);
  }, 60_000);
});
