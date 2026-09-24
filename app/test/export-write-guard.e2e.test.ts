import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { readFileSync, statSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { launchWithTakeInEditor, inkiness } from "./_editor-fixture.js";
import { exportMediaName } from "../src/share.js";
import { tagMp4 } from "@transform/media-tag.js";
import { mintCaptureId } from "@transform/capture-id.js";

/**
 * Source media is never mutated — enforced at the process boundary, not by
 * the renderer's good behaviour. export:write accepted any leaf name with a
 * known extension, which included the take's own display.mp4 and sidecars.
 *
 * `writeExport` lives on the editor's own bridge now (STC-373), not the main
 * window's — it is one of the channels that moved with the player.
 *
 * STC-413: a media export now lands at the TOP LEVEL of the folder (a sibling
 * of `raw/`, one directory up from the bundle `takeDir` names), resolved by
 * the bundle's own identity rather than by name. This file covers the three
 * cases the brief calls out: a first export lands at the derived name; a
 * re-export after a Finder rename overwrites the renamed file rather than
 * creating a second tile; and an export refuses to clobber an unrelated file
 * that happens to already occupy the derived name.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

/** A structurally valid, tiny MP4 `tagMp4` can actually tag (not just pad). */
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, data: number[]) => [...be32(8 + data.length), ...chars(type), ...data];
function mp4Bytes(): Uint8Array {
  return new Uint8Array([...box("ftyp", chars("isom")), ...box("mdat", [1, 2, 3, 4]),
    ...box("moov", [])]);
}

/** Write `bytes` through the editor's bridge, from the Node side of the test. */
async function writeExport(editorWin: Page, name: string, bytes: Uint8Array): Promise<string> {
  return editorWin.evaluate(async ([n, arr]: [string, number[]]) => {
    return (window as any).editor.writeExport(n, new Uint8Array(arr).buffer);
  }, [name, Array.from(bytes)] as [string, number[]]);
}

describe("export:write, through the editor's bridge (STC-373)", () => {
  test("refuses to overwrite the take's own files, and still writes an export", async () => {
    const { app: a, editorWin, takeDir, dir } = await launchWithTakeInEditor();
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
    // The legitimate name still works — and lands at the TOP LEVEL of the
    // folder now (a sibling of the bundle, not inside it).
    expect(await attempt("export-probe.mp4")).toBe("wrote");
    expect(existsSync(join(takeDir, "export-probe.mp4"))).toBe(false);
    expect(statSync(join(dir, "export-probe.mp4")).size).toBe(8);
  }, 120_000);

  /**
   * The load-bearing case for the whole design: rename the export in Finder,
   * then re-export. Naively deriving `<root>/<takeName>.mp4` again would
   * write a FRESH file beside the renamed one — two top-level files carrying
   * the SAME embedded id, two tiles for one capture. The destination is
   * resolved by the bundle's id instead, so the SECOND write lands on the
   * file the user named.
   */
  test("a re-export after a rename overwrites the renamed file, not a fresh one", async () => {
    const { app: a, editorWin, dir, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const takeName = basename(takeDir);
    const derivedName = exportMediaName(takeName);
    const id: string = await editorWin.evaluate(() => (window as any).editor.captureId());

    await writeExport(editorWin, derivedName, tagMp4(mp4Bytes(), id));
    const derivedPath = join(dir, derivedName);
    expect(existsSync(derivedPath)).toBe(true);

    // Simulate the Finder rename this ticket exists for.
    const renamedPath = join(dir, "login-bug.mp4");
    renameSync(derivedPath, renamedPath);

    // Re-export, asking (as the app always does) for the SAME derived name.
    await writeExport(editorWin, derivedName, tagMp4(mp4Bytes(), id));

    // The renamed file was overwritten in place...
    expect(readFileSync(renamedPath).length).toBeGreaterThan(0);
    // ...and no second file appeared at the derived name.
    expect(existsSync(derivedPath)).toBe(false);
  }, 120_000);

  /**
   * The widened overwrite guard. A file already occupying the derived name
   * with no id, or a DIFFERENT bundle's id, is someone else's capture or a
   * file the user placed there by hand — refuse rather than risk it.
   */
  test("refuses to clobber a file that occupies the name but isn't this bundle's", async () => {
    const { app: a, editorWin, dir, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const takeName = basename(takeDir);
    const derivedName = exportMediaName(takeName);
    const derivedPath = join(dir, derivedName);

    // A foreign capture (or a hand-placed file) already sits at the name
    // this take's own export would derive.
    writeFileSync(derivedPath, tagMp4(mp4Bytes(), mintCaptureId()));
    const before = readFileSync(derivedPath);

    const id: string = await editorWin.evaluate(() => (window as any).editor.captureId());
    const attempt = editorWin.evaluate(async ([n, arr]: [string, number[]]) => {
      try {
        await (window as any).editor.writeExport(n, new Uint8Array(arr).buffer);
        return "wrote";
      } catch (e: any) { return String(e?.message ?? e); }
    }, [derivedName, Array.from(tagMp4(mp4Bytes(), id))] as [string, number[]]);

    expect(await attempt).toMatch(/refusing to overwrite/);
    expect(readFileSync(derivedPath)).toEqual(before);
  }, 120_000);
});
