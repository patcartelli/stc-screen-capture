import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-519: a recording saved from its panel did not appear under the selected
 * chip until the user changed chips. Promotion happens in main; the library
 * window only rescans when told. This pins the telling as a grep — the same
 * shape as `library-seam.test.ts` — because the failure needs a real panel
 * Save to reproduce and a new promote site is easy to add without it.
 */
const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

describe("library:changed (STC-519)", () => {
  const main = src("main.ts");

  test("main.ts promotes through promoteIntoLibrary, except Save All at quit", () => {
    const bare = main.split("\n").filter((l) => /\bpromoteTake\(/.test(l) && !l.trim().startsWith("*") && !l.trim().startsWith("//"));
    // The wrapper's own call, and the quit loop (the window is going away).
    expect(bare.length).toBe(2);
    expect(bare.some((l) => l.includes("onPromoted") || /promoteTake\([^)]*libraryChanged\)/.test(l))).toBe(true);
  });

  test("the wrapper tells the library, and libraryChanged sends the channel", () => {
    expect(main).toMatch(/promoteTake\([^)]*libraryChanged\)/);
    expect(main).toMatch(/function libraryChanged\(\): void \{\s*send\("library:changed"/);
    // One sender: every other place goes through libraryChanged.
    expect(main.match(/send\("library:changed"/g)?.length).toBe(1);
  });

  // STC-489: writes that add an item without a promotion. Each handler's
  // body, up to the next top-level handler, must call libraryChanged AFTER
  // its write, or the rescan runs before the file exists.
  const handler = (channel: string) => {
    const start = main.indexOf(`ipcMain.handle("${channel}"`);
    expect(start).toBeGreaterThan(-1);
    const end = main.indexOf("\nipcMain.handle(", start + 1);
    return main.slice(start, end === -1 ? undefined : end);
  };

  test.each(["export:write", "export:writeGif"])("%s tells the library after it writes", (channel) => {
    const body = handler(channel);
    expect(body.lastIndexOf("libraryChanged()")).toBeGreaterThan(body.lastIndexOf("await writeFile("));
  });

  test("panel:save tells the library again once the GIF is in place", () => {
    const body = handler("panel:save");
    const renamed = body.indexOf("await rename(partial, dest)");
    expect(renamed).toBeGreaterThan(-1);
    expect(body.indexOf("libraryChanged()", renamed)).toBeGreaterThan(renamed);
  });

  test("the renderer draws only the newest scan (STC-489)", () => {
    const r = src("renderer.ts");
    expect(r).toMatch(/const isCurrent = beginScan\(\)/);
    // Checked after each await, before anything the scan sets.
    const body = r.slice(r.indexOf("async function refreshTakes"), r.indexOf("lastList = list;"));
    expect(body.match(/if \(!isCurrent\(\)\) return;/g)?.length).toBe(2);
  });

  test("preload forwards the channel and the renderer rescans on it", () => {
    expect(src("preload.ts")).toContain('"library:changed"');
    expect(src("renderer.ts")).toMatch(/recorder\.on\("library:changed", \(\) => \{ void refreshTakes\(\)/);
  });

  test("control: the patterns do not match a file that lacks the wiring", () => {
    expect('recorder.on("still:captured", () => {})').not.toMatch(/recorder\.on\("library:changed"/);
    const unsignalled = "await writeFile(dest, data);\n  return dest;";
    expect(unsignalled.lastIndexOf("libraryChanged()")).toBeLessThan(unsignalled.lastIndexOf("await writeFile("));
  });
});
