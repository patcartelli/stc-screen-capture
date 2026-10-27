import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { openSettings, pickDropdown } from "./_settings-window.js";
import { formatAccelerator } from "../src/hotkeys.js";
import { windowCount } from "./_windows.js";

/**
 * The Settings window (STC-581): its own 760 x 560 window with a five-pane
 * sidebar, replacing the library's slide-over sheet. What each control writes
 * is unchanged from the sheet; these tests pin where it lives now, that the
 * library no longer carries any of it, and the one thing that crosses windows
 * (Show diagnostics drives the library's table).
 *
 * The pixels are Figma's to judge, on a Mac: docs/STC-581-RUNBOOK.md.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

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

const fresh = () => ({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: makeTakeFolder().dir });
const settingsJson = (userData: string) => JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));

describe("the Settings window", () => {
  test("the gear opens it as its own window, once, with the five panes in order", async () => {
    const win = await launch(fresh());
    const settings = await openSettings(app!, win);
    expect(await settings.locator("#sidebar button").allTextContents())
      .toEqual(["Capture", "Camera", "Shortcuts", "Output", "Advanced"]);
    expect(await settings.getAttribute('#sidebar button[data-pane="capture"]', "aria-current")).toBe("page");
    expect(await settings.textContent("#titlebar")).toBe("Capture");
    // Asking again brings the same window forward rather than making another.
    await win.click("#settings");
    await expect.poll(() => windowCount(app!, "settings.html")).toBe(1);
    // The library carries none of it any more, Source (STC-581) included.
    for (const id of ["profilesheet", "display", "scope", "shortcuts", "pipsettings", "giffps"]) {
      expect(await win.locator(`#${id}`).count(), id).toBe(0);
    }
  }, 60_000);

  test("each pane holds its Figma sections, and only its own pane shows", async () => {
    const win = await launch(fresh());
    const settings = await openSettings(app!, win);
    const sections: Record<string, string[]> = {
      capture: ["App", "After a shot", "Recording"],
      camera: ["Preview", "Shape", "Style"],
      shortcuts: ["Shots", "Recording"],
      output: ["Locations", "Storage", "GIF"],
      advanced: ["Diagnostics"],
    };
    for (const [pane, headings] of Object.entries(sections)) {
      await settings.click(`#sidebar button[data-pane="${pane}"]`);
      expect(await settings.locator(`#pane-${pane} h2`).allTextContents(), pane).toEqual(headings);
      expect(await settings.locator(".pane:not([hidden])").count(), pane).toBe(1);
      expect(await settings.isVisible(`#pane-${pane}`), pane).toBe(true);
    }
  }, 60_000);

  test("Record is its own group, after the shots", async () => {
    const win = await launch(fresh());
    const settings = await openSettings(app!, win, "shortcuts");
    await expect.poll(() => settings.locator("#shortcuts-recording .shortcut").count(), { timeout: 10_000 }).toBe(1);
    expect(await settings.locator("#shortcuts-recording #shortcut-record").count()).toBe(1);
    expect(await settings.locator("#shortcuts-shots #shortcut-record").count()).toBe(0);
    expect(await settings.locator("#shortcuts-shots .shortcut").count()).toBe(4);
    expect(await settings.textContent("#pane-shortcuts .note"))
      .toBe("Registered means Capture holds the key. Another app can still share it.");
  }, 60_000);

  test("Show diagnostics in Settings shows the library's table", async () => {
    const win = await launch(fresh());
    expect(await win.locator("#diagnostics").isHidden()).toBe(true);
    const settings = await openSettings(app!, win, "advanced");
    await settings.check("#showdiagnostics");
    await expect.poll(() => win.locator("#diagnostics").isVisible(), { timeout: 10_000 }).toBe(true);
    await settings.uncheck("#showdiagnostics");
    await expect.poll(() => win.locator("#diagnostics").isHidden(), { timeout: 10_000 }).toBe(true);
  }, 60_000);

  test("the save location names the real resolved path, and the site folder reads Not set", async () => {
    const opts = fresh();
    const win = await launch(opts);
    const settings = await openSettings(app!, win, "output");
    // With `saveFolder` unset, this fixture's STC_RECORDINGS_DIR IS the
    // resolved default: main answered, the page invented nothing.
    await expect.poll(() => settings.textContent("#stilldest"), { timeout: 10_000 }).toBe(opts.recordings);
    await expect.poll(() => settings.textContent("#sitedest"), { timeout: 10_000 }).toBe("Not set");
  }, 60_000);

  test("STC-395: the GIF rows persist frame rate and max width", async () => {
    const opts = fresh();
    const win = await launch(opts);
    const settings = await openSettings(app!, win, "output");
    await pickDropdown(settings, "giffps", "30");
    await pickDropdown(settings, "gifwidth", "original");
    await expect.poll(() => settingsJson(opts.userData).gif, { timeout: 15_000 })
      .toEqual({ fps: 30, maxWidth: "original" });
  }, 60_000);

  // "5 or more options: dropdown, the record bar component" (Row pattern spec):
  // the record bar's own menu and row builder, never a native <select>.
  test("the dropdowns are the record bar's menu, not native selects", async () => {
    const opts = fresh();
    const win = await launch(opts);
    const settings = await openSettings(app!, win);
    expect(await settings.locator("select").count()).toBe(0);
    await expect.poll(() => settings.textContent("#thumbcorner"), { timeout: 10_000 }).toBe("Bottom right");
    await settings.click("#thumbcorner");
    const menu = settings.locator("#settings-menu");
    expect(await menu.getAttribute("class")).toContain("device-menu");
    expect(await settings.getAttribute("#thumbcorner", "aria-expanded")).toBe("true");
    expect(await menu.locator(".row").allTextContents())
      .toEqual(["Bottom right", "Bottom left", "Top right", "Top left"]);
    // The chosen row is checked, and the menu's rows carry no icon.
    expect(await menu.locator('.row[aria-checked="true"]').getAttribute("data-key")).toBe("bottom-right");
    expect(await menu.locator(".row svg:not(.check)").count()).toBe(0);
    await settings.click('#settings-menu .row[data-key="top-left"]');
    expect(await menu.isHidden()).toBe(true);
    expect(await settings.textContent("#thumbcorner")).toBe("Top left");
    await expect.poll(() => settingsJson(opts.userData).thumbnail?.corner, { timeout: 15_000 }).toBe("top-left");
  }, 60_000);

  test("a dropdown works from the keyboard, and Escape closes it without a change", async () => {
    const opts = fresh();
    const win = await launch(opts);
    const settings = await openSettings(app!, win, "output");
    await expect.poll(() => settings.getAttribute("#giffps", "data-value"), { timeout: 10_000 }).not.toBe("");
    const before = await settings.getAttribute("#giffps", "data-value");
    await settings.focus("#giffps");
    await settings.keyboard.press("ArrowDown");
    expect(await settings.isVisible("#settings-menu")).toBe(true);
    await settings.keyboard.press("Escape");
    expect(await settings.isHidden("#settings-menu")).toBe(true);
    expect(await settings.getAttribute("#giffps", "data-value")).toBe(before);
    // Focus is back on the trigger, so Enter opens it again; a down-arrow and
    // Enter pick the next option.
    expect(await settings.evaluate(() => document.activeElement?.id)).toBe("giffps");
    await settings.keyboard.press("Enter");
    await settings.keyboard.press("ArrowDown");
    const next = await settings.evaluate(() => (document.activeElement as HTMLElement).dataset.key);
    await settings.keyboard.press("Enter");
    expect(await settings.isHidden("#settings-menu")).toBe(true);
    expect(await settings.getAttribute("#giffps", "data-value")).toBe(next);
    await expect.poll(() => String(settingsJson(opts.userData).gif?.fps), { timeout: 15_000 }).toBe(next);
  }, 60_000);

  test("a press outside closes the menu, and only one is ever open", async () => {
    const win = await launch(fresh());
    const settings = await openSettings(app!, win, "output");
    await settings.click("#giffps");
    await settings.click("#gifwidth");
    expect(await settings.getAttribute("#giffps", "aria-expanded")).toBe("false");
    expect(await settings.getAttribute("#gifwidth", "aria-expanded")).toBe("true");
    await settings.mouse.click(400, 40);
    expect(await settings.isHidden("#settings-menu")).toBe(true);
    expect(await settings.getAttribute("#gifwidth", "aria-expanded")).toBe("false");
  }, 60_000);

  test("When a shot is taken writes the panel's skip preference", async () => {
    const opts = fresh();
    const win = await launch(opts);
    const settings = await openSettings(app!, win);
    await settings.click('#aftershot button[data-value="clipboard"]');
    await expect.poll(() => settingsJson(opts.userData).thumbnail?.skip, { timeout: 15_000 }).toBe(true);
    expect(await settings.getAttribute('#aftershot button[data-value="clipboard"]', "aria-checked")).toBe("true");
    await settings.click('#aftershot button[data-value="panel"]');
    await expect.poll(() => settingsJson(opts.userData).thumbnail?.skip, { timeout: 15_000 }).toBe(false);
  }, 60_000);

  // The title bar and the sidebar are the window's drag handle; the controls
  // in them are not, or a real click would move the window instead.
  test("the title bar and sidebar drag the window, the sidebar's buttons do not", async () => {
    const win = await launch(fresh());
    const settings = await openSettings(app!, win);
    const region = (sel: string) => settings.evaluate((s) =>
      getComputedStyle(document.querySelector(s)!).getPropertyValue("-webkit-app-region"), sel);
    expect(await region("#titlebar")).toBe("drag");
    expect(await region("#sidebar")).toBe("drag");
    expect(await region('#sidebar button[data-pane="camera"]')).toBe("no-drag");
  }, 60_000);

  test("camera and mic state stay visible in the library with diagnostics off", async () => {
    const win = await launch(fresh());
    expect(await win.locator("#diagnostics").isHidden()).toBe(true);
    expect(await win.isVisible("#camera-state")).toBe(true);
    expect(await win.isVisible("#mic-state")).toBe(true);
    const inside = await win.evaluate(() => {
      const table = document.getElementById("diagnostics")!;
      return ["camera-state", "mic-state"].filter((id) => table.contains(document.getElementById(id)));
    });
    expect(inside).toEqual([]);
    expect(await win.isVisible("#pid")).toBe(false);
  }, 60_000);

  // shortcuts:set used to write without telling the library, so the empty
  // library went on naming the old key until something else redrew it.
  test("a key rebound in Settings reaches the library's empty hint", async () => {
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: mkdtempSync(join(tmpdir(), "stc-empty-")) });
    await expect.poll(() => win.locator("#empty").textContent(), { timeout: 10_000 })
      .toContain("starts a recording");
    const settings = await openSettings(app!, win, "shortcuts");
    const key = "Alt+Shift+Command+9";
    await settings.evaluate((k) => (window as any).settingsBridge.setShortcut("record", k), key);
    await expect.poll(() => win.locator("#empty").textContent(), { timeout: 10_000 })
      .toContain(`${formatAccelerator(key)} starts a recording`);
  }, 60_000);
});
