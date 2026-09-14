import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * The pill's real window collapse, wired through the real app (STC-375).
 *
 * `pill.test.ts` proves the pure decisions with no window; this drives the
 * real `BrowserWindow` main.ts actually creates, through the real Record
 * button, against the control-plane stand-in `_fake-helper.mjs` — the same
 * arrangement `camera-toggle.e2e.test.ts` and `hotkeys.e2e.test.ts` use, for
 * the same reason: faking supervisor state against a live idle helper gets
 * undone by the next heartbeat (CLAUDE.md's "test seam that fakes state the
 * subject contradicts" trap), so the stand-in has to actually go
 * `state: "recording"` and report it on its own heartbeat.
 *
 * ## What this CANNOT check, on THIS machine, and why
 *
 * This sandbox's Xvfb has no window manager (`which fluxbox openbox icewm
 * twm` all come back empty, and none can be installed here). Measured
 * directly before writing this file: a bare `win.setSize(96, 26)` on a
 * freshly created window — no pill code involved — leaves `getBounds()`
 * unchanged, while `win.setResizable(false)`/`win.isResizable()` and
 * `win.setAlwaysOnTop(true, ...)`/`win.isAlwaysOnTop()` toggle correctly.
 * `resizable` and `alwaysOnTop` are booleans Electron tracks in-process;
 * `setSize` on Linux asks the window manager to perform the resize and
 * `getBounds()` reports what the WM confirmed, so with no WM the size
 * request has nowhere to go. This is the same class of finding as
 * `app.dock.hide()` behaving differently on CI than on a real Mac
 * (CLAUDE.md, STC-292) — measured here, not assumed, and it is why the
 * actual pixel collapse/restore is `docs/STC-375-RUNBOOK.md`'s, not this
 * file's, to confirm.
 *
 * What IS verified here: the mechanism actually fires, driven by the real
 * heartbeat and not the click (traps 1 and 3), toggles the two properties
 * that do not need a window manager, and does the same thing whether the
 * user stops the take or the helper ends it unsolicited.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

async function launch(env: Record<string, string> = {}): Promise<{ win: Page }> {
  const { dir: recordings } = makeTakeFolder();
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_HELPER_BIN: FAKE_HELPER, ...env },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { win };
}

async function chrome(): Promise<{ resizable: boolean; alwaysOnTop: boolean }> {
  const win = await app!.firstWindow();
  const handle = await app!.browserWindow(win);
  return handle.evaluate((w) => ({ resizable: w.isResizable(), alwaysOnTop: w.isAlwaysOnTop() }));
}

describe("the pill's collapse mechanism", () => {
  test("Record locks resizing and floats the window; Stop undoes both", async () => {
    const { win } = await launch();
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    expect(await chrome()).toEqual({ resizable: true, alwaysOnTop: false });

    await win.click("#record");
    await expect.poll(() => win.textContent("#record"), { timeout: 20_000 }).toBe("Stop");
    // Driven by the heartbeat (500ms in this app), not the click — the poll
    // is what proves that, not an assumption about timing.
    await expect.poll(chrome, { timeout: 20_000 }).toEqual({ resizable: false, alwaysOnTop: true });

    await win.click("#record");
    await expect.poll(() => win.textContent("#record"), { timeout: 20_000 }).toBe("Record");
    await expect.poll(chrome, { timeout: 20_000 }).toEqual({ resizable: true, alwaysOnTop: false });
  }, 120_000);

  test("a take the helper ends on its own also undoes the collapse", async () => {
    // STC-306: a display stream dying mid-take ends it unsolicited, through
    // the same `recording-ended` path a user's own Stop produces. The pill
    // must not depend on which path got there — trap 3 in pill.ts's header.
    const { win } = await launch({ STC_FAKE_STREAM_DEATH_MS: "300" });
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);

    await win.click("#record");
    await expect.poll(chrome, { timeout: 20_000 }).toEqual({ resizable: false, alwaysOnTop: true });

    // No further click: the stand-in ends the take on its own at ~300ms.
    await expect.poll(chrome, { timeout: 20_000 }).toEqual({ resizable: true, alwaysOnTop: false });
    await expect.poll(() => win.textContent("#record"), { timeout: 20_000 }).toBe("Record");
  }, 120_000);
});
