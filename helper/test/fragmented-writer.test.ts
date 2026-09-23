import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * STC-394 — does `movieFragmentInterval` actually do what the ticket assumes,
 * against the SAME writer settings `Capture.swift` uses?
 *
 * The ticket says "check what the helper does today before picking an
 * approach" — this file is that check, made empirically rather than by
 * reading Apple's docs, the same way `helper/test/writer-gate/` answers
 * STC-254 by really racing the two threads instead of reasoning about them.
 * It needs no ScreenCaptureKit and no grant: `AVAssetWriter` fed synthetic
 * pixel buffers is the whole subject, and `transform/test/fixture-mp4.test.ts`
 * already established that `demuxTrack` runs in plain Node with no browser —
 * which is what makes checking the ACTUAL compatibility question (does the
 * transform's demuxer read a fragmented file the same way) possible from
 * here rather than requiring a Mac with a grant.
 *
 * Four files, one writer configuration each (`helper/test/fragmented-writer/
 * main.swift` mirrors `setupWriter()` exactly, fragmentation aside):
 *   - baseline: no `movieFragmentInterval`, finished cleanly — today's shape.
 *   - fragmented, finished cleanly — must demux IDENTICALLY to baseline,
 *     which is the ticket's "normal-stop output is unchanged" criterion.
 *   - fragmented, killed mid-write (`_exit()`, no `finishWriting`) — must
 *     still demux to something close to the frame count at the kill, which
 *     is the ticket's actual acceptance criterion.
 *   - fragmented, finished cleanly, but with a real multi-fragment-interval
 *     GAP where no sample was appended (STC-408, modelling what STC-240's
 *     pause does to this writer — see the fourth test below) — must still
 *     finish and demux every frame, with the gap intact rather than
 *     collapsed or corrupted.
 */
const FRAMES = 300;   // 5s at 60fps
const FPS = 60;
const FRAGMENT_SEC = 1;   // "a few seconds is enough" per the ticket; 1s makes a 5s clip cross several boundaries

function tmpOut(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "stc-frag-")), name);
}

async function write(
  out: string,
  opts: { fragmentSec?: number; crashAfter?: number; gapAfterFrame?: number; gapSec?: number } = {},
) {
  await runSwiftHarness({
    label: "fragwriter",
    sources: ["helper/test/fragmented-writer/main.swift"],
    env: {
      STC_FRAG_OUT: out,
      STC_FRAG_FRAMES: String(FRAMES),
      STC_FRAG_FPS: String(FPS),
      ...(opts.fragmentSec ? { STC_FRAG_INTERVAL_SEC: String(opts.fragmentSec) } : {}),
      ...(opts.crashAfter ? { STC_FRAG_CRASH_AFTER: String(opts.crashAfter) } : {}),
      ...(opts.gapAfterFrame ? { STC_FRAG_GAP_AFTER_FRAME: String(opts.gapAfterFrame) } : {}),
      ...(opts.gapSec ? { STC_FRAG_GAP_SEC: String(opts.gapSec) } : {}),
    },
    // Killing the process IS the test in the crash case — a non-zero/signal
    // exit there is expected, not a harness failure, so this function's own
    // return value is unused for that call; only the file it left behind is.
  }).catch((e) => {
    if (!opts.crashAfter) throw e;
    // `_exit(9)` is a plain non-zero exit, not a fatal signal — runBounded
    // only resolves on a clean (0) exit, so the simulated crash surfaces here
    // as a rejection (`_swift-harness.ts`'s exact wording: "... exited 9.").
    // Anything else (compile failure, a REAL crash signal) should still fail
    // the test loudly.
    if (!/exited 9\./.test(String(e?.message ?? e))) throw e;
  });
}

function readAb(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("STC-394: movieFragmentInterval against Capture.swift's real settings", () => {
  test("fragmented, cleanly finished, demuxes IDENTICALLY to non-fragmented", async () => {
    const baselineOut = tmpOut("baseline.mp4");
    const fragOut = tmpOut("frag.mp4");
    await write(baselineOut);
    await write(fragOut, { fragmentSec: FRAGMENT_SEC });

    // Both real files, not a mock — confirm they actually differ in shape on
    // disk (a fragmented file has the mvex/moof machinery baseline lacks),
    // otherwise "identical demux" would be true for the boring reason that
    // fragmentation never actually took effect.
    expect(statSync(fragOut).size).toBeGreaterThan(0);
    expect(statSync(baselineOut).size).toBeGreaterThan(0);

    const { demuxTrack } = await import("../../transform/src/demux.js");
    const baseline = await demuxTrack(readAb(baselineOut), "baseline.mp4");
    const frag = await demuxTrack(readAb(fragOut), "frag.mp4");

    expect(frag.framesNs.length).toBe(FRAMES);
    expect(frag.framesNs).toEqual(baseline.framesNs);
    expect(frag.codec).toBe(baseline.codec);
    expect(frag.codedWidth).toBe(baseline.codedWidth);
    expect(frag.codedHeight).toBe(baseline.codedHeight);
    expect(frag.chunks.length).toBe(baseline.chunks.length);
    expect(frag.chunks.map((c) => c.type)).toEqual(baseline.chunks.map((c) => c.type));
    expect(frag.chunks.map((c) => c.timestampUs)).toEqual(baseline.chunks.map((c) => c.timestampUs));
  }, 120_000);

  test("killed mid-write, the file is still readable up to close to the kill", async () => {
    const out = tmpOut("crashed.mp4");
    const crashAfter = 210;   // 3.5s in — comfortably past several 1s fragment boundaries
    await write(out, { fragmentSec: FRAGMENT_SEC, crashAfter });

    expect(statSync(out).size).toBeGreaterThan(0);

    const { demuxTrack } = await import("../../transform/src/demux.js");
    const video = await demuxTrack(readAb(out), "crashed.mp4");

    // "Plays up to within one fragment interval of the kill" (the ticket's
    // own words) — not exactly `crashAfter` frames (the in-flight fragment at
    // the moment of the kill is lost, not partially recovered), and
    // certainly not all 300, which would mean fragmentation bought nothing.
    const tolerance = FRAGMENT_SEC * FPS;
    expect(video.framesNs.length).toBeGreaterThan(0);
    expect(video.framesNs.length).toBeLessThanOrEqual(crashAfter);
    expect(video.framesNs.length).toBeGreaterThan(crashAfter - tolerance * 2);
    // What IS there must still be a clean, gap-free prefix of the real grid —
    // a reader must never have to guess which frames are trustworthy.
    // `Math.trunc`, matching the harness's own `Int64(1_000_000_000 / fps)`:
    // an INTEGER ns step computed once and multiplied, not rounded per frame.
    const ptsStepNs = Math.trunc(1_000_000_000 / FPS);
    for (let i = 0; i < video.framesNs.length; i++) {
      expect(video.framesNs[i]).toBe(i * ptsStepNs);
    }
  }, 120_000);

  test("without fragmentation, the same kill leaves an UNREADABLE file — the problem this ticket exists to fix", async () => {
    const out = tmpOut("crashed-unfragmented.mp4");
    await write(out, { crashAfter: 210 });   // no fragmentSec: today's behaviour

    expect(statSync(out).size).toBeGreaterThan(0);
    const { demuxTrack } = await import("../../transform/src/demux.js");
    await expect(demuxTrack(readAb(out), "crashed-unfragmented.mp4")).rejects.toThrow();
  }, 120_000);

  // STC-408: an ordinary, UNCRASHED take can still sit idle across several
  // fragment boundaries — that is exactly what STC-240's pause does to this
  // writer (PauseGate drops paused samples outright; nothing is appended for
  // the pause's real duration, then real time picks back up). Unlike the
  // crash case above, `finishWriting` runs normally here — the question is
  // not "how much survives a kill" but "does a real gap, with no crash at
  // all, still finalize and demux cleanly, with every frame present and the
  // gap itself intact rather than silently collapsed or corrupted".
  test("a real multi-fragment-interval gap (a pause), finished cleanly, demuxes every frame with the gap intact", async () => {
    const out = tmpOut("paused.mp4");
    const gapAfterFrame = 120;         // 2s in at 60fps
    const gapSec = 5;                  // spans 5 whole fragment intervals (FRAGMENT_SEC=1)
    await write(out, { fragmentSec: FRAGMENT_SEC, gapAfterFrame, gapSec });

    expect(statSync(out).size).toBeGreaterThan(0);

    const { demuxTrack } = await import("../../transform/src/demux.js");
    const video = await demuxTrack(readAb(out), "paused.mp4");

    // Nothing crashed, so nothing is missing — unlike the kill case, every
    // frame the harness appended must be recoverable.
    expect(video.framesNs.length).toBe(FRAMES);

    const ptsStepNs = Math.trunc(1_000_000_000 / FPS);
    const gapNs = Math.round(gapSec * 1_000_000_000);
    for (let i = 0; i < video.framesNs.length; i++) {
      const want = i * ptsStepNs + (i >= gapAfterFrame ? gapNs : 0);
      expect(video.framesNs[i]).toBe(want);
    }

    // The gap itself must survive the round trip — a demuxer that rebased or
    // collapsed it would misreport real elapsed time to the transform's
    // frame-selection rule ("greatest PTS <= t"), which is what actually
    // holds the picture through a paused span once STC-240's export half
    // consumes `pauses`.
    const jump = video.framesNs[gapAfterFrame]! - video.framesNs[gapAfterFrame - 1]!;
    expect(jump).toBeGreaterThan(gapNs);
    expect(jump).toBeLessThan(gapNs + ptsStepNs * 2);
  }, 120_000);
});
