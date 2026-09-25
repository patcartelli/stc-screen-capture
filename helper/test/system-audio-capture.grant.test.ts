/**
 * Requires a Screen Recording grant for the STC Signing Probe bundle, and
 * nothing else: ScreenCaptureKit's audio rides the same grant as its pixels,
 * so unlike the mic there is no second permission. Not part of `npm test` —
 * see vitest.grant.config.ts and `npm run test:capture`.
 *
 * Mirrors mic-capture.grant.test.ts (STC-233) for the system-audio track
 * (STC-418 PR 2). The machine must PLAY something during the take, so this
 * test plays a stock system sound through `afplay` while the host records —
 * without it, a take on a silent Mac may legitimately carry no samples at all
 * (whether it does is one of docs/STC-418-RUNBOOK.md's open questions), and
 * the test would be asserting the room's silence rather than the capture.
 *
 * A separate FILE, not a skip — see CLAUDE.md's own note on why a skipped
 * test reads as covered and rots.
 */
import { describe, test, expect } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AjvImport from "ajv";
import { demuxAudioTrack } from "../../transform/src/demux-audio.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const APP = join(root, "tools/test-host/STCTestHost.app");
const HELPER = join(root, "helper/build/stc-helper");
const SOUND = "/System/Library/Sounds/Glass.aiff";

function bufferOf(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe("system audio capture — requires Screen Recording", () => {
  test("a real recording with sound playing produces system.m4a and a schema-valid anchors.system", async () => {
    if (!existsSync(APP)) {
      throw new Error(`${APP} is missing — run tools/test-host/build.sh first`);
    }
    if (!existsSync(SOUND)) throw new Error(`${SOUND} is missing — pick another stock sound`);

    const dir = mkdtempSync(join(tmpdir(), "stc-syscap-"));
    // Something to hear, repeatedly, across the middle of the 10 s take —
    // started before the host so the first play lands after the helper's
    // own start (~1 s), and bounded so it cannot outlive the test.
    const player = spawn("/bin/sh", ["-c",
      `sleep 2; for i in 1 2 3 4 5 6; do afplay ${SOUND}; sleep 0.5; done`], { stdio: "ignore" });
    try {
      execFileSync("open", ["-W", APP, "--args", "--helper", HELPER,
                            "--dir", dir, "--ms", "10000", "--system-audio",
                            "--out", join(dir, "result.json")],
                   { timeout: 120_000 });
    } finally {
      player.kill();
    }

    const anchorsPath = join(dir, "anchors.json");
    if (!existsSync(anchorsPath)) {
      const resultPath = join(dir, "result.json");
      if (existsSync(resultPath)) {
        throw new Error(
          "the test-host ran but the recording produced no anchors.json — this is NOT " +
          "a grant problem. Its transcript:\n" + readFileSync(resultPath, "utf8").slice(0, 2000));
      }
      throw new Error(
        "SKIP-GRANT: the test-host produced nothing at all, most likely missing Screen " +
        "Recording for STC Signing Probe. Grant it in System Settings, then re-run " +
        "'npm run test:capture'.");
    }

    const anchors = JSON.parse(readFileSync(anchorsPath, "utf8"));

    // NOT a SKIP-GRANT: there is no separate grant to blame. A requested
    // system-audio stream that recorded nothing while a sound was playing is
    // the capture failing, and the transcript says which warning it sent.
    if (anchors.system?.present !== true) {
      const resultPath = join(dir, "result.json");
      const transcript = existsSync(resultPath) ? readFileSync(resultPath, "utf8").slice(0, 2000) : "(none)";
      throw new Error(
        `system audio was requested but the take has no system track ` +
        `(system=${JSON.stringify(anchors.system)}). Output volume muted? Transcript:\n${transcript}`);
    }

    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(JSON.parse(
      readFileSync(join(root, "schema/anchors-6.schema.json"), "utf8")));
    expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);

    expect(anchors.version).toBe(6);
    expect(anchors.files.system).toBe("system.m4a");
    expect(anchors.mic, "system audio alone must not claim a mic").toBeUndefined();
    expect(statSync(join(dir, "system.m4a")).size).toBeGreaterThan(0);

    const sys = anchors.system;
    expect(sys.sampleRate).toBe(48000);
    expect(sys.channels).toBe(2);
    expect(sys.lastFramePtsNs).toBeGreaterThan(sys.firstFramePtsNs);
    // Session-relative. SystemAudioCapture assumes SCK's audio PTS shares the
    // mach host clock t0Ns is read from — the same assumption MicCapture makes
    // of AVCapture. If that were wrong these would be boot-relative (hours)
    // or stream-relative (near zero at the stream's own start), and the first
    // bound below is what catches the first case.
    expect(sys.firstFramePtsNs).toBeGreaterThanOrEqual(0);
    expect(sys.lastFramePtsNs).toBeLessThanOrEqual(anchors.stop.t);

    const demuxed = await demuxAudioTrack(bufferOf(join(dir, "system.m4a")), "system.m4a");
    expect(demuxed.framesNs.length).toBeGreaterThan(0);
    expect(demuxed.sampleRate).toBe(sys.sampleRate);
    expect(demuxed.numberOfChannels).toBe(sys.channels);
  }, 180_000);
});
