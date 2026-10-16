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
 * The volume is a 64 MB APFS disk image, mounted unprivileged with `hdiutil`.
 *
 * 64, not the 16 it was (STC-554). The writer is set up like `Capture.swift`'s
 * (50 Mb/s, 2 s fragments), and its `moov` is written only AFTER the first
 * fragment: a file whose first 2 s do not fit has no track information at
 * all. On 16 MB that fragment was 14.25 MB of a ~15.2 MB volume, and an
 * encoder overshooting under a full parallel run (measured: >15.3 MB) filled
 * the disk before the `moov`, so the "readable prefix" check failed in 2 of 3
 * full runs while passing every time alone. 64 MB holds that fragment four
 * times over. The harness's settings stay the product's; only the disk grew.
 * If the machine refuses to mount it the test FAILS rather than skips: a gate
 * that quietly did not run reads as covered (`docs/STC-259-GATE-SKIP-RATE.md`).
 */
const SOURCES = [
  "helper/src/DiskDecisions.swift",
  "helper/src/DiskVolume.swift",
  "helper/src/WriterGate.swift",
  "helper/test/disk-full/main.swift",
];

/** `movieFragmentIntervalSec` (CaptureDecisions.swift), which the harness mirrors. */
const FRAGMENT_SEC = 2;

/** Top-level MP4 boxes: just enough to tell a file with a `moov` from one without. */
function topLevelBoxes(b: Buffer): { type: string; size: number }[] {
  const out: { type: string; size: number }[] = [];
  for (let o = 0; o + 8 <= b.length;) {
    let size = b.readUInt32BE(o);
    if (size === 1 && o + 16 <= b.length) size = Number(b.readBigUInt64BE(o + 8));
    if (size === 0) size = b.length - o;
    out.push({ type: b.toString("latin1", o + 4, o + 8), size });
    if (size < 8) break;
    o += size;
  }
  return out;
}

describe("disk full (STC-527)", () => {
  test("the decisions hold, and a real full disk is detected and classified as disk-full", async () => {
    const work = mkdtempSync(join(tmpdir(), "stc-diskfull-"));
    const image = join(work, "small.dmg");
    const mount = join(work, "mnt");
    mkdirSync(mount);
    execFileSync("hdiutil", ["create", "-size", "64m", "-fs", "APFS", "-volname", "StcDiskFull", image],
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
      // A file with no `moov` cannot be demuxed at all, and the demuxer only
      // says "no track information". Say why instead (STC-554).
      const boxes = topLevelBoxes(buf);
      expect(boxes.map((b) => b.type), `no moov: the first ${FRAGMENT_SEC} s fragment did not fit the volume ` +
        `(${buf.byteLength} bytes written; boxes ${boxes.map((b) => `${b.type}:${b.size}`).join(" ")})`)
        .toContain("moov");
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
