import { describe, expect, it } from "vitest";
import {
  EXPORT_QUALITIES, DEFAULT_EXPORT_QUALITY, QUALITY_BPP, cleanExportQuality, qualityIndex, qualityAtIndex,
  videoBitrate, audioBitrate, estimateExportBytes, formatSizeEstimate,
} from "../src/export-quality.js";

const SEC = 1_000_000_000;

describe("export quality (STC-613)", () => {
  it("defaults to High, and High at 1080p60 is about the flat 12 Mbps it replaced", () => {
    expect(DEFAULT_EXPORT_QUALITY).toBe("high");
    const bps = videoBitrate(1920, 1080, 60, "high");
    expect(bps).toBeGreaterThan(11_000_000);
    expect(bps).toBeLessThan(13_000_000);
  });

  it("levels rise from Low to High", () => {
    const bpp = EXPORT_QUALITIES.map((q) => QUALITY_BPP[q]);
    expect([...bpp].sort((a, b) => a - b)).toEqual(bpp);
    expect(new Set(bpp).size).toBe(bpp.length);
  });

  it("bitrate scales with pixels and with rate: 30 fps is half, 4K is four times 1080p", () => {
    for (const q of EXPORT_QUALITIES) {
      expect(videoBitrate(1920, 1080, 30, q)).toBe(videoBitrate(1920, 1080, 60, q) / 2);
      expect(videoBitrate(3840, 2160, 60, q)).toBe(videoBitrate(1920, 1080, 60, q) * 4);
    }
  });

  it("cleans untrusted input to High", () => {
    for (const q of EXPORT_QUALITIES) expect(cleanExportQuality(q)).toBe(q);
    for (const v of [undefined, null, "", "max", "High", 2, {}]) expect(cleanExportQuality(v)).toBe("high");
  });

  it("maps slider stops both ways, and an unknown stop to High", () => {
    EXPORT_QUALITIES.forEach((q, i) => {
      expect(qualityIndex(q)).toBe(i);
      expect(qualityAtIndex(i)).toBe(q);
      expect(qualityAtIndex(String(i))).toBe(q);
    });
    for (const v of [-1, 3, 1.5, "x", undefined]) expect(qualityAtIndex(v)).toBe("high");
  });

  it("audio bitrate follows the export's audio path", () => {
    expect(audioBitrate("mix")).toBe(192_000);
    expect(audioBitrate("mic")).toBe(128_000);
    expect(audioBitrate("none")).toBe(0);
  });

  it("estimates bytes as (video + audio) bitrate over the trimmed length", () => {
    const base = { width: 1920, height: 1080, rate: 60, quality: "high" as const, durationNs: 10 * SEC };
    const v = videoBitrate(1920, 1080, 60, "high");
    expect(estimateExportBytes({ ...base, audio: "none" })).toBe(Math.round((v * 10) / 8));
    expect(estimateExportBytes({ ...base, audio: "mix" })).toBe(Math.round(((v + 192_000) * 10) / 8));
    expect(estimateExportBytes({ ...base, audio: "none", durationNs: 0 })).toBe(0);
    expect(estimateExportBytes({ ...base, audio: "none", durationNs: -5 })).toBe(0);
    // Half the rate, half the video bytes.
    expect(estimateExportBytes({ ...base, audio: "none", rate: 30 }))
      .toBe(Math.round(estimateExportBytes({ ...base, audio: "none" }) / 2));
  });

  it("formats like the Figma frame, MB to one place, GB from 1000 MB", () => {
    expect(formatSizeEstimate(18_400_000)).toBe("≈ 18.4 MB");
    expect(formatSizeEstimate(0)).toBe("≈ 0.0 MB");
    expect(formatSizeEstimate(999_940_000)).toBe("≈ 999.9 MB");
    expect(formatSizeEstimate(1_250_000_000)).toBe("≈ 1.3 GB");
  });
});
