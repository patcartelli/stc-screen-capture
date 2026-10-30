import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { launchWithTakeInEditor, waitForTakeLoaded } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The editor's focus and reduced-motion pass (STC-607, on STC-506's and
 * STC-587's rules), for the surfaces STC-603 to STC-606 rebuilt. What these
 * pin: the trim brackets and the scrub bar wear the one `--focus` ring (they
 * wore the accent), a bracket the keyboard is on is visible in Export (where
 * the bars stand in for them at opacity 0), and a held bracket does not
 * animate a transform under reduced motion. axe is `npm run axe:renderers`;
 * whether any of it LOOKS right is the runbook's, on a Mac.
 */
/** tokens.css's dark `--focus`; the editor is dark. */
const FOCUS_RING = "rgb(122, 162, 255)";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openEditor(): Promise<Page> {
  const { app: a, editorWin } = await launchWithTakeInEditor();
  app = a;
  await waitForTakeLoaded(editorWin);
  await editorWin.waitForFunction(() => !/\/\s*0:00:00\s*$/.test(document.getElementById("clock")?.textContent ?? ""), null, { timeout: 20_000 });
  return editorWin;
}

/** Put the keyboard on `sel` the way a person gets there, so :focus-visible matches. */
async function tabTo(win: Page, sel: string): Promise<void> {
  await win.focus(sel);
  await win.keyboard.press("Shift+Tab");
  await win.keyboard.press("Tab");
}

const ringOf = (win: Page, sel: string) => win.evaluate((s) => {
  const el = document.querySelector<HTMLElement>(s)!;
  const cs = getComputedStyle(el);
  return { visible: el.matches(":focus-visible"), outline: `${cs.outlineStyle} ${cs.outlineColor}`, opacity: cs.opacity, z: Number(cs.zIndex) };
}, sel);

describe("the editor: focus and reduced motion (STC-607)", () => {
  test("the brackets and the scrub bar wear the --focus ring", async () => {
    const win = await openEditor();
    for (const sel of ["#trim-in", "#trim-out", "#scrub"]) {
      await tabTo(win, sel);
      const ring = await ringOf(win, sel);
      expect(ring.visible, `${sel} is focus-visible`).toBe(true);
      expect(ring.outline, sel).toBe(`solid ${FOCUS_RING}`);
    }
  }, 60_000);

  test("in Export a bracket the keyboard is on is visible, and hides again when it leaves", async () => {
    const win = await openEditor();
    await win.click("#tab-export");
    expect((await ringOf(win, "#trim-in")).opacity).toBe("0");
    await tabTo(win, "#trim-in");
    const ring = await ringOf(win, "#trim-in");
    expect(ring.visible).toBe(true);
    expect(ring.opacity).toBe("1");
    // Above the brass bar that stands on the same point, or the bracket is
    // drawn but covered (Patrick's Mac pass).
    expect(ring.z).toBeGreaterThan((await ringOf(win, "#exportbar-in")).z);
    expect(ring.outline).toBe(`solid ${FOCUS_RING}`);
    await win.evaluate(() => (document.activeElement as HTMLElement).blur());
    expect((await ringOf(win, "#trim-in")).opacity).toBe("0");
  }, 60_000);

  test("under reduced motion a bracket does not transition a transform", async () => {
    const win = await openEditor();
    const props = () => win.evaluate(() => getComputedStyle(document.getElementById("trim-in")!).transitionProperty);
    await win.emulateMedia({ reducedMotion: "no-preference" });
    expect(await props()).toContain("transform");
    await win.emulateMedia({ reducedMotion: "reduce" });
    expect(await props()).not.toContain("transform");
    expect(await props()).toContain("color");
  }, 60_000);
});
