import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { openSettings } from "./_settings-window.js";

/**
 * The Settings window's focus and reduced-motion pass (STC-587, on
 * STC-506's rules). What these pin: every control a Tab reaches wears the one
 * `--focus` ring; the window works from the keyboard alone (segmented
 * controls are radio groups, a keycap keeps the focus it was pressed with, the
 * PiP moves with the arrow keys); and a switch under reduced motion
 * crossfades instead of sliding. axe is `npm run axe:renderers`; whether the
 * ring and the crossfade LOOK right is the runbook's, on a Mac.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
/** tokens.css's dark `--focus`; Settings is dark-always (data-surface="dark"). */
const FOCUS_RING = "rgb(122, 162, 255)";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(userData: string) {
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: makeTakeFolder().dir, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await withoutCountdown(win);
  return win;
}
const settingsJson = (userData: string) => JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));

/** What has the keyboard, and the ring it wears. */
function focused(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return {
      key: el.id || `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 24)}]`,
      visible: el.matches(":focus-visible"),
      outline: `${cs.outlineStyle} ${cs.outlineColor}`,
      pane: el.closest(".pane")?.id ?? (el.closest("#sidebar") ? "sidebar" : "other"),
    };
  });
}

describe("Settings: focus and reduced motion (STC-587)", () => {
  test("every control a Tab reaches, in every pane, wears the --focus ring", async () => {
    const win = await launch(mkdtempSync(join(tmpdir(), "stc-ud-")));
    const settings = await openSettings(app!, win);
    const panes = await settings.$$eval("#sidebar button[data-pane]", (bs) => bs.map((b) => b.dataset.pane!));
    const seen: string[] = [];
    for (const pane of panes) {
      await settings.click(`#sidebar button[data-pane="${pane}"]`);
      // From the pane's own sidebar button, Tab through the pane until the
      // focus leaves it again.
      await settings.focus(`#sidebar button[data-pane="${pane}"]`);
      let inPane = 0;
      for (let i = 0; i < 80; i++) {
        await settings.keyboard.press("Tab");
        const f = await focused(settings);
        if (!f) break;
        if (f.pane === "sidebar") { if (inPane) break; continue; }
        inPane++;
        seen.push(`${pane}:${f.key}`);
        expect(f.visible, f.key).toBe(true);
        expect(f.outline, f.key).toBe(`solid ${FOCUS_RING}`);
      }
      expect(inPane, pane).toBeGreaterThan(0);
    }
    // The controls this pass made reachable are among them.
    expect(seen).toContain("camera:pipbox");
    expect(seen.some((k) => k.startsWith("shortcuts:shortcut-"))).toBe(true);
  }, 120_000);

  test("the sidebar is one Tab stop, and ↑/↓/Home/End show each pane (STC-595)", async () => {
    const win = await launch(mkdtempSync(join(tmpdir(), "stc-ud-")));
    const settings = await openSettings(app!, win);
    const stops = () => settings.$$eval("#sidebar button", (bs) => bs.map((b) => (b as HTMLButtonElement).tabIndex));
    const shown = () => settings.$$eval(".pane", (ps) => ps.filter((p) => !(p as HTMLElement).hidden).map((p) => p.id));
    expect(await stops()).toEqual([0, -1, -1, -1, -1]);
    await settings.focus('#sidebar button[data-pane="capture"]');
    await settings.keyboard.press("ArrowDown");
    expect(await shown()).toEqual(["pane-camera"]);
    expect(await settings.evaluate(() => (document.activeElement as HTMLElement).dataset.pane)).toBe("camera");
    expect(await stops()).toEqual([-1, 0, -1, -1, -1]);
    await settings.keyboard.press("End");
    expect(await shown()).toEqual(["pane-advanced"]);
    // No wrap at the ends.
    await settings.keyboard.press("ArrowDown");
    expect(await shown()).toEqual(["pane-advanced"]);
    await settings.keyboard.press("Home");
    await settings.keyboard.press("ArrowUp");
    expect(await shown()).toEqual(["pane-capture"]);
    // Tab leaves the sidebar for the pane in one stop.
    await settings.keyboard.press("Tab");
    expect((await focused(settings))?.pane).toBe("pane-capture");
  }, 60_000);

  test("a segmented control is one Tab stop, and the arrow keys choose", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const win = await launch(userData);
    const settings = await openSettings(app!, win);
    await expect.poll(() => settings.getAttribute('#aftershot [data-value="panel"]', "aria-checked")).toBe("true");
    expect(await settings.$$eval("#aftershot button", (bs) => bs.map((b) => (b as HTMLButtonElement).tabIndex)))
      .toEqual([0, -1]);
    await settings.focus('#aftershot [data-value="panel"]');
    await settings.keyboard.press("ArrowRight");
    await expect.poll(() => settingsJson(userData).thumbnail?.skip, { timeout: 10_000 }).toBe(true);
    expect((await focused(settings))?.key).toContain("button");
    expect(await settings.$$eval("#aftershot button", (bs) => bs.map((b) => (b as HTMLButtonElement).tabIndex)))
      .toEqual([-1, 0]);
    // Home goes back to the first, and chooses it.
    await settings.keyboard.press("Home");
    await expect.poll(() => settingsJson(userData).thumbnail?.skip, { timeout: 10_000 }).toBe(false);
  }, 60_000);

  test("Return on a keycap listens without losing the keyboard, and Escape keeps it there", async () => {
    const win = await launch(mkdtempSync(join(tmpdir(), "stc-ud-")));
    const settings = await openSettings(app!, win, "shortcuts");
    await settings.waitForSelector("#shortcut-region");
    expect(await settings.getAttribute("#shortcut-region", "aria-labelledby")).toBe("shortcutname-region shortcut-region");
    await settings.focus("#shortcut-region");
    await settings.keyboard.press("Enter");
    await expect.poll(() => settings.getAttribute("#shortcut-region", "aria-pressed")).toBe("true");
    expect((await focused(settings))?.key).toBe("shortcut-region");
    await settings.keyboard.press("Escape");
    await expect.poll(() => settings.getAttribute("#shortcut-region", "aria-pressed")).toBe("false");
    expect((await focused(settings))?.key).toBe("shortcut-region");
  }, 60_000);

  test("the PiP moves with the arrow keys, and the release saves where it went", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const win = await launch(userData);
    const settings = await openSettings(app!, win, "camera");
    const start = await settings.evaluate(async () =>
      ((await (window as any).settingsBridge.getSettings()).pipStyle.center.x as number));
    await settings.focus("#pipbox");
    const before = await settings.evaluate(() => (document.getElementById("pipbox") as HTMLElement).getBoundingClientRect().x);
    await settings.keyboard.press("Shift+ArrowLeft");
    // 10% of the frame to the left, give or take a snap to a guide.
    await expect.poll(() => (settingsJson(userData).pipStyle as { center?: { x: number } } | undefined)?.center?.x,
      { timeout: 10_000 }).toBeLessThan(start - 0.05);
    const after = await settings.evaluate(() => (document.getElementById("pipbox") as HTMLElement).getBoundingClientRect().x);
    expect(after).toBeLessThan(before);
    // Held against the edge, it stays wholly inside the frame.
    for (let i = 0; i < 15; i++) await settings.keyboard.press("Shift+ArrowLeft");
    const inside = await settings.evaluate(() => {
      const box = document.getElementById("pipbox")!.getBoundingClientRect();
      const screen = document.getElementById("pipscreen")!.getBoundingClientRect();
      return box.left >= screen.left - 0.5;
    });
    expect(inside).toBe(true);
  }, 60_000);

  test("a switch crossfades under reduced motion instead of sliding", async () => {
    const win = await launch(mkdtempSync(join(tmpdir(), "stc-ud-")));
    const settings = await openSettings(app!, win);
    const motion = () => settings.evaluate(() => {
      const sw = document.getElementById("shuttersound")!;
      return {
        track: `${getComputedStyle(sw).transitionProperty} ${getComputedStyle(sw).transitionDuration}`,
        knob: getComputedStyle(sw, "::after").transitionDuration,
      };
    });
    expect(await motion()).toEqual({ track: "background 0.15s", knob: "0.15s" });
    await settings.emulateMedia({ reducedMotion: "reduce" });
    // The track fades over --dur-quick (120 ms); the knob does not travel.
    expect(await motion()).toEqual({ track: "background 0.12s", knob: "0s" });
  }, 60_000);
});
