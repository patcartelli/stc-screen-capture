import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * STC-465 review (no ticket yet — Patrick should file one): `preview:writeProject`
 * used to parse the renderer's bytes only far enough to check `isProjectVersion`,
 * then write the ORIGINAL bytes to `project.json` verbatim — unlike
 * `still:writeShot`, which always round-trips through `parseShot`/`shotForWrite`.
 * A version-valid document could still carry a field of the wrong type or out
 * of range (a negative cursor scale, an unknown extra key) and it reached disk
 * completely unfiltered.
 *
 * The identical fix (routing through `parseProject`/`projectForWrite`) is not
 * reachable from `main.ts`: `trim.ts` reaches DOM-typed code
 * (`transform-version.ts` -> `cursor.ts` -> `cursor-art.ts`) and
 * `tsconfig.node.json`'s no-DOM pass correctly refuses it (confirmed by
 * running `npm run typecheck` against that import — the node pass failed on
 * `cursor-art.ts`'s `CanvasGradient`/`CanvasPattern` types). What shipped
 * instead is `rejectMalformedProjectDoc`, a main-process-safe guard that
 * REFUSES a document with an unrecognised field or a wrong-typed/out-of-range
 * known one, rather than `parseProject`'s fuller clamp-to-default behaviour.
 * This test drives that guard through the editor's real bridge.
 *
 * `makeTakeFolder`'s fixture (`_take-fixture.ts`) copies only anchors.json/
 * events.json/display.mp4 — a take the app records has no project.json until
 * something writes one, the same as a real take. So "before" is "no file",
 * and a refusal must leave it that way rather than manufacturing one.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function attemptWrite(editorWin: any, doc: unknown): Promise<string> {
  return editorWin.evaluate(async (d: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(d));
    try { await (window as any).editor.writeProject(bytes.buffer); return "wrote"; }
    catch (e: any) { return String(e?.message ?? e); }
  }, doc);
}

// A minimal, otherwise-well-formed document every "refuses X" test starts
// from and overrides just the field under test — output now needs `fps` too
// (a gap this same review pass closed; see rejectMalformedProjectDoc).
const BASE_GOOD = {
  version: 3,
  output: { width: 640, height: 360, fps: 60 },
  cursor: { style: "default", scale: 1 },
  transform: { version: 8 },
};

// A valid pip.style (STC-461): every field cleanPipStyle requires.
const GOOD_STYLE = {
  shape: "circle", width: 0.125, cornerRadius: 0, center: { x: 0.9, y: 0.9 },
  shadow: true, border: null, mirror: false,
};

describe("preview:writeProject refuses a malformed document (STC-465 review)", () => {
  test("refuses an out-of-range known field", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const projectPath = join(takeDir, "project.json");
    expect(existsSync(projectPath)).toBe(false);

    const malformed = { ...BASE_GOOD, cursor: { style: "default", scale: -5 } }; // out of range
    expect(await attemptWrite(editorWin, malformed)).toMatch(/cursor\.scale/);
    // The refusal must not have created a project.json where none existed.
    expect(existsSync(projectPath)).toBe(false);
  }, 120_000);

  test("refuses an unrecognised top-level field", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const projectPath = join(takeDir, "project.json");
    expect(existsSync(projectPath)).toBe(false);

    const malformed = { ...BASE_GOOD, extraneousField: "must not survive" };
    expect(await attemptWrite(editorWin, malformed)).toMatch(/unrecognised field/);
    expect(existsSync(projectPath)).toBe(false);
  }, 120_000);

  test("still refuses a document whose version is not supported, the same as before", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await attemptWrite(editorWin, { version: 999 })).toMatch(/not supported/);
  }, 120_000);

  // STC-466/467/468 review pass: rejectMalformedProjectDoc originally left
  // pip/transform/overrides/narrationCleanup completely unchecked, and
  // under-enforced output/cursor.scale/micLevel/systemAudioLevel/trim against
  // the schema's real bounds. Each case below pins one closed gap.
  test("refuses output missing fps or out of its schema range", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await attemptWrite(editorWin, { ...BASE_GOOD, output: { width: 640, height: 360 } }))
      .toMatch(/output must be/);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, output: { width: 3841, height: 360, fps: 60 } }))
      .toMatch(/output must be/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("refuses an inverted trim range (endNs <= startNs)", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await attemptWrite(editorWin, { ...BASE_GOOD, trim: { startNs: 5000, endNs: 100 } }))
      .toMatch(/endNs > startNs/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("refuses zoom.intensity out of range and an unknown zoom.preset", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await attemptWrite(editorWin, { ...BASE_GOOD, zoom: { enabled: true, intensity: 99, preset: "standard" } }))
      .toMatch(/zoom\.intensity/);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, zoom: { enabled: true, intensity: 0.5, preset: "bogus" } }))
      .toMatch(/zoom\.preset/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("refuses micLevel/systemAudioLevel out of their schema ranges", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await attemptWrite(editorWin, { ...BASE_GOOD, micLevel: 500 })).toMatch(/micLevel/);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, systemAudioLevel: 500 })).toMatch(/systemAudioLevel/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("refuses a malformed pip block", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await attemptWrite(editorWin, { ...BASE_GOOD, pip: { enabled: true, corner: "top-left", widthPct: 0.125, marginPx: 24 } }))
      .toMatch(/pip/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("refuses a malformed narrationCleanup block", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await attemptWrite(editorWin, { ...BASE_GOOD, narrationCleanup: { enabled: "yes", strength: 99 } }))
      .toMatch(/narrationCleanup/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("refuses a malformed overrides entry", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await attemptWrite(editorWin, { ...BASE_GOOD, overrides: [{ kind: "geometry", windowId: "1000" }] }))
      .toMatch(/geometry override/);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, overrides: [{ kind: "bogus" }] }))
      .toMatch(/unknown kind/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("a well-formed document still writes", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await attemptWrite(editorWin, BASE_GOOD)).toBe("wrote");
    const written = JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));
    expect(written.cursor.scale).toBe(1);
  }, 120_000);

  test("a well-formed document exercising every newly-validated field still writes", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const full = {
      ...BASE_GOOD,
      pip: { enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 24 },
      trim: { startNs: 0, endNs: 5_000_000_000 },
      zoom: { enabled: true, intensity: 0.5, preset: "standard" },
      narrationCleanup: { enabled: true, strength: 0.5 },
      micLevel: 1, systemAudioLevel: 1,
      overrides: [{ kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
    };
    expect(await attemptWrite(editorWin, full)).toBe("wrote");
    const written = JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));
    expect(written.pip.corner).toBe("bottom-right");
  }, 120_000);

  test("refuses a malformed keycast block (STC-419)", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 14, keycast: { show: "no" } })).toMatch(/keycast/);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 14, keycast: { show: false, at: "top" } })).toMatch(/keycast/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("a project-14 with keycast hidden writes (STC-419)", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 14, keycast: { show: false } })).toBe("wrote");
    expect(JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8")).keycast).toEqual({ show: false });
  }, 120_000);

  test("refuses a malformed pip.style (STC-461)", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    const pip = { enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32 };
    const style = { ...GOOD_STYLE, border: { widthPt: 2, color: "white" } };
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 16, pip: { ...pip, style } })).toMatch(/pip\.style/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("a project-16 with a valid pip.style writes (STC-461)", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    const pip = { enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32 };
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 16, pip: { ...pip, style: GOOD_STYLE } })).toBe("wrote");
    expect(JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8")).pip.style.shape).toBe("circle");
  }, 120_000);

  test("refuses a malformed framing block (STC-396)", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 15, framing: { preset: "bogus" } })).toMatch(/framing/);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 15, framing: { preset: "clean", paddingPct: 9 } })).toMatch(/framing/);
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
  }, 120_000);

  test("a project-15 with a framing writes (STC-396)", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await attemptWrite(editorWin, { ...BASE_GOOD, version: 15, framing: { preset: "clean" } })).toBe("wrote");
    expect(JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8")).framing).toEqual({ preset: "clean" });
  }, 120_000);
});
