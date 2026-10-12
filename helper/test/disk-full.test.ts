import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * STC-527 — a full disk, for real, on every push. No grant: `AVAssetWriter`
 * fed synthetic frames through the real `WriterGate` is the subject, the way
 * `fragmented-writer.test.ts` answers STC-394.
 *
 * The volume is a 16 MB APFS disk image, mounted unprivileged with `hdiutil`.
 * If the machine refuses to mount it the test FAILS rather than skips: a gate
 * that quietly did not run reads as covered (`docs/STC-259-GATE-SKIP-RATE.md`).
 */
const SOURCES = [
  "helper/src/DiskDecisions.swift",
  "helper/src/WriterGate.swift",
  "helper/test/disk-full/main.swift",
];

describe("disk full (STC-527)", () => {
  test("the decisions hold, and a real full disk is detected and classified as disk-full", async () => {
    const work = mkdtempSync(join(tmpdir(), "stc-diskfull-"));
    const image = join(work, "small.dmg");
    const mount = join(work, "mnt");
    mkdirSync(mount);
    execFileSync("hdiutil", ["create", "-size", "16m", "-fs", "APFS", "-volname", "StcDiskFull", image],
                 { stdio: "pipe" });
    execFileSync("hdiutil", ["attach", image, "-nobrowse", "-mountpoint", mount], { stdio: "pipe" });
    try {
      const out = await runSwiftHarness({
        label: "disk-full",
        sources: SOURCES,
        env: { STC_DISK_FULL_OUT: join(mount, "display.mp4") },
      });
      expect(out, out).toContain("ALL PASS");
      // What AVFoundation said on 2026-10-12, recorded so a change on a later
      // macOS shows up as a diff rather than only as a classifier that still
      // happens to pass through its fallback.
      expect(out).toMatch(/ERROR-CHAIN: AVFoundationErrorDomain -11807 > NSPOSIXErrorDomain 28/);

      // "Playable up to the failure": STC-394's fragments survive the writer
      // failing, the same way they survive a crash.
      const frames = Number(/FRAMES: (\d+)/.exec(out)![1]);
      const { demuxTrack } = await import("../../transform/src/demux.js");
      const { memorySource } = await import("../../transform/src/chunk-reader.js");
      const buf = readFileSync(join(mount, "display.mp4"));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const video = await demuxTrack(memorySource(ab, "display.mp4"), "display.mp4");
      expect(video.framesNs.length, "a full disk must leave a readable prefix").toBeGreaterThan(0);
      expect(video.framesNs.length).toBeLessThanOrEqual(frames);
    } finally {
      try { execFileSync("hdiutil", ["detach", mount, "-force"], { stdio: "pipe" }); } catch { /* reported below */ }
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
