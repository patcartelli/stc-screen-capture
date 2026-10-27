import { describe, test, expect } from "vitest";
import {
  pixelSizeLabel, formatChip, capturedLabel, countLabel, applySearch, searchPlaceholder,
  looseFileItem, LIBRARY_FILTERS, NO_VALUE, type LibraryItem,
} from "../src/library-items.js";

/**
 * The library redesign's pure presentation (STC-584): what the grid's readout,
 * the list's columns, the title bar's count and the search box show. Each is a
 * function of the item and nothing else, so it is checked here with no window.
 */

describe("a capture's pixel size", () => {
  test("a recording at a standard 16:9 height is named by it", () => {
    expect(pixelSizeLabel(1920, 1080, true)).toBe("1080p");
    expect(pixelSizeLabel(2560, 1440, true)).toBe("1440p");
    expect(pixelSizeLabel(3840, 2160, true)).toBe("2160p");
  });
  test("anything else, and every still, is W × H", () => {
    // An area take is rarely 16:9; "567p" would describe nothing.
    expect(pixelSizeLabel(1234, 567, true)).toBe("1234 × 567");
    // A 1080-tall take that is not 16:9 is not "1080p" either.
    expect(pixelSizeLabel(1440, 1080, true)).toBe("1440 × 1080");
    expect(pixelSizeLabel(1920, 1080, false)).toBe("1920 × 1080");
  });
  test("an unknown size is the empty-cell dash, never 0 × 0", () => {
    expect(pixelSizeLabel(undefined, undefined, true)).toBe(NO_VALUE);
    expect(pixelSizeLabel(0, 0, false)).toBe(NO_VALUE);
  });
});

describe("the thumbnail chip's format", () => {
  test("is the file's extension, upper-case", () => {
    expect(formatChip("/a/b/Pricing page.png")).toBe("PNG");
    expect(formatChip("/a/b/shot.heic")).toBe("HEIC");
  });
  test("is absent when there is no file to read it from", () => {
    expect(formatChip(undefined)).toBeUndefined();
    expect(formatChip("/a/b/no-extension")).toBeUndefined();
  });
  test("a loose video's chip is its duration, a loose image's its format", () => {
    const base = { id: "x", createdAt: 0, bytes: 10 };
    expect(looseFileItem({ ...base, file: "/r/x.mp4", isVideo: true, durationMs: 42_000 }).chip).toBe("0:42");
    expect(looseFileItem({ ...base, file: "/r/x.png", isVideo: false }).chip).toBe("PNG");
  });
});

describe("the Captured column", () => {
  // Built from local fields, so the rule holds in whatever zone the test runs.
  const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m, d, h, min).getTime();
  const now = at(2026, 9, 27, 18, 0);

  test("today shows the time, in 12-hour form", () => {
    expect(capturedLabel(at(2026, 9, 27, 13, 12), now)).toBe("Today 1:12 PM");
    expect(capturedLabel(at(2026, 9, 27, 0, 5), now)).toBe("Today 12:05 AM");
    expect(capturedLabel(at(2026, 9, 27, 11, 40), now)).toBe("Today 11:40 AM");
  });
  test("yesterday is a word, by calendar day rather than by 24 hours", () => {
    expect(capturedLabel(at(2026, 9, 26, 23, 59), at(2026, 9, 27, 0, 1))).toBe("Yesterday");
  });
  test("earlier this year is month and day; another year adds it", () => {
    expect(capturedLabel(at(2026, 9, 22), now)).toBe("Oct 22");
    expect(capturedLabel(at(2025, 11, 31), now)).toBe("Dec 31, 2025");
  });
});

describe("the title bar's count", () => {
  test("counts captures, singular at one", () => {
    expect(countLabel(42, 42)).toBe("42 captures");
    expect(countLabel(1, 1)).toBe("1 capture");
    expect(countLabel(0, 0)).toBe("0 captures");
  });
  test("a search that narrows the list says how far", () => {
    expect(countLabel(3, 42)).toBe("3 of 42");
  });
});

describe("search", () => {
  const item = (id: string, label?: string) => ({ id, label } as LibraryItem);
  const items = [
    item("2026-10-27_13-12-00", "Onboarding walkthrough"),
    item("2026-10-27_11-40-00", "Settings bug repro"),
    item("2026-10-22_09-00-00"),
  ];

  test("an empty or blank query is everything", () => {
    expect(applySearch(items, "")).toHaveLength(3);
    expect(applySearch(items, "   ")).toHaveLength(3);
  });
  test("matches the label or the id, ignoring case", () => {
    expect(applySearch(items, "BUG").map((i) => i.id)).toEqual(["2026-10-27_11-40-00"]);
    expect(applySearch(items, "10-22").map((i) => i.id)).toEqual(["2026-10-22_09-00-00"]);
  });
  test("every word must match, in any order", () => {
    expect(applySearch(items, "repro settings")).toHaveLength(1);
    expect(applySearch(items, "settings walkthrough")).toHaveLength(0);
  });
  test("no match has its own sentence, quoting what was typed", () => {
    expect(searchPlaceholder("  zebra ").title).toBe("No captures match “zebra”");
  });
});

describe("the filter (STC-584)", () => {
  test("is All, Recordings, Stills — no GIFs chip while the library cannot list one", () => {
    // A saved GIF is untagged (STC-395) and outside the scan; a chip that is
    // always empty would say there are none.
    expect(LIBRARY_FILTERS.map((f) => f.label)).toEqual(["All", "Recordings", "Stills"]);
  });
});
