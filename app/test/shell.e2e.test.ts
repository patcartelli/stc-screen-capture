import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutCountdown } from "./_countdown-fixture.js";
import { PRODUCT_NAME } from "../src/product.js";
import { toastPage } from "./_toast.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { startRecordFlow } from "./_record-flow.js";

const root = join(__dirname, "..", "..");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch() {
  // The bundle is built once in vitest.global-setup.ts. Building it here
  // raced every other suite doing the same on app/dist/ — see that file.
  // Never write takes to the real ~/Desktop/stc from an automated run.
  // STC-403: isolated from the developer's real settings too, same as every
  // other fixture — this used to load the real ~/Library/.../settings.json.
  app = await electron.launch({
    args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`], cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: mkdtempSync(join(tmpdir(), "stc-e2e-")),
      STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_OVERLAY_SYNTHETIC_INPUT: "1",
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  // STC-391: Record counts down now. This file is not about the countdown,
  // so it turns it off through the shipped preference rather than waiting
  // out three real seconds on every take.
  await withoutCountdown(win);
  return win;
}

describe("Electron shell", () => {
  test("launches, spawns the helper, and reports it ready", async () => {
    const win = await launch();
    await expect.poll(() => win.textContent("#pid"), { timeout: 20_000 })
      .toMatch(/^\d+$/);                                  // a real helper pid
    expect(await win.textContent("#state")).toBe("idle");
    expect(await win.textContent("h1")).toBe(PRODUCT_NAME);
  }, 60_000);

  test("live stats arrive from the lossy channel while idle", async () => {
    const win = await launch();
    await expect.poll(() => win.textContent("#pid"), { timeout: 20_000 }).toMatch(/^\d+$/);
    // The heartbeat runs from boot, so an idle helper is observably alive even
    // though it reports no frame counts (there is no capture session yet).
    await expect.poll(() => win.textContent("#alive"), { timeout: 15_000 }).toBe("idle");
  }, 60_000);

  test("the record button reports a missing grant in actionable terms", async () => {
    const win = await launch();
    await expect.poll(() => win.textContent("#pid"), { timeout: 20_000 }).toMatch(/^\d+$/);
    // STC-388: `#record` opens the overlay; the bar's own Record starts the take.
    await startRecordFlow(app!, win);
    // Either it records (granted) or it explains itself (not granted) —
    // what it must never do is fail silently or hang the button.
    await expect.poll(async () =>
      (await win.textContent("#state")) === "recording" ||
      ((await toastPage(app!)) !== undefined), { timeout: 30_000 }).toBe(true);

    const toast = await toastPage(app!);
    if (toast) {
      const msg = await toast.textContent("#label");
      expect(msg).toMatch(/Screen Recording permission|Could not start/);
      expect(await win.locator("#record").isDisabled()).toBe(false);  // still usable
    } else {
      expect(await win.textContent("#record")).toBe("Stop");
    }
  }, 90_000);
});
