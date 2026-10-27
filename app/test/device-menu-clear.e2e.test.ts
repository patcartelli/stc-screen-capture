import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { closeApp, APP_CLOSE_MS, stubQuitDialog } from "./_quit-fixture.js";

/**
 * Click-to-clear and the system-audio switch, end to end through the main
 * window's device popovers (STC-583). The bar's menus share the same row model
 * and are pinned in record-flow.e2e.test.ts.
 *
 * - Pressing the row that is ALREADY selected clears it: a mic goes to none
 *   (muted), a camera goes off. Pressing a different row still switches.
 * - "Include System Audio" is a switch row, not a check row: it flips in
 *   place, keeps the menu open and is written back.
 *
 * The helper stand-in lists the devices and captures nothing.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const MICS = [
  { name: "Mic A", uid: "mic-a", bluetooth: false },
  { name: "Mic B", uid: "mic-b", bluetooth: false },
];
const CAMERAS = [
  { name: "Cam A", uid: "cam-a" },
  { name: "Cam B", uid: "cam-b" },
];

async function launch(userData = mkdtempSync(join(tmpdir(), "stc-ud-"))): Promise<{ win: Page; userData: string }> {
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: makeTakeFolder().dir, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
      STC_FAKE_MICS: JSON.stringify(MICS), STC_FAKE_CAMERAS: JSON.stringify(CAMERAS),
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await withoutCountdown(win);
  return { win, userData };
}

const settingsOf = (userData: string): any => JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));

/** Opens a popover and waits for its rows: the list arrives from an async `devices()` round trip. */
async function openMenu(win: Page, trigger: "#mic-picker" | "#camera-picker", expectRows: number) {
  await win.click(trigger);
  const rows = win.locator("#devicepopover .row");
  await expect.poll(() => rows.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(expectRows);
  return rows;
}

/** The row whose label is exactly this text (the row, not its inner span: `aria-checked` lives on the row). */
const rowLabelled = (win: Page, label: string) =>
  win.locator("#devicepopover .row").filter({ has: win.locator(".label", { hasText: new RegExp(`^${label}$`) }) });

describe("click-to-clear in the device popovers (STC-583)", () => {
  test("pressing the selected mic clears it: muted, closed, written back; system audio is untouched", async () => {
    const { win, userData } = await launch();
    await win.evaluate(() => (window as any).recorder.setSettings({ systemAudio: true }));

    await openMenu(win, "#mic-picker", 4);   // system audio, Mute External, Mic A, Mic B
    await rowLabelled(win, "Mic A").click();
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 }).toBe("Mic A");
    await expect.poll(() => settingsOf(userData).micDeviceUid, { timeout: 20_000 }).toBe("mic-a");

    // The popover closed on the pick. Open it again: Mic A carries the check.
    await openMenu(win, "#mic-picker", 4);
    expect(await rowLabelled(win, "Mic A").getAttribute("aria-checked")).toBe("true");

    await rowLabelled(win, "Mic A").click();   // press the SELECTED row
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 }).toBe("off");
    await expect.poll(() => settingsOf(userData).micDeviceUid, { timeout: 20_000 }).toBeNull();
    expect(await win.isHidden("#devicepopover"), "a choice closes the menu, a clear included").toBe(true);
    expect(settingsOf(userData).systemAudio, "clearing the mic leaves system audio alone").toBe(true);

    // And the cleared state is what the menu now shows: Mute External holds the check.
    await openMenu(win, "#mic-picker", 4);
    expect(await rowLabelled(win, "Mute External").getAttribute("aria-checked")).toBe("true");
    expect(await rowLabelled(win, "Mic A").getAttribute("aria-checked")).toBe("false");
  }, 180_000);

  test("pressing a DIFFERENT mic switches to it; pressing that one clears it", async () => {
    const { win, userData } = await launch();
    await openMenu(win, "#mic-picker", 4);
    await rowLabelled(win, "Mic A").click();
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 }).toBe("Mic A");

    await openMenu(win, "#mic-picker", 4);
    await rowLabelled(win, "Mic B").click();
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 }).toBe("Mic B");
    await expect.poll(() => settingsOf(userData).micDeviceUid, { timeout: 20_000 }).toBe("mic-b");

    await openMenu(win, "#mic-picker", 4);
    await rowLabelled(win, "Mic B").click();
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 }).toBe("off");
  }, 180_000);

  test("pressing Mute External while already muted stays muted", async () => {
    const { win, userData } = await launch();
    await expect.poll(() => win.textContent("#mic-state"), { timeout: 20_000 }).toBe("off");
    await openMenu(win, "#mic-picker", 4);
    await rowLabelled(win, "Mute External").click();
    await expect.poll(() => win.textContent("#mic-state")).toBe("off");
    expect(settingsOf(userData).micDeviceUid ?? null).toBeNull();
  }, 180_000);

  test("pressing the selected camera turns it off and remembers which one for next time", async () => {
    const { win, userData } = await launch();
    await expect.poll(() => win.textContent("#camera-state"), { timeout: 20_000 }).toBe("off");
    await openMenu(win, "#camera-picker", 4);   // No Camera, Automatic, Cam A, Cam B
    await rowLabelled(win, "Cam A").click();
    await expect.poll(() => win.textContent("#camera-state"), { timeout: 20_000 }).toBe("Cam A");
    expect(settingsOf(userData)).toMatchObject({ camera: true, cameraDeviceUid: "cam-a" });

    await openMenu(win, "#camera-picker", 4);
    expect(await rowLabelled(win, "Cam A").getAttribute("aria-checked")).toBe("true");
    await rowLabelled(win, "Cam A").click();   // press the SELECTED row
    await expect.poll(() => win.textContent("#camera-state"), { timeout: 20_000 }).toBe("off");
    await expect.poll(() => settingsOf(userData), { timeout: 20_000 }).toMatchObject({ camera: false, cameraDeviceUid: "cam-a" });
  }, 180_000);

  test("pressing Automatic while it is selected turns the camera off", async () => {
    const { win, userData } = await launch();
    await openMenu(win, "#camera-picker", 4);
    await rowLabelled(win, "Automatic").click();
    await expect.poll(() => win.textContent("#camera-state"), { timeout: 20_000 }).toBe("automatic");

    await openMenu(win, "#camera-picker", 4);
    await rowLabelled(win, "Automatic").click();
    await expect.poll(() => win.textContent("#camera-state"), { timeout: 20_000 }).toBe("off");
    await expect.poll(() => settingsOf(userData).camera, { timeout: 20_000 }).toBe(false);
  }, 180_000);

  test("a camera that is only REMEMBERED while the camera is off is not selected: pressing it turns the camera on", async () => {
    const { win, userData } = await launch();
    await win.evaluate(() => (window as any).recorder.setSettings({ camera: false, cameraDeviceUid: "cam-b" }));
    await openMenu(win, "#camera-picker", 4);
    expect(await rowLabelled(win, "Cam B").getAttribute("aria-checked")).toBe("false");
    await rowLabelled(win, "Cam B").click();
    await expect.poll(() => win.textContent("#camera-state"), { timeout: 20_000 }).toBe("Cam B");
    expect(settingsOf(userData)).toMatchObject({ camera: true, cameraDeviceUid: "cam-b" });
  }, 180_000);
});

describe("Include System Audio is a switch (STC-583)", () => {
  test("it is the first row, a switch with no check mark, and flips in place without closing the menu", async () => {
    const { win, userData } = await launch();
    const rows = await openMenu(win, "#mic-picker", 3);
    const first = rows.first();
    expect(await first.textContent()).toContain("Include System Audio");
    expect(await first.getAttribute("role")).toBe("switch");
    expect(await first.locator(".sw").count(), "it draws a switch").toBe(1);
    expect(await first.locator(".check").count(), "and no check mark").toBe(0);
    expect(await first.getAttribute("aria-checked")).toBe("false");

    await first.click();
    await expect.poll(() => rows.first().getAttribute("aria-checked"), { timeout: 20_000 }).toBe("true");
    expect(await win.isHidden("#devicepopover"), "a toggle keeps the menu open").toBe(false);
    await expect.poll(() => settingsOf(userData).systemAudio, { timeout: 20_000 }).toBe(true);

    await rows.first().click();   // and off again: a switch flips both ways
    await expect.poll(() => rows.first().getAttribute("aria-checked"), { timeout: 20_000 }).toBe("false");
    await expect.poll(() => settingsOf(userData).systemAudio, { timeout: 20_000 }).toBe(false);
  }, 180_000);

  test("device rows beside it stay radios with a check, so only the toggle is a switch", async () => {
    const { win } = await launch();
    const rows = await openMenu(win, "#mic-picker", 3);
    const device = rowLabelled(win, "Mic A");
    expect(await device.getAttribute("role")).toBe("menuitemradio");
    expect(await device.locator(".check").count()).toBe(1);
    expect(await device.locator(".sw").count()).toBe(0);
    expect(await rows.count()).toBe(4);
  }, 180_000);

  test("the switch is reachable and operable from the keyboard", async () => {
    const { win, userData } = await launch();
    const rows = await openMenu(win, "#mic-picker", 3);
    await rows.first().focus();
    await win.keyboard.press("Enter");
    await expect.poll(() => settingsOf(userData).systemAudio, { timeout: 20_000 }).toBe(true);
    // The popover rebuilds its rows on a change, which drops focus (as it always has),
    // so focus the row again before the second key.
    await expect.poll(() => rows.first().getAttribute("aria-checked"), { timeout: 20_000 }).toBe("true");
    await rows.first().focus();
    await win.keyboard.press("Space");
    await expect.poll(() => settingsOf(userData).systemAudio, { timeout: 20_000 }).toBe(false);
  }, 180_000);
});
