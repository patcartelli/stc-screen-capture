import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, openEditorFromLibrary, waitForTakeLoaded } from "./_editor-fixture.js";
import { makeMicTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The Audio pane's slider feel and meters (STC-460), wired. How it LOOKS and
 * FEELS — the tick, the detent, whether a meter reads as live — needs a Mac:
 * docs/STC-460-RUNBOOK.md. Checked here: the as-recorded tick is where the
 * unity is, double-click resets, Shift+arrow nudges 0.1 dB WITHOUT moving the
 * playhead and persists, and the meters exist and sit at the floor while
 * nothing plays.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openEditor(dir: string): Promise<Page> {
  const launched = await launchApp(dir);
  app = launched.app;
  const win = await openEditorFromLibrary(app, launched.win);
  await win.waitForSelector("#stage", { timeout: 20_000 });
  await waitForTakeLoaded(win);
  await expect.poll(() => win.getAttribute("#audiobtn", "hidden"), { timeout: 20_000 }).toBeNull();
  return win;
}

const projectOf = (takeDir: string) => {
  const p = join(takeDir, "project.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

describe("the Audio pane's feel", () => {
  test("tick at as-recorded, double-click resets, Shift+arrow nudges 0.1 dB and leaves the playhead alone", async () => {
    const take = makeMicTakeFolder();
    const win = await openEditor(take.dir);
    await win.click("#audiobtn");

    expect(await win.evaluate(() => getComputedStyle(document.querySelector("#micaudio .fader")!).getPropertyValue("--unity").trim()))
      .toBe("0.75");

    // Away from unity, then a double-click puts it back.
    await win.evaluate(() => {
      const el = document.getElementById("miclevel") as HTMLInputElement;
      el.value = "30";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(await win.textContent("#miclevelvalue")).not.toBe("0 dB");
    // The value is the visible reset: live only while changed.
    expect(await win.getAttribute("#miclevelvalue", "data-dirty")).not.toBeNull();
    await win.click("#miclevelvalue");
    expect(await win.inputValue("#miclevel")).toBe("75");
    expect(await win.getAttribute("#miclevelvalue", "data-dirty")).toBeNull();
    await win.evaluate(() => {
      const el = document.getElementById("miclevel") as HTMLInputElement;
      el.value = "30";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await win.dblclick("#miclevel");
    expect(await win.inputValue("#miclevel")).toBe("75");
    expect(await win.textContent("#miclevelvalue")).toBe("0 dB");

    // Shift+ArrowRight: +0.1 dB, and the playhead does not move.
    const before = await win.textContent("#clock-cur");
    await win.focus("#miclevel");
    await win.keyboard.press("Shift+ArrowRight");
    expect(await win.textContent("#miclevelvalue")).toBe("+0.1 dB");
    expect(await win.textContent("#clock-cur")).toBe(before);
    await expect.poll(() => projectOf(take.takeDir)?.micLevel, { timeout: 20_000 }).toBeCloseTo(10 ** (0.1 / 20), 4);

    // And back: exactly unity again.
    await win.keyboard.press("Shift+ArrowLeft");
    expect(await win.textContent("#miclevelvalue")).toBe("0 dB");
  }, 120_000);

  test("playing with the panel open runs the meters on the audio clock without an error", async () => {
    // The fixture decodes to exact silence, so the BAR staying low is all this
    // can see; a real voice moving it is the runbook's (needs a Mac and a take).
    const win = await openEditor(makeMicTakeFolder().dir);
    const errors: string[] = [];
    win.on("pageerror", (e) => errors.push(String(e)));
    win.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await win.click("#audiobtn");
    await win.click("#playpause");
    await expect.poll(() => win.getAttribute("#stage", "data-clock"), { timeout: 10_000 }).toBe("audio");
    await new Promise((r) => setTimeout(r, 800));
    const db = Number(await win.getAttribute("#micmeter", "data-db"));
    expect(db).toBeGreaterThanOrEqual(-60);
    expect(db).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  }, 120_000);

  test("the meters are there, at the floor while nothing plays, and stop with the panel", async () => {
    const win = await openEditor(makeMicTakeFolder().dir);
    await win.click("#audiobtn");
    await expect.poll(() => win.getAttribute("#micmeter", "data-db")).toBe("-60.0");
    expect(await win.getAttribute("#micclip", "data-lit")).toBeNull();
    await win.keyboard.press("Escape");
    expect(await win.evaluate(() => document.getElementById("audiopanel")!.matches(":popover-open"))).toBe(false);
  }, 120_000);
});
