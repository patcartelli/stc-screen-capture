import { describe, test, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  copiesRoot, copyPathFor, gifCopyPathFor, savedGifName, purgeDecision, PARTIAL_SUFFIX,
  COPY_MAX_AGE_MS, PARTIAL_MAX_AGE_MS,
} from "../src/recording-copy.js";
import { PRODUCT_NAME } from "../src/product.js";

/**
 * STC-488: where a recording's rendered copy lives, and which copies the
 * purge may delete. No Electron, no filesystem: main does the I/O.
 */
describe("where a copy lives", () => {
  test("STC_COPIES_DIR wins, so tests never touch a real Application Support", () => {
    expect(copiesRoot({ STC_COPIES_DIR: "/tmp/x" })).toBe("/tmp/x");
  });

  test("otherwise beside temp-takes, under the product's own folder", () => {
    expect(copiesRoot({})).toBe(join(homedir(), "Library", "Application Support", PRODUCT_NAME, "copies"));
  });

  test("a copy is named after its take, which is what a paste shows", () => {
    expect(copyPathFor({ STC_COPIES_DIR: "/c" }, "/t/2026-10-01_18-04-12"))
      .toBe("/c/2026-10-01_18-04-12.mp4");
  });
});

describe("the purge", () => {
  const now = 10 * COPY_MAX_AGE_MS;
  const root = "/c";
  const old = { name: "a.mp4", mtimeMs: now - COPY_MAX_AGE_MS - 1 };
  const young = { name: "b.mp4", mtimeMs: now - COPY_MAX_AGE_MS + 1_000 };
  const stalePartial = { name: `c.mp4${PARTIAL_SUFFIX}`, mtimeMs: now - PARTIAL_MAX_AGE_MS - 1 };
  const freshPartial = { name: `d.mp4${PARTIAL_SUFFIX}`, mtimeMs: now - 1_000 };

  test("deletes copies older than 24 h, keeps younger ones", () => {
    expect(purgeDecision([old, young], now, new Set(), root)).toEqual(["a.mp4"]);
  });

  test("keeps the copy still on the clipboard, however old", () => {
    expect(purgeDecision([old], now, new Set([join(root, "a.mp4")]), root)).toEqual([]);
  });

  test("deletes a partial a crash left behind, keeps one a render may still be writing", () => {
    expect(purgeDecision([stalePartial, freshPartial], now, new Set(), root)).toEqual([`c.mp4${PARTIAL_SUFFIX}`]);
  });

  test("deletes nothing when the clipboard is unknown (Review Focus 5)", () => {
    expect(purgeDecision([old, stalePartial], now, undefined, root)).toEqual([]);
  });

  test("ignores anything that is not a copy or a partial", () => {
    expect(purgeDecision([{ name: ".DS_Store", mtimeMs: 0 }], now, new Set(), root)).toEqual([]);
  });
});

describe("STC-395: GIF copies", () => {
  test("a GIF copy sits beside the mp4 copy, named after its take", () => {
    expect(gifCopyPathFor({ STC_COPIES_DIR: "/c" }, "/t/2026-10-08_10-00-00"))
      .toBe("/c/2026-10-08_10-00-00.gif");
  });

  const now = 10 * COPY_MAX_AGE_MS;
  const root = "/c";
  test("the purge treats .gif exactly as .mp4", () => {
    const entries = [
      { name: "old.gif", mtimeMs: now - COPY_MAX_AGE_MS - 1 },
      { name: "new.gif", mtimeMs: now - 1000 },
      { name: "pasted.gif", mtimeMs: now - COPY_MAX_AGE_MS - 1 },
      { name: "stale.gif" + PARTIAL_SUFFIX, mtimeMs: now - PARTIAL_MAX_AGE_MS - 1 },
      { name: "fresh.gif" + PARTIAL_SUFFIX, mtimeMs: now - 1000 },
    ];
    expect(purgeDecision(entries, now, new Set([join(root, "pasted.gif")]), root).sort())
      .toEqual(["old.gif", "stale.gif" + PARTIAL_SUFFIX]);
  });
  test("an unreadable clipboard still deletes nothing, GIFs included", () => {
    expect(purgeDecision([{ name: "old.gif", mtimeMs: 0 }], now, undefined, root)).toEqual([]);
  });
});

describe("STC-395: a saved GIF's name (Review Focus 5)", () => {
  test("the take's name when free", () => {
    expect(savedGifName("2026-10-08_10-00-00", ["2026-10-08_10-00-00.mp4", "raw"])).toBe("2026-10-08_10-00-00.gif");
  });
  test("never overwrites: -2, -3 … like a take directory", () => {
    expect(savedGifName("t", ["t.gif"])).toBe("t-2.gif");
    expect(savedGifName("t", ["t.gif", "t-2.gif"])).toBe("t-3.gif");
  });
  test("a partial in flight counts as taken", () => {
    expect(savedGifName("t", ["t.gif.partial"])).toBe("t-2.gif");
  });
});
