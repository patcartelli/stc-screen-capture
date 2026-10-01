import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./_editor-fixture.js";
import { toastPage, toastText } from "./_toast.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { mintCaptureId } from "@transform/capture-id.js";

/**
 * Reclaim space (STC-435), WIRED: the profile sheet's button, main's
 * find -> ask -> re-find -> trash, and the toast. `orphan-sweep.test.ts`
 * proves what `findOrphanedBundles` decides and `reclaim.test.ts` what the
 * user is told; neither proves the button reaches main, that a Cancel really
 * moves nothing, or that the skip case lands in a toast a person can see
 * instead of the stderr line STC-413 shipped. The native sheet is stubbed
 * (`manage.e2e.test.ts`'s idiom) and its arguments kept, so what it WOULD
 * have shown is asserted too; how it LOOKS is `docs/STC-435-RUNBOOK.md`'s.
 */

const RECORDING = "2026-09-01_10-00-00";
const STILL = "2026-09-02_10-00-00";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);

let app: ElectronApplication | undefined;
let page: Page;
let root: string;

function bundle(name: string, doc: "anchors.json" | "shot.json"): string {
  const dir = join(root, "raw", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, doc), "{}");
  writeFileSync(join(dir, "capture.json"), JSON.stringify({ version: 1, id: mintCaptureId() }));
  writeFileSync(join(dir, "payload.bin"), new Uint8Array(4096));
  return dir;
}

/** Stub the native sheet: answer `response`, and keep what it was asked to show. */
async function stubDialog(response: number): Promise<void> {
  await app!.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as { __reclaimAsked: unknown[] };
    g.__reclaimAsked = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.__reclaimAsked.push(args[args.length - 1]);
      return { response: r, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);
}

const asked = (): Promise<Array<{ message: string; detail: string; buttons: string[] }>> =>
  app!.evaluate(() => (globalThis as unknown as { __reclaimAsked: never[] }).__reclaimAsked);

async function pressReclaim(): Promise<void> {
  await page.click("#settings");
  await expect.poll(() => page.getAttribute("#profilesheet", "class")).toMatch(/open/);
  await page.click("#reclaimspace");
  // The renderer disables the button for the whole round trip.
  await expect.poll(() => page.locator("#reclaimspace").isDisabled(), { timeout: 20_000 }).toBe(false);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "stc-reclaim-"));
});
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

// 90 s per test: the launch (20 s), the button coming back (20 s), the bundle
// leaving `raw/` (20 s) and the toast (10 s) are 70 s worst case.
// `timeout-budget.test.ts` reads the literal, so it stays a literal.
describe("Reclaim space, through the real app", () => {
  test("shows the orphan first, trashes it on confirm, and leaves the untagged image alone", async () => {
    const rec = bundle(RECORDING, "anchors.json");
    writeFileSync(join(root, "holiday.jpg"), JPEG);           // untagged, but a still's kind
    ({ app, win: page } = await launchApp(root, {}, { ready: "#reclaimspace" }));
    await stubDialog(0);

    await pressReclaim();

    const [box] = await asked();
    expect(box?.message).toBe("Move 1 unused take to the Trash?");
    expect(box?.detail).toContain(`${RECORDING} — recording`);
    expect(box?.buttons[0]).toMatch(/^Move to Trash \(/);
    await expect.poll(() => existsSync(rec), { timeout: 20_000 }).toBe(false);
    expect(readFileSync(join(root, "holiday.jpg"))).toEqual(Buffer.from(JPEG));
    await expect.poll(() => toastText(app!), { timeout: 10_000 }).toContain("Moved 1 take");
  }, 90_000);

  test("Cancel moves nothing", async () => {
    const rec = bundle(RECORDING, "anchors.json");
    ({ app, win: page } = await launchApp(root, {}, { ready: "#reclaimspace" }));
    await stubDialog(1);

    await pressReclaim();

    expect(await asked()).toHaveLength(1);
    expect(existsSync(rec)).toBe(true);
  }, 90_000);

  test("the skip case is a visible toast naming the file in the way — no dialog, nothing moved", async () => {
    const still = bundle(STILL, "shot.json");
    writeFileSync(join(root, "holiday.jpg"), JPEG);           // blocks the still bundle
    ({ app, win: page } = await launchApp(root, {}, { ready: "#reclaimspace" }));
    await stubDialog(0);

    await pressReclaim();

    await expect.poll(() => toastPage(app!).then((p) => !!p), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => toastText(app!), { timeout: 10_000 }).toContain("Nothing to reclaim");
    expect(await toastText(app!)).toContain("holiday.jpg");
    expect(await asked()).toHaveLength(0);
    expect(existsSync(still)).toBe(true);
  }, 90_000);
});
