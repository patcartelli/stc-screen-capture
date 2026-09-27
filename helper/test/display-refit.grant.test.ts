/**
 * STC-235 — the helper refits the display stream into the SAME file instead
 * of stopping the take when the display changes under it.
 *
 * Needs a Screen Recording grant, same as capture.grant.test.ts — see that
 * file for why grant tests live apart from `npm test` rather than skipping.
 * Modelled on region-window-scope.grant.test.ts (same spawn helper, same
 * `STC_CAPTURE_FAULT` env usage, same stop request). Written on Linux;
 * NOTHING here has run against real ScreenCaptureKit. `docs/STC-235-RUNBOOK.md`
 * is what a Mac still owes this ticket — in particular §3, the only thing
 * that watches a REAL display-mode change rather than the injected fault.
 *
 * The fault (`STC_CAPTURE_FAULT=display-refit`, Capture.swift's
 * `armDisplayFault`) fires ~0.5 s after a successful start: it calls the
 * same `displayChanged()` the real CG callback would, against the SAME
 * display, and forces `apply`'s source rect to 3/4 width so the refit
 * produces a real, checkable pillarbox rather than a no-op update. That
 * reaches `DISPLAY_CHANGE_SETTLE_MS` (250 ms) of debounce and then the
 * refit itself, so geometry[1] should land noticeably before the 3 s take
 * ends but well after 0.5 s.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";
import { runSwiftHarness } from "./_swift-harness.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

interface Line { ev: string; seq?: number; [k: string]: any }
const live: ChildProcess[] = [];
afterEach(() => { for (const p of live.splice(0)) p.kill("SIGKILL"); });

function collect(stream: Readable, sink: Line[]): void {
  let buf = "";
  stream.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (l) { try { sink.push(JSON.parse(l)); } catch { /* not JSON */ } }
    }
  });
  stream.resume();
}

function spawnHelper(env: Record<string, string> = {}, args: string[] = []) {
  const proc = spawn(BIN, args, { stdio: ["pipe", "pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  collect(proc.stdio[3] as Readable, fd3);
  proc.stderr!.resume();
  let seq = 100;
  return {
    out, fd3,
    send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n"),
    request: async (c: object, ms = 15_000): Promise<Line> => {
      const s = ++seq;
      proc.stdin!.write(JSON.stringify({ ...c, seq: s }) + "\n");
      return waitFor(() => fd3.find((l) => l.seq === s), ms, `seq ${s} (${JSON.stringify(c)})`);
    },
    kill: () => proc.kill("SIGKILL"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 15_000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}
const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);
const session = () => mkdtempSync(join(tmpdir(), "stc-display-refit-"));

/**
 * The pause cases need to know how many frames were WRITTEN, and `started`
 * cannot say: it is answered when `startCapture` completes, before any frame
 * exists. The heartbeat can — `stats` on stdout carries `frames`
 * (`CaptureSession.stats()`'s `framesAppended`), so these cases run the
 * heartbeat at 50 ms instead of the default 2 s.
 */
const FAST_HEARTBEAT = ["--stats-interval-ms", "50"];
/**
 * The pause cases' fault delay (`STC_DISPLAY_FAULT_DELAY_MS`,
 * `armDisplayFault`), instead of the default 0.5 s: "pause after the first
 * written frame, but before the refit" needs a margin that does not depend on
 * how fast this machine delivers its first frame. The refit itself runs
 * `DISPLAY_CHANGE_SETTLE_MS` (250 ms) after this, which is extra margin.
 */
const PAUSE_FAULT_DELAY_MS = 2000;
const lastStats = (ls: Line[], from = 0) => ls.slice(from).filter((l) => l.ev === "stats").at(-1);

const validate7 = new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/anchors-7.schema.json"), "utf8")));
const validateAny = new Ajv({ allErrors: true, strict: true });

function loadRawAnchors(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
}

/** Validates against anchors-7 — only valid to call once `geometry` is expected. */
function loadAnchorsV7(dir: string): any {
  const raw = loadRawAnchors(dir);
  expect(validate7(raw), JSON.stringify(validate7.errors, null, 2)).toBe(true);
  return raw;
}

/** Starts, throwing `explainFailedStart`'s classified error on any refusal. */
async function startOrExplain(h: ReturnType<typeof spawnHelper>, cmd: object, what: string): Promise<Line> {
  const started = await h.request({ cmd: "start", ...cmd }, 30_000);
  if (started.ev !== "started") throw explainFailedStart(started as StartOutcome, what);
  return started;
}

/** The probe's two LUMA_* lines, parsed. Throws with the full output on a bad parse. */
async function probeLuma(mp4: string, tSeconds: number, rect: { x: number; y: number; width: number; height: number }) {
  const out = await runSwiftHarness({
    label: "frame-probe",
    sources: ["helper/test/frame-probe/main.swift"],
    args: [mp4, String(tSeconds), String(rect.x), String(rect.y), String(rect.width), String(rect.height)],
  });
  const outside = /LUMA_OUTSIDE=([\d.eE+-]+)/.exec(out);
  const inside = /LUMA_INSIDE=([\d.eE+-]+)/.exec(out);
  if (!outside || !inside) throw new Error(`frame probe did not print LUMA lines:\n${out}`);
  return { outside: Number(outside[1]), inside: Number(inside[1]) };
}

describe("display hot-swap refit (STC-235)", () => {
  test("refit: a display change mid-take refits into the SAME file, and the pixels agree", async () => {
    const h = spawnHelper({ STC_CAPTURE_FAULT: "display-refit" });
    await waitFor(() => find(h.fd3, "ready"));
    const dir = session();
    await startOrExplain(h, { dir }, "the display-refit fault (STC-235)");

    await sleep(3000);
    const stopped = await h.request({ cmd: "stop" }, 30_000);
    // Our own stop request, not the classifier's — a refit does not stop the
    // take, only the injected `display-gone` case (below) does.
    expect(stopped.ev).toBe("stopped");
    expect(stopped.reason).toBe("user");

    const anchors = loadAnchorsV7(dir);
    expect(anchors.version).toBe(7);
    expect(Array.isArray(anchors.geometry)).toBe(true);
    expect(anchors.geometry).toHaveLength(2);
    expect(anchors.geometry[0].startNs).toBe(anchors.capture.firstFrameNs ?? 0);
    expect(anchors.geometry[1].contentRect.width).toBeLessThan(anchors.capture.width);

    // The recorded startNs must be a REAL frame's PTS, not merely a plausible
    // number — the shared demux is what `render()` itself uses to find frames.
    const mp4Path = join(dir, "display.mp4");
    const buf = readFileSync(mp4Path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const { demuxTrack } = await import("../../transform/src/demux.js");
    const { memorySource } = await import("../../transform/src/chunk-reader.js");
    const video = await demuxTrack(memorySource(ab, "display.mp4"), "display.mp4");
    expect(video.framesNs).toContain(anchors.geometry[1].startNs);

    // The warning that reports the landing — CLAUDE.md's own record of what
    // shipped: sent from refitQueue, never the capture callback.
    const warning = h.fd3.find((l) => l.ev === "warning" && l.code === "display-refit");
    expect(warning, "no display-refit warning arrived").toBeDefined();
    expect(warning!.startNs).toBe(anchors.geometry[1].startNs);

    // loadSession must accept the take end to end.
    const { loadSession } = await import("../../transform/src/session.js");
    const events = JSON.parse(readFileSync(join(dir, "events.json"), "utf8"));
    await loadSession({
      anchors,
      events,
      displayMp4: memorySource(ab, "display.mp4"),
    });

    // The pixels: half a second after the refit lands, the computed
    // contentRect should show real content, and outside it should be the
    // forced pillarbox's black bars.
    const rect = anchors.geometry[1].contentRect;
    const tSeconds = (anchors.geometry[1].startNs + 0.5e9) / 1e9;
    const { outside, inside } = await probeLuma(mp4Path, tSeconds, rect);
    expect(outside, `LUMA_OUTSIDE=${outside} — expected near-black bars`).toBeLessThan(8);
    expect(inside, `LUMA_INSIDE=${inside} should read brighter than the bars (${outside})`).toBeGreaterThan(outside);
  }, 60_000);

  test("refit while paused (Review Focus 5): the geometry lands only after resume", async () => {
    const h = spawnHelper({ STC_CAPTURE_FAULT: "display-refit",
                            STC_DISPLAY_FAULT_DELAY_MS: String(PAUSE_FAULT_DELAY_MS) }, FAST_HEARTBEAT);
    await waitFor(() => find(h.fd3, "ready"));
    const dir = session();
    await startOrExplain(h, { dir }, "refit-while-paused (STC-235)");
    const startedAt = Date.now();

    // Pause only once a frame has been WRITTEN. Pausing on `started` alone
    // put the take's first frame inside the pause, and a take whose first
    // written frame already carries a letterboxing refit is the documented
    // "geometry unrepresentable" STOP (the case below) — not the refit this
    // case is about.
    await waitFor(() => h.out.some((l) => l.ev === "stats" && l.frames > 0), PAUSE_FAULT_DELAY_MS,
      "a written frame on the heartbeat, before the fault fires");
    const paused = await h.request({ cmd: "pause" }, 10_000);
    expect(paused.ev).toBe("paused");
    // ...and still before the fault: otherwise the refit landed un-paused and
    // this case would pass without testing anything about a pause.
    expect(Date.now() - startedAt, "the pause landed after the fault fired").toBeLessThan(PAUSE_FAULT_DELAY_MS);

    // Past the fault, its debounce, and the refit.
    await sleep(PAUSE_FAULT_DELAY_MS + 1000);
    const resumed = await h.request({ cmd: "resume" }, 10_000);
    expect(resumed.ev).toBe("resumed");

    await sleep(1500);
    const stopped = await h.request({ cmd: "stop" }, 30_000);
    expect(stopped.reason).toBe("user");

    const anchors = loadAnchorsV7(dir);
    expect(anchors.geometry).toHaveLength(2);
    expect(anchors.pauses).toHaveLength(1);
    const [span] = anchors.pauses;
    // The precondition, from the file itself: entry 0 (the first written
    // frame) predates the pause.
    expect(anchors.geometry[0].startNs).toBeLessThan(span.startNs);
    // The refit's geometry entry is recorded only from a WRITTEN frame
    // (Task 10, deviation 4/9) — no frame in the file was captured while
    // paused, so the entry cannot predate the pause's own end.
    expect(anchors.geometry[1].startNs).toBeGreaterThanOrEqual(span.endNs);
  }, 60_000);

  // The other side of the case above: paused BEFORE the first frame is
  // written, a letterboxing refit lands inside the pause, and the first frame
  // after resume would have to be geometry entry 0 — which anchors-7 requires
  // to be the full capture frame. The take is refused rather than recorded
  // with the wrong mapping (Task 10, deviation 9): `display-reconfigured`,
  // no geometry.
  //
  // Not deterministic in one shot: `started` precedes the first frame by an
  // unknown margin, and a frame that lands before the pause turns this into
  // the refit case above. So the precondition is MEASURED, not assumed (the
  // heartbeat's written-frame count, read after the pause has settled), and
  // an attempt that misses it is discarded and retried — never counted as a
  // pass. If every attempt misses, the test FAILS saying so rather than
  // skipping: a skip here would read as covered.
  test("paused from the start through a letterboxing refit: the take stops, geometry unrepresentable", async () => {
    const ATTEMPTS = 3;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const h = spawnHelper({ STC_CAPTURE_FAULT: "display-refit", STC_DISPLAY_FAULT_DELAY_MS: "1000" }, FAST_HEARTBEAT);
      await waitFor(() => find(h.fd3, "ready"));
      const dir = session();
      await startOrExplain(h, { dir }, "paused-from-start refit (STC-235)");
      const paused = await h.request({ cmd: "pause" }, 10_000);
      expect(paused.ev).toBe("paused");

      // A frame whose PTS predates the pause can still be delivered (and
      // written) just after the reply, so the count is read from a heartbeat
      // sent a little later, not the first one after the reply.
      await sleep(200);
      const mark = h.out.length;
      const beat = await waitFor(() => lastStats(h.out, mark), 2_000, "a heartbeat after the pause settled");
      if (beat.frames > 0) {
        h.kill();
        continue;       // precondition missed: a frame beat the pause; try again
      }

      // Past the fault (1 s), its debounce and the refit — all inside the pause.
      await sleep(2000);
      const resumed = await h.request({ cmd: "resume" }, 10_000);
      expect(resumed.ev).toBe("resumed");

      // Unsolicited: the first frame after resume is refused and the take ends.
      const stopped = await waitFor(
        () => h.fd3.find((l) => l.ev === "stopped" && typeof l.seq !== "number"),
        15_000, "an unsolicited `stopped` after resume");
      expect(stopped.reason).toBe("display-reconfigured");
      expect(stopped.frames, "a frame was written under an unrepresentable geometry").toBe(0);

      const anchors = loadRawAnchors(dir);
      expect(anchors.geometry).toBeUndefined();
      expect(anchors.stop?.reason).toBe("display-reconfigured");
      const validate = validateAny.compile(
        JSON.parse(readFileSync(join(root, `schema/anchors-${anchors.version}.schema.json`), "utf8")));
      expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);
      return;
    }
    throw new Error(
      `in ${ATTEMPTS} attempts a frame was always written before the pause took effect, so the ` +
      "paused-from-start precondition was never met and nothing was tested. This is a test-harness " +
      "outcome, not a helper failure: the machine delivers its first frame faster than a pause round trip.");
  }, 120_000);

  test("display-gone: the captured display disappearing stops the take, not a refit", async () => {
    const h = spawnHelper({ STC_CAPTURE_FAULT: "display-gone" });
    await waitFor(() => find(h.fd3, "ready"));
    const dir = session();
    await startOrExplain(h, { dir }, "the display-gone fault (STC-235)");

    // Unsolicited: nobody here sends `stop`.
    const stopped = await waitFor(
      () => h.fd3.find((l) => l.ev === "stopped" && typeof l.seq !== "number"),
      15_000, "an unsolicited `stopped`");
    expect(stopped.reason).toBe("display-reconfigured");
    expect(stopped.dir).toBe(dir);

    const anchors = loadRawAnchors(dir);
    expect(anchors.geometry).toBeUndefined();
    expect(anchors.stop?.reason).toBe("display-reconfigured");
  }, 60_000);

  // The control: same 3 s take, no fault. Proves the fault — not merely the
  // passage of time or the take's own length — is what produced `geometry`
  // above; without it a take stays at v2-v6 with no `geometry` key at all
  // (the byte-identical-when-untouched rule this ticket's global constraints
  // require).
  test("control: no fault, no geometry, version stays <= 6", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const dir = session();
    await startOrExplain(h, { dir }, "the no-fault control (STC-235)");

    await sleep(3000);
    const stopped = await h.request({ cmd: "stop" }, 30_000);
    expect(stopped.reason).toBe("user");

    const anchors = loadRawAnchors(dir);
    expect(anchors.version).toBeLessThanOrEqual(6);
    expect(anchors.geometry).toBeUndefined();
    // Whatever version it landed on validates against ITS OWN schema — not
    // anchors-7, which a take with no geometry need not (and should not)
    // claim to be.
    const validate = validateAny.compile(
      JSON.parse(readFileSync(join(root, `schema/anchors-${anchors.version}.schema.json`), "utf8")));
    expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);
  }, 60_000);
});
