import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { windowCount, pageWithUrl } from "./_windows.js";
import { toastText } from "./_toast.js";

/**
 * The helper dies mid-take (STC-530).
 *
 * `_fake-helper.mjs`'s `STC_FAKE_DIE_MS` writes a playable display.mp4 and an
 * anchors.partial.json (from fixtures/basic) and SIGKILLs itself, the shape
 * `kill -9` leaves. The supervisor respawns the stand-in afterwards; that is
 * expected and irrelevant here.
 *
 * Takes are started through `startRecordFlow`, windows counted through
 * `_windows.ts`, the toast read through `_toast.ts` — the mechanisms every
 * other e2e file in this suite uses (modelled on recording-panel.e2e.test.ts).
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(extraEnv: Record<string, string>): Promise<Page> {
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
      STC_HELPER_BIN: FAKE_HELPER, STC_OVERLAY_SYNTHETIC_INPUT: "1", STC_NO_SHUTTER: "1",
      ...extraEnv,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#titlebar");
  await withoutCountdown(win);
  return win;
}

describe("the helper dies mid-take (STC-530)", () => {
  test("the take comes back as a panel with the reason, and no 'not saved' toast", async () => {
    const win = await launch({ STC_FAKE_DIE_MS: "1500" });
    await startRecordFlow(app!, win);
    await expect.poll(() => windowCount(app!, "thumbnail.html"), { timeout: 20_000 }).toBe(1);
    const panel = await pageWithUrl(app!, "thumbnail.html");
    await panel.waitForLoadState("domcontentloaded");
    await expect.poll(() => panel.textContent("#takereason"), { timeout: 15_000 })
      .toBe("Capture's recorder quit unexpectedly. This is what was saved before it stopped. Cursor and event data are missing.");
    // Sampled over time, not read once: main presents the panel FIRST and sends
    // helper:recording-lost after, so a toast raised by that send arrives late.
    for (let i = 0; i < 12; i++) {
      expect(await toastText(app!)).not.toMatch(/not saved|couldn't be recovered/);
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 240_000);

  test("the helper dies before writing anything: the toast says so and no panel appears", async () => {
    const win = await launch({ STC_FAKE_DIE_MS: "1500", STC_FAKE_DIE_NO_PARTIAL: "1" });
    await startRecordFlow(app!, win);
    await expect.poll(() => toastText(app!), { timeout: 20_000 })
      .toContain("The recorder quit while recording, and the take couldn't be recovered.");
    expect(await windowCount(app!, "thumbnail.html")).toBe(0);
  }, 240_000);
});
