import { describe, test, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { HelperSupervisor } from "../src/supervisor.js";
import { withTimeout } from "../../transform/src/timeout.js";
import { RAW_SUBDIR } from "../src/takes.js";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");
// Speaks the control plane and can actually be recording; captures nothing.
const FAKE_BIN = join(root, "app", "test", "_fake-helper.mjs");

const live: HelperSupervisor[] = [];
afterEach(async () => { for (const s of live.splice(0)) await s.shutdown(); });

function sup(opts: Parameters<typeof HelperSupervisor.start>[1] = {}, bin = BIN) {
  const s = HelperSupervisor.start(bin, { statsIntervalMs: 25, ...opts });
  live.push(s);
  return s;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const session = () => mkdtempSync(join(tmpdir(), "stc-sup-"));

describe("HelperSupervisor — keeping a helper alive", () => {
  test("comes up ready and reports idle", async () => {
    const s = sup();
    await s.ready();
    expect(s.state).toBe("idle");
  });

  test("respawns after an unexpected death and becomes usable again", async () => {
    const s = sup();
    await s.ready();
    const firstPid = s.pid;
    const respawned = new Promise<void>((res) => s.on("respawned", () => res()));
    s.killForTest();
    await respawned;
    await s.ready();
    expect(s.pid).not.toBe(firstPid);
    const r = await s.client!.request("status");
    expect(r.state).toBe("idle");
  }, 20_000);

  test("a stale idle heartbeat read after `started` does not end the take (STC-501)", async () => {
    // The heartbeat (stdout) and the `started` reply (fd3) are separate pipes,
    // so an idle line written BEFORE the helper handled `start` can land after
    // it. The helper IS recording; only the reliable channel may say otherwise.
    process.env.STC_FAKE_STALE_IDLE = "1";
    try {
      const s = sup({}, FAKE_BIN);
      await s.ready();
      const ended: unknown[] = [];
      s.on("take-ended", (e) => ended.push(e));
      s.on("recording-ended", (e) => ended.push(e));
      await s.startRecording(session());
      // Several heartbeats' worth, so the stale line has certainly been read
      // and any status check it provoked has been answered.
      await sleep(400);
      expect(ended).toEqual([]);
      expect(s.state).toBe("recording");
    } finally { delete process.env.STC_FAKE_STALE_IDLE; }
  }, 20_000);

  test("a crash mid-recording surfaces as a lost recording, not a silent reset", async () => {
    // Against the REAL helper this has to fake the recording, and the fake is
    // one the helper contradicts: it is idle, its heartbeat says so, and the
    // supervisor rightly heals the desync by ending the recording — which
    // clears recordingDir, so the crash has nothing left to report as lost.
    // That made the test a race against the supervisor's own self-healing:
    // green here, red whenever a loaded CI VM let a buffered stats line land
    // between the kill and the exit (run 33104414974). The stand-in can
    // actually be recording, so the recording is started for real and the
    // heartbeat agrees with it.
    const s = sup({}, FAKE_BIN);
    await s.ready();
    const dir = session();
    await s.startRecording(dir);
    // Not cosmetic: waiting for the helper's own heartbeat to agree is exactly
    // what the old fake could not survive. Nothing can now heal the state out
    // from under the assertion.
    await withTimeout(new Promise<void>((res) => {
      const off = s.on("stats", (l) => { if (l.state === "recording") { off(); res(); } });
    }), 2_000, "the stand-in's heartbeat agreeing that it is recording");
    expect(s.state).toBe("recording");

    const lost: any[] = [];
    s.on("recording-lost", (e) => lost.push(e));
    const respawned = new Promise<void>((res) => s.on("respawned", () => res()));
    s.killForTest();
    await respawned;
    expect(lost.length).toBe(1);
    expect(lost[0].dir).toBe(dir);
    expect(lost[0].signal).toBe("SIGKILL");
  }, 20_000);

  test("stops respawning after repeated rapid failures instead of looping forever", async () => {
    const s = sup({ maxRestarts: 2, restartWindowMs: 60_000 });
    await s.ready();
    const gaveUp = new Promise<void>((res) => s.on("gave-up", () => res()));
    for (let i = 0; i < 4; i++) {
      s.killForTest();
      await sleep(400);
    }
    await gaveUp;
    expect(s.state).toBe("failed");
  }, 30_000);

  test("shutdown is deliberate — it does not trigger a respawn", async () => {
    const s = sup();
    await s.ready();
    let respawns = 0;
    s.on("respawned", () => respawns++);
    await s.shutdown();
    await sleep(400);
    expect(respawns).toBe(0);
    expect(s.state).toBe("stopped");
  }, 20_000);
});

describe("HelperSupervisor — recording lifecycle", () => {
  test("start failure is reported without wedging the supervisor", async () => {
    const s = sup();
    await s.ready();
    const dir = session();
    const res = await s.startRecording(dir).catch((e) => e);
    if (res instanceof Error) {
      // no Screen Recording grant here: must stay usable
      expect(s.state).toBe("idle");
      const st = await s.client!.request("status");
      expect(st.state).toBe("idle");
    } else {
      expect(s.state).toBe("recording");
      const stopped = await s.stopRecording();
      expect(stopped.ev).toBe("stopped");
      expect(existsSync(join(dir, "display.mp4"))).toBe(true);
    }
  }, 40_000);
});

describe("HelperSupervisor — the helper can stop itself", () => {
  test("reconciles when the helper stops on its own (e.g. display reconfigured)", async () => {
    // A display change makes the helper stop cleanly and emit an unsolicited
    // `stopped`. Nothing asked for it, so a supervisor that only updates state
    // inside stopRecording() stays stuck believing it is recording — the UI
    // keeps offering Stop, and pressing it returns "bad-state: not recording".
    // Observed for real during the increment-5 display-change test.
    const s = sup();
    await s.ready();
    s.markRecordingForTest("/tmp/whatever");
    expect(s.state).toBe("recording");

    const notified = new Promise<any>((res) => s.on("recording-ended", res));
    // The heartbeat reports the helper's own state, which is the backstop for
    // any desync — not just this one.
    const info = await notified;
    expect(info.reason).toBeDefined();
    expect(s.state).toBe("idle");
  }, 20_000);
});

/**
 * A clean stop does NOT promote (STC-487, superseding STC-393's "a clean stop
 * IS the save"): the take stays in temp storage until someone decides on it at
 * the panel. Both stop paths — `stopRecording` and the self-initiated
 * `endRecording` — report it through ONE event, `take-ended`, and the
 * supervisor owns no promotion and no save folder at all.
 *
 * The temp and library roots are read from `process.env` by the modules that
 * own them (`takes.ts`, `temp-takes.ts`), so these mutate it for the duration
 * of the test rather than injecting it.
 */
describe("HelperSupervisor — a clean stop leaves the take in temp storage (STC-487)", () => {
  let base: string, tempRoot: string, libRoot: string, prevTemp: string | undefined, prevLib: string | undefined;

  function setEnv() {
    base = mkdtempSync(join(tmpdir(), "stc-sup-takeended-"));
    tempRoot = join(base, "temp");
    libRoot = join(base, "lib");
    mkdirSync(tempRoot, { recursive: true });
    prevTemp = process.env.STC_TEMP_TAKES_DIR;
    prevLib = process.env.STC_RECORDINGS_DIR;
    process.env.STC_TEMP_TAKES_DIR = tempRoot;
    process.env.STC_RECORDINGS_DIR = libRoot;
  }
  function restoreEnv() {
    if (prevTemp === undefined) delete process.env.STC_TEMP_TAKES_DIR; else process.env.STC_TEMP_TAKES_DIR = prevTemp;
    if (prevLib === undefined) delete process.env.STC_RECORDINGS_DIR; else process.env.STC_RECORDINGS_DIR = prevLib;
    rmSync(base, { recursive: true, force: true });
  }

  test("stopRecording() leaves the take in temp, the library empty, and emits take-ended", async () => {
    setEnv();
    try {
      const s = sup({}, FAKE_BIN);
      live.push(s);
      await s.ready();
      const dir = join(tempRoot, "2026-09-16_10-00-00");
      // Unlike the real helper, the stand-in does not create `dir` on start
      // (its "start" handling has nothing that captures) — matched here so
      // there is something real that a promote WOULD have moved.
      mkdirSync(dir, { recursive: true });
      const ended: any[] = [];
      s.on("take-ended", (i) => ended.push(i));
      let recordingEnded = false;
      s.on("recording-ended", () => { recordingEnded = true; });
      await s.startRecording(dir);
      await s.stopRecording();
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(libRoot, RAW_SUBDIR, "2026-09-16_10-00-00"))).toBe(false);
      expect(ended).toEqual([{ dir, reason: "stopped" }]);
      // A Stop somebody asked for is not "the helper stopped on its own".
      expect(recordingEnded).toBe(false);
      expect(s.state).toBe("idle");
    } finally { restoreEnv(); }
  }, 20_000);

  test("the helper stopping itself emits BOTH take-ended and recording-ended, with the TEMP dir", async () => {
    setEnv();
    try {
      const s = sup();
      live.push(s);
      await s.ready();
      const dir = join(tempRoot, "2026-09-16_11-00-00");
      mkdirSync(dir, { recursive: true });
      s.markRecordingForTest(dir);

      const order: string[] = [];
      const takeEnded = new Promise<any>((res) => s.on("take-ended", (i) => { order.push("take-ended"); res(i); }));
      const recordingEnded = new Promise<any>((res) => s.on("recording-ended", (i) => { order.push("recording-ended"); res(i); }));
      const [t, r] = await Promise.all([takeEnded, recordingEnded]);
      expect(t.dir).toBe(dir);
      expect(r.dir).toBe(dir);
      expect(t.reason).toBe(r.reason);
      // The panel's event first, so the alert never describes a take with no panel yet.
      expect(order).toEqual(["take-ended", "recording-ended"]);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(libRoot, RAW_SUBDIR, "2026-09-16_11-00-00"))).toBe(false);
    } finally { restoreEnv(); }
  }, 20_000);

  test("a stop with no recording directory emits no take-ended (nothing to decide on)", async () => {
    const s = sup({}, FAKE_BIN);
    live.push(s);
    await s.ready();
    const ended: any[] = [];
    s.on("take-ended", (i) => ended.push(i));
    s.markRecordingForTest(undefined as unknown as string);
    await s.stopRecording().catch(() => {});
    expect(ended).toEqual([]);
  }, 20_000);
});
