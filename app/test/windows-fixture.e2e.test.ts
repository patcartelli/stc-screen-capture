import { test, expect, afterEach, describe } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { windowCount, windowUrls } from "./_windows.js";

/**
 * The count helper itself (STC-416): a window the MAIN process has is counted
 * whether or not Playwright has attached a Page to it yet.
 *
 * Measured on this machine (2026-09-19, three runs each, `_windows.ts` has the
 * table): a BrowserWindow that never loads a URL is NEVER listed by
 * `app.windows()`; one that does load is listed 78-147 ms after creation; a
 * destroyed one is still listed for ~25 ms. Every one of those is a window an
 * e2e assertion can be wrong about while reading as coverage, which is what
 * the ticket found. These two tests pin the discriminators that are
 * DETERMINISTIC — a never-loaded decoy (which Playwright never sees, so the
 * settle before the assertion is a real wait rather than a race) and a
 * destroy (which main sees synchronously). The attach lag itself is timing
 * and is not asserted on.
 */

const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(__dirname, "_fake-helper.mjs");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

async function launch(): Promise<ElectronApplication> {
  app = await electron.launch({
    args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: makeTakeFolder().dir,
      STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
      STC_NO_SHUTTER: "1",
    },
  });
  await app.firstWindow();
  return app;
}

describe("windowCount reads the main process, not Playwright's page list", () => {
  test("a window Playwright never attaches to is still counted", async () => {
    const a = await launch();
    const before = await windowCount(a);
    const pwBefore = a.windows().length;
    // A bare BrowserWindow with no URL — the exact decoy STC-392 planted.
    await a.evaluate(({ BrowserWindow }) => { new BrowserWindow({ show: false }); });
    expect(await windowCount(a)).toBe(before + 1);
    // Give Playwright every chance; it never sees this one, so the old way of
    // counting reads "nothing appeared" indefinitely.
    await new Promise((r) => setTimeout(r, 500));
    expect(a.windows().length).toBe(pwBefore);
    expect(await windowCount(a)).toBe(before + 1);
  }, 30_000);

  test("a url-scoped count drops the instant the window is destroyed", async () => {
    const a = await launch();
    await a.evaluate(({ BrowserWindow }) => {
      const w = new BrowserWindow({ show: false });
      void w.loadURL("about:blank#probe.html");
    });
    await expect.poll(() => windowCount(a, "probe.html"), { timeout: 5_000 }).toBe(1);
    expect(await windowUrls(a)).toContainEqual(expect.stringContaining("probe.html"));
    await a.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("probe.html"))!.destroy();
    });
    // No poll: the main process has no lag to wait out.
    expect(await windowCount(a, "probe.html")).toBe(0);
    expect(await windowUrls(a)).not.toContainEqual(expect.stringContaining("probe.html"));
  }, 30_000);
});
