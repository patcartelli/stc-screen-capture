import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder, makeStillFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { LIBRARY_READY } from "./_library-window.js";
import { buildPalette, GifWriter } from "@transform/gif-encode.js";

/**
 * The Library window's focus pass (STC-587, the Library half; the Settings
 * half is `settings-a11y.e2e.test.ts`). What these pin: every control a Tab
 * reaches wears the one `--focus` ring; the view toggle and the kind filter
 * are radio groups whose keyboard picks keep the focus through the redraw;
 * the overflow menu takes the keys a menu does; and a rename hands the
 * keyboard back to the button it came from. axe is `npm run axe:renderers`;
 * whether the ring and the press states LOOK right is the runbook's, on a Mac.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
/** tokens.css's dark `--focus`; the Library is dark-always (data-surface="dark"). */
const FOCUS_RING = "rgb(122, 162, 255)";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

/** A real GIF from the app's own encoder: three frames of 7 cs, 32×18. */
function gifBytes(): Uint8Array {
  const frame = (v: number) => new Uint8ClampedArray(32 * 18 * 4).fill(v);
  const frames = [frame(0), frame(128), frame(255)];
  const w = new GifWriter(32, 18, buildPalette(frames), [7, 7, 7]);
  for (const f of frames) w.addFrame(f);
  return w.finish();
}

/**
 * A recording and a still, so both kinds' controls are on screen; a saved GIF
 * on request; and `more` further recordings, so the grid has a second row.
 */
async function launch(opts: { gif?: boolean; more?: number } = {}): Promise<Page> {
  const recordings = mkdtempSync(join(tmpdir(), "stc-liba11y-"));
  makeTakeFolder("2026-08-24_10-00-00", { into: recordings });
  makeStillFolder("2026-09-08_12-00-00", { into: recordings });
  for (let i = 0; i < (opts.more ?? 0); i++) makeTakeFolder(`2026-08-2${i}_09-00-00`, { into: recordings });
  if (opts.gif) writeFileSync(join(recordings, "login-bug.gif"), gifBytes());
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER, STC_NO_SHUTTER: "1",
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector(LIBRARY_READY);
  await win.waitForSelector(".libtile");
  return win;
}

/** What has the keyboard, and the ring it wears (an outline, or an input's box-shadow). */
function focused(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return {
      key: el.id || el.dataset.view || el.dataset.filter || el.dataset.focus || el.dataset.action
        || `${el.tagName.toLowerCase()}.${el.className}`,
      item: el.closest<HTMLElement>("[data-id]")?.dataset.id ?? null,
      visible: el.matches(":focus-visible"),
      ring: cs.outlineStyle === "solid" ? cs.outlineColor : cs.boxShadow,
    };
  });
}

describe("Library: focus and keyboard (STC-587)", () => {
  test("every control a Tab reaches wears the --focus ring", async () => {
    const win = await launch();
    await win.focus("#libsearch");
    await win.keyboard.press("Shift+Tab");
    const seen: string[] = [];
    // From the bar's start, Tab through the window until the focus comes round.
    for (let i = 0; i < 40; i++) {
      await win.keyboard.press("Tab");
      const f = await focused(win);
      if (!f) break;
      if (seen.includes(`${f.item}:${f.key}`)) break;
      seen.push(`${f.item}:${f.key}`);
      expect(f.visible, f.key).toBe(true);
      expect(f.ring, f.key).toContain(FOCUS_RING);
    }
    // One stop per segmented control (its chosen segment), the search, the
    // gear, and each item's tile, Share and More.
    expect(seen).toContain("null:grid");
    expect(seen).toContain("null:all");
    expect(seen).not.toContain("null:list");
    expect(seen).toContain("null:libsearch");
    expect(seen).toContain("null:settings");
    for (const id of ["2026-08-24_10-00-00", "2026-09-08_12-00-00"]) {
      for (const part of ["open", "more"]) expect(seen).toContain(`${id}:${part}`);
    }
  }, 60_000);

  test("a segmented control is a radio group, and an arrow pick keeps the focus through the redraw", async () => {
    const win = await launch();
    expect(await win.getAttribute(".libviewtoggle", "role")).toBe("radiogroup");
    expect(await win.$$eval(".libviewtoggle button", (bs) => bs.map((b) => [b.getAttribute("aria-checked"), (b as HTMLButtonElement).tabIndex])))
      .toEqual([["true", 0], ["false", -1]]);
    await win.focus('.libviewtoggle [data-view="grid"]');
    await win.keyboard.press("ArrowRight");
    await win.waitForSelector("#liblist");
    await expect.poll(async () => (await focused(win))?.key).toBe("list");
    expect(await win.getAttribute('.libviewtoggle [data-view="list"]', "aria-checked")).toBe("true");
    // The filter: → twice chooses Recordings, then Shots. The list narrows at
    // each, and the focus survives both redraws.
    await win.focus('.libfilters [data-filter="all"]');
    await win.keyboard.press("ArrowRight");
    await expect.poll(async () => (await focused(win))?.key).toBe("recording");
    await win.keyboard.press("ArrowRight");
    await expect.poll(() => win.locator("#liblist .librow[data-id]").count()).toBe(1);
    await expect.poll(async () => (await focused(win))?.key).toBe("still");
  }, 60_000);

  test("the overflow menu takes Home, End, Escape and Tab, and gives the focus back", async () => {
    const win = await launch();
    const more = '.libtile[data-id="2026-08-24_10-00-00"] .libmore';
    await win.focus(more);
    await win.keyboard.press("Enter");
    await win.waitForSelector(".liboverflow-menu");
    expect((await focused(win))?.key).toBe("rename");
    await win.keyboard.press("End");
    expect((await focused(win))?.key).toBe("delete");
    // The ring is drawn inside the row.
    expect(await win.$eval(".liboverflow-menu button:focus", (b) => getComputedStyle(b).outlineOffset)).toBe("-2px");
    await win.keyboard.press("Home");
    expect((await focused(win))?.key).toBe("rename");
    await win.keyboard.press("Escape");
    expect(await win.locator(".liboverflow-menu").count()).toBe(0);
    expect(await focused(win)).toMatchObject({ key: "more", item: "2026-08-24_10-00-00" });
    // Tab closes it as well, rather than walking out of an open menu.
    await win.keyboard.press("Enter");
    await win.waitForSelector(".liboverflow-menu");
    await win.keyboard.press("Tab");
    expect(await win.locator(".liboverflow-menu").count()).toBe(0);
    expect(await focused(win)).toMatchObject({ key: "more", item: "2026-08-24_10-00-00" });
  }, 60_000);

  test("a rename from the keyboard wears the ring, and ends with the focus back on More", async () => {
    const win = await launch();
    const id = "2026-08-24_10-00-00";
    await win.focus(`.libtile[data-id="${id}"] .libmore`);
    await win.keyboard.press("Enter");
    await win.waitForSelector(".liboverflow-menu");
    await win.keyboard.press("Enter");                       // Rename, the first row
    await win.waitForSelector(".labelinput");
    const field = await focused(win);
    expect(field?.ring).toContain(FOCUS_RING);
    // Escape: nothing saved, and the keyboard is where it was.
    await win.keyboard.press("Escape");
    expect(await focused(win)).toMatchObject({ key: "more", item: id });
    // Again, committed: the library redraws every tile, and the focus survives it.
    await win.keyboard.press("Enter");
    await win.waitForSelector(".liboverflow-menu");
    await win.keyboard.press("Enter");
    await win.waitForSelector(".labelinput");
    await win.keyboard.type("Login bug");
    await win.keyboard.press("Enter");
    await expect.poll(() => win.locator(`.libtile[data-id="${id}"] .libtitle`).textContent()).toBe("Login bug");
    await expect.poll(() => focused(win)).toMatchObject({ key: "more", item: id });
  }, 60_000);
});

describe("Library: the Mac pass's follow-ups (STC-595)", () => {
  /** The items' ids in the order the page draws them. */
  const order = (win: Page, sel: string) => win.$$eval(sel, (cs) => cs.map((c) => (c as HTMLElement).dataset.id!));

  test("a menu row hands the focus back to ••• before it acts, so a cancelled Delete keeps it there", async () => {
    // On the Mac a confirmed Delete left the ring on the title bar: picking
    // the row removed the menu while it had the focus, so the focus fell to
    // the page before the sheet opened. A cancelled Delete is the same path
    // without needing a Trash, which Linux has none of.
    const win = await launch();
    const id = "2026-08-24_10-00-00";
    await app!.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });  // Cancel
    });
    await win.focus(`.libtile[data-id="${id}"] .libmore`);
    await win.keyboard.press("Enter");
    await win.waitForSelector(".liboverflow-menu");
    await win.keyboard.press("End");                         // Delete, the last row
    expect((await focused(win))?.key).toBe("delete");
    await win.keyboard.press("Enter");
    await expect.poll(() => win.locator(".liboverflow-menu").count()).toBe(0);
    await expect.poll(() => focused(win)).toMatchObject({ key: "more", item: id });
  }, 60_000);

  test("in the grid ←/→ go to the previous and next item and ↑/↓ a row away, keeping the control", async () => {
    const win = await launch({ more: 3 });                  // five items: a row of three, then two
    await win.waitForSelector(".libtile:nth-child(5)");
    const ids = await order(win, "#libgrid .libtile");
    expect(ids).toHaveLength(5);
    await win.focus(`.libtile[data-id="${ids[0]}"] .libthumb`);
    await win.keyboard.press("ArrowRight");
    expect(await focused(win)).toMatchObject({ key: "open", item: ids[1] });
    await win.keyboard.press("ArrowDown");                   // the row is three wide
    expect(await focused(win)).toMatchObject({ key: "open", item: ids[4] });
    await win.keyboard.press("ArrowDown");                   // no row below: stays
    expect(await focused(win)).toMatchObject({ key: "open", item: ids[4] });
    await win.keyboard.press("ArrowUp");
    expect(await focused(win)).toMatchObject({ key: "open", item: ids[1] });
    // From •••, the same control on the next item; nothing before the first.
    await win.focus(`.libtile[data-id="${ids[0]}"] .libmore`);
    await win.keyboard.press("ArrowLeft");
    expect(await focused(win)).toMatchObject({ key: "more", item: ids[0] });
    await win.keyboard.press("ArrowRight");
    expect(await focused(win)).toMatchObject({ key: "more", item: ids[1] });
  }, 60_000);

  test("in the list ↑/↓ move between items; ←/→ leave the focus where it is", async () => {
    const win = await launch();
    await win.click('.libviewtoggle [data-view="list"]');
    await win.waitForSelector("#liblist .librow[data-id]");
    const ids = await order(win, "#liblist .librow[data-id]");
    await win.focus(`.librow[data-id="${ids[0]}"] .libthumb`);
    await win.keyboard.press("ArrowDown");
    expect(await focused(win)).toMatchObject({ key: "open", item: ids[1] });
    await win.keyboard.press("ArrowRight");
    expect(await focused(win)).toMatchObject({ key: "open", item: ids[1] });
    await win.keyboard.press("ArrowUp");
    expect(await focused(win)).toMatchObject({ key: "open", item: ids[0] });
  }, 60_000);
});

describe("Library: reduced motion (STC-593)", () => {
  const tile = '.libtile[data-id="login-bug"]';
  const src = (win: Page) => win.getAttribute(`${tile} .libthumb img`, "src");

  /** The GIF tile, drawn with its first frame, and that frame's URL. */
  async function gifAtRest(win: Page): Promise<string> {
    await win.waitForSelector(`${tile} .libthumb img[src^="blob:"]`);
    return (await src(win))!;
  }

  // The control for the test after it: without Reduce Motion the same hover
  // does swap the picture, so a still picture there is the preference's doing.
  test("a GIF plays while the pointer is over its tile, and rests on its first frame after", async () => {
    const win = await launch({ gif: true });
    await win.emulateMedia({ reducedMotion: "no-preference" });
    const still = await gifAtRest(win);
    await win.hover(tile);
    await expect.poll(() => src(win)).not.toBe(still);
    await win.mouse.move(1, 1);
    await expect.poll(() => src(win)).toBe(still);
  }, 60_000);

  test("under Reduce Motion a GIF never plays: the hover leaves its first frame", async () => {
    const win = await launch({ gif: true });
    await win.emulateMedia({ reducedMotion: "reduce" });
    const still = await gifAtRest(win);
    await win.hover(tile);
    // Long enough for the bytes to have come back and been swapped in, had
    // they been asked for (the control above sees the swap well inside this).
    await win.waitForTimeout(1_000);
    expect(await src(win)).toBe(still);
  }, 60_000);
});
