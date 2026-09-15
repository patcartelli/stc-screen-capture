/**
 * Requires BOTH a Screen Recording grant and a Microphone grant for the STC
 * Signing Probe bundle. Not part of `npm test` — see vitest.grant.config.ts
 * and `npm run test:capture`.
 *
 * Mirrors camera-capture.grant.test.ts (STC-232) as closely as the two
 * subsystems' real difference allows: unlike the camera, there is no
 * "pick the best device" — the settled decision (phase 0) forbids taking a
 * mic without the user naming it explicitly, so this test enumerates
 * devices itself and picks the FIRST one by uid, the same way a real picker
 * would offer a list rather than auto-selecting.
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

/** A file as an ArrayBuffer, which is what demuxAudioTrack takes. */
function bufferOf(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/**
 * Enumerating audio devices does not itself need the Microphone grant — only
 * OPENING one does — so this can run the bare helper binary directly, the
 * same latitude `devices` gets everywhere else in this repo. Returns the
 * first mic's uid, or null if none is connected (a real machine with no
 * external mic still has a built-in one; a CI runner has neither, which is
 * exactly why this whole file is grant-gated).
 */
function firstMicUid(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!existsSync(HELPER)) { resolve(null); return; }
    const p = spawn(HELPER, ["--stats-interval-ms", "60000"], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    let settled = false;
    const finish = (uid: string | null) => {
      if (settled) return;
      settled = true;
      try { p.stdin.write(JSON.stringify({ cmd: "quit", seq: 2 }) + "\n"); } catch { /* already gone */ }
      setTimeout(() => p.kill(), 500);
      resolve(uid);
    };
    const timeout = setTimeout(() => finish(null), 10_000);
    p.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.ev === "ready") {
          p.stdin.write(JSON.stringify({ cmd: "devices", seq: 1 }) + "\n");
        } else if (o.ev === "devices" && o.seq === 1) {
          clearTimeout(timeout);
          const mics = Array.isArray(o.mics) ? o.mics : [];
          finish(mics[0]?.uid ?? null);
        }
      }
    });
    p.on("error", () => { clearTimeout(timeout); finish(null); });
  });
}

describe("mic capture — requires Screen Recording AND Microphone", () => {
  test("a real recording produces mic.m4a and a schema-valid anchors.mic", async () => {
    if (!existsSync(APP)) {
      throw new Error(`${APP} is missing — run tools/test-host/build.sh first`);
    }
    const uid = await firstMicUid();
    if (!uid) {
      throw new Error(
        "SKIP-GRANT: could not enumerate any microphone device — either no mic is " +
        "connected, or helper/build/stc-helper is missing (run helper/build.sh first).",
      );
    }

    const dir = mkdtempSync(join(tmpdir(), "stc-miccap-"));
    execFileSync("open", ["-W", APP, "--args", "--helper", HELPER,
                          "--dir", dir, "--ms", "15000", "--mic", uid,
                          "--out", join(dir, "result.json")],
                 { timeout: 120_000 });

    const anchorsPath = join(dir, "anchors.json");
    if (!existsSync(anchorsPath)) {
      const resultPath = join(dir, "result.json");
      if (existsSync(resultPath)) {
        throw new Error(
          "the test-host ran but the recording produced no anchors.json — this is NOT " +
          "a grant problem. Its transcript:\n" + readFileSync(resultPath, "utf8").slice(0, 2000));
      }
      throw new Error(
        "SKIP-GRANT: the test-host produced nothing at all, most likely missing " +
        "Screen Recording and/or Microphone for STC Signing Probe. Working procedure: " +
        "(1) run 'open -W " + APP + " --args --mic-request --out /tmp/mic-request.json' " +
        "to raise the system prompt, (2) click Allow, (3) grant Screen Recording to " +
        "STC Signing Probe in System Settings if not already granted, " +
        "(4) re-run 'npm run test:capture'.");
    }

    const anchors = JSON.parse(readFileSync(anchorsPath, "utf8"));

    if (anchors.mic?.present !== true) {
      throw new Error(
        `SKIP-GRANT: the take has no mic track (present=${anchors.mic?.present}). ` +
        "Working procedure: (1) run 'open -W " + APP + " --args --mic-request " +
        "--out /tmp/mic-request.json' to raise the system prompt, (2) click Allow, " +
        "(3) re-run this test (or 'npm run test:capture').");
    }

    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(JSON.parse(
      readFileSync(join(root, "schema/anchors-4.schema.json"), "utf8")));
    expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);

    expect(anchors.version).toBe(4);
    expect(anchors.files.mic).toBe("mic.m4a");
    expect(statSync(join(dir, "mic.m4a")).size).toBeGreaterThan(0);

    const mic = anchors.mic;
    expect(mic.sampleRate).toBeGreaterThan(0);
    expect(mic.channels).toBeGreaterThan(0);
    expect(mic.lastFramePtsNs).toBeGreaterThan(mic.firstFramePtsNs);
    // Session-relative, like every other track — an unrebased (boot-relative
    // or stream-relative) timestamp would be orders of magnitude off from the
    // take's own duration. Mirrors the camera grant test's own upper bound.
    expect(mic.lastFramePtsNs).toBeLessThanOrEqual(anchors.stop.t);

    // The demux path itself, on a REAL file — the one thing no unit test in
    // this repo can check, since no committed mic.m4a fixture exists.
    const demuxed = await demuxAudioTrack(bufferOf(join(dir, "mic.m4a")), "mic.m4a");
    expect(demuxed.framesNs.length).toBeGreaterThan(0);
    expect(demuxed.sampleRate).toBe(mic.sampleRate);
    expect(demuxed.numberOfChannels).toBe(mic.channels);
  }, 180_000);
});
