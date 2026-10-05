import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The Settings sheet's Camera subsection (STC-461): the shared PiP inspector
 * over a mock 16:9 frame, saving Settings.pipStyle as the default for new
 * camera takes. No Reframe and no Show camera here — framing is per take.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const FILE = "settings.json"; // settings.ts's FILE

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(opts: { userData: string; recordings: string }) {
  app = await electron.launch({
    args: [root, `--user-data-dir=${opts.userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: opts.recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await withoutCountdown(win);
  return win;
}

function readStoredSettings(dir: string): { pipStyle?: { shape?: string } } {
  return JSON.parse(readFileSync(join(dir, FILE), "utf8"));
}

describe("the Settings sheet's Camera subsection", () => {
  test("the Circle preset in Settings becomes the stored default", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const win = await launch({ userData, recordings: makeTakeFolder().dir });
    await win.click("#settings");
    await expect.poll(() => win.getAttribute("#profilesheet", "class")).toMatch(/open/);
    await win.click('#pipsettings [data-pip-preset="circle"]');
    await expect.poll(() => readStoredSettings(userData).pipStyle?.shape, { timeout: 10_000 }).toBe("circle");
  });

  test("Settings has no Reframe and no Show camera", async () => {
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: makeTakeFolder().dir });
    await win.click("#settings");
    await expect.poll(() => win.getAttribute("#profilesheet", "class")).toMatch(/open/);
    expect(await win.locator("#pipsettings #pipreframe").count()).toBe(0);
    expect(await win.locator("#pipsettings #pipenabled").count()).toBe(0);
    expect(await win.locator("#pipmock #pipmockbox").count()).toBe(1);
  });
});
