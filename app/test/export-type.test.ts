import { describe, test, expect } from "vitest";
import {
  cleanExportType, exportButtonLabel, gifFormatNote, gifSavedLine, looksLikeGif, DEFAULT_EXPORT_TYPE,
} from "../src/export-type.js";
import { DEFAULT_GIF_SETTINGS } from "@transform/gif-options";

/**
 * STC-615: the editor's export Type, decided without a window. Main takes the
 * type off IPC, so the validator is what keeps a bad value from picking a path.
 */
describe("the export Type", () => {
  test("only gif is gif; anything else is the MP4 default", () => {
    expect(cleanExportType("gif")).toBe("gif");
    expect(cleanExportType("mp4")).toBe("mp4");
    for (const v of ["webm", "GIF", "", undefined, null, 1, {}]) expect(cleanExportType(v)).toBe(DEFAULT_EXPORT_TYPE);
  });

  test("the button names what it will make", () => {
    expect(exportButtonLabel("mp4")).toBe("Export");
    expect(exportButtonLabel("gif")).toBe("Export GIF");
  });
});

describe("the GIF note and result line", () => {
  test("is sized by the max width, capped at the capture", () => {
    expect(gifFormatNote({ width: 3840, height: 2160 }, DEFAULT_GIF_SETTINGS)).toBe("960×540 · 15 fps");
    // never larger than the capture (no upscaling)
    expect(gifFormatNote({ width: 800, height: 600 }, { fps: 10, maxWidth: 1280 })).toBe("800×600 · 10 fps");
    expect(gifFormatNote({ width: 1920, height: 1080 }, { fps: 30, maxWidth: "original" })).toBe("1920×1080 · 30 fps");
  });

  test("says KB under a megabyte and MB above it", () => {
    expect(gifSavedLine("a.gif", 75, 250_000)).toBe("Saved a.gif — 75 frames, 250 KB");
    expect(gifSavedLine("a.gif", 75, 3_400_000)).toBe("Saved a.gif — 75 frames, 3.4 MB");
    expect(gifSavedLine("a.gif", 1, 10)).toBe("Saved a.gif — 1 frames, 1 KB");
  });
});

describe("looksLikeGif", () => {
  const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  test("accepts both GIF headers", () => {
    expect(looksLikeGif(ascii("GIF89a\0\0"))).toBe(true);
    expect(looksLikeGif(ascii("GIF87a\0\0"))).toBe(true);
  });
  test("refuses an MP4, text, and anything too short to have a header", () => {
    expect(looksLikeGif(ascii("\0\0\0\x18ftypisom"))).toBe(false);
    expect(looksLikeGif(ascii("GIF89"))).toBe(false);
    expect(looksLikeGif(new Uint8Array(0))).toBe(false);
  });
});
