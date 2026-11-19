import { describe, test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeName, installTrashSeam, seamPasteboardText, trashItem, writeClipboardText } from "../src/machine-seams.js";

/** STC-658: the Trash and clipboard seams, without an app. */

function take(name = "2026-08-24_10-00-00"): string {
  const dir = join(mkdtempSync(join(tmpdir(), "stc-seam-src-")), name);
  mkdirSync(dir);
  writeFileSync(join(dir, "anchors.json"), "{}");
  return dir;
}

describe("trashItem", () => {
  test("with no STC_TRASH_DIR it is the real Trash, and nothing else", async () => {
    const asked: string[] = [];
    const dir = take();
    const at = await trashItem(dir, { env: {}, shellTrash: async (p) => { asked.push(p); } });
    expect(asked).toEqual([dir]);
    expect(at).toBeUndefined();
    expect(existsSync(dir), "the seam moved it as well as the Trash").toBe(true);
  });

  test("with STC_TRASH_DIR it moves the folder there and never calls the real Trash", async () => {
    const trash = mkdtempSync(join(tmpdir(), "stc-seam-trash-"));
    const dir = take();
    const at = await trashItem(dir, {
      env: { STC_TRASH_DIR: trash },
      shellTrash: async () => { throw new Error("reached the real Trash"); },
    });
    expect(at).toBe(join(trash, "2026-08-24_10-00-00"));
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(at!, "anchors.json"), "utf8")).toBe("{}");
  });

  test("a second folder with the same name gets a numbered name, like the Finder's Trash", async () => {
    const trash = mkdtempSync(join(tmpdir(), "stc-seam-trash-"));
    const deps = { env: { STC_TRASH_DIR: trash }, shellTrash: async () => {} };
    expect(await trashItem(take(), deps)).toBe(join(trash, "2026-08-24_10-00-00"));
    expect(await trashItem(take(), deps)).toBe(join(trash, "2026-08-24_10-00-00 2"));
    expect(freeName(trash, "2026-08-24_10-00-00")).toBe(join(trash, "2026-08-24_10-00-00 3"));
  });

  test("a missing path rejects, as shell.trashItem does", async () => {
    const trash = mkdtempSync(join(tmpdir(), "stc-seam-trash-"));
    await expect(trashItem(join(trash, "nope", "gone"), { env: { STC_TRASH_DIR: trash }, shellTrash: async () => {} }))
      .rejects.toThrow();
  });
});

describe("installTrashSeam", () => {
  test("replaces shell.trashItem only when STC_TRASH_DIR is set", async () => {
    const real = async (_path: string): Promise<void> => { throw new Error("real Trash"); };
    const off = { trashItem: real };
    expect(installTrashSeam(off, {})).toBe(false);
    expect(off.trashItem).toBe(real);

    const trash = mkdtempSync(join(tmpdir(), "stc-seam-trash-"));
    const on = { trashItem: real };
    expect(installTrashSeam(on, { STC_TRASH_DIR: trash })).toBe(true);
    const dir = take();
    await on.trashItem(dir);
    expect(existsSync(join(trash, "2026-08-24_10-00-00"))).toBe(true);
  });
});

describe("writeClipboardText", () => {
  test("with no STC_PASTEBOARD it writes the real clipboard", () => {
    const wrote: string[] = [];
    writeClipboardText("#FF0000", { env: {}, writeText: (t) => wrote.push(t) });
    expect(wrote).toEqual(["#FF0000"]);
  });

  test("with STC_PASTEBOARD it keeps the text and never touches the real clipboard", () => {
    const before = seamPasteboardText.length;
    writeClipboardText("recognised text", {
      env: { STC_PASTEBOARD: "stc-e2e-test" },
      writeText: () => { throw new Error("reached the real clipboard"); },
    });
    expect(seamPasteboardText.slice(before)).toEqual(["recognised text"]);
  });
});
