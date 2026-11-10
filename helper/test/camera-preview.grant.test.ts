/**
 * Requires a Camera grant for STCTestHost, so it is NOT part of `npm test` —
 * see vitest.grant.config.ts and `npm run test:capture`. Lights the camera for a
 * few seconds.
 *
 * STC-638: the helper's live camera view on a real camera. A preview delivers
 * valid JPEG frames, no faster than the 12 fps cap, and stopping it stops the
 * frames (and the camera). A refused start (no grant) is a REFUSAL here, never
 * a pass: a test that passes with no camera has proved nothing.
 *
 * What this does NOT cover, because a take needs a Screen Recording grant too:
 * that a take starting while a preview runs detaches it (`take-started`). That
 * is STC-638's runbook check, and `CameraPreview.detachForTake` is one line.
 */
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const APP = join(root, "tools/test-host/STCTestHost.app");
const HELPER = join(root, "helper/build/stc-helper");

/** Preview length. Long enough for ~25 frames at the 12 fps cap. */
const PREVIEW_MS = 3000;
/** A cold open took 3.2 s on an Elgato; plus the preview, the stop and the wait after it. */
const OPEN_TIMEOUT_MS = 60_000;

describe("camera preview on a real camera (STC-638)", () => {
  test("delivers valid, throttled JPEG frames; stopping stops them", () => {
    if (!existsSync(APP)) {
      throw new Error(`${APP} is missing — run tools/test-host/build.sh first`);
    }
    const out = join(mkdtempSync(join(tmpdir(), "stc-cam-preview-")), "result.json");
    execFileSync("open", ["-W", APP, "--args", "--camera-preview", "--helper", HELPER,
                          "--ms", String(PREVIEW_MS), "--out", out],
                 { timeout: OPEN_TIMEOUT_MS });
    if (!existsSync(out)) {
      throw new Error("SKIP-GRANT: the test-host produced nothing — most likely STC Signing Probe has no " +
        "Camera grant. Run tools/test-host with --camera-request once.");
    }
    const r = JSON.parse(readFileSync(out, "utf8"));
    if (r.verdict === "start-refused") {
      throw new Error(`SKIP-GRANT: the preview was refused (${JSON.stringify(r.reply)}) — most likely no Camera grant.`);
    }
    expect(r.verdict).toBe("previewed");

    // It said which camera, and it was running when it answered.
    expect(r.started.ev).toBe("camera-preview-started");
    expect(typeof r.started.device).toBe("string");

    // Frames: enough to be a live view, valid JPEGs, at the declared size.
    expect(r.frames).toBeGreaterThanOrEqual(10);
    expect(r.jpegOk).toBe(true);
    expect(r.width).toBe(320);
    expect(r.height).toBeGreaterThan(0);

    // The cap. A little slack over 12 for timer jitter, none of it for a missing cap:
    // a 30 or 60 fps camera unthrottled would read 30 to 60 here.
    expect(r.ratePerSec).toBeLessThanOrEqual(14);

    // Small enough for the lossy channel: a 320 px frame at q0.6 is a few KB.
    expect(r.maxJpegBytes).toBeLessThan(64 * 1024);

    // Stop: answered, says so, and nothing keeps arriving after the reply
    // (one frame already being encoded may land just behind it).
    expect(r.stopped.ev).toBe("camera-preview-stopped");
    expect(r.stopped.reason).toBe("stopped");
    expect(r.stopped.wasRunning).toBe(true);
    expect(r.framesAfterStopReply).toBeLessThanOrEqual(1);

    // Stopping again is not an error and says nothing was running.
    expect(r.stoppedAgain.ev).toBe("camera-preview-stopped");
    expect(r.stoppedAgain.wasRunning).toBe(false);
  }, 90_000);
});
