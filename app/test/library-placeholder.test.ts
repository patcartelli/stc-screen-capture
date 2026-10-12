import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLibrary, folderStatusOf } from "../src/library.js";
import { placeholderFor, type LibraryList } from "../src/library-items.js";

/**
 * What the library says with nothing to draw (STC-521). The decisions are pure
 * and the folder classification is one readdir, so none of this needs a window;
 * `library.e2e.test.ts` reaches each state through the real app.
 */

const ctx = { folder: "/Users/x/Desktop/stc", shotKey: "⌃⌥⇧⌘3", recordKey: "⌃⌥⇧⌘4" };
const list = (over: Partial<LibraryList> = {}): LibraryList => ({
  items: [], invalid: [], filters: [], filter: "all", folder: { state: "ok" }, ...over,
});

describe("placeholderFor", () => {
  test("an empty folder names itself and both hotkeys", () => {
    const p = placeholderFor(list(), ctx)!;
    expect(p.state).toBe("empty");
    expect(p.path).toBe(ctx.folder);
    expect(p.body).toContain("⌃⌥⇧⌘3 takes a screenshot");
    expect(p.body).toContain("⌃⌥⇧⌘4 starts a recording");
  });

  test("with both hotkeys unbound it points at the buttons instead", () => {
    const p = placeholderFor(list(), { ...ctx, shotKey: null, recordKey: null })!;
    expect(p.body).toContain("Record or Shot");
    expect(p.body).not.toContain("null");
  });

  test("a filter with nothing in it is not the empty folder", () => {
    expect(placeholderFor(list({ filter: "recordings" }), ctx)!.state).toBe("filtered");
  });

  test("a library with items has no placeholder", () => {
    expect(placeholderFor(list({ items: [{} as never] }), ctx)).toBeNull();
  });

  test("a broken item alone is still a grid, not an empty state", () => {
    expect(placeholderFor(list({ invalid: [{ dir: "d", name: "n", reason: "r" }] }), ctx)).toBeNull();
  });

  test("a lost folder wins over empty, and offers a way out", () => {
    const p = placeholderFor(list({ folder: { state: "missing", path: "/gone" } }), ctx)!;
    expect(p.state).toBe("missing");
    expect(p.path).toBe("/gone");
    expect(p.actions).toEqual(["retry", "choose-folder"]);
  });

  test("an unreadable folder is its own state, even over items", () => {
    const p = placeholderFor(list({ items: [{} as never], folder: { state: "unreadable", path: "/locked" } }), ctx)!;
    expect(p.state).toBe("unreadable");
  });
});

describe("folderStatusOf", () => {
  test("a missing DEFAULT folder is a fresh install, not a problem", () => {
    expect(folderStatusOf({}, null, "/p", "ENOENT")).toEqual({ state: "ok" });
  });
  test("a missing NAMED folder (setting or env) is missing", () => {
    expect(folderStatusOf({}, "/p", "/p", "ENOENT")).toEqual({ state: "missing", path: "/p" });
    expect(folderStatusOf({ STC_RECORDINGS_DIR: "/p" }, null, "/p", "ENOENT"))
      .toEqual({ state: "missing", path: "/p" });
  });
  test("anything else is unreadable, named or not", () => {
    expect(folderStatusOf({}, null, "/p", "EACCES")).toEqual({ state: "unreadable", path: "/p" });
    expect(folderStatusOf({}, null, "/p", undefined)).toEqual({ state: "unreadable", path: "/p" });
  });
});

describe("listLibrary reports the folder", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "stc-ph-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("an existing empty folder is ok", async () => {
    const l = await listLibrary({ STC_RECORDINGS_DIR: root } as NodeJS.ProcessEnv, null);
    expect(l.folder).toEqual({ state: "ok" });
  });
  test("a deleted folder is missing", async () => {
    rmSync(root, { recursive: true });
    const l = await listLibrary({ STC_RECORDINGS_DIR: root } as NodeJS.ProcessEnv, null);
    expect(l.folder).toEqual({ state: "missing", path: root });
  });
  test("a file where the folder should be is unreadable", async () => {
    const file = join(root, "not-a-folder");
    writeFileSync(file, "x");
    const l = await listLibrary({} as NodeJS.ProcessEnv, file);
    expect(l.folder).toEqual({ state: "unreadable", path: file });
  });
});
