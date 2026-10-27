import type { Locator, Page } from "playwright";

/**
 * The library window's doors, for the e2e suite (STC-584).
 *
 * The window used to carry Record, Shot, a `#state` chip and the device
 * pickers, and tests clicked and read those. STC-584 took them out (Patrick,
 * 2026-10-27): the menu bar, the hotkeys and the record bar start a capture.
 * The window's bridge kept `start`, `stop`, `status` and `captureStill`, which
 * are exactly what those buttons called, so a test presses "Record" through
 * the same `recorder:start` → `runRecordFlow` path the button took. Main
 * announces a refusal on that path itself now, as it does for the menu bar's.
 *
 * Fire-and-forget where a click was: `win.click("#record")` returned as soon
 * as the click landed, long before the overlay, the countdown or the take, and
 * every caller polls for what it needs after that.
 */

/** Ready once the first list is drawn: the title bar's kind filter is there. */
export const LIBRARY_READY = "#libcontrols .libfilters";

/** What the Record button did: ask main to run the record flow, and not wait. */
export async function pressRecord(win: Page): Promise<void> {
  await win.evaluate(() => { void (window as any).recorder.start(); });
}

/** Record, awaited: the flow's own answer (a refusal, a cancel, or the take). */
export function recordAndWait(win: Page): Promise<{ ok: boolean; cancelled?: boolean; code?: string; dir?: string }> {
  return win.evaluate(() => (window as any).recorder.start());
}

/** What the Stop button did. Resolves once main has the helper's answer. */
export async function pressStop(win: Page): Promise<void> {
  await win.evaluate(() => (window as any).recorder.stop());
}

/** What `#state` used to show: the supervisor's own state, from main. */
export function recorderState(win: Page): Promise<string> {
  return win.evaluate(() => (window as any).recorder.status().then((s: { state: string }) => s.state));
}

/** What the Shot button did: an area shot through the overlay, not waited for. */
export async function pressShot(win: Page, action = "region"): Promise<void> {
  await win.evaluate((a) => { void (window as any).recorder.captureStill(a); }, action);
}

/**
 * Choose `action` from an item's overflow menu (Rename, Duplicate, Show in
 * Finder, Delete): open the menu from the item's "•••", then press the row.
 * `item` is the tile or the row.
 */
export async function chooseFromMenu(win: Page, item: Locator, action: string): Promise<void> {
  await item.locator(".libmore").click();
  await win.locator(`.liboverflow-menu button[data-action="${action}"]`).click();
}

/**
 * Press an item's action wherever it lives: its visible button (Share), the
 * overflow menu, or the whole tile for the tile's own action (Preview, Edit).
 */
export async function pressItemAction(win: Page, item: Locator, action: string): Promise<void> {
  if (await item.getAttribute("data-open") === action) {
    await item.locator(".libthumb").click();
    return;
  }
  const visible = item.locator(`.libactions > button[data-action="${action}"]`);
  if (await visible.count()) { await visible.click(); return; }
  await chooseFromMenu(win, item, action);
}

/**
 * Every action an item offers, in order, by id: its tile action, its visible
 * button, then its overflow menu. Read from the DOM, the menu opened and
 * closed again, so a test sees what a person can reach.
 */
export async function itemActions(win: Page, item: Locator): Promise<string[]> {
  const open = await item.getAttribute("data-open");
  const visible = await item.locator(".libactions > button[data-action]")
    .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.action!));
  let menu: string[] = [];
  if (await item.locator(".libmore").count()) {
    await item.locator(".libmore").click();
    menu = await win.locator(".liboverflow-menu button[data-action]")
      .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.action!));
    await win.keyboard.press("Escape");
  }
  return [...(open ? [open] : []), ...visible, ...menu];
}
