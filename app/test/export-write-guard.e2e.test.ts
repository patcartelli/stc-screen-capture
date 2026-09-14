import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, inkiness } from "./_editor-fixture.js";

/**
 * Source media is never mutated — enforced at the process boundary, not by
 * the renderer's good behaviour. export:write accepted any leaf name with a
 * known extension, which included the take's own display.mp4 and sidecars.
 *
 * `writeExport` lives on the editor's own bridge now (STC-373), not the main
 * window's — it is one of the channels that moved with the player.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

describe("export:write, through the editor's bridge (STC-373)", () => {
  test("refuses to overwrite the take's own files, and still writes an export", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const before = statSync(join(takeDir, "display.mp4")).size;
    const anchorsBefore = readFileSync(join(takeDir, "anchors.json"), "utf8");
    const attempt = (name: string) => editorWin.evaluate(async (n: string) => {
      try { await (window as any).editor.writeExport(n, new ArrayBuffer(8)); return "wrote"; }
      catch (e: any) { return String(e?.message ?? e); }
    }, name);

    for (const name of ["display.mp4", "camera.mp4", "anchors.json", "events.json", "project.json", "take.json"]) {
      expect(await attempt(name), name).toMatch(/refusing to overwrite/);
    }
    expect(statSync(join(takeDir, "display.mp4")).size).toBe(before);
    expect(readFileSync(join(takeDir, "anchors.json"), "utf8")).toBe(anchorsBefore);
    // The legitimate name still works.
    expect(await attempt("export-probe.mp4")).toBe("wrote");
    expect(statSync(join(takeDir, "export-probe.mp4")).size).toBe(8);
  }, 120_000);
});
