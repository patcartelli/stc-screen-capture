import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";

/**
 * The main window's capture scope (STC-370's region/window capability, wired
 * up by STC-374): the Scope picker (Screen/Window/Area) and the "source"
 * control beside it, end to end.
 *
 * `settings.test.ts` proves the `scope` preference itself round-trips and
 * validates; what this file exists for is the WIRING that cannot see: that
 * picking a window or an area really opens the same overlay `capturestill`
 * uses, that a pick is persisted and reflected back into the source control,
 * that Record is unavailable until one exists, and that `recorder:start`
 * actually sends `windowId`/`region` — not `displayId` — to the helper.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Launched { win: Page; userData: string; startLog: string; }

async function launch(userData?: string): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const ud = userData ?? mkdtempSync(join(tmpdir(), "stc-ud-"));
  const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");
  app = await electron.launch({
    args: [root, `--user-data-dir=${ud}`],
    cwd: root,
    // Synthetic overlay input, for the same reason still-overlay.e2e.test.ts
    // needs it: real input would test the window server's hit-testing, which
    // belongs on the Mac, and would make this file flaky the same way that
    // one already paid for once.
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")), STC_HELPER_BIN: FAKE_HELPER,
           STC_FAKE_START_LOG: startLog, STC_OVERLAY_SYNTHETIC_INPUT: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#scope");
  // STC-391: Record counts down now. This file is not about the countdown,
  // so it turns it off through the shipped preference rather than waiting
  // out three real seconds on every take.
  await withoutCountdown(win);
  return { win, userData: ud, startLog };
}

async function overlayWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) {
      if (p.url().includes("overlay.html")) return p;
    }
    if (Date.now() - start > ms) {
      throw new Error(`no overlay window appeared within ${ms}ms; windows: ` +
                      JSON.stringify(app!.windows().map((p) => p.url())));
    }
    await sleep(50);
  }
}

async function send(overlay: Page, event: unknown): Promise<void> {
  await overlay.evaluate((e) => (window as any).overlay.send(e), event);
}

/** See still-overlay.e2e.test.ts's identical helper for why this is not a sleep. */
async function awaitConfirmable(overlay: Page, ms = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if ((await overlay.textContent("#size"))?.trim()) return;
    if (Date.now() - start > ms) {
      throw new Error(`the drag never produced a confirmable selection within ${ms}ms`);
    }
    await sleep(50);
  }
}

async function primaryBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
  return app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
}

const lastStart = (log: string): any =>
  JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);

describe("the scope picker", () => {
  test("defaults to Screen, with Record available and the display source shown", async () => {
    const { win } = await launch();
    expect(await win.inputValue("#scope")).toBe("display");
    expect(await win.isHidden("#display-label")).toBe(false);
    expect(await win.isHidden("#window-source")).toBe(true);
    expect(await win.isHidden("#region-source")).toBe(true);
    await expect.poll(() => win.isEnabled("#record"), { timeout: 20_000 }).toBe(true);
  }, 120_000);

  test("Window scope disables Record until a window is chosen", async () => {
    const { win } = await launch();
    await win.selectOption("#scope", "window");
    expect(await win.isHidden("#window-source")).toBe(false);
    expect(await win.isHidden("#display-label")).toBe(true);
    await expect.poll(() => win.isDisabled("#record"), { timeout: 10_000 }).toBe(true);
    expect(await win.textContent("#window-source-label")).toBe("No window chosen");
  }, 120_000);

  test("choosing a window enables Record, shows its label, and start sends its windowId", async () => {
    const { win, startLog } = await launch();
    await win.selectOption("#scope", "window");
    await win.click("#pickwindow");
    const overlay = await overlayWindow();

    // The stand-in's Finder window (id 4711) sits at (100,100) 400x300.
    // The overlay already opened in WINDOW mode (pickCaptureTarget asked
    // for it), unlike the still-capture button which always opens in region
    // mode and needs Space to toggle — sending it here would toggle away.
    await send(overlay, { t: "pointermove", at: { x: 200, y: 200 } });
    await send(overlay, { t: "pointerdown", at: { x: 200, y: 200 } });

    await expect.poll(() => app!.windows().filter((p) => p.url().includes("overlay.html")).length,
                      { timeout: 15_000 }).toBe(0);
    await expect.poll(() => win.textContent("#window-source-label"), { timeout: 10_000 })
      .toBe("Finder — Downloads");
    await expect.poll(() => win.isEnabled("#record"), { timeout: 10_000 }).toBe(true);

    await win.click("#record");
    await expect.poll(() => existsSync(startLog), { timeout: 20_000 }).toBe(true);
    const cmd = lastStart(startLog);
    expect(cmd.windowId).toBe(4711);
    expect(cmd.region).toBeUndefined();
    expect(cmd.displayId).toBeUndefined();
    // Fixed at start, released at stop: the pick control must not look
    // changeable mid-take.
    await expect.poll(() => win.isDisabled("#pickwindow"), { timeout: 10_000 }).toBe(true);
  }, 120_000);

  test("choosing an area enables Record, shows its size, and start sends the region and its display", async () => {
    const { win, startLog } = await launch();
    await win.selectOption("#scope", "region");
    await win.click("#pickregion");
    const overlay = await overlayWindow();
    const b = await primaryBounds();

    const from = { x: b.x + 100, y: b.y + 80 };
    const to = { x: from.x + 200, y: from.y + 100 };
    await send(overlay, { t: "pointerdown", at: from });
    await send(overlay, { t: "pointermove", at: to });
    await send(overlay, { t: "pointerup", at: to });
    await awaitConfirmable(overlay);
    await send(overlay, { t: "key", key: "Enter" });

    await expect.poll(() => app!.windows().filter((p) => p.url().includes("overlay.html")).length,
                      { timeout: 15_000 }).toBe(0);
    await expect.poll(() => win.textContent("#region-source-label"), { timeout: 10_000 })
      .toBe("200 × 100");
    await expect.poll(() => win.isEnabled("#record"), { timeout: 10_000 }).toBe(true);

    await win.click("#record");
    await expect.poll(() => existsSync(startLog), { timeout: 20_000 }).toBe(true);
    const cmd = lastStart(startLog);
    expect(cmd.region).toEqual({ x: 100, y: 80, width: 200, height: 100 });
    expect(cmd.windowId).toBeUndefined();
    expect(cmd.displayId).toBe(await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().id));
  }, 120_000);

  test("cancelling the picker leaves the scope with nothing chosen", async () => {
    const { win } = await launch();
    await win.selectOption("#scope", "window");
    await win.click("#pickwindow");
    const overlay = await overlayWindow();
    await send(overlay, { t: "key", key: "Escape" });

    await expect.poll(() => app!.windows().filter((p) => p.url().includes("overlay.html")).length,
                      { timeout: 15_000 }).toBe(0);
    expect(await win.textContent("#window-source-label")).toBe("No window chosen");
    expect(await win.isDisabled("#record")).toBe(true);
  }, 120_000);

  test("a chosen window survives a restart", async () => {
    const { win, userData } = await launch();
    await win.selectOption("#scope", "window");
    await win.click("#pickwindow");
    const overlay = await overlayWindow();
    // The overlay already opened in WINDOW mode (pickCaptureTarget asked
    // for it), unlike the still-capture button which always opens in region
    // mode and needs Space to toggle — sending it here would toggle away.
    await send(overlay, { t: "pointermove", at: { x: 200, y: 200 } });
    await send(overlay, { t: "pointerdown", at: { x: 200, y: 200 } });
    await expect.poll(() => win.textContent("#window-source-label"), { timeout: 15_000 })
      .toBe("Finder — Downloads");

    await app!.close();
    app = undefined;
    const second = await launch(userData);
    expect(await second.win.inputValue("#scope")).toBe("window");
    await expect.poll(() => second.win.textContent("#window-source-label"), { timeout: 15_000 })
      .toBe("Finder — Downloads");
    await expect.poll(() => second.win.isEnabled("#record"), { timeout: 10_000 }).toBe(true);
  }, 180_000);

  // The runbook's finding (2026-09-14): once a window or area was chosen,
  // there was no way BACK to "nothing chosen" without reopening the picker
  // and making a new one.
  test("Clear forgets a chosen window without reopening the picker", async () => {
    const { win } = await launch();
    await win.selectOption("#scope", "window");
    expect(await win.isDisabled("#clearwindow")).toBe(true);

    await win.click("#pickwindow");
    const overlay = await overlayWindow();
    await send(overlay, { t: "pointermove", at: { x: 200, y: 200 } });
    await send(overlay, { t: "pointerdown", at: { x: 200, y: 200 } });
    await expect.poll(() => win.textContent("#window-source-label"), { timeout: 15_000 })
      .toBe("Finder — Downloads");
    await expect.poll(() => win.isEnabled("#clearwindow"), { timeout: 10_000 }).toBe(true);

    await win.click("#clearwindow");
    await expect.poll(() => win.textContent("#window-source-label"), { timeout: 10_000 })
      .toBe("No window chosen");
    expect(await win.isDisabled("#record")).toBe(true);
    expect(await win.isDisabled("#clearwindow")).toBe(true);
    // The scope stays Window — clearing forgets the target, not the mode.
    expect(await win.inputValue("#scope")).toBe("window");
  }, 120_000);

  test("Clear forgets a chosen area without reopening the picker", async () => {
    const { win } = await launch();
    await win.selectOption("#scope", "region");
    expect(await win.isDisabled("#clearregion")).toBe(true);

    await win.click("#pickregion");
    const overlay = await overlayWindow();
    const b = await primaryBounds();
    const from = { x: b.x + 100, y: b.y + 80 };
    const to = { x: from.x + 200, y: from.y + 100 };
    await send(overlay, { t: "pointerdown", at: from });
    await send(overlay, { t: "pointermove", at: to });
    await send(overlay, { t: "pointerup", at: to });
    await awaitConfirmable(overlay);
    await send(overlay, { t: "key", key: "Enter" });
    await expect.poll(() => win.textContent("#region-source-label"), { timeout: 15_000 })
      .toBe("200 × 100");
    await expect.poll(() => win.isEnabled("#clearregion"), { timeout: 10_000 }).toBe(true);

    await win.click("#clearregion");
    await expect.poll(() => win.textContent("#region-source-label"), { timeout: 10_000 })
      .toBe("No area chosen");
    expect(await win.isDisabled("#record")).toBe(true);
    expect(await win.isDisabled("#clearregion")).toBe(true);
    expect(await win.inputValue("#scope")).toBe("region");
  }, 120_000);
});
