import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";

/**
 * The Settings sheet, end to end (STC-412): the sheet-opening button renamed
 * from "Profile" to "Settings", and Scope/Camera/Mic relocated out of the
 * main window's record row into a new "Profile" section inside the sheet,
 * ahead of the pre-existing "Preferences" section. Nothing about the sheet's
 * open/close mechanics changed — only what it contains and how it is opened.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

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

describe("the settings sheet", () => {
  test("the sheet holds Profile and Preferences as two sections, and Source/Camera/Mic live there now", async () => {
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: makeTakeFolder().dir });
    // Not directly clickable before the sheet opens — this is the ticket's own
    // acceptance property, and the negative check matters as much as the
    // positive one below. The sheet is a slide-over (`transform: translateX`)
    // rather than `display: none`, so Playwright's own `isVisible()` reports
    // true even while it sits off-screen — the real signal is the bounding
    // box, which lands past the window's right edge until `.open` slides it
    // in.
    const viewportWidth = await win.evaluate(() => window.innerWidth);
    const boxBeforeOpen = await win.locator("#display").boundingBox();
    expect(boxBeforeOpen).not.toBeNull();
    expect(boxBeforeOpen!.x).toBeGreaterThanOrEqual(viewportWidth);
    await win.click("#settings");
    await expect.poll(() => win.getAttribute("#profilesheet", "class")).toMatch(/open/);
    // Exactly two — not "contains", which would pass even if Countdown or
    // Shot shortcuts were still their own <h2> peer sections (STC-430: they
    // used to be, and the sheet read as four flat sections rather than two).
    const headings = await win.locator("#profilesheet h2").allTextContents();
    expect(headings).toEqual(["Profile", "Preferences"]);
    expect(await win.isVisible("#display")).toBe(true);
    // STC-388: no Scope picker at all — scope is chosen fresh for every take in
    // the Record flow's overlay, and nothing about it is remembered.
    expect(await win.locator("#scope").count()).toBe(0);
    expect(await win.isVisible("#camera")).toBe(true);
    expect(await win.isVisible("#mic")).toBe(true);
    expect(await win.locator("#stillcleardest").count()).toBe(0);
    expect(await win.locator("#diagnostics").isHidden()).toBe(true);
    await win.check("#showdiagnostics");
    expect(await win.locator("#diagnostics").isVisible()).toBe(true);
  });

  /**
   * STC-430. "Countdown" and "Shot shortcuts" used to be their own `<h2>`,
   * styled identically to Profile and Preferences — so a click-through read
   * the sheet as four flat sections rather than the two the split promises.
   * They are `.subhead` labels within Preferences now: present (so the
   * fields stay scannable) but not `<h2>`, and positioned after the
   * Preferences heading rather than before it or between Profile's fields.
   */
  test("Countdown and Shot shortcuts are Preferences subheads, not their own sections", async () => {
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: makeTakeFolder().dir });
    await win.click("#settings");
    await expect.poll(() => win.getAttribute("#profilesheet", "class")).toMatch(/open/);

    const headings = await win.locator("#profilesheet h2").allTextContents();
    expect(headings).not.toContain("Countdown");
    expect(headings).not.toContain("Shot shortcuts");

    const subheads = await win.locator("#profilesheet .subhead").allTextContents();
    expect(subheads).toEqual(["Countdown", "Shot shortcuts"]);

    // Both sit under the Preferences <h2>, not Profile's — read positionally,
    // the same way the save-location test above pins its own placement.
    const sectionOf = await win.evaluate(() => {
      const bySubhead = (text: string) => {
        const el = [...document.querySelectorAll("#profilesheet .subhead")]
          .find((n) => n.textContent === text)!;
        let prev = el.previousElementSibling;
        while (prev && prev.tagName !== "H2") prev = prev.previousElementSibling;
        return prev?.textContent ?? null;
      };
      return { countdown: bySubhead("Countdown"), shortcuts: bySubhead("Shot shortcuts") };
    });
    expect(sectionOf).toEqual({ countdown: "Preferences", shortcuts: "Preferences" });
  });

  /**
   * STC-412 final review, I1. The save-location row used to sit under its own
   * `<h2>Shot</h2>` — true while it was `still.destination` and governed
   * stills alone, and wrong from the moment `saveFolder` also decided where
   * RECORDINGS go and which root the library scans. Three claims, each of
   * which was false before this fix.
   */
  test("the save location is a Preferences row naming a real resolved path", async () => {
    const recordings = makeTakeFolder().dir;
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings });
    await win.click("#settings");
    await expect.poll(() => win.getAttribute("#profilesheet", "class")).toMatch(/open/);

    // 1. No section of its own any more.
    const headings = await win.locator("#profilesheet h2").allTextContents();
    expect(headings).not.toContain("Shot");

    // 2. And it is the first thing UNDER Preferences, not a peer of it. Read
    //    positionally rather than by a class name: the row could carry any
    //    markup and still be in the wrong place.
    const savedUnderPreferences = await win.evaluate(() => {
      const dest = document.getElementById("stilldest")!;
      const row = dest.closest("div")!;
      let prev = row.previousElementSibling;
      while (prev && prev.tagName !== "H2") prev = prev.previousElementSibling;
      return prev?.textContent ?? null;
    });
    expect(savedUnderPreferences).toBe("Preferences");

    // 3. A real path, never the words "beside the shot". With `saveFolder`
    //    unset this fixture's own `STC_RECORDINGS_DIR` IS the resolved
    //    default, which is exactly what `takesRoot` answers — so this also
    //    pins that the renderer asked main rather than inventing a default of
    //    its own, since nothing in the page can know this directory's name.
    await expect.poll(() => win.textContent("#stilldest"), { timeout: 10_000 })
      .toBe(recordings);
  });

  /**
   * STC-412 final review, I2. `camera-state`/`mic-state` were built as one
   * half of a PAIR with the warning that accompanies them (STC-287): the row
   * is the at-a-glance state, the alert is the thing that cannot be missed.
   * Task 4 put the whole diagnostics table behind a preference that is off by
   * default, which left STC-286's silent-camera case — a camera that opens,
   * names itself and delivers nothing — reporting itself in a toast for a few
   * seconds and then nowhere at all.
   */
  test("camera and mic state stay visible with diagnostics off", async () => {
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: makeTakeFolder().dir });
    // The preference is off by default, so this is the state a normal user is
    // in — no toggling first, deliberately.
    expect(await win.locator("#diagnostics").isHidden()).toBe(true);
    expect(await win.isVisible("#camera-state")).toBe(true);
    expect(await win.isVisible("#mic-state")).toBe(true);
    // And they are visible because they are OUTSIDE the toggled table, not
    // because the toggle happens to be on — the structural half, which is
    // what stops them being folded back in by a later edit.
    const inside = await win.evaluate(() => {
      const table = document.getElementById("diagnostics")!;
      return ["camera-state", "mic-state"]
        .filter((id) => table.contains(document.getElementById(id)));
    });
    expect(inside).toEqual([]);
    // The developer instrumentation is still behind the toggle, which is the
    // half of Task 4 that must NOT be undone by this.
    expect(await win.isVisible("#pid")).toBe(false);
    expect(await win.isVisible("#frames")).toBe(false);
  });
});
