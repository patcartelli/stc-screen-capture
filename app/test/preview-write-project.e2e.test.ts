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

describe("preview:writeProject refuses a malformed document (STC-465 review)", () => {
  test("refuses an out-of-range known field", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const projectPath = join(takeDir, "project.json");
    expect(existsSync(projectPath)).toBe(false);

    const malformed = {
      version: 3,
      output: { width: 640, height: 360 },
      cursor: { style: "default", scale: -5 }, // out of range
      transform: { version: 8 },
    };
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

    const malformed = {
      version: 3,
      output: { width: 640, height: 360 },
      cursor: { style: "default", scale: 1 },
      transform: { version: 8 },
      extraneousField: "must not survive",
    };
    expect(await attemptWrite(editorWin, malformed)).toMatch(/unrecognised field/);
    expect(existsSync(projectPath)).toBe(false);
  }, 120_000);

  test("still refuses a document whose version is not supported, the same as before", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await attemptWrite(editorWin, { version: 999 })).toMatch(/not supported/);
  }, 120_000);

  test("a well-formed document still writes", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const good = {
      version: 3,
      output: { width: 640, height: 360 },
      cursor: { style: "default", scale: 1 },
      transform: { version: 8 },
    };
    expect(await attemptWrite(editorWin, good)).toBe("wrote");
    const written = JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));
    expect(written.cursor.scale).toBe(1);
  }, 120_000);
});
