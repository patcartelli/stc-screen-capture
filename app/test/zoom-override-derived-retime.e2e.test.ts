/**
 * Deleting or retiming a DERIVED window (STC-329), wired — phase 3 of
 * STC-328, reusing the exact interaction vocabulary STC-330/331 already
 * built: `zoom-override.test.ts`/`zoom-override-project.test.ts` prove the
 * pure resolution and document logic with no screen; this drives the real
 * editor window the same way `zoom-override.e2e.test.ts` (phase 1) and
 * `zoom-override-manual.e2e.test.ts` (phase 2) already do.
 *
 * The fixture (`fixtures/basic`) has one click at t=2005ms, so the one
 * derived zoom window is [1705ms, 4505ms] (300ms lead, 2500ms hold),
 * windowId "1705000000".
 */
import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launchWithTakeInEditor, dragOnStage, pressOverrideDone } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const MS = 1_000_000;
const WINDOW_ID = "1705000000";
const ORIGINAL_START_MS = 1705;
const ORIGINAL_END_MS = 4505;

async function openPreview() {
  const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
  app = a;
  await expect.poll(() => editorWin.textContent("#clock"), { timeout: 20_000 }).toMatch(/^\d:\d\d:\d\d /);
  await expect.poll(() => editorWin.locator(".zoomblock").count(), { timeout: 10_000 }).toBe(1);
  return { win: editorWin, takeDir };
}

function readProject(takeDir: string): any {
  return JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));
}

/** Drags the derived block's own edge handle to a fraction of the FULL lane width — the exact helper zoom-override-manual.e2e.test.ts uses for a manual window's own handles, reused verbatim since the handles are the same elements. */
async function dragHandle(win: Page, which: "start" | "end", toFraction: number): Promise<void> {
  await win.locator(`#manualhandle-${which}`).scrollIntoViewIfNeeded();
  const laneBox = await win.locator("#override-blocks").boundingBox();
  const handle = await win.locator(`#manualhandle-${which}`).boundingBox();
  if (!laneBox || !handle) throw new Error("lane or handle has no box");
  const fromX = handle.x + handle.width / 2;
  const fromY = handle.y + handle.height / 2;
  const toX = laneBox.x + toFraction * laneBox.width;
  await win.mouse.move(fromX, fromY);
  await win.mouse.down();
  await win.mouse.move((fromX + toX) / 2, fromY);
  await win.mouse.move(toX, fromY);
  await win.mouse.up();
}

describe("selecting a derived block", () => {
  test("shows the edge handles as well as the rect tool", async () => {
    const { win } = await openPreview();
    await win.click(".zoomblock");
    await expect.poll(() => win.isVisible("#overridebar"), { timeout: 10_000 }).toBe(true);
    expect(await win.isVisible("#manualhandle-start")).toBe(true);
    expect(await win.isVisible("#manualhandle-end")).toBe(true);
    // The block itself moves off the dynamic list onto #manualdraft while
    // being edited — the same trick a manual window's own edit already
    // relies on — so exactly one .zoomblock remains: the static draft one.
    expect(await win.locator(".zoomblock").count()).toBe(1);
  }, 60_000);

  test("shows the Delete window button, distinct from Remove override", async () => {
    const { win } = await openPreview();
    await win.click(".zoomblock");
    await expect.poll(() => win.isVisible("#overridedelete"), { timeout: 10_000 }).toBe(true);
    expect(await win.textContent("#overridedelete")).toBe("Delete window");
    expect(await win.textContent("#overrideclear")).toBe("Remove override");
  }, 60_000);
});

describe("retiming a derived window by its edges", () => {
  test("dragging the start handle earlier writes a retime with only startNs set", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragHandle(win, "start", 0.05); // well before the original 1705ms start
    await pressOverrideDone(win);

    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    const [o] = readProject(takeDir).overrides;
    expect(o.kind).toBe("retime");
    expect(o.windowId).toBe(WINDOW_ID);
    expect(o.startNs).toBeLessThan(ORIGINAL_START_MS * MS);
    expect("endNs" in o).toBe(false); // untouched — not written at all
  }, 30_000);

  test("dragging the end handle later writes a retime with only endNs set", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragHandle(win, "end", 0.98); // well past the original 4505ms end
    await pressOverrideDone(win);

    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    const [o] = readProject(takeDir).overrides;
    expect(o.kind).toBe("retime");
    expect(o.windowId).toBe(WINDOW_ID);
    expect(o.endNs).toBeGreaterThan(ORIGINAL_END_MS * MS);
    expect("startNs" in o).toBe(false);
  }, 30_000);

  test("re-opening a retimed block seeds the handles from its NEW bounds, not the original derivation", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragHandle(win, "start", 0.05);
    await pressOverrideDone(win);
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    const first = readProject(takeDir).overrides[0];

    // Reopen and leave immediately — a no-op edit must not rewrite the
    // override back toward the original derivation.
    await win.click(".zoomblock");
    await expect.poll(() => win.isVisible("#overridebar"), { timeout: 10_000 }).toBe(true);
    await win.keyboard.press("Escape");
    await expect.poll(() => win.isHidden("#overridebar"), { timeout: 10_000 }).toBe(true);

    expect(readProject(takeDir).overrides?.length).toBe(1);
    expect(readProject(takeDir).overrides[0]).toEqual(first);
  }, 60_000);
});

describe("retime composes with a geometry override on the same window", () => {
  test("dragging both the rect and an edge in one edit writes BOTH a geometry and a retime entry", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.5 });
    await dragHandle(win, "end", 0.98);
    await pressOverrideDone(win);

    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(2);
    const kinds = readProject(takeDir).overrides.map((o: any) => o.kind).sort();
    expect(kinds).toEqual(["geometry", "retime"]);
    const geometry = readProject(takeDir).overrides.find((o: any) => o.kind === "geometry");
    const retime = readProject(takeDir).overrides.find((o: any) => o.kind === "retime");
    expect(geometry.windowId).toBe(WINDOW_ID);
    expect(retime.windowId).toBe(WINDOW_ID);
    expect(geometry.rect.x).toBeCloseTo(0.2, 1);
  }, 30_000);

  test("Remove override clears only the geometry — a prior retime survives", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragHandle(win, "end", 0.98);
    await pressOverrideDone(win);
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);

    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 });
    await expect.poll(() => win.isEnabled("#overrideclear"), { timeout: 10_000 }).toBe(true);
    await win.click("#overrideclear");

    await expect.poll(() => readProject(takeDir).overrides?.length ?? 0, { timeout: 10_000 }).toBe(1);
    const [o] = readProject(takeDir).overrides;
    expect(o.kind).toBe("retime"); // the geometry drag was discarded, the retime kept
  }, 60_000);
});

describe("deleting a derived window", () => {
  test("Delete window drops it outright — the block disappears and it never plays again", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await win.click("#overridedelete");

    await expect.poll(() => readProject(takeDir).overrides?.length ?? 0, { timeout: 10_000 }).toBe(1);
    const [o] = readProject(takeDir).overrides;
    expect(o).toEqual({ kind: "removed", windowId: WINDOW_ID });
    await expect.poll(() => win.locator(".zoomblock").count(), { timeout: 10_000 }).toBe(0);
    expect(await win.isHidden("#overridebar")).toBe(true);
  }, 60_000);

  test("deleting a window that already had a geometry override replaces it with removed, not both", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 });
    await pressOverrideDone(win);
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);

    await win.click(".zoomblock");
    await win.click("#overridedelete");
    await expect.poll(() => readProject(takeDir).overrides?.length ?? 0, { timeout: 10_000 }).toBe(1);
    expect(readProject(takeDir).overrides[0]).toEqual({ kind: "removed", windowId: WINDOW_ID });
  }, 60_000);
});
