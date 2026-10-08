import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { hasWindow } from "./_windows.js";

/**
 * The required-grants panel, wired (STC-476 MVP slice). The fake helper
 * reports the grants (`STC_FAKE_PERMISSIONS`), so this proves main reads them,
 * the panel draws them, a request goes to the helper, and a Record with a
 * grant missing opens NO overlay. Whether macOS's own prompts appear, and
 * whether TCC lists Capture (STC-518), is the VM's: `docs/STC-476-RUNBOOK.md`.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(permissions: string) {
  const cmdLog = join(mkdtempSync(join(tmpdir(), "stc-cmdlog-")), "cmds.txt");
  app = await electron.launch({
    args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
    cwd: root,
    env: {
      ...process.env,
      STC_ASSUME_PERMISSIONS: "",
      STC_RECORDINGS_DIR: mkdtempSync(join(tmpdir(), "stc-e2e-")),
      STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
      STC_FAKE_PERMISSIONS: permissions,
      STC_FAKE_CMD_LOG: cmdLog,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  const cmds = () => existsSync(cmdLog) ? readFileSync(cmdLog, "utf8").split("\n").filter(Boolean) : [];
  return { win, cmds };
}

const status = (win: any, grant: string) =>
  win.getAttribute(`#permissionrows .permrow[data-grant="${grant}"]`, "data-status");

describe("the required-grants panel (STC-476)", () => {
  test("a clean install: the panel is up, and Record opens no overlay", async () => {
    const { win, cmds } = await launch("0,unknown");
    await expect.poll(() => win.isVisible("#permissionsheet"), { timeout: 30_000 }).toBe(true);
    expect(await status(win, "screen-recording")).toBe("not-yet");
    expect(await status(win, "input-monitoring")).toBe("not-yet");

    // No way to close it (VM pass, 2026-10-08).
    expect(await win.locator("#permissionsheet button[aria-label='Close']").count()).toBe(0);
    // Record through the same IPC the (now covered) button uses, and through
    // the hotkey/menu door's code: refused, the panel stays, no overlay.
    const r = await win.evaluate(() => (window as any).recorder.start());
    expect(r).toMatchObject({ ok: false, code: "permissions-needed" });
    expect(await win.isVisible("#permissionsheet")).toBe(true);
    expect(await hasWindow(app!, "overlay")).toBe(false);
    expect(cmds()).not.toContain("windows");
    expect(cmds()).not.toContain("start");
  }, 120_000);

  test("Grant on Input Monitoring asks the helper and the row turns granted", async () => {
    const { win, cmds } = await launch("1,unknown");
    await expect.poll(() => win.isVisible("#permissionsheet"), { timeout: 30_000 }).toBe(true);
    expect(await status(win, "screen-recording")).toBe("granted");
    await win.click('#permissionrows .permrow[data-grant="input-monitoring"] button[data-action="request"]');
    await expect.poll(() => status(win, "input-monitoring"), { timeout: 15_000 }).toBe("granted");
    expect(cmds()).toContain("request-permission");
    await expect.poll(() => win.isVisible("#permissionsheet")).toBe(false);
  }, 120_000);

  test("Grant on Screen Recording never claims success before a relaunch", async () => {
    const { win } = await launch("0,granted");
    await expect.poll(() => win.isVisible("#permissionsheet"), { timeout: 30_000 }).toBe(true);
    await win.click('#permissionrows .permrow[data-grant="screen-recording"] button[data-action="request"]');
    await expect.poll(() => status(win, "screen-recording"), { timeout: 15_000 }).toBe("denied");
    const actions = await win.$$eval(
      '#permissionrows .permrow[data-grant="screen-recording"] button',
      (bs) => bs.map((b) => (b as HTMLElement).dataset.action));
    expect(actions).toEqual(["open-settings", "relaunch"]);
  }, 120_000);

  test("everything granted: no panel at all", async () => {
    const { win, cmds } = await launch("1,granted");
    await expect.poll(() => cmds().includes("permissions"), { timeout: 30_000 }).toBe(true);
    expect(await win.isVisible("#permissionsheet")).toBe(false);
  }, 120_000);
});
