import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";

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
 * that do not need a window manager, does the same thing whether the user
 * stops the take or the helper ends it unsolicited, and that the pill's own
 * content (dot, live timer, hatched meter, and its Stop click) is real DOM
 * state rather than a static placeholder.
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
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")), STC_HELPER_BIN: FAKE_HELPER, ...env },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  // STC-391: Record counts down now. This file is not about the countdown,
  // so it turns it off through the shipped preference rather than waiting
  // out three real seconds on every take.
  await withoutCountdown(win);
  return { win };
}

async function chrome(): Promise<{ resizable: boolean; alwaysOnTop: boolean }> {
  const win = await app!.firstWindow();
  const handle = await app!.browserWindow(win);
  return handle.evaluate((w) => ({ resizable: w.isResizable(), alwaysOnTop: w.isAlwaysOnTop() }));
}

/**
 * Whether the page has hidden its normal content in favour of the pill.
 * Real reported bug (screenshot, on a real Mac): the mechanism above worked
 * — a genuine 26px pill-shaped window — but the FULL instrument UI was
 * rendered clipped inside it, because the renderer had no way to know its
 * own window had shrunk. This is the one part of "does it look like a pill"
 * that IS checkable without a window manager: DOM state, not pixels.
 */
const isPillCollapsed = (win: Page): Promise<boolean> =>
  win.evaluate(() => document.body.classList.contains("pill-collapsed"));

describe("the pill's collapse mechanism", () => {
  test("Record locks resizing and floats the window; the pill's own Stop undoes both", async () => {
    const { win } = await launch();
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    expect(await chrome()).toEqual({ resizable: true, alwaysOnTop: false });
    expect(await isPillCollapsed(win)).toBe(false);

    await win.click("#record");
    await expect.poll(() => win.textContent("#record"), { timeout: 20_000 }).toBe("Stop");
    // Driven by the heartbeat (500ms in this app), not the click — the poll
    // is what proves that, not an assumption about timing.
    await expect.poll(chrome, { timeout: 20_000 }).toEqual({ resizable: false, alwaysOnTop: true });
    await expect.poll(() => isPillCollapsed(win), { timeout: 5_000 }).toBe(true);

    // #record itself is hidden now (index.html); #pill is the only reachable
    // control, and it must actually contain the dot/timer/meter/stop-icon and
    // a real, moving elapsed time — not just be present.
    await expect.poll(() => win.isVisible("#record"), { timeout: 5_000 }).toBe(false);
    expect(await win.isVisible("#pill")).toBe(true);
    expect(await win.locator("#pill-dot").count()).toBe(1);
    expect(await win.locator("#pill-meter").count()).toBe(1);
    // The stop icon (added after the first hardware look reported nothing
    // visible said what clicking the pill does) — a distinct visual glyph,
    // not just the aria-label a screen reader would get.
    expect(await win.locator("#pill-stop").count()).toBe(1);
    const timer1 = await win.textContent("#pill-timer");
    expect(timer1).toMatch(/^\d{2}:\d{2}$/);
    await expect.poll(() => win.textContent("#pill-timer"), { timeout: 5_000 })
      .not.toBe(timer1);

    // The pill itself is the Stop control — clicking it must do exactly what
    // clicking #record would have, since it shares that click handler
    // (renderer.ts). A real user has no other way to end this take: there
    // is no hotkey for it (hotkeys.ts's CAPTURE_ACTIONS is stills only).
    await win.click("#pill");
    await expect.poll(() => win.textContent("#record"), { timeout: 20_000 }).toBe("Record");
    await expect.poll(chrome, { timeout: 20_000 }).toEqual({ resizable: true, alwaysOnTop: false });
    await expect.poll(() => isPillCollapsed(win), { timeout: 5_000 }).toBe(false);
  }, 120_000);

  test("a take the helper ends on its own also undoes the collapse", async () => {
    // STC-306: a display stream dying mid-take ends it unsolicited, through
    // the same `recording-ended` path a user's own Stop produces. The pill
    // must not depend on which path got there — trap 3 in pill.ts's header.
    //
    // The death must land AFTER at least one heartbeat (500ms in this app):
    // attachPillToSupervisor only ever learns "recording" from the stats
    // heartbeat or recording-ended, and endRecording() resets sup.state to
    // "idle" before recording-ended fires — so a death faster than one
    // heartbeat interval means no heartbeat ever observes "recording" at
    // all, and there is nothing to collapse or restore. 900ms clears that
    // with margin.
    const { win } = await launch({ STC_FAKE_STREAM_DEATH_MS: "900" });
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);

    await win.click("#record");
    await expect.poll(chrome, { timeout: 20_000 }).toEqual({ resizable: false, alwaysOnTop: true });

    // No further click: the stand-in ends the take on its own at ~300ms.
    await expect.poll(chrome, { timeout: 20_000 }).toEqual({ resizable: true, alwaysOnTop: false });
    await expect.poll(() => win.textContent("#record"), { timeout: 20_000 }).toBe("Record");
  }, 120_000);
});
