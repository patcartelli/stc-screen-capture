/**
 * STC-238 — the fault-injection soak. Every fault the ticket names, run into a
 * real take, and the result held to one bar (helper/test/_soak.ts says which):
 * the directory loads, the take exports through the real pipeline up to where
 * it stopped, and the fault is on record with a reason and a time.
 *
 *   display disconnect    STC_CAPTURE_FAULT=display-gone       stop: display-reconfigured
 *   disk full             STC_CAPTURE_FAULT=disk-full          stop: disk-full
 *   write error           STC_CAPTURE_FAULT=disk-write-failed  stop: disk-full
 *   encoder stall         STC_CAPTURE_FAULT=encoder-stall      warning: frames-dropped (the take goes on)
 *   camera disconnect     STC_CAPTURE_FAULT=camera-disconnected warning: camera-disconnected + tNs
 *   IPC pipe close        stdin closed mid-take                stop: stdin-closed
 *   helper crash          SIGKILL mid-take                     recovered: recorder-quit
 *   ...and the last two again through the REAL HelperSupervisor, which must
 *   respawn the helper and come back idle and able to record.
 *
 * Needs Screen Recording, Input Monitoring and Camera granted to the terminal
 * that runs it, plus real Chrome for the export. `npm run test:soak`, never CI.
 * A machine with no camera FAILS the camera case rather than skipping it: a
 * skip reads as covered. `STC_SOAK_ROUNDS=N` runs the whole table N times.
 */
import { describe, test, expect, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BIN, EXPORT_SLACK_FRAMES, exportTake, killAll, loadTakeDir, readAnchors, sessionDir, sleep,
  startTake, unsolicitedStop, waitFor, warning, type Helper,
} from "./_soak.js";
import { recoverTake } from "../../app/src/recover-take.js";
import { HelperSupervisor } from "../../app/src/supervisor.js";

afterEach(killAll);

const ROUNDS = Math.max(1, Number(process.env.STC_SOAK_ROUNDS ?? 1));

/** Acceptance 1 and 2, the same for every case. */
async function accept(dir: string) {
  const session = await loadTakeDir(dir);
  expect(session.video.framesNs.length, "the take has no display frames").toBeGreaterThan(0);
  const x = await exportTake(dir);
  expect(x.encodedSamples, `the encoded export holds ${x.encodedSamples} frames, the export made ${x.frames}\n${x.log}`)
    .toBe(x.frames);
  expect(x.frames, `export stopped at ${x.frames} frames; the take ran to frame ~${x.expectedFrames}\n${x.log}`)
    .toBeGreaterThanOrEqual(x.expectedFrames - EXPORT_SLACK_FRAMES);
  return session;
}

/** A stop's record: the reason, and a time inside the take. */
function expectStopRecord(dir: string, reason: string) {
  const a = readAnchors(dir);
  expect(a.stop?.reason).toBe(reason);
  expect(Number.isInteger(a.stop?.t) && a.stop.t > Number(a.capture.firstFrameNs),
    `stop.t ${a.stop?.t} is not after the first frame ${a.capture.firstFrameNs}`).toBe(true);
}

async function userStop(h: Helper) {
  h.send({ cmd: "stop", seq: 2 });
  const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stopped");
  expect(stopped.reason).toBe("user");
}

/** Test-only reach into the client's private child: the fault IS the owner's pipe closing. */
const childOf = (sup: HelperSupervisor) => (sup.client as unknown as { proc: ChildProcess }).proc;

for (let round = 1; round <= ROUNDS; round++) {
  describe(`fault soak (STC-238)${ROUNDS > 1 ? `, round ${round}/${ROUNDS}` : ""}`, () => {
    test.each([
      ["display-gone", "display-reconfigured"],
      ["disk-full", "disk-full"],
      ["disk-write-failed", "disk-full"],
    ])("STC_CAPTURE_FAULT=%s: the helper stops the take as %s, and it loads and exports", async (fault, reason) => {
      const { dir, h } = await startTake({ STC_CAPTURE_FAULT: fault }, {}, `the ${fault} soak`);
      const stopped = await unsolicitedStop(h);
      expect(stopped.reason).toBe(reason);
      expectStopRecord(dir, reason);
      await accept(dir);
    }, 180_000);

    test("encoder-stall: one frames-dropped warning covers the hole, the take goes on, and the file has the hole where it says", async () => {
      const { dir, h } = await startTake({ STC_CAPTURE_FAULT: "encoder-stall" }, {}, "the encoder-stall soak");
      // The window ends 2.0 s after the first frame; run well past it.
      await sleep(4_000);
      const w = await waitFor(() => warning(h, "frames-dropped"), 2_000, "a frames-dropped warning");
      expect(h.fd3.find((l) => l.ev === "stopped"), "a stall must not end the take").toBeUndefined();
      await userStop(h);
      expectStopRecord(dir, "user");

      const a = readAnchors(dir);
      const first = Number(a.capture.firstFrameNs);
      const startNs = Number(w.startNs), endNs = Number(w.endNs);
      expect(Number(w.count)).toBeGreaterThan(0);
      // Inside the injected window (DropRunDecisions.swift: 0.5 s after the first frame, for 1.5 s).
      expect(startNs).toBeGreaterThanOrEqual(first + 500_000_000);
      expect(endNs).toBeLessThan(first + 2_000_000_000);
      expect(endNs).toBeGreaterThanOrEqual(startNs);
      // One hole, one warning.
      expect(h.fd3.filter((l) => l.ev === "warning" && l.code === "frames-dropped")).toHaveLength(1);

      const session = await accept(dir);
      const inHole = session.video.framesNs.filter((t) => t >= startNs && t <= endNs);
      expect(inHole, "frames the warning says were dropped are in the file").toEqual([]);
      expect(session.video.framesNs.some((t) => t > endNs), "nothing was written after the stall").toBe(true);
    }, 180_000);

    test("camera-disconnected: the warning says when, the take goes on, and the camera track ends there", async () => {
      const { dir, h } = await startTake({ STC_CAPTURE_FAULT: "camera-disconnected" }, { camera: true }, "the camera soak");
      await waitFor(() => h.fd3.find((l) => l.ev === "camera-started")
        ?? h.fd3.find((l) => l.ev === "warning" && /^camera-/.test(String(l.code)) && l.code !== "camera-disconnected"),
      15_000, "the camera to open (this case needs a camera and a Camera grant)");
      expect(h.fd3.find((l) => l.ev === "camera-started"),
        `the camera did not open: ${JSON.stringify(h.fd3.filter((l) => l.ev === "warning"))}`).toBeDefined();
      const w = await waitFor(() => warning(h, "camera-disconnected"), 10_000, "the camera-disconnected warning");
      expect(Number.isInteger(w.tNs) && Number(w.tNs) > 0, `no session time on the warning: ${JSON.stringify(w)}`).toBe(true);
      await sleep(1_500);
      expect(h.fd3.find((l) => l.ev === "stopped"), "a camera unplug must not end the take").toBeUndefined();
      await userStop(h);
      expectStopRecord(dir, "user");
      expect(existsSync(join(dir, "camera.mp4")), "camera.mp4 missing").toBe(true);

      const session = await accept(dir);
      const cam = session.cameraVideo?.framesNs ?? [];
      expect(cam.length, "the camera track before the unplug is gone").toBeGreaterThan(0);
      // Nothing after the unplug, give or take one camera frame in flight (30 fps).
      expect(cam[cam.length - 1]).toBeLessThanOrEqual(Number(w.tNs) + 34_000_000);
    }, 180_000);

    test("IPC pipe close: stdin closing mid-take ends it as stdin-closed, cleanly, and it loads and exports", async () => {
      const { dir, h } = await startTake({}, {}, "the pipe-close soak");
      await sleep(2_000);
      h.proc.stdin!.end();
      const exit = await h.exited;
      expect(exit, "the helper must shut down cleanly on its own").toEqual({ code: 0, signal: null });
      expectStopRecord(dir, "stdin-closed");
      await accept(dir);
    }, 180_000);

    test("helper crash: SIGKILL mid-take recovers to a take that loads and exports", async () => {
      const { dir, h } = await startTake({}, {}, "the SIGKILL soak");
      await sleep(3_000);
      h.proc.kill("SIGKILL");
      await h.exited;
      expect(existsSync(join(dir, "anchors.json"))).toBe(false);
      expect(await recoverTake(dir, "recorder-quit")).toEqual({ ok: true });
      expectStopRecord(dir, "recorder-quit");
      await accept(dir);
    }, 180_000);

    describe("through the real supervisor", () => {
      let sup: HelperSupervisor | undefined;
      afterEach(async () => { await sup?.shutdown?.(); sup = undefined; });

      /** Record, break the helper with `fault`, and prove the supervisor reconciles. */
      async function superviseFault(fault: (child: ChildProcess) => void) {
        sup = HelperSupervisor.start(BIN, { statsIntervalMs: 200 });
        await sup.ready();
        const dir = sessionDir();
        const lost: any[] = [], respawned: any[] = [];
        sup.on("recording-lost", (p) => lost.push(p));
        sup.on("respawned", (p) => respawned.push(p));
        await sup.startRecording(dir);
        await sleep(2_500);
        const first = sup.pid;
        fault(childOf(sup));

        await waitFor(() => respawned[0], 10_000, "the supervisor to respawn the helper");
        await sup.ready();
        expect(sup.pid, "a new helper process").not.toBe(first);
        expect(lost.map((l) => l.dir), "the take in flight is reported, by its directory").toEqual([dir]);
        await waitFor(() => sup!.state === "idle" || undefined, 10_000, "the supervisor to settle idle");
        expect(sup.recordingDir, "no take left believed live").toBeUndefined();

        // Reconciled means usable: the respawned helper records.
        const next = sessionDir();
        await sup.startRecording(next);
        await sleep(1_500);
        await sup.stopRecording();
        expect(readAnchors(next).stop.reason).toBe("user");
        return dir;
      }

      test("pipe close: the supervisor respawns, reports the take, comes back idle, and records again", async () => {
        const dir = await superviseFault((c) => c.stdin!.end());
        // A clean shutdown wrote its own record; nothing to recover.
        expectStopRecord(dir, "stdin-closed");
        await accept(dir);
      }, 240_000);

      test("SIGKILL: the supervisor respawns, reports the take, comes back idle, and records again", async () => {
        const dir = await superviseFault((c) => c.kill("SIGKILL"));
        expect(await recoverTake(dir, "recorder-quit")).toEqual({ ok: true });
        expectStopRecord(dir, "recorder-quit");
        await accept(dir);
      }, 240_000);
    });
  });
}
